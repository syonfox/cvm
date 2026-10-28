# Migration analysis: Python → Node / Cloudflare (one codespace)

Verdict up front: **migrate. It is ~90% done already.** The Worker is not a
port-in-progress — it is a near-superset of the Python backend today. Python
should shrink to one optional job: running code (`/exec`) and sending mail,
both callable from Node over HTTP when self-hosting.

## 1. What exists today (measured, not assumed)

| | Python `backend/` | Node `workers/src/` |
|---|---|---|
| Size | server.py 1242 + meta_ai.py 579 + memcache.py 138 lines | worker.js 798 + agent.js 376 + sync.js 85 lines |
| Routes | 34 (`/build /zero /exec /api/tables …`) | 41 — every Python route except below, plus the Durable Object WebSocket sync Python cannot do (stdlib has no WS upgrade) |
| Agent loop | `meta_ai.agent_zero/recommend/improve/duel` | `agent.js` — same prompts, same tool loop, fetch-native |
| Store | SQLite `cvm.db` + 1 GB in-process LRU | D1 + per-isolate L1 Map (same cache semantics) |
| Frontend | serves `pwa/` | serves the same `pwa/` (bundled as Text rules) |

Route parity: `./cvm check` prints both counts. The frontend already treats
both identically (`BACKEND = window.location.origin`, 31 call sites), so
users cannot tell which runtime served them — that is what makes this cheap.

## 2. The only Python-only capabilities

| Capability | Why it is Python-only | Node plan |
|---|---|---|
| `/exec` (run user code) | Workers have **no subprocess** — hard platform limit, not a porting gap | Keep a small Python (or any-language) **tool sidecar** on the Debian host; Worker calls `POST $EXEC_URL/exec` when configured, else `/exec` stays disabled as it is on Cloudflare today |
| Feature-request SMTP email | `smtplib` | Any transactional mail HTTP API (fetch) — or let the sidecar keep doing it |
| `memcache.py` 1 GB LRU | process-local | Already replaced: isolate Map + D1 `concept_cache`; Cloudflare Cache API if cross-isolate L1 is ever needed |
| `storage_demo.py`, `osint.db` | demo / legacy data | archive or delete; `cvm.db` exports via `/api/export/offline` (already in both runtimes) |

SpacetimeDB is unaffected: both runtimes already call it over HTTP
(`backend/spacetime_sync.py` ↔ Worker `fetch`), and it stays sync server #2.

## 3. Target shape (one codespace)

```
pwa/            frontend (unchanged, shared)
workers/        THE backend — dev (wrangler dev), prod (wrangler deploy), same code
spacetimedb/    sync #2 (unchanged)
tools/          optional Python sidecar: POST /exec, POST /mail  (Debian host only)
  server.py       ~150 lines, stdlib, no graph logic at all
backend/        deleted after step 4 below (git history keeps it)
```

"Node can call Python tools" is exactly the sidecar row: the Worker never
shells out (it can't), it makes one authenticated HTTP call to a box you
control. On pure Cloudflare deploys there is no sidecar and `/exec` simply
reports disabled — today's behaviour.

## 4. Migration steps (each independently shippable)

1. **Declare Node primary** (done in this cleanup): `./cvm dev` is the
   default, README recommends it, Python is labelled legacy.
2. **Close the small gaps in the Worker**: `/search` and `/graphs`
   convenience routes (trivial D1 queries), SMTP → mail-API fetch behind
   `MAIL_API_URL` env. Half a day.
3. **Extract the sidecar**: move `run_exec`/`_run_exec_sandbox` +
   `send_feature_email` from `server.py` into `tools/server.py` with the
   same JSON shapes; add `EXEC_URL`/`MAIL_URL` forwarding in `worker.js`.
   Half a day.
4. **Retire `backend/`**: after one release with no `./cvm py` bug reports,
   delete `server.py`/`meta_ai.py`/`memcache.py` (or tag-archive them).
   Update `Dockerfile`/`cvm.service` to run the sidecar only.
5. **Tests**: add a route-parity smoke script that boots `wrangler dev`
   and the sidecar and diffs `/health /build /api/tables` responses —
   `./cvm check` is the hook it hangs off.

## 5. Risks / honest constraints

- **Workers CPU/time limits**: the agent loop already runs there; very long
  `/zero` sessions are the thing to watch (25s budget is already enforced).
- **D1**: single-writer, ~10 GB — fine for this app's JSON-row workload;
  SpacetimeDB remains the scale-out story (see spacetimedb.md).
- **No local filesystem on Workers**: anything reading `.env`/disk must go
  through env vars / D1 / the sidecar. Already true in the current Worker.
- **Debian 13 remains the recommended host** for the sidecar + local dev;
  production needs no host at all (Cloudflare edge).

## 6. Recommendation

Do steps 1–3, live on Node-only for the graph product, keep the Python
sidecar only where code execution or self-hosted mail matters. One
codespace (`workers/` + `pwa/`), one entry point (`./cvm`), Python as a
tool — not a second backend to keep in parity forever.
