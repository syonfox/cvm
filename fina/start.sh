#!/usr/bin/env bash
# FINA console lifecycle. Usage: bash start.sh [start|stop|restart|status|logs]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

PID_DIR="$ROOT/.run"; PID_FILE="$PID_DIR/server.pid"; LOG_FILE="$PID_DIR/server.log"
PORT="${PORT:-8443}"
mkdir -p "$PID_DIR"

if [ ! -f "$ROOT/.env" ]; then
  echo "missing .env — copy .env.example to .env and set AUTH_TOKEN first."
  exit 1
fi

cmd="${1:-start}"
case "$cmd" in
  start)
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      echo "already running (pid $(cat "$PID_FILE"))"; exit 0
    fi
    if [ ! -f "$ROOT/certs/key.pem" ]; then bash "$ROOT/scripts/gen-certs.sh"; fi
    npm run build >/dev/null
    set -a; source "$ROOT/.env"; set +a
    PORT="$PORT" nohup node dist/main.js >"$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"
    for _ in $(seq 1 40); do
      if curl -sk "https://localhost:$PORT/health" 2>/dev/null | grep -q '^ok$'; then
        echo "started (pid $(cat "$PID_FILE")) on https://localhost:$PORT/"
        exit 0
      fi
      if ! kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
        echo "server exited. log:"; tail -30 "$LOG_FILE"; rm -f "$PID_FILE"; exit 1
      fi
      sleep 0.25
    done
    echo "timed out waiting for health. log:"; tail -30 "$LOG_FILE"; exit 1
    ;;
  stop)
    if [ -f "$PID_FILE" ]; then
      kill "$(cat "$PID_FILE")" 2>/dev/null && echo stopped || echo "not running"
      rm -f "$PID_FILE"
    else echo "no pid file"; fi
    ;;
  restart) bash "$0" stop; sleep 1; bash "$0" start ;;
  status)
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      echo "running (pid $(cat "$PID_FILE"))"; curl -sk "https://localhost:$PORT/health"; echo
    else echo "not running"; fi
    ;;
  logs) tail -n "${2:-50}" "$LOG_FILE" ;;
  *) echo "usage: $0 {start|stop|restart|status|logs}"; exit 1 ;;
esac
