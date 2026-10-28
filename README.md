# CVM — Cache Variable Memory

Ask one question → an AI builds a relational graph you can explore, enrich, and share.
Two ingest modes (Unstructured free-text / Structured tables), two redundant sync
servers, and a read-only viewer. Live demo: https://threatpath.sgol.workers.dev

## Run it (Debian 13 recommended)

```bash
./cvm setup    # check toolchain (Node 20+, Python 3.13), create .env, local D1
./cvm dev      # Node/Cloudflare Worker locally — the recommended runtime
# open http://localhost:8787
./cvm check    # syntax-check everything
./cvm deploy   # ship it (SpacetimeDB module + Cloudflare Worker)
```

That is the whole surface. `./cvm` is the only script you need; `start.sh` and
`deploy.sh` are back-compat shims that delegate to it.

**Environment:** Debian 13 (trixie) · Node 20+ with `wrangler`
(`npm i -g wrangler`) · Python 3.13 only if you use the legacy backend.
Put your AI key in `.env` (copy of `.env.example`); it works without one,
falling back to heuristic extraction.

## Which runtime?

| | `./cvm dev` / production Worker | `./cvm py` (legacy) |
|---|---|---|
| Code | `workers/src/*.js` — **the one codebase going forward** | `backend/*.py` |
| Use it for | everything: graph build, structured ingest, sync, viewer | `/exec` code sandbox (Docker) + SMTP feature emails |
| Data | Cloudflare D1 + Durable Objects | local SQLite (`backend/cvm.db`) |

Recommendation: run Node everywhere; keep Python only as an optional
tool sidecar the Worker can call over HTTP for `/exec`. Full analysis,
route-parity table, and migration plan: [docs/migration-node.md](docs/migration-node.md).

## What you can do

1. **Build** — type anything in Unstructured mode; AI maps entities + relations.
2. **Structured ingest** — switch to Structured (toolbar): describe one row →
   AI finds/creates a table → entities insert as rows → sort + render.
3. **Enrich** — right-click nodes, AI Improve, node pages + chat, 0shot agent (`/0shot.html`).
4. **Share** — every commit races two sync servers (Durable Object vs
   SpacetimeDB); open `/viewer.html?g=<uuid>` for a fullscreen read-only view.

Smoke test:

```bash
curl localhost:8787/health
curl -X POST localhost:8787/build -H 'Content-Type: application/json' \
  -d '{"text":"Acme Corp CEO John Doe, IP 10.0.0.5"}'
```

## Layout (one codespace)

```
cvm               THE entry point (setup/dev/py/check/deploy)
pwa/              frontend — the same files both runtimes serve
workers/          Node/Cloudflare backend  ← primary codebase
  src/worker.js     API routes        src/agent.js   AI agent loop
  src/sync.js       Durable Object sync server #1     schema.sql  D1 schema
spacetimedb/      sync server #2 (durable module tables + reducers)
backend/          legacy Python twin (kept for /exec + SMTP; see migration doc)
docs/             deploy.md · selfhosting.md · spacetimedb.md · migration-node.md
```

## Docs

- [docs/migration-node.md](docs/migration-node.md) — Python → Node/Cloudflare analysis + plan
- [docs/deploy.md](docs/deploy.md) — production deploy (Cloudflare-first)
- [docs/selfhosting.md](docs/selfhosting.md) — Debian self-host, exec sandbox, offline snapshots
- [docs/spacetimedb.md](docs/spacetimedb.md) — sync server #2 data plan
- [docs/architecture.md](docs/architecture.md) — components, sync race, layout tuning
- [CHANGELOG.md](CHANGELOG.md) — what changed, per commit
