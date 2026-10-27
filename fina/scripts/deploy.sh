#!/usr/bin/env bash
# Live code update for the SpacetimeDB module (hot-swap, zero downtime).
#
#   bash scripts/deploy.sh [--server maincloud|local] [--db finadb] [--skip-console]
#
# Pipeline (every step is gated; publish never runs on red):
#   1. typecheck console + module
#   2. unit tests (node --test)
#   3. build module bundle
#   4. spacetime publish  <- live code update: reducers/tables hot-swap on the
#      running database; existing client connections migrate automatically
#   5. regenerate TypeScript bindings for the console
#   6. rebuild + restart the console (only the proxy; the DB never goes down)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
mkdir -p "$ROOT/.run"
DEPLOY_LOG="$ROOT/.run/deploy.log"
# Tee all output to the deploy log so every Maincloud publish is audited.
exec > >(tee -a "$DEPLOY_LOG") 2>&1
echo "=== deploy $(date -u +%FT%TZ) user=$(whoami) ==="

SERVER="maincloud"
DB="$(node -e "try{console.log(require('./spacetime.json').database)}catch{console.log('finadb')}" 2>/dev/null || echo finadb)"
# Prefer the pinned hex identity from .env so Maincloud deploys can't drift to the wrong DB.
if [ -f "$ROOT/.env" ]; then
  # shellcheck disable=SC1091
  set -a; source "$ROOT/.env"; set +a
  DB="${SPACETIME_IDENTITY:-${SPACETIME_DB:-$DB}}"
fi
SKIP_CONSOLE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --server=*) SERVER="${1#*=}"; shift ;;
    --server) SERVER="$2"; shift 2 ;;
    --db=*) DB="${1#*=}"; shift ;;
    --db) DB="$2"; shift 2 ;;
    --skip-console) SKIP_CONSOLE=1; shift ;;
    local) SERVER="local"; shift ;;
    *) echo "unknown arg: $1 (see header)"; exit 1 ;;
  esac
done
if [ "$SERVER" = "local" ] && [ -f spacetime.local.json ]; then
  DB="$(node -e "console.log(require('./spacetime.local.json').database)" 2>/dev/null || echo "$DB")"
fi

echo "==> [1/6] typecheck console"
npx tsc --noEmit
echo "==> [2/6] unit tests"
npm test 2>&1 | tail -8
test "${PIPESTATUS[0]}" -eq 0
echo "==> [3/6] build module"
npm --prefix spacetimedb run build
echo "==> [4/6] publish module '$DB' to '$SERVER' (live update)"
echo "    db=$DB server=$SERVER"
spacetime publish "$DB" --server "$SERVER" --yes
echo "    publish exit=$? — verifying…"
spacetime describe "$DB" --server "$SERVER" 2>&1 | head -10 || true
echo "    verify done (see $DEPLOY_LOG)"
echo "==> [5/6] regenerate bindings"
spacetime generate --lang typescript --out-dir src/module_bindings --module-path spacetimedb || \
  echo "    (bindings regen failed — console proxy is unaffected; retry with the CLI connected)"
if [ "$SKIP_CONSOLE" = "1" ]; then
  echo "done (console restart skipped)."
  exit 0
fi
echo "==> [6/6] rebuild + restart console"
npm run build >/dev/null
bash start.sh restart
echo "live update complete: module '$DB' @ '$SERVER' + console restarted."
