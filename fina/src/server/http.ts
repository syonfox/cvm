import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

export type Handler = (req: Req) => Promise<void> | void;

export type Req = {
  raw: IncomingMessage;
  res: ServerResponse;
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  ip: string;
  body?: unknown;
};

export function json(res: ServerResponse, status: number, obj: unknown): void {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': b.length,
    'access-control-allow-origin': '*',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
  });
  res.end(b);
}

export function text(res: ServerResponse, status: number, body: string, type = 'text/plain'): void {
  const b = Buffer.from(body);
  res.writeHead(status, { 'content-type': type, 'content-length': b.length });
  res.end(b);
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) throw new Error(`body exceeds ${maxBytes} bytes`);
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/** Sliding-window per-IP rate limiter (in-memory; single instance). */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(
    private perMin: number,
    private windowMs = 60_000,
  ) {}

  allow(ip: string, cost = 1): boolean {
    const now = Date.now();
    const arr = (this.hits.get(ip) ?? []).filter((t) => now - t < this.windowMs);
    if (arr.length + cost > this.perMin) {
      this.hits.set(ip, arr);
      return false;
    }
    for (let i = 0; i < cost; i++) arr.push(now);
    this.hits.set(ip, arr);
    if (this.hits.size > 10_000) {
      for (const [k, v] of this.hits) {
        if (v.length === 0 || now - v[v.length - 1] >= this.windowMs) this.hits.delete(k);
        if (this.hits.size <= 10_000) break;
      }
    }
    return true;
  }
}

export function serve(handler: Handler, opts: { host: string; port: number; certDir: string }): void {
  const onReq = async (raw: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const url = new URL(raw.url ?? '/', 'http://x');
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw.headers)) {
        if (typeof v === 'string') headers[k.toLowerCase()] = v;
      }
      const req: Req = {
        raw,
        res,
        method: (raw.method ?? 'GET').toUpperCase(),
        path: url.pathname,
        query: url.searchParams,
        headers,
        ip: raw.socket.remoteAddress ?? 'unknown',
      };
      if (req.method === 'OPTIONS') {
        res.writeHead(200, {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET,POST,OPTIONS',
          'access-control-allow-headers': 'content-type,x-auth-token',
        });
        res.end();
        return;
      }
      await handler(req);
      console.log(`${new Date().toISOString()} ${req.ip} ${req.method} ${req.path} -> ${res.statusCode}`);
    } catch (e) {
      if (!res.headersSent) json(res, 500, { ok: false, error: String(e).slice(0, 300) });
      else res.end();
    }
  };

  const key = join(opts.certDir, 'key.pem');
  const cert = join(opts.certDir, 'cert.pem');
  const root = join(dirname(opts.certDir), '..');
  void root;
  if (existsSync(key) && existsSync(cert)) {
    const server = createHttpsServer({ key: readFileSync(key), cert: readFileSync(cert) }, onReq);
    server.listen(opts.port, opts.host, () => console.log(`listening https://${opts.host}:${opts.port}`));
  } else {
    console.log('TLS certs missing — serving plain HTTP (dev only; run scripts/gen-certs.sh)');
    const server = createServer(onReq);
    server.listen(opts.port, opts.host, () => console.log(`listening http://${opts.host}:${opts.port}`));
  }
}

export async function parseJsonBody(req: Req, maxBytes: number): Promise<unknown> {
  if (req.method === 'GET' || req.method === 'HEAD') return {};
  const buf = await readBody(req.raw, maxBytes);
  if (buf.length === 0) return {};
  try {
    return JSON.parse(buf.toString('utf-8'));
  } catch {
    throw new Error('invalid JSON body');
  }
}
