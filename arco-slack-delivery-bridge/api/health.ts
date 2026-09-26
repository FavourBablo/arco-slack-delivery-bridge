import type { IncomingMessage, ServerResponse } from 'node:http';

export default function health(req: IncomingMessage, res: ServerResponse) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.statusCode = 405;
    return res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }));
  }
  res.statusCode = 200;
  res.end(JSON.stringify({ ok: true, service: 'arco-slack-delivery-bridge' }));
}
