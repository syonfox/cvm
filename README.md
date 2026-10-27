# OSINT Graph (threatpath)

Single-input OSINT graph viewer + secret `0shot` eval page, with a Python stdlib backend.

## Components

| Component | File | Role |
|---|---|---|
| **Graph viewer** | `index.html` | Cytoscape canvas. Force/Tree/Grid switcher, run-once `cose` layout (no perpetual sim) + one-shot boids `settle` (separation/cohesion/alignment, easeOutBack). Right-click node menu (Ask 0shot / path / CRUD), additive multi-select, path-pick (click A→B or ⚓ anchor), per-path relation labeling, undo/redo (cap 60, `Ctrl+←/→`, `Ctrl+Z/Y`), zoom/fit/big-view, JSON export/import, AI log. |
| **0shot eval page** | `0shot.html` | Secret tool-calling eval UI. `?q=` input, 28s budget, md/html/plain auto-render, Continue/resume, freemap `lit` + local-time context, `GRAPH_CTX` hook, Answer vs Graph-edits mode, `Ctrl+0` handoff, append-back + apply-ops to graph. |
| **Backend** | `backend/server.py` | stdlib HTTP. Routes: `/build`, `/recommend`, `/improve`, `/zero` (agent, 28s / 6 fresh + 8 resume turns, forced final no-tools pass), `/exec`, `/mem`, `/health`, `/info`, `/api/agent-manifest`. |
| **Agent** | `backend/meta_ai.py` | `agent_zero` (plain-language answers, `format=json` instruction, history resume). `web_search` = DDG instant API with `html.duckduckgo.com` scrape fallback. |
| **Cache L1** | `backend/memcache.py` | 1GB in-memory LRU, TTL, `compact`/`snapshot`/`restore`/`stats`, background compactor, `POST /mem`. Fronts cache reads; L2 is sqlite today, SpacetimeDB next. |
| **Store (today)** | `backend/osint.db` (sqlite) | `entities`, `relations`, `graphs`, `concept_cache`, `users`, `prompts`. Cold backup after migration. |
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

- `spacetime.json` = host config (`database: osintdb`, `server: maincloud`, local override).
- `spacetimedb/schema.ts` = module tables (mirrors `SPACETIMEDB_MIGRATION.md` §2).
- `backend/spacetime_sync.py` = dual-write/backfill/proxy helpers (sqlite → reducers).
- Steps: `spacetime publish` → dual-write → backfill (~500/batch) → cut reads → scheduled `compact_cache` → retire sqlite writes.

## Run

```bash
./start.sh            # backend :3333 + frontend
curl localhost:3333/health
```

See `GETTING_STARTED.md` (product tour) and `SPACETIMEDB_MIGRATION.md` (migration detail).
