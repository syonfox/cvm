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

