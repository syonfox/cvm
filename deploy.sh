#!/bin/bash
# Deploy both backends + the Worker that serves the app.
#   1. SpacetimeDB module  -> osintdb (sync server #2, durable copy)
#   2. Cloudflare Worker   -> threatpath.sgol.workers.dev (app + API + sync #1 DO)
set -euo pipefail
cd "$(dirname "$0")"

LIVE_URL="https://threatpath.sgol.workers.dev"

echo "==> [1/2] publishing SpacetimeDB module (osintdb)…"
if command -v spacetime >/dev/null 2>&1; then
  spacetime publish -y=all || echo "(!) spacetime publish failed — continuing to Worker deploy"
else
  echo "(!) spacetime CLI not found — skipping module publish"
fi

echo "==> [2/2] deploying Cloudflare Worker…"
cd workers
wrangler deploy

echo
echo "done — live at $LIVE_URL"
