import { schema, table, t } from 'spacetimedb/server';

/** Canonical entity (mirrors sqlite `entities`). Public for subscribed search. */
export const entity = table(
  { name: 'entity', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    name: t.string().index('btree'),
    kind: t.string(),
    attrs: t.string(),
    embedding: t.string(),
    user: t.string().index('btree'),
  }
);

/** Directed relation (mirrors sqlite `relations`). Indexed for graph traversal. */
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
  }
);

/** Chunked graph snapshots (rows have ~64KB budget; big graphs split here). */
export const snapshotChunk = table(
  {
    name: 'snapshot_chunk',
    public: false,
    indexes: [{ accessor: 'by_snap', algorithm: 'btree', columns: ['snapId', 'idx'] }],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    snapId: t.string(),
    idx: t.u32(),
    data: t.string(),
    user: t.string().index('btree'),
  }
);

/** TTL cache (mirrors memcache semantics: key/result/expires_at). */
export const kvCache = table(
  { name: 'kv_cache', public: false },
  {
    key: t.string().primaryKey(),
    result: t.string(),
    expiresAt: t.u64(),
  }
);

const spacetimedb = schema({ entity, relation, snapshotChunk, kvCache });

export default spacetimedb;
