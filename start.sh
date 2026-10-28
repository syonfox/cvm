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
  edge|dev|worker)
    # Unified codebase, edge runtime locally: same Worker code + routes as prod,
    # D1 running locally, secrets from workers/.dev.vars (auto-loaded).
    # Binds 0.0.0.0 so LAN hosts can reach it, same as the linux server.
    # First run: generates workers/.dev.vars from repo-root .env.
    if [ ! -f workers/.dev.vars ]; then
      python3 - <<'EOF'
import os
env = {}
for f in (".env",):
    if os.path.exists(f):
        for line in open(f):
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env.setdefault(k.strip(), v.strip())
key = env.get("MODEL_API_KEY") or env.get("AI_API_KEY", "")
base = env.get("AI_BASE_URL", "")
if not base and env.get("AI_URL"):
    base = env["AI_URL"].replace("/chat/completions", "").rstrip("/")
base = base or "https://api.meta.ai/v1"
model = env.get("AI_MODEL", "muse-spark-1.3")
auth = env.get("AUTH_TOKEN", "")
os.makedirs("workers", exist_ok=True)
with open("workers/.dev.vars", "w") as f:
    f.write(f"MODEL_API_KEY={key}\nAI_BASE_URL={base}\nAI_MODEL={model}\nAUTH_TOKEN={auth}\n")
print("generated workers/.dev.vars from .env (edit it directly from here on)")
EOF
    fi
    cd workers && exec wrangler dev --ip 0.0.0.0
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
    echo "Usage: $0 {start|stop|restart|status|logs [n]|edge}  (edge = wrangler dev --ip 0.0.0.0)"; exit 1
    ;;
esac