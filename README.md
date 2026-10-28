# CVM — Cache Variable Memory

CVM (Cache Variable Memory), evolved from the threatpath prototype

live demo https://threatpath.sgol.workers.dev



Single-input CVM graph viewer + secret `0shot` eval page, with a Python stdlib backend.

## Components

| Component | File | Role |
|---|---|---|
| **Graph viewer** | `index.html` | Cytoscape canvas. Force/Tree/Grid switcher, run-once `cose` layout (no perpetual sim) + one-shot boids `settle` (separation/cohesion/alignment, easeOutBack). Right-click node menu (Ask 0shot / path / CRUD), additive multi-select, path-pick (click A→B or ⚓ anchor), per-path relation labeling, undo/redo (cap 60, `Ctrl+←/→`, `Ctrl+Z/Y`), zoom/fit/big-view, JSON export/import, AI log. |
| **0shot eval page** | `0shot.html` | Secret tool-calling eval UI. `?q=` input, 28s budget, md/html/plain auto-render, Continue/resume, freemap `lit` + local-time context, `GRAPH_CTX` hook, Answer vs Graph-edits mode, `Ctrl+0` handoff, append-back + apply-ops to graph. |
| **Backend** | `backend/server.py` | stdlib HTTP. Routes: `/build`, `/recommend`, `/improve`, `/zero` (agent, 28s / 6 fresh + 8 resume turns, forced final no-tools pass), `/exec`, `/mem`, `/health`, `/info`, `/api/agent-manifest`. |
| **Agent** | `backend/meta_ai.py` | `agent_zero` (plain-language answers, `format=json` instruction, history resume). `web_search` = DDG instant API with `html.duckduckgo.com` scrape fallback. |
| **Cache L1** | `backend/memcache.py` | 1GB in-memory LRU, TTL, `compact`/`snapshot`/`restore`/`stats`, background compactor, `POST /mem`. Fronts cache reads; L2 is sqlite today, SpacetimeDB next. |
| **Store (today)** | `backend/cvm.db` (sqlite, auto-migrated from legacy `osint.db`) | `entities`, `relations`, `graphs`, `concept_cache`, `users`, `prompts`. Cold backup after migration. |
| **Store (next)** | `spacetimedb/` + `spacetime.json` | SpacetimeDB host modeled on `~/oc/oc`: module schema (`entity`, `relation`, `snapshot_chunk`, `kv_cache`), local console proxy. See `SPACETIMEDB_MIGRATION.md`. |
| **Handoff keys** | localStorage | `osint_0shot_handoff`, `osint_0shot_result`, `osint_0shot_ops`, `osint_0shot_prompt`; `osint_view`, `osint_phys`, layer state. |

## Force tuning (smooth default)

- Defaults `BEST = { rep:22000, len:170, sep:190, grav:0.22 }` (persisted `osint_phys`, sliders in ⚙ panel, `Reset` restores).
- `cose`: `edgeElasticity:90`, `nodeOverlap:12`, `componentSpacing:70`, `nodeDimensionsIncludeLabels:true`, `numIter` scales down with size (14 / 8 / 4), `randomize:false`, single 800ms run + `fit`.
- Boids settle: gentler weights (`wSep 1.35`, `wCoh 0.038`, `wAli 0.016`, `wGrav 0.003`), higher damping (`0.86`), smaller step cap (`22`), more iterations (`110`, `50` if >300 nodes) → evenly spaced, no bunching, no drift-off.
- Node size scales with degree (`34 + min(44, deg*5)`); dense graphs get `+dens*4000` repulsion and `+min(110, dens*22)` edge length; >400 nodes fall back to grid.

## SpacetimeDB host (like `~/oc/oc`)

```
Browser ──> this backend (:3333, stdlib) ──> SpacetimeDB (maincloud or local)
   │                ├── serves index.html / 0shot.html        tables: entity, relation,
   │                ├── /api/spacetime/* proxy (never raw creds)  snapshot_chunk, kv_cache
   │                └── memcache L1 + sqlite cold backup      reducers: ingest_entity,
                                                              ingest_relation, cache_put,
                                                              compact_cache
```

