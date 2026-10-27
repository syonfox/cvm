# FINA — production-grade starter (console + SpacetimeDB module)

Migrated from the `threatpath` demo: keeps its smartest parts, fixes its
load-bearing flaws, and adds live code updates for the database module.

```
Browser ──TLS──> this console (:8443) ──Bearer──> SpacetimeDB (finadb)
  │                  ├── auth (fail-closed) + rate limits        tables: entity, relation,
  │                  ├── /api/spacetime/call proxy (creds stay   snapshot_chunk, kv_cache,
  │                  │    server-side; reducers allowlisted)      activity
  │                  ├── L1 LruCache + AI response cache        reducers: ingest_entity,
  │                  └── budget agent (/zero, /recommend,        ingest_relation, cache_put,
                       /improve) with exec OFF by default        compact_cache, snapshot_*
```

Reads use SpacetimeDB subscriptions client-side (regenerate with
`npm run spacetime:generate` after each deploy). The console only proxies
**reducer calls** — the raw DB is never exposed and creds never reach the browser.

## Run

```bash
cp .env.example .env   # set AUTH_TOKEN (required; server exits without it)
npm install
bash start.sh          # certs + build + health-gated start on https://localhost:8443/
curl -sk -H "X-Auth-Token: $AUTH_TOKEN" https://localhost:8443/info
```

Local SpacetimeDB instead of maincloud: `spacetime start`, then
`bash scripts/deploy.sh local`.

## Live code update (the point of this layout)

```bash
bash scripts/deploy.sh [--server maincloud|local] [--db finadb] [--skip-console]
```

Gated pipeline: typecheck → tests → module build → **`spacetime publish`**
(hot-swaps reducers/tables on the running DB, zero downtime, clients migrate)
→ regenerate bindings → rebuild + restart console. The console restart touches
only the proxy; the database never goes down. small, additive reducer changes
are the safe unit of deploy; table-shape changes need a backfill pass first
(see "Migration from the demo" below).

Other commands: `npm test`, `npm run typecheck`, `bash scripts/deploy.sh --skip-console`.

## What was kept from the demo (and why)

| Demo part | FINA equivalent | Why it survived adversarial review |
|---|---|---|
| `memcache.py` LRU/TTL/`compact`/`snapshot`/`restore`/`stats` | `src/core/lru-cache.ts` | Exact SpacetimeDB `kv_cache` semantics; fixed O(n) eviction to O(1) via Map order |
| `agent_zero` budget + history resume + forced final no-tools pass | `src/core/agent.ts` | Guarantees no dead-end replies; transport injected so it is unit-testable |
| `{web, exec}` tool gating, exec default off | `toolsAllow()` + server enforcement | Right default; now also enforced on dropped calls mid-loop |
| `_ai_cache_key` response cache | `aiCacheKey()` | Same sha256 shape; L1-backed with 1h TTL |
| `adversarial_check` hub/homogeneity flags | `src/core/adversarial.ts` | Cheap deterministic gate before expensive agent passes |
| `spacetime_sync.py` proxy-only pattern + `schema.ts` tables | `spacetimedb/src/*` + `/api/spacetime/call` | Creds server-side; reducers now implemented with validation + row budgets |
| Chunked snapshots (migration doc §4) | `snapshot_put_chunk` / `snapshot_clear` | Honors the ~64KB row budget the demo only documented |

## What was deliberately dropped / fixed

- **Unauthenticated RCE** (`POST /exec` ran `bash -lc` with no token) → exec OFF by default, allowlisted prefixes, `spawn` with `shell:false`, timeouts, output caps, separate 5/min rate limit, always requires auth.
- **Fail-open auth** (`AUTH_TOKEN=""` ⇒ all requests pass; only `/build` checked anyway) → every non-health route requires `X-Auth-Token` (constant-time compare); server exits if `AUTH_TOKEN` is unset.
- **Single-threaded server** (`socketserver.TCPServer`) → Node HTTP(S); one slow LLM call no longer head-of-line-blocks health checks.
- **Committed API key** (`.env` with a live key on disk) → `.env.example` only, `.env` gitignored, key never logged.
- **Silent fallbacks** (tokenizer fallback graphs, heuristic recs presented like agent output) → explicit `503 AI not configured`, empty nodes, flagged fallbacks.
- **Regex HTML scraping** (DDG scrape) → `fetch_url` with DNS SSRF guard (blocks loopback/RFC1918), redirect cap, content-type check, 64KB cap.
- **Unbounded inputs** (no body caps, 2000+ line prompts) → 1MB body cap, node/edge caps (2000/5000), 8KB prompt caps, per-IP rate limiting.
- **Dead migration code** (`spacetime_sync.py` never imported; schema had no reducers) → reducers implemented, tested deploy path, backfill order documented below.

## Migration from the demo (sqlite → finadb)

1. Deploy FINA once: `bash scripts/deploy.sh` (creates tables on first publish).
2. Backfill in ~500-row batches via `/api/spacetime/call` → `ingest_entity` / `ingest_relation`
   (same shape as the demo's `backfill()`; keep the demo's `.db` as cold backup).
3. `concept_cache` rows → `cache_put` with `ttl = max(0, created + 86400 - now)`; live L1 → `snapshot()` → same path.
4. Cut reads: point the frontend at SpacetimeDB subscriptions (regenerated bindings); keep the L1.
5. Schedule `POST /spacetime/compact` (replaces the demo's memcache compactor thread for L2).
6. Retire sqlite writes.
