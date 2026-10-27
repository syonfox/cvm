import { spawn } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { LruCache } from '../core/lru-cache.js';
import { adversarialCheck, type GraphEdge, type GraphNode } from '../core/adversarial.js';
import {
  aiCacheKey,
  agentZero,
  extractJson,
  toolsAllow,
  ZERO_SYSTEM,
  type ChatFn,
  type ToolName,
} from '../core/agent.js';
import type { Config } from './config.js';
import { json, parseJsonBody, RateLimiter, type Req } from './http.js';

const CACHE = new LruCache();
setInterval(() => CACHE.compact(), 5 * 60_1000).unref();

const REDUCER_ALLOW = new Set([
  'ingest_entity',
  'ingest_relation',
  'cache_put',
  'cache_invalidate',
  'compact_cache',
  'snapshot_put_chunk',
  'snapshot_clear',
]);

function authed(req: Req, cfg: Config): boolean {
  const got = req.headers['x-auth-token'] ?? '';
  const want = cfg.authToken;
  if (got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}

function bodyOf(req: Req): Record<string, unknown> {
  return (req.body ?? {}) as Record<string, unknown>;
}

/* ---------------- SpacetimeDB proxy (creds never leave the server) -------- */

function dbRef(cfg: Config): string {
  // SpacetimeDB addresses DBs by hex identity on Maincloud.
  // SPACETIME_DB may be the hex identity OR a name; SPACETIME_IDENTITY wins if set.
  const id = (process.env['SPACETIME_IDENTITY'] ?? '').trim();
  return (id || cfg.spacetimeDb).trim();
}

const REDUCER_ARG_ORDER: Record<string, string[]> = {
  ingest_entity: ['name', 'kind', 'attrs', 'user'],
  ingest_relation: ['src', 'dst', 'rel', 'score', 'evidence', 'user'],
  cache_put: ['key', 'result', 'ttlSecs'],
  cache_invalidate: ['key'],
  compact_cache: [],
  snapshot_put_chunk: ['id', 'chunkIdx', 'chunks', 'data'],
  snapshot_clear: ['id'],
};

async function callReducer(cfg: Config, reducer: string, args: Record<string, unknown> | unknown[]): Promise<unknown> {
  if (!REDUCER_ALLOW.has(reducer)) throw new Error('reducer not allowlisted');
  // SpacetimeDB HTTP API expects a JSON *array* of positional args:
  // POST /v1/database/:name_or_identity/call/:reducer  body: ["a","b",...]
  const arr: unknown[] = Array.isArray(args)
    ? args
    : (REDUCER_ARG_ORDER[reducer] ?? Object.keys(args)).map((k) => (args as Record<string, unknown>)[k]);
  const raw = JSON.stringify(arr);
  if (raw.length > 64_000) throw new Error('args exceed 64KB');
  const res = await fetch(`${cfg.spacetimeHost}/v1/database/${dbRef(cfg)}/call/${reducer}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cfg.spacetimeToken ? { authorization: `Bearer ${cfg.spacetimeToken}` } : {}),
    },
    body: raw,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`spacetimedb ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

/* ---------------- Tool implementations ------------------------------------ */

async function fetchUrlTool(url: unknown): Promise<unknown> {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return { error: 'url must be http(s)' };
  let current = url;
  for (let hop = 0; hop <= 3; hop++) {
    const host = new URL(current).hostname;
    try {
      const addrs = await lookup(host);
      const ip = addrs.address;
      if (/^(127\.|10\.|192\.168\.|169\.254\.)/.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip) || ip === '::1') {
        return { error: 'blocked: private/loopback host' };
      }
    } catch {
      return { error: 'dns failed' };
    }
    const res = await fetch(current, {
      headers: { 'user-agent': 'fina-console/0.1' },
      redirect: 'manual',
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location')!, current).toString();
      continue;
    }
    const type = res.headers.get('content-type') ?? '';
    if (!/text|json/i.test(type)) return { error: `blocked content-type: ${type.slice(0, 80)}` };
    const raw = await res.text();
    const noScript = raw.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
    const txt = noScript.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return { url: current, text: txt.slice(0, 4000) };
  }
  return { error: 'too many redirects' };
}

function execTool(cfg: Config, name: string, args: Record<string, unknown>): Promise<unknown> {
  if (!cfg.execEnabled) return Promise.resolve({ error: 'exec disabled (EXEC_ENABLED=0)' });
  const code = String(args['code'] ?? '');
  const lang = String(args['lang'] ?? 'python3').toLowerCase();
  const argv = lang.startsWith('node') || lang === 'js' ? ['node', '-e', code] : ['python3', '-c', code];
  const cmdline = argv.slice(0, 2).join(' ');
  if (!cfg.execAllowPrefixes.some((p) => cmdline === p || cmdline.startsWith(p + ' '))) {
    return Promise.resolve({ error: `command not allowlisted: ${cmdline}` });
  }
  if (!code || code.length > 8000) return Promise.resolve({ error: 'code empty or exceeds 8KB' });
  return new Promise((resolve) => {
    const p = spawn(argv[0], argv.slice(1), { timeout: cfg.execTimeoutSecs * 1000, shell: false });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('error', (e) => resolve({ ok: false, error: String(e).slice(0, 200) }));
    p.on('close', (code2) => resolve({ ok: code2 === 0, code: code2, output: out.slice(0, cfg.execMaxOut) }));
    setTimeout(() => p.kill('SIGKILL'), cfg.execTimeoutSecs * 1000 + 500).unref();
  });
}

/* ---------------- LLM transport (OpenAI-compatible, injected) ------------- */

function makeChat(cfg: Config): ChatFn {
  return async (messages, tools, opts) => {
    if (!cfg.aiKey) throw new Error('AI_API_KEY is not set');
    const ccTools = tools.map((t) => ({
      type: 'function',
      function: {
        name: t,
        description: t,
        parameters: { type: 'object', properties: { query: { type: 'string' }, url: { type: 'string' }, code: { type: 'string' }, lang: { type: 'string' } }, additionalProperties: true },
      },
    }));
    const res = await fetch(`${cfg.aiBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.aiKey}` },
      body: JSON.stringify({
        model: cfg.aiModel,
        messages: opts.final ? messages : [{ role: 'system', content: ZERO_SYSTEM }, ...messages],
        ...(ccTools.length > 0 ? { tools: ccTools } : {}),
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(55_000),
    });
    if (!res.ok) throw new Error(`llm ${res.status}`);
    const j = (await res.json()) as {
      choices?: Array<{ message?: { content?: string; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> } }>;
    };
    const msg = j.choices?.[0]?.message ?? {};
    const calls = (msg.tool_calls ?? []).map((t) => {
      let args: unknown = {};
      try {
        args = JSON.parse(t.function?.arguments ?? '{}');
      } catch {
        args = {};
      }
      return { id: t.id ?? '', name: t.function?.name ?? '', args };
    });
    return { text: msg.content ?? '', calls };
  };
}

/* ---------------- Router --------------------------------------------------- */

export function buildRouter(cfg: Config) {
  const limit = new RateLimiter(cfg.rateLimitPerMin);
  const chat = makeChat(cfg);

  return async (req: Req): Promise<void> => {
    const { res } = req;

    if (req.method === 'GET' && req.path === '/health') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok\n');
      return;
    }
    if (req.method === 'GET' && req.path === '/info') {
      json(res, 200, { port: cfg.port, spacetimeDb: cfg.spacetimeDb, execEnabled: cfg.execEnabled, model: cfg.aiModel });
      return;
    }
    if (req.method === 'GET' && req.path === '/api/agent-manifest') {
      json(res, 200, {
        name: 'fina',
        version: 1,
        tools: ['ingest', 'recommend', 'improve', 'zero', 'spacetime/call'],
        hints: 'All POST routes require X-Auth-Token. Exec defaults off. Reads use SpacetimeDB subscriptions client-side.',
      });
      return;
    }

    // Everything else requires auth + rate limit.
    if (!authed(req, cfg)) {
      json(res, 401, { ok: false, error: 'unauthorized' });
      return;
    }
    if (!limit.allow(req.ip)) {
      json(res, 429, { ok: false, error: 'rate limited' });
      return;
    }
    if (req.method === 'POST') {
      try {
        req.body = await parseJsonBody(req, cfg.bodyMaxBytes);
      } catch (e) {
        json(res, 413, { ok: false, error: String(e).slice(0, 120) });
        return;
      }
    }
    const body = bodyOf(req);

    if (req.method === 'POST' && req.path === '/api/spacetime/call') {
      const reducer = String(body['reducer'] ?? '');
      const args = (body['args'] ?? {}) as Record<string, unknown>;
      try {
        json(res, 200, { ok: true, result: await callReducer(cfg, reducer, args) });
      } catch (e) {
        json(res, 400, { ok: false, error: String(e).slice(0, 300) });
      }
      return;
    }

    if (req.method === 'POST' && req.path === '/ingest') {
      const kind = String(body['kind'] ?? 'entity');
      try {
        if (kind === 'relation') {
          const out = await callReducer(cfg, 'ingest_relation', {
            src: String(body['src'] ?? ''), dst: String(body['dst'] ?? ''),
            rel: String(body['rel'] ?? 'related'), score: Number(body['score'] ?? 0.5),
            evidence: String(body['evidence'] ?? ''), user: String(body['user'] ?? ''),
          });
          json(res, 200, { ok: true, result: out });
        } else {
          const out = await callReducer(cfg, 'ingest_entity', {
            name: String(body['name'] ?? ''), kind: String(body['kind'] ?? 'Concept'),
            attrs: typeof body['attrs'] === 'string' ? body['attrs'] : JSON.stringify(body['attrs'] ?? {}),
            user: String(body['user'] ?? ''),
          });
          json(res, 200, { ok: true, result: out });
        }
      } catch (e) {
        json(res, 400, { ok: false, error: String(e).slice(0, 300) });
      }
      return;
    }

    if (req.method === 'POST' && (req.path === '/recommend' || req.path === '/improve' || req.path === '/zero')) {
      if (!cfg.aiKey) {
        json(res, 503, { ok: false, error: 'AI not configured (AI_API_KEY missing)' });
        return;
      }
      const allow = toolsAllow((body['tools'] ?? {}) as { web?: boolean; exec?: boolean });
      const t0 = Date.now();
      if (req.path === '/zero') {
        const q = String(body['q'] ?? body['prompt'] ?? body['text'] ?? '');
        if (!q.trim() || q.length > 8000) {
          json(res, 400, { ok: false, error: 'empty q or exceeds 8KB' });
          return;
        }
        const exec: (name: ToolName, args: Record<string, unknown>) => Promise<unknown> | unknown = (name, args) => {
          if (name === 'fetch_url') return fetchUrlTool(args['url']);
          if (name === 'exec_code') return execTool(cfg, name, args);
          return { result: [] as unknown[] };
        };
        try {
          const r = await agentZero(q, {
            chat,
            execTool: exec,
            allow,
            budgetSecs: cfg.agentBudgetSecs,
            ctx: String(body['ctx'] ?? ''),
            history: Array.isArray(body['history']) ? body['history'] : undefined,
          });
          json(res, 200, { ...r, ok: true, ms: Date.now() - t0 });
        } catch (e) {
          json(res, 500, { ok: false, error: String(e).slice(0, 300) });
        }
        return;
      }
      // recommend / improve: cached agent passes over the supplied graph.
      const nodes = (body['nodes'] ?? []) as GraphNode[];
      const edges = (body['edges'] ?? []) as GraphEdge[];
      if (!Array.isArray(nodes) || !Array.isArray(edges) || nodes.length > 2000 || edges.length > 5000) {
        json(res, 400, { ok: false, error: 'nodes/edges missing or exceed caps (2000/5000)' });
        return;
      }
      const flags = adversarialCheck(nodes, edges);
      const ck = aiCacheKey(req.path.slice(1), body, cfg.aiModel);
      const hit = CACHE.get(ck);
      if (hit) {
        const parsed = JSON.parse(hit) as Record<string, unknown>;
        json(res, 200, { ...parsed, cached: true, ms: 0 });
        return;
      }
      const instruction =
        req.path === '/recommend'
          ? `Entities: ${JSON.stringify(nodes.map((n) => n.label ?? n.id))}. Suggest exactly 5 likely relationships as JSON array {source,target,rel,reason}.`
          : `Instruction: ${String(body['input'] ?? body['instruction'] ?? '(clean up the graph)').slice(0, 2000)}\nGraph: ${JSON.stringify({ nodes, edges }).slice(0, 8000)}`;
      try {
        const r = await agentZero(instruction, {
          chat,
          execTool: (name, args) => {
            if (name === 'fetch_url') return fetchUrlTool(args['url']);
            if (name === 'exec_code') return execTool(cfg, name, args);
            return { result: [] as unknown[] };
          },
          allow,
          budgetSecs: cfg.agentBudgetSecs,
        });
        const ops = extractJson(r.text);
        const out = {
          ok: true,
          ops: (ops as { ops?: unknown }) && typeof ops === 'object' && 'ops' in (ops as object) ? (ops as { ops: unknown }).ops : ops,
          flags,
          turns: r.turns,
          tools: [...allow],
          cached: false,
          ms: Date.now() - t0,
        };
        CACHE.set(ck, JSON.stringify(out), 3600);
        json(res, 200, out);
      } catch (e) {
        json(res, 500, { ok: false, error: String(e).slice(0, 300) });
      }
      return;
    }

    if (req.method === 'POST' && req.path === '/exec') {
      if (!cfg.execEnabled) {
        json(res, 403, { ok: false, error: 'exec disabled (EXEC_ENABLED=0)' });
        return;
      }
      if (!limit.allow(req.ip + ':exec', 5)) {
        json(res, 429, { ok: false, error: 'exec rate limited' });
        return;
      }
      json(res, 200, await execTool(cfg, 'exec', { code: body['code'], lang: body['lang'] }));
      return;
    }

    if (req.method === 'POST' && req.path === '/mem') {
      const op = String(body['op'] ?? 'stats');
      if (op === 'compact') json(res, 200, { ok: true, ...CACHE.compact() });
      else json(res, 200, { ok: true, ...CACHE.stats() });
      return;
    }

    if (req.method === 'POST' && req.path === '/spacetime/compact') {
      try {
        json(res, 200, { ok: true, result: await callReducer(cfg, 'compact_cache', {}) });
      } catch (e) {
        json(res, 502, { ok: false, error: String(e).slice(0, 300) });
      }
      return;
    }

    json(res, 404, { ok: false, error: 'not found' });
  };
}
