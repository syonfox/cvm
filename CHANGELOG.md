# Changelog

## Unreleased — pre-cat snapshot (2026-10-28)

Baseline commit of all work in the tree before the cat/button/intro overhaul.
The cat overhaul lands in a **separate commit** (`cat: …`) so it can be
reverted on its own (`git revert <that commit>`) without touching this work.

### Added
- `pwa/` — the app moves under `pwa/`: `index.html` (editor), `viewer.html`
  (read-only fullscreen viewer), `0shot.html`, `icon.svg`, `manifest.txt`,
  `styles.txt` (master stylesheet), `sync-client.txt` (`CVMSync` race client).
- Dual sync: Cloudflare Durable Object (`workers/src/sync.js`, `GraphSync`
  per-graph room) races SpacetimeDB; UI reports the winner. Local Python twin
  in `backend/server.py` (`/api/sync/*`) mirrors the same shapes.
- `deploy.sh`; SpacetimeDB package scaffolding (`spacetimedb/package.json`,
  `tsconfig.json`, lockfile); module moved `spacetimedb/schema.ts` →
  `spacetimedb/src/index.ts`.
- README: vision/deploy docs for the two-server sync + viewer.

### Changed
- `backend/server.py`, `workers/src/worker.js`, `workers/schema.sql`,
  `workers/wrangler.toml`, `start.sh`, `.env.example`,
  `workers/.dev.vars.example`, `.gitignore` — sync endpoints, env vars,
  local/edge startup wiring.

### Removed
- Root-level `index.html`, `0shot.html`, `icon.svg` (superseded by `pwa/`).

## Cat overhaul (separate commit, revertible)

- Low-poly arcade cat: faceted silver/bronze re-skin, segmented tail, ear
  twitches, paw tap, forehead gem pulse, squash-and-stretch idle/thinking.
  Public API unchanged (`window.catPal`, `#catMouth`, `#tailG`, `.eye`, states).
- Buttons: global `.secondary` base style (bare uses were unstyled), fixed
  `#nodePageTabs` being forced circular, defined `.arcade-mini`.
- Intro tour: tooltip + backdrop darkened to smoky silver/bronze.


## Structured ingest + cat retune (2026-10-28)

- Cat: no emerald on the head (titanium stud, pink friendly mouth), finer
  facet cuts + larger display size, black/grey palette, bronze → titanium
  everywhere (cat + intro tour).
- Modes are explicit on the main toolbar: **Unstructured** / **Structured**.
- Structured flow: 1 define fields array → 2 AI find-or-create table
  (`POST /api/tables`) → 3 insert rows (`/api/tables/rows`, single object,
  whole graph, or auto on Build) → 4 sort + render (`GET /api/tables`).
  Tables are stored definitions + JSON rows: SQLite (backend), D1 (worker),
  `table_def`/`table_row` in SpacetimeDB — real SpacetimeDB schemas are
  compile-time, so user tables cannot be literal new SpacetimeDB tables.

## Cat styling + structured guidance (2026-10-28)

- Cat: smaller tucked ears, tiny swaying hair tuft, knit sweater (ribbed
  collar, titanium stripes, stitch lines) instead of the chest plate.
- Mouse: faceted body/belly/feet, twitching ears, sniffing nose, cheese wedge.
- Structured panel now guides: "what the AI needs first" box, required
  one-row description (feeds AI field prediction), Fill-an-example button,
  live field chips, step indicators that light up, steps 3-4 disabled
  until a table exists, sort dropdown rebuilt from real table fields,
  renaming the table re-arms step 2. `/build` receives the description too.

## Repo cleanup: one entry point + Node migration analysis (2026-10-28)

- `./cvm` is now THE entry point (setup/dev/py/check/deploy/stop/status/logs);
  `start.sh`/`deploy.sh` are back-compat shims, `kill_ports.sh` removed
  (folded into `./cvm stop`). Recommended env: Debian 13, Node 20+.
- README rewritten human-first (5-minute quickstart, runtime choice table);
  detail moved to `docs/` (architecture, deploy, selfhosting, spacetimedb);
  stale `GETTING_STARTED.md` merged into README and deleted.
- `docs/migration-node.md`: measured Python→Node/Cloudflare analysis —
  Worker already serves 39/41 routes; Python-only = /exec sandbox + SMTP,
  both extractable to a small HTTP tool sidecar Node calls. Plan + risks.
- Fixed `Dockerfile` (broken since the pwa/ move) and stale doc references.
