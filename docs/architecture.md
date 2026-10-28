# Architecture (detail moved from the README)

## Components

| Component | File | Role |
|---|---|---|
| Graph viewer | `pwa/index.html` | Cytoscape canvas; Force/Tree/Grid switch, run-once `cose` layout + one-shot boids settle, right-click node menu, path-pick, undo/redo (cap 60), JSON export/import, structured ingest panel, cat familiar |
| 0shot eval | `pwa/0shot.html` | Tool-calling agent UI: `?q=` input, ~28s budget, Answer vs Graph-edits modes, apply-ops back to the graph |
| Viewer | `pwa/viewer.html` | Fullscreen read-only graph: zoom/fit/layout/follow-live, `?g=<uuid>` |
| Backend (primary) | `workers/src/worker.js` + `agent.js` | All API routes, AI agent loop, D1 store |
| Backend (legacy) | `backend/server.py` + `meta_ai.py` | Same routes on Python stdlib; kept for `/exec` + SMTP — see migration-node.md |
| Sync client | `pwa/sync-client.txt` (`window.CVMSync`) | Races both sync servers per commit, reports the winner, WS subscribe with 3s poll fallback |

## Two redundant sync servers

Every graph edit races down two independent paths and the UI shows which
acked first — no single box to trust, and you can see the redundancy work.

```
                        ┌── #1 Cloudflare Durable Object (GraphSync, per-graph room)
editor (index.html) ────┤    WS fan-out + HTTP publish, latest snapshot in DO storage
commit / share / Race   └── #2 SpacetimeDB (durable module tables, best-effort proxy)
        │ shows winner: "sync race: DO won · 42ms vs spacetime 180ms"
        ▼
viewer (viewer.html) — read-only; subscribes to the DO over WS,
falls back to polling /api/sync/state
```

- SpacetimeDB answers an honest `{skipped:true}` when `SPACETIME_HOST` is
  unset — the race never shows a false win.
- The editor's Layers rail has a `sync host:` override (persisted
  `osint_sync_host`, passed to the viewer as `?sync=`) for LAN testing.

## Layout tuning (smooth default)

- Defaults `BEST = { rep:22000, len:170, sep:190, grav:0.22 }` (persisted
  `osint_phys`, sliders in the ⚙ panel).
- `cose`: single run, `numIter` scales down with graph size, then `fit`.
- Boids settle: gentler weights, damping 0.86, more iterations for small
  graphs → evenly spaced, no bunching, no drift-off.
- Node size scales with degree; >400 nodes fall back to grid.
