#!/usr/bin/env bash
for p in 3333 3334 3335; do
  fuser -k ${p}/tcp 2>/dev/null
done
pkill -f 'backend/server.py' 2>/dev/null
echo "killed"