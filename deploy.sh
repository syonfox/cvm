#!/usr/bin/env bash
# Back-compat shim — the real entry point is ./cvm deploy (see README.md).
cd "$(dirname "$0")"
exec ./cvm deploy
