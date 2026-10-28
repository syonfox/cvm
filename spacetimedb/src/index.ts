import { schema, table, t } from 'spacetimedb/server';

/** Canonical entity (mirrors sqlite `entities`). Public for subscribed search. */
const entity = table(
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
const relation = table(
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
const snapshotChunk = table(
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
const kvCache = table(
  { name: 'kv_cache', public: false },
  {
    key: t.string().primaryKey(),
    result: t.string(),
    expiresAt: t.u64(),
  }
);

/** Per-node living page (refined over time; sqlite `node_pages` mirrors this). */
const nodePage = table(
  {
    name: 'node_page',
    public: true,
    indexes: [{ accessor: 'by_owner', algorithm: 'btree', columns: ['node', 'user'] }],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    node: t.string(),
    user: t.string(),
    title: t.string(),
    kind: t.string(),
    body: t.string(),
    updated: t.u64(),
  }
);

/** Per-node context chat (append-only; sqlite `node_msgs` mirrors this). */
const nodeChat = table(
  {
    name: 'node_chat',
    public: true,
    indexes: [{ accessor: 'by_thread', algorithm: 'btree', columns: ['node', 'user', 'id'] }],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    node: t.string(),
    user: t.string(),
    role: t.string(),
    text: t.string(),
    created: t.u64(),
  }
);

const spacetimedb = schema({ entity, relation, snapshotChunk, kvCache, nodePage, nodeChat });

export default spacetimedb;

// Called by POST /api/spacetime/publish (backend proxy): stores one full-doc
// snapshot as a single chunk (idx 0). Keeps the race honest when configured.
export const ingestSnapshot = spacetimedb.reducer(
  { snapId: t.string(), data: t.string(), user: t.string() },
  (ctx, { snapId, data, user }) => {
    ctx.db.snapshotChunk.insert({ id: 0n, snapId, idx: 0, data, user });
  }
);
