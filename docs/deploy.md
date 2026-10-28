# Production deploy

## Recommended: full Cloudflare Workers (`workers/`)

One project serves everything — static frontend bundled in, API in the Worker,
D1 as the database. No single box to fall over: Cloudflare runs it at the edge.
This is the best uptime-per-effort option.

What changes vs the VPS build:
- `backend/server.py` → `workers/src/worker.js` (same routes, same JSON shapes — see migration-node.md).
- `backend/meta_ai.py` → `workers/src/agent.js` (same prompts/tool loop, fetch-native).
- sqlite → D1 (`workers/schema.sql`); memcache L1 → per-isolate Map + D1.
- `/exec` is **disabled** (Workers have no subprocess) — the toggle just no-ops.
  Everything else (`/build /recommend /improve /duel /investigate /zero`,
  node pages + chat, export/import) works as before.

```bash
npm i -g wrangler
cd workers
# local edge runtime (same code as prod, D1 local, secrets from .dev.vars):
#   ./cvm setup   # then: ./cvm dev
# or directly: wrangler dev --ip 0.0.0.0   # [dev] ip/port already set in wrangler.toml
wrangler login                                   # opens dash.cloudflare.com — the dashboard
wrangler d1 create cvm                             # paste the database_id into wrangler.toml
wrangler d1 execute cvm --remote --file schema.sql
wrangler secret put MODEL_API_KEY               # AI key (never in code)
# optional: wrangler secret put AUTH_TOKEN       # login gate, like .env
wrangler deploy                                  # → https://cvm.<you>.workers.dev
```

Custom domain: Workers & Pages → your worker → Settings → Domains & Routes →
Add Custom Domain (`graph.<domain>`). Free SSL, done.

Dashboards for the demo link:
- **App + Worker logs/observability**: Cloudflare dashboard → Workers & Pages →
  `cvm` (traffic, errors, realtime logs).
- **Database dashboard**: dashboard → Storage & Databases → D1 → `cvm`
  (browse every table live: entities, graphs, node_pages, node_chat...).
- Share the `*.workers.dev` URL (or custom domain) — that's the demo link.

## Alternatives

Three hosts, three jobs. Be honest about what each one can do:

| Host | Serves frontend? | Runs Python backend? | Holds data? |
|---|---|---|---|
| VPS (this repo as-is) | yes | yes | sqlite today |
| Cloudflare | yes (Pages / Tunnel) | no (Workers can't run this stdlib server) | no |
| SpacetimeDB Cloud | no (no static hosting, no outbound HTTP from reducers) | partial (reducers only) | yes (source of truth) |

The production shape is: **VPS runs the app, Cloudflare fronts it (DNS + Tunnel or proxy), SpacetimeDB Cloud holds the data.** A "pure SpacetimeDB" deploy is not possible for this app — reducers can't make outbound HTTPS calls, so the AI/tool loop (`meta_ai.py`) and the static HTML have to live elsewhere. Closest to pure: data-plane on SpacetimeDB + static frontend on Cloudflare Pages + this backend as a small API box.

## A. VPS (systemd + Caddy, automatic HTTPS)

```bash
# on the VPS
sudo apt install python3 caddy
git clone <repo> /opt/cvm && cd /opt/cvm
cp .env.example .env && nano .env   # MODEL_API_KEY, AUTH_TOKEN, PORT
sudo cp cvm.service /etc/systemd/system/
sudo systemctl enable --now cvm
# DNS: point A record at VPS, then
DOMAIN=graph.example.com caddy run --config Caddyfile
```

Health: `curl https://graph.example.com/health` → `{"status":"ok"}`.

Or Docker: `docker build -t cvm . && docker run -p 3334:3334 --env-file .env cvm`.

## B. Cloudflare in front (pick one)

**Option 1 — proxied DNS (simplest).** DNS A record → VPS IP, orange-cloud on,
SSL mode "Full (strict)". Caddy still terminates with its own cert. 5-minute setup.

**Option 2 — Tunnel (no open ports).** On the VPS:
`cloudflared tunnel login && cloudflared tunnel create cvm`,
route DNS to it, then run `cloudflared tunnel run --url http://localhost:3334 cvm`.
Firewall can drop 80/443 entirely. Best for a demo link you share.

**Option 3 — Pages for the static half.** `index.html` + `0shot.html` are static —
drag them into a Pages project. The pages call `BACKEND` from `/info`, so set the
API origin accordingly (hostMode WAN). Backend still needs a home (VPS/Railway).
Only worth it if the VPS is slow to serve — usually skip.

## C. SpacetimeDB data plane + dashboards

```bash
spacetime login            # CLI prints your Cloud console URL — that's the dashboard
spacetime publish --project-path ./spacetimedb -s maincloud osintdb
spacetime sql osintdb "SELECT * FROM node_page LIMIT 5"   # verify pages land
```

Tables after this change: `entity`, `relation`, `snapshot_chunk`, `kv_cache`,
`node_page`, `node_chat` (see `spacetimedb/schema.ts`). The backend dual-writes
`node_pages`/`node_chat` best-effort — sqlite stays source of truth until you cut
reads over (`SPACETIMEDB_MIGRATION.md` §3).

Dashboard links to hand out for the demo:
- **App**: `https://<your-domain>/` (graph) — via A or B above.
- **DB console**: the Cloud console URL from `spacetime login` (shows databases,
  tables, live rows). There is no fixed public URL per database — access is tied
  to your SpacetimeDB Cloud identity, so share a screenshot or add viewers as
  collaborators rather than a link.
- **Cloudflare**: one-click "share Tunnel URL" exists only for quick tunnels
  (`cloudflared tunnel --url ...` prints a `*.trycloudflare.com` link, great for
  a throwaway demo, dies with the process).

## Suggested demo rollout (tonight, ~20 min)

1. VPS: systemd + Caddy (A) → `https://graph.<domain>` live.
2. `spacetime publish` (C) → tables live, dashboard visible in Cloud console.
3. Share two things: the app link + a screenshot/recording of the Cloud console
   rows (or collaborator access). Quick-tunnel link if you need something in 60s.