- `spacetime.json` = host config (`database: osintdb`, `server: maincloud`, local override). D1 database is already `cvm`.
- `spacetimedb/schema.ts` = module tables (mirrors `SPACETIMEDB_MIGRATION.md` §2).
- `backend/spacetime_sync.py` = dual-write/backfill/proxy helpers (sqlite → reducers).
- Steps: `spacetime publish` → dual-write → backfill (~500/batch) → cut reads → scheduled `compact_cache` → retire sqlite writes.

## Run

```bash
./start.sh            # backend :3333 + frontend
curl localhost:3333/health
```

See `GETTING_STARTED.md` (product tour) and `SPACETIMEDB_MIGRATION.md` (migration detail).

## Vision: two redundant sync servers + a view-only viewer

Every graph edit races down **two independent sync paths** and the UI shows which one
acked first — no single box to trust, and you can *see* the redundancy working.

```
                        ┌── #1 Cloudflare Durable Object (GraphSync, per-graph room) ──┐
  editor (index.html) ──┤  WS live fan-out + HTTP publish, latest snapshot in DO storage ├─► live clients
  commit / share / Race │                                                              │
  `CVMSync.racePublish` └── #2 SpacetimeDB (durable module tables, best-effort proxy) ──┘
        │ shows winner: "sync race: DO won · 42ms vs spacetime 180ms"
        ▼
  viewer (viewer.html) — fullscreen, read-only: zoom/fit, force/tree/grid,
  follow-live toggle, big home button. ?g=<uuid>. Subscribes DO over WS,
  falls back to polling /api/sync/state. No editing UI by design.
```

| Piece | File | Role |
|---|---|---|
| Sync server #1 | `workers/src/sync.js` (`GraphSync` DO) | Per-graph room (`graph:<uuid>`). WS `hello`/`publish`, broadcast `state`, persist latest snapshot. HTTP: `GET /api/sync/state`, `POST /api/sync/publish`. |
| Sync server #2 | SpacetimeDB module (`spacetimedb/schema.ts`) via `POST /api/spacetime/publish` | Durable tables (`entity`, `relation`, `node_page`, …). Honest `skipped` answer when `SPACETIME_HOST` is unset — the race never shows a false win. |
| Race client | `sync-client.js` (`window.CVMSync`) | `racePublish(uuid, doc)` fires both in parallel, reports `{winner, doMs, stMs}` into `#syncRace` + AI log. `subscribe(uuid, cb)` = WS live with 3s poll fallback. |
| Viewer | `viewer.html` | Fullscreen read-only graph. Controls are adjustment-only (zoom/fit/layout/follow-live) + big home button. |
| Local twin | `backend/server.py` (`sync_publish`/`sync_state`, in-memory) | Same `/api/sync/*` shapes on the Python backend (no WS upgrade in stdlib) so `bash start.sh` dev behaves like the edge. `/api/graph/commit` also mirrors into sync. |

**Sync host setting:** the editor's Layers rail has a `sync host:` row (blank = auto =
same as backend/origin). Type a bare LAN address like `192.168.1.5:8787` (wrangler dev
port) and every race + live subscribe goes there instead; `test` pings
`/api/sync/ping` first. The choice persists in `osint_sync_host`, is passed to the
viewer as `?sync=` when you open it, and the viewer accepts `?sync=` directly too
(tap its sync badge to change hosts on the spot).

## Final deploy: Cloudflare + SpacetimeDB + browser

The browser is a full participant: it publishes to **both** backends independently and
each client syncs from whichever answers — both fast, either sufficient.

```bash
# 1. edge app + sync #1 (DO + D1)
cd workers
wrangler d1 execute cvm --remote --file schema.sql
wrangler deploy   # → https://<you>.workers.dev (serves index/0shot/viewer + API + DO)
wrangler secret put MODEL_API_KEY

# 2. sync #2 (durable tables)
spacetime publish --project-path ./spacetimedb -s maincloud osintdb
# then set SPACETIME_HOST (+ creds) as Worker env / .env SPACETIME_HOST
# until then /api/spacetime/publish answers {skipped:true} and DO carries sync alone

# 3. browser
# open / → build → every commit races DO vs SpacetimeDB, badge shows winner
# open /viewer.html?g=<uuid> → fullscreen read-only, follows live
```

Local equivalent: `bash start.sh edge` (Worker + local D1 + DO with `--local`),
or `bash start.sh` (Python twin, same race UI, Spacetime skipped until configured).
