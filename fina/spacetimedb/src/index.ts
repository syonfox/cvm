import {
  SenderError,
  t,
  type InferSchema,
  type TransactionCtx,
} from 'spacetimedb/server';
import spacetimedb from './schema';

export { default } from './schema';

type ModuleSchema = InferSchema<typeof spacetimedb>;
type Tx = TransactionCtx<ModuleSchema>;
type DbCtx = Pick<Tx, 'db' | 'timestamp'>;

/* -------------------------------------------------------------------------- */
/* Validation (fail fast on bad input; every row is size-bounded)             */
/* -------------------------------------------------------------------------- */

const MAX_TEXT = 2048;
const MAX_JSON = 60_000; // stay under the ~64KB row budget
const MAX_ACTIVITY = 250;
const MAX_CHUNKS_PER_SNAP = 256;
const TTL_MAX_SECS = 7 * 24 * 3600;

function text(value: unknown, max = MAX_TEXT): string {
  return String(value ?? '').trim().slice(0, max);
}

function required(value: unknown, label: string, max = MAX_TEXT): string {
  const result = text(value, max);
  if (!result) throw new SenderError(`${label} is required`);
  return result;
}

function jsonText(value: unknown, label: string): string {
  const raw = typeof value === 'string' ? value : JSON.stringify(value ?? {});
  if (raw.length > MAX_JSON) {
    throw new SenderError(`${label} exceeds ${MAX_JSON} bytes; chunk it via snapshot_put_chunk`);
  }
  try {
    JSON.parse(raw);
  } catch {
    throw new SenderError(`${label} must be valid JSON`);
  }
  return raw;
}

function clampScore(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new SenderError('score must be a number');
  return Math.min(1, Math.max(0, n));
}

/** Bounded audit trail: insert, then trim oldest rows past the cap. */
function logActivity(ctx: DbCtx, kind: string, subject: string): void {
  ctx.db.activity.insert({
    id: 0n,
    kind: text(kind, 64),
    subject: text(subject, 254),
    time: ctx.timestamp,
  });
  const rows = [...ctx.db.activity.iter()];
  if (rows.length <= MAX_ACTIVITY) return;
  rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const row of rows.slice(0, rows.length - MAX_ACTIVITY)) {
    ctx.db.activity.id.delete(row.id);
  }
}

/* -------------------------------------------------------------------------- */
/* Reducers — the live-updatable API surface. `scripts/deploy.sh` hot-swaps  */
/* these on the running database with zero downtime.                          */
/* -------------------------------------------------------------------------- */

export const ingest_entity = spacetimedb.reducer(
  { name: t.string(), kind: t.string(), attrs: t.string(), user: t.string() },
  (ctx, payload) => {
    const row = {
      id: 0n,
      name: required(payload.name, 'name', 512),
      kind: text(payload.kind, 64) || 'Concept',
      attrs: jsonText(payload.attrs, 'attrs'),
      embedding: '',
      user: text(payload.user, 254) || 'anon',
    };
    ctx.db.entity.insert(row);
    logActivity(ctx, 'ingest_entity', row.name);
  },
);

export const ingest_relation = spacetimedb.reducer(
  {
    src: t.string(),
    dst: t.string(),
    rel: t.string(),
    score: t.f32(),
    evidence: t.string(),
    user: t.string(),
  },
  (ctx, payload) => {
    const row = {
      id: 0n,
      src: required(payload.src, 'src', 512),
      dst: required(payload.dst, 'dst', 512),
      rel: text(payload.rel, 128) || 'related',
      score: clampScore(payload.score),
      evidence: text(payload.evidence),
      user: text(payload.user, 254) || 'anon',
    };
    ctx.db.relation.insert(row);
    logActivity(ctx, 'ingest_relation', `${row.src} -> ${row.dst}`);
  },
);

export const cache_put = spacetimedb.reducer(
  { key: t.string(), result: t.string(), ttlSecs: t.u32() },
  (ctx, payload) => {
    const k = required(payload.key, 'key', 512);
    const body = jsonText(payload.result, 'result');
    const ttl = Math.min(Math.max(payload.ttlSecs || 0, 1), TTL_MAX_SECS);
    try {
      ctx.db.kvCache.key.delete(k);
    } catch {
      // missing key: nothing to evict
    }
    ctx.db.kvCache.insert({
      key: k,
      result: body,
      expiresAt: ctx.timestamp.microsSinceUnixEpoch + BigInt(ttl) * 1_000_000n,
    });
  },
);

export const cache_invalidate = spacetimedb.reducer({ key: t.string() }, (ctx, payload) => {
  const k = required(payload.key, 'key', 512);
  try {
    ctx.db.kvCache.key.delete(k);
  } catch {
    // idempotent: missing keys are fine
  }
});

/** Delete expired cache rows. Called on a schedule by the console. */
export const compact_cache = spacetimedb.reducer({}, (ctx, _payload) => {
  const now = ctx.timestamp.microsSinceUnixEpoch;
  let removed = 0;
  for (const row of ctx.db.kvCache.iter()) {
    if (row.expiresAt < now) {
      ctx.db.kvCache.key.delete(row.key);
      removed += 1;
      if (removed >= 5000) break; // bounded work per call
    }
  }
  logActivity(ctx, 'compact_cache', `removed=${removed}`);
});

export const snapshot_put_chunk = spacetimedb.reducer(
  { snapId: t.string(), idx: t.u32(), data: t.string(), user: t.string() },
  (ctx, payload) => {
    const id = required(payload.snapId, 'snapId', 128);
    const i = payload.idx;
    if (!Number.isInteger(i) || i < 0 || i >= MAX_CHUNKS_PER_SNAP) {
      throw new SenderError(`idx must be an integer in [0, ${MAX_CHUNKS_PER_SNAP})`);
    }
    const body = text(payload.data, MAX_JSON);
    if (!body) throw new SenderError('data is required');
    // Replace-on-rewrite keeps retries idempotent.
    for (const row of ctx.db.snapshotChunk.by_snap.filter(id)) {
      if (row.idx === i) ctx.db.snapshotChunk.id.delete(row.id);
    }
    ctx.db.snapshotChunk.insert({
      id: 0n,
      snapId: id,
      idx: i,
      data: body,
      user: text(payload.user, 254) || 'anon',
    });
    if (i === 0) logActivity(ctx, 'snapshot_put', id);
  },
);

export const snapshot_clear = spacetimedb.reducer({ snapId: t.string() }, (ctx, payload) => {
  const id = required(payload.snapId, 'snapId', 128);
  for (const row of ctx.db.snapshotChunk.by_snap.filter(id)) {
    ctx.db.snapshotChunk.id.delete(row.id);
  }
  logActivity(ctx, 'snapshot_clear', id);
});
