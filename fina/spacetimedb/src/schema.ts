import { schema, table, t } from 'spacetimedb/server';

/**
 * Canonical entity. Mirrors the demo's sqlite `entities` table.
 * `user` is the caller identity string until identity-based RLS lands.
 */
export const entity = table(
  { name: 'entity', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    name: t.string().index('btree'),
    kind: t.string(),
    attrs: t.string(),
    embedding: t.string(),
    user: t.string().index('btree'),
  },
);

/** Directed relation. Indexed for graph traversal. */
export const relation = table(
  {
    name: 'relation',
    public: true,
    indexes: [{ accessor: 'by_pair', algorithm: 'btree', columns: ['src', 'dst'] }],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    src: t.string(),
    dst: t.string(),
    rel: t.string(),
    score: t.f32(),
    evidence: t.string(),
    user: t.string().index('btree'),
  },
);

/** Chunked graph snapshots. Rows have a ~64KB budget, so large graphs split
 * across rows keyed by snapId (single-column index, mirroring oc's pattern). */
export const snapshotChunk = table(
  {
    name: 'snapshot_chunk',
    public: false,
    indexes: [{ accessor: 'by_snap', algorithm: 'btree', columns: ['snapId'] }],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    snapId: t.string(),
    idx: t.u32(),
    data: t.string(),
    user: t.string().index('btree'),
  },
);

/** TTL cache. Mirrors the console L1 (src/core/lru-cache.ts) semantics. */
export const kvCache = table(
  { name: 'kv_cache', public: false },
  {
    key: t.string().primaryKey(),
    result: t.string(),
    expiresAt: t.u64(),
  },
);

/** Bounded, privacy-safe audit trail. Never store private content here. */
export const activity = table(
  { name: 'activity', public: false },
  {
    id: t.u64().primaryKey().autoInc(),
    kind: t.string(),
    subject: t.string(),
    time: t.timestamp(),
  },
);

const spacetimedb = schema({ entity, relation, snapshotChunk, kvCache, activity });

export default spacetimedb;
