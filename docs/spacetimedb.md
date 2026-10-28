# SpacetimeDB Migration Guide

Current state: **sqlite** (`backend/cvm.db`, tables below) + **in-memory LRU** (`backend/memcache.py`, 1GB cap).

## 1. What lives where today

| sqlite table    | shape | hot? | SpacetimeDB plan |
|---|---|---|---|
| `entities`      | id, name, kind, attrs(JSON), embedding, user | yes (graph_search) | `entity` table, index on `name` + `user` |
| `relations`     | id, src, dst, rel, score, evidence, user | yes | `relation` table, index on `(src,dst)` + `user` |
| `graphs`        | id, user, text, nodes(JSON), edges(JSON), flags(JSON), created | medium | `snapshot` table (one row per saved graph) |
| `concept_cache` | key, result(JSON), created | hot | **replaced by** memcache + SpacetimeDB `kv_cache` table with `expires_at` |
| `users` / `prompts` | small | cold | `user`, `prompt` tables (or client-held) |

`memcache.py` already mirrors the **exact semantics SpacetimeDB wants**: string keys,
TTL (`expires_at`), LRU eviction, `snapshot()`/`restore()`, `stats()`. The migration
is mostly swapping the backing store.

## 2. SpacetimeDB schema sketch

```rust
#[table(name = entity, public)]
pub struct Entity { #[primary_key] #[auto_inc] id: u64, name: String, kind: String,
    attrs: String, embedding: String, user: String }

#[table(name = relation, public)]
pub struct Relation { #[primary_key] #[auto_inc] id: u64, src: String, dst: String,
    rel: String, score: f32, evidence: String, user: String }

#[table(name = kv_cache, public)]
pub struct KvCache { #[primary_key] key: String, result: String, expires_at: u64 }
```

Reducers: `ingest_entity`, `ingest_relation`, `cache_put(key,result,ttl)`,
`cache_get` (client reads directly — no reducer needed), `compact_cache`
(delete `expires_at < now`, same as `MemCache.compact()`).

## 3. Migration steps

1. **Stand up the module**: `spacetime publish` the schema above (identity = per-user `user` string maps to SpacetimeDB `Identity`; keep the `user` column during transition).
2. **Dual-write (no downtime)**: in `server.py`, after each sqlite `INSERT` into
   `entities`/`relations`, also call the matching reducer. Reads stay on sqlite+memcache.
3. **Backfill**: one-off script — `SELECT *` per table → reducer calls in batches of
   ~500. `concept_cache` → `cache_put` with `ttl = max(0, created + 86400 - now)`.
   Memcache live entries: `CACHE.snapshot()` → same path (this is what `snapshot()` is for).
4. **Cut reads over**: point `db_search`, `/api/graph`, `/graphs` at SpacetimeDB client
   subscriptions; keep memcache as L1 (it already fronts `cache_get`/`cache_set` —
   only the L2 changes from sqlite to a reducer call).
5. **Compaction parity**: replace the `MEM_COMPACT_SECS` thread with a scheduled
   `compact_cache` reducer call; keep `MemCache.compact()` for the L1.
6. **Retire sqlite**: once subscriptions are stable, drop sqlite writes, keep the
   `.db` file as a cold backup.

## 4. Notes / gotchas

- SpacetimeDB rows have size limits (~64KB default budget per row) — `graphs.nodes`
  JSON can exceed it: store snapshots **chunked** (`snapshot_chunk { snap_id, idx, data }`)
  or keep big graphs client-side and only index metadata server-side.
- `attrs`/`evidence` stay JSON strings — same as today, no refactor needed.
- Auth: map `X-Auth-Token` → SpacetimeDB identity token; the `user` column becomes
  redundant once identity-based row-level checks land — keep it until then.
- The `/mem` endpoint (`stats`/`compact`) is the operational template for the
  future `/spacetime compact` admin call.
