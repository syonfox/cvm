# Self-hosting plan: Debian exec sandbox + offline snapshots + SpacetimeDB at 800 GB+

This is the runbook for running CVM off Cloudflare: a Debian sandbox for
`/exec`, portable sqlite snapshots of any graph, and a self-hosted SpacetimeDB
instance sized for 800+ GB ("slowstation" archive box).

## 1. Exec sandbox (finalized: Debian container per snippet)

`EXEC_MODE=sandbox` (now the default) runs every snippet in a throwaway Docker
container built from `Dockerfile.sandbox` (`debian:stable-slim` + python3 +
nodejs, `USER nobody`).

```bash
# build once per host
docker build -f Dockerfile.sandbox -t cvm-sandbox:debian .

# .env
EXEC_ENABLED=1
EXEC_MODE=sandbox
SANDBOX_IMAGE=cvm-sandbox:debian
SANDBOX_TIMEOUT=30
SANDBOX_MEM=256m
SANDBOX_CPUS=0.5
SANDBOX_NET=none        # keep 'none'; only open if you mean it
```

Per-run hardening (see `_run_exec_sandbox` in `backend/server.py`): `--network
none`, `--memory/--cpus/--pids-limit 64`, `--read-only` + 64 MB `noexec`
tmpfs, `--cap-drop ALL`, `no-new-privileges`, `--user nobody`, code mounted
read-only at `/work/code`, container `--rm`'d after each run. Snippets are
capped at 8 KB in, `EXEC_MAX_OUT` bytes out.

Verify: `POST /exec {"lang":"python3","code":"print(1)"}` → `{"mode":"sandbox",…}`.
Without docker you get `sandbox unavailable: docker not found` (graceful, no
fallback to host exec). `local`/`ssh` modes remain for dev only.

## 2. Offline snapshots (graph as the user sees it, as a .db file)

`POST /api/export/offline {uuid?, doc?}` → downloads `graph-<id>-v<N>.db`.
Frontend: the **SQLite** button next to PNG/SVG exports the active tab's
*visible* layers. Server attaches living wiki pages + recent chat for every
visible concept. With no `uuid` it commits a v1 first, so every offline file
traces back to a versioned series.

Schema of the file (`build_offline_db`):

| table | contents |
|---|---|
| `meta` | app, exported-at, uuid, name, graph_version, message |
| `nodes` / `edges` / `flags` | exactly the visible view (id, label, kind, layer, attrs…) |
| `pages` | shared wiki page per visible concept (key, title, body, updated) |
| `chat` | recent thread per concept (last 200 msgs) |

Open with any sqlite browser; no server needed. This is the offline story:
JSON for interchange, `.db` for a self-contained archive.

## 3. Self-hosting the app (backend + sandbox)

```bash
# one box, docker compose (suggested compose file below)
cp .env.example .env   # MODEL_API_KEY, AUTH_TOKEN, EXEC_* as above
docker build -f Dockerfile.sandbox -t cvm-sandbox:debian .
docker compose up -d --build
```

Minimal `compose.yml` (plan — adapt paths):

```yaml
services:
  app:
    build: .
    env_file: .env
    ports: ["127.0.0.1:3334:3334"]
    volumes:
      - ./data:/app/data        # mount DB out of the container; set DB path via env if moved
      - /var/run/docker.sock:/var/run/docker.sock  # ONLY so the app can spawn sandbox siblings
    restart: unless-stopped
```

Notes:
- Mounting the docker socket is the one sharp edge: it lets the app spawn
  *only* the pinned sandbox image (see `SANDBOX_IMAGE`; runs are `--rm`,
  resourceless after exit). Alternative without socket-mount: run snippets over
  `EXEC_MODE=ssh` to a locked-down sibling container. Never `local` in prod.
- Or keep the current `cvm.service` (systemd) + system docker; same env.
- Put Cloudflare in front: proxied DNS (5 min) or `cloudflared` Tunnel (no
  open ports) — see `DEPLOY.md` §B. Tunnel is the recommended demo link.

## 4. SpacetimeDB self-hosted for 800+ GB (slowstation archive box)

Goal: one box holding the full history (node pages/chat, graph versions)
with headroom past 800 GB. SpacetimeDB standalone keeps everything under its
data dir (snapshots + commit log), so capacity planning = disk planning.

- **Disk**: 2 TB usable minimum for an 800 GB dataset (live data + snapshot
  copies + WAL during compaction + restore scratch). Prefer 2× disks in
  mirror (or RAID6 for 4+ disks) — a resilver at these sizes takes days, so
  mirror + hot spare beats parity on a single box.
- **Layout**: OS + SpacetimeDB binary on small SSD; `--data-dir` on the big
  volume (XFS/ext4, `noatime`). Keep 20% free: compaction stalls on full disks.
- **Run** (standalone, behind localhost; Cloudflare Tunnel for remote):
  `spacetime start --listen-addr 127.0.0.1:3000 --data-dir /mnt/slowstation/spacetime`
  (pin the version; check `spacetime --version` against `spacetimedb/schema.ts`
  compatibility before upgrading).
- **Retention is the capacity control**: the app already ages out history —
  `PAGE_HISTORY_DAYS=365`, `GRAPH_HISTORY_DAYS=1095` (0 = keep forever).
  Size the box from *retained* data, not raw ingest: e.g. 2 GB/day retained
  × 1095 days ≈ 2.2 TB → next disk tier.
- **Backups**: nightly `spacetime` snapshot + `rsync --inplace` of the data
  dir to a second box (or `rclone` to R2/S3); test-restore quarterly by
  replaying the log dir on a scratch box. sqlite sidecars (`cvm.db`,
  offline `.db` files) back up with plain file copy (WAL mode: copy db +
  `-wal` together, or `.backup` first).
- **Migrate cloud → self-host**: `spacetime publish` the same
  `./spacetimedb` project against the local server, then flip the backend's
  `SPACETIME_HOST` to it; dual-write (`spacetime_sync`) keeps both copies
  live during cutover. Dashboard becomes your own console URL, not Cloud's.
- **Monitoring**: alert at 70/85% disk; graph `graph_versions` row counts and
  `LENGTH(doc)` sums weekly (same query as the History panel) to forecast
  growth against retention settings.

## 5. Where Cloudflare still fits

- Workers = edge API + D1 when you want zero boxes; `/exec` is disabled
  there (no subprocess) — point exec-capable clients at the sandbox backend.
- Pages/Tunnel in front of the self-hosted box for TLS + share links.
- D1 and self-hosted SpacetimeDB are interchangeable stores behind the same
  routes (`workers/schema.sql` mirrors `backend/server.py`); pick one source
  of truth per deployment.

## Appendix: env vars introduced

| var | default | meaning |
|---|---|---|
| `EXEC_MODE` | `sandbox` | `sandbox` (Debian docker) / `local` / `ssh` |
| `SANDBOX_IMAGE` | `cvm-sandbox:debian` | pinned sandbox image |
| `SANDBOX_TIMEOUT/MEM/CPUS/NET` | `30`/`256m`/`0.5`/`none` | per-run caps |
| `PAGE_HISTORY_DAYS` | `365` | living-page version retention |
| `GRAPH_HISTORY_DAYS` | `1095` | graph snapshot retention |
