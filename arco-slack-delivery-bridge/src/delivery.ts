import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const MAX_IMAGE_BYTES = 2_800_000; // Base64 and metadata must fit the 4 MB request cap.
export const MAX_REQUEST_BYTES = 4_000_000;

type Metadata = { day: string; subsidiary: string; headline: string; caption: string; visualRationale?: string };
type DeliveryResult = {
  ok: boolean;
  requestId: string;
  image: { succeeded: boolean; fileId?: string; error?: string };
  text: { succeeded: boolean; messageTs?: string; error?: string };
};

function reply(res: ServerResponse, status: number, value: object) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(value));
}

function secureMatch(a: string, b: string): boolean {
  const x = createHash('sha256').update(a).digest();
  const y = createHash('sha256').update(b).digest();
  return timingSafeEqual(x, y);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += part.length;
    if (size > MAX_REQUEST_BYTES) throw new DeliveryError(413, 'request_too_large');
    parts.push(part);
  }
  return Buffer.concat(parts);
}

export class DeliveryError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string) { super(code); this.status = status; this.code = code; }
}

export function validateMetadata(input: unknown): Metadata {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new DeliveryError(400, 'invalid_metadata');
  const data = input as Record<string, unknown>;
  const keys = ['day', 'subsidiary', 'headline', 'caption'] as const;
  for (const key of keys) {
    if (typeof data[key] !== 'string' || !(data[key] as string).trim() || (data[key] as string).length > (key === 'caption' ? 4000 : 200)) {
      throw new DeliveryError(400, `invalid_${key}`);
    }
  }
  if (data.visualRationale !== undefined && (typeof data.visualRationale !== 'string' || data.visualRationale.length > 2000)) throw new DeliveryError(400, 'invalid_visualRationale');
  return { day: data.day as string, subsidiary: data.subsidiary as string, headline: data.headline as string, caption: data.caption as string, ...(data.visualRationale === undefined ? {} : { visualRationale: data.visualRationale as string }) };
}

export function detectImage(bytes: Buffer): { mime: string; extension: string } {
  if (bytes.length < 12 || bytes.length > MAX_IMAGE_BYTES) throw new DeliveryError(400, 'invalid_image_size');
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return { mime: 'image/png', extension: 'png' };
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && bytes[bytes.length - 2] === 255 && bytes[bytes.length - 1] === 217) return { mime: 'image/jpeg', extension: 'jpg' };
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return { mime: 'image/webp', extension: 'webp' };
  throw new DeliveryError(400, 'unsupported_image');
}

async function slack(method: string, token: string, payload: object): Promise<Record<string, unknown>> {
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) throw new Error(`slack_http_${response.status}`);
  const data = await response.json() as Record<string, unknown>;
  if (data.ok !== true) throw new Error(`slack_${String(data.error ?? 'unknown_error').replace(/[^a-z0-9_]/gi, '')}`);
  return data;
}

export async function deliver(req: IncomingMessage, res: ServerResponse, requestId: string) {
  res.setHeader('X-Request-Id', requestId);
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return reply(res, 405, { ok: false, requestId, error: 'method_not_allowed' });
  }
  const expected = process.env.BRIDGE_BEARER_TOKEN;
  const token = process.env.SLACK_BOT_TOKEN;
  const channel = process.env.SLACK_CHANNEL_ID;
  if (!expected || !token || !channel) return reply(res, 503, { ok: false, requestId, error: 'not_configured' });
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ') || !secureMatch(header.slice(7), expected)) return reply(res, 401, { ok: false, requestId, error: 'unauthorized' });
  try {
    const contentType = req.headers['content-type'] ?? '';
    if (!/^application\/json(?:\s*;|\s*$)/i.test(contentType)) throw new DeliveryError(415, 'expected_json');
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) throw new DeliveryError(413, 'request_too_large');
    const body = JSON.parse((await readBody(req)).toString('utf8')) as Record<string, unknown>;
    const metadata = validateMetadata(body);
    if (typeof body.imageBase64 !== 'string' || body.imageBase64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.imageBase64)) throw new DeliveryError(400, 'invalid_image_base64');
    const image = Buffer.from(body.imageBase64, 'base64');
    const kind = detectImage(image);
    const fileName = `arco-${requestId}.${kind.extension}`;
    const result: DeliveryResult = { ok: false, requestId, image: { succeeded: false }, text: { succeeded: false } };

    try {
      const slot = await slack('files.getUploadURLExternal', token, { filename: fileName, length: image.length });
      if (typeof slot.upload_url !== 'string' || typeof slot.file_id !== 'string') throw new Error('slack_invalid_upload_slot');
      const upload = await fetch(slot.upload_url, { method: 'POST', headers: { 'Content-Type': kind.mime }, body: new Uint8Array(image), signal: AbortSignal.timeout(30000) });
      if (!upload.ok) throw new Error(`slack_binary_upload_http_${upload.status}`);
      await slack('files.completeUploadExternal', token, { files: [{ id: slot.file_id, title: `${metadata.subsidiary} — ${metadata.headline}` }], channel_id: channel });
      result.image = { succeeded: true, fileId: slot.file_id };
    } catch (error) {
      result.image.error = error instanceof Error ? error.message : 'upload_failed';
      console.error(JSON.stringify({ requestId, stage: 'image', error: result.image.error }));
      return reply(res, 502, result);
    }

    try {
      const message = await slack('chat.postMessage', token, {
        channel, text: `*${metadata.headline.replace(/[*_~`]/g, '')}*\n\n${metadata.caption}`
      });
      result.text = { succeeded: true, messageTs: String(message.ts) };
      result.ok = true;
      console.info(JSON.stringify({ requestId, stage: 'complete', fileId: result.image.fileId, messageTs: result.text.messageTs }));
      return reply(res, 200, result);
    } catch (error) {
      result.text.error = error instanceof Error ? error.message : 'message_failed';
      console.error(JSON.stringify({ requestId, stage: 'text', error: result.text.error, fileId: result.image.fileId }));
      return reply(res, 502, result);
    }
  } catch (error) {
    if (error instanceof DeliveryError) return reply(res, error.status, { ok: false, requestId, error: error.code });
    if (error instanceof SyntaxError) return reply(res, 400, { ok: false, requestId, error: 'invalid_json' });
    console.error(JSON.stringify({ requestId, stage: 'request', error: 'internal_error' }));
    return reply(res, 500, { ok: false, requestId, error: 'internal_error' });
  }
}
