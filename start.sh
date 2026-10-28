#!/bin/bash
cd "$(dirname "$0")"
PORT="${PORT:-3334}"
PIDFILE="/tmp/opencode/cvm.pid"
LOG="/tmp/opencode/cvm.log"

cmd="${1:-start}"
case "$cmd" in
  start)
    if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      echo "Already running (pid $(cat "$PIDFILE"))"; exit 0
    fi
    nohup python3 backend/server.py > /tmp/opencode/cvm.log 2>&1 &
    echo $! > "$PIDFILE"
    echo "Backend started on http://localhost:$PORT (pid $!)"
    echo "Spot-check logs: tail -50 $LOG"
    ;;
  stop)
    if [ -f "$PIDFILE" ]; then
      kill "$(cat "$PIDFILE")" 2>/dev/null && echo "Stopped" || echo "Not running"
      rm -f "$PIDFILE"
    else
      echo "No pid file"
    fi
    ;;
  restart)
    bash "$0" stop; sleep 1; bash "$0" start
    ;;
  logs)
    tail -n "${2:-50}" "$LOG"
    ;;
  status)
    if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      echo "Running (pid $(cat "$PIDFILE")) on port $PORT"
      curl -s http://localhost:$PORT/health; echo
    else
      echo "Not running"
    fi
    ;;
  *)
    echo "Usage: $0 {start|stop|restart|status|logs [n]}"; exit 1
    ;;
esac