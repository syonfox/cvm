#!/usr/bin/env bash
# Back-compat shim — the real entry point is ./cvm (see README.md).
cd "$(dirname "$0")"
case "${1:-}" in
  edge|dev|worker) exec ./cvm dev ;;
  start|"")        exec ./cvm py ;;
  *)               exec ./cvm "$@" ;;
esac
