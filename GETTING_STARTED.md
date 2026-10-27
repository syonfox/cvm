# OSINT Graph Network — Getting Started

## What it is
A single-input OSINT tool. You type a question or paste an arbitrary object/entity/claim.
The backend (Meta Llama + SQLite DB similarity + adversarial red-team) builds a relational
graph rendered with Cytoscape. Host choice (Local / LAN / WAN) is selectable in the UI.

## Files
- `index.html` — frontend (React + Cytoscape via CDN)
- `backend/server.py` — HTTP backend (stdlib, no pip needed)
- `.env` — Meta API key + config
- `GETTING_STARTED.md` — this file

## Prereqs
- Python 3.13 (Debian 13) — already present
- Port 3333 open (firewall/router) if using LAN/WAN
- (Optional) Meta/Llama API key already in `.env`

## Start
```bash
cd /home/user/cvm/third/threatpath-production.up.railway.app
python3 backend/server.py            # binds 0.0.0.0:3333
# in another shell:
python3 -m http.server 5173         # serve frontend
# open http://localhost:5173
```

## What to test (in order)
1. Health: `curl http://localhost:3333/health` → `{"status":"ok"}`.
2. Host info: `curl http://localhost:3333/info` → lan_ip, public_ip, port.
3. Build (no AI key needed for fallback): 
   `curl -X POST http://localhost:3333/build -H 'Content-Type: application/json' -d '{"text":"Acme Corp CEO John Doe email john@acme.com IP 10.0.0.5"}'`
   Expect nodes + edges + adversarial flags.
4. Ingest a known entity then rebuild to see DB similarity links:
   `curl -X POST http://localhost:3333/ingest -H 'Content-Type: application/json' -d '{"name":"acme.com","kind":"Domain","attrs":{"registrar":"X"}}'`
5. Frontend: type a free-text question, click "Build Network" (or Ctrl+Enter).
   - Switch host mode Local/LAN/WAN; selection persists.
   - Click nodes/edges in canvas; zoom/fit/reset work.
6. Adversarial: paste a text that repeats one entity many times → expect "high-degree hub" flag.

## Best next steps
1. Add persistent graph storage (FalkorDB/Neo4j) instead of SQLite for multi-hop traversal.
2. Add embedding-based similarity (sentence-transformers) instead of Jaccard.
3. Add a real adversarial LLM red-team pass (second model critiques the graph).
4. Add authentication + rate limiting before exposing WAN.
5. Export graph as JSON/CSV and PNG; add saved investigations.
6. Add streaming progress (SSE) for large builds.
7. Containerize (Docker) with the frontend served by the backend.
8. Add tests (pytest for backend, Playwright for frontend).