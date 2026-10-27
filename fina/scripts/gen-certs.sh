#!/usr/bin/env bash
# Generate a local dev TLS certificate (openssl). Production: use real certs.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$ROOT/certs"
if [ -f "$ROOT/certs/key.pem" ] && [ -f "$ROOT/certs/cert.pem" ]; then
  echo "certs exist; skipping."
  exit 0
fi
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$ROOT/certs/key.pem" -out "$ROOT/certs/cert.pem" \
  -days 825 -subj "/CN=localhost" 2>/dev/null
chmod 600 "$ROOT/certs/key.pem"
echo "wrote certs/key.pem + certs/cert.pem"
