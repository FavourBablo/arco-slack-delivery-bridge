import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { deliver } from '../src/delivery.js';

// Disable Vercel's default parser so the function can enforce its own byte limit.
export const config = { api: { bodyParser: false } };
export default function handler(req: IncomingMessage, res: ServerResponse) {
  return deliver(req, res, randomUUID());
}
