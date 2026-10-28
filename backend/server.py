import json, sqlite3, urllib.request, os, http.server, socketserver, subprocess, time, hashlib
from urllib.parse import urlparse, parse_qs

_env_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), ".env")
if os.path.exists(_env_path):
    with open(_env_path) as _f:
        for _line in _f:
            _line=_line.strip()
            if not _line or _line.startswith("#") or "=" not in _line: continue
            k,v=_line.split("=",1)
            os.environ.setdefault(k.strip(), v.strip())

def _db_path():
    here = os.path.dirname(__file__)
    new = os.path.join(here, "cvm.db"); old = os.path.join(here, "osint.db")
    if not os.path.exists(new) and os.path.exists(old):
        try:
            import shutil as _sh; _sh.copyfile(old, new)
        except Exception: pass
    return new
DB = _db_path()
AI_URL = os.environ.get("AI_URL", "https://api.openai.com/v1/chat/completions")
AI_KEY = os.environ.get("MODEL_API_KEY", "") or os.environ.get("AI_API_KEY", "")
AI_MODEL = os.environ.get("AI_MODEL", "muse-spark-1.3")
AI_BASE = os.environ.get("AI_BASE_URL", "https://api.meta.ai/v1")
EXEC_TIMEOUT = int(os.environ.get("EXEC_TIMEOUT", "30"))
EXEC_MAX_OUT = int(os.environ.get("EXEC_MAX_OUT", "8000"))
# history retention (days; 0 = keep forever). Perpetual system: living pages
# turn over yearly, graph snapshots every 3 years by default.
PAGE_HISTORY_DAYS = int(os.environ.get("PAGE_HISTORY_DAYS", "365"))
GRAPH_HISTORY_DAYS = int(os.environ.get("GRAPH_HISTORY_DAYS", "1095"))
AUTH_TOKEN = os.environ.get("AUTH_TOKEN", "")  # set to require login token
try:
    from backend.meta_ai import agent_recommend, agent_investigate, agent_improve
    from backend import meta_ai as _ma
    AI_AGENT = True
except ImportError:
    try:
        from meta_ai import agent_recommend, agent_investigate, agent_improve
        import meta_ai as _ma
        AI_AGENT = True
    except ImportError:
        AI_AGENT = False; _ma = None
try:
    from backend.memcache import CACHE, _start_compactor
    _start_compactor()
    MEM = True
except ImportError:
    try:
        from memcache import CACHE, _start_compactor
        _start_compactor()
        MEM = True
    except ImportError:
        MEM = False; CACHE = None

def migrate_db(c):
    for tbl in ("entities", "relations"):
        try:
            cols = [r[1] for r in c.execute(f"PRAGMA table_info({tbl})").fetchall()]
            if "user" not in cols:
                c.execute(f"ALTER TABLE {tbl} ADD COLUMN user TEXT")
        except Exception:
            pass

def init_db():
    c = sqlite3.connect(DB)
    c.execute("""CREATE TABLE IF NOT EXISTS entities (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, kind TEXT, attrs TEXT, embedding TEXT, user TEXT)""")
    c.execute("""CREATE TABLE IF NOT EXISTS relations (id INTEGER PRIMARY KEY AUTOINCREMENT, src TEXT, dst TEXT, rel TEXT, score REAL, evidence TEXT, user TEXT)""")
    c.execute("""CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, ip TEXT, created REAL)""")
    c.execute("""CREATE TABLE IF NOT EXISTS graphs (id INTEGER PRIMARY KEY AUTOINCREMENT, user TEXT, text TEXT, nodes TEXT, edges TEXT, flags TEXT, created REAL)""")
    # git-like time series: every improvement commits a FULL document snapshot.
    # uuid = unguessable capability id (whoever knows it can read); version = monotonic commit number.
    c.execute("""CREATE TABLE IF NOT EXISTS graph_versions (uuid TEXT NOT NULL, version INTEGER NOT NULL, user TEXT, name TEXT, doc TEXT, message TEXT, created REAL, PRIMARY KEY (uuid, version))""")
    c.execute("""CREATE INDEX IF NOT EXISTS idx_graph_versions ON graph_versions(uuid, version)""")
    # living-page history: every page save appends a version (same git-like model as graphs)
    c.execute("""CREATE TABLE IF NOT EXISTS page_versions (node TEXT NOT NULL, user TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL, title TEXT, kind TEXT, body TEXT, message TEXT, created REAL, PRIMARY KEY (node, user, version))""")
    c.execute("""CREATE INDEX IF NOT EXISTS idx_page_versions ON page_versions(node, user, version)""")
    c.execute("""CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)""")
    c.execute("""CREATE TABLE IF NOT EXISTS concept_cache (key TEXT PRIMARY KEY, result TEXT, created REAL)""")
    c.execute("""CREATE TABLE IF NOT EXISTS prompts (name TEXT PRIMARY KEY, template TEXT, created REAL)""")
    c.execute("""CREATE TABLE IF NOT EXISTS node_pages (node TEXT NOT NULL, user TEXT NOT NULL DEFAULT '', title TEXT DEFAULT '', kind TEXT DEFAULT '', body TEXT DEFAULT '', updated REAL, PRIMARY KEY (node, user))""")
    c.execute("""CREATE TABLE IF NOT EXISTS node_msgs (id INTEGER PRIMARY KEY AUTOINCREMENT, node TEXT NOT NULL, user TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT 'user', text TEXT NOT NULL DEFAULT '', created REAL)""")
    c.execute("""CREATE INDEX IF NOT EXISTS idx_node_msgs ON node_msgs(node, user, id)""")
    # generic feature-request / vote forum: every unimplemented action funnels here
    c.execute("""CREATE TABLE IF NOT EXISTS feature_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, detail TEXT DEFAULT '', contact TEXT DEFAULT '', votes INTEGER NOT NULL DEFAULT 1, status TEXT DEFAULT 'open', created REAL)""")
    c.execute("""CREATE TABLE IF NOT EXISTS feature_votes (req_id INTEGER NOT NULL, voter TEXT NOT NULL, created REAL, PRIMARY KEY (req_id, voter))""")
    # structured ingest: user-defined tables. SpacetimeDB schemas are compile-time,
    # so a user table = a stored definition (user_tables) + JSON rows (table_rows);
    # mirrored to SpacetimeDB table_def/table_row when configured.
    c.execute("""CREATE TABLE IF NOT EXISTS user_tables (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, fields TEXT NOT NULL DEFAULT '[]', constraints_text TEXT DEFAULT '', user TEXT, created REAL, UNIQUE(name, user))""")
    c.execute("""CREATE TABLE IF NOT EXISTS table_rows (id INTEGER PRIMARY KEY AUTOINCREMENT, table_id INTEGER NOT NULL, row TEXT NOT NULL DEFAULT '{}', user TEXT, created REAL)""")
    c.execute("""CREATE INDEX IF NOT EXISTS idx_table_rows ON table_rows(table_id, id)""")
    # seed prompts
    seeds = {
     "entity_extract": "You are a CVM (Cache Variable Memory) graph builder. Given free-text input, extract a knowledge graph.\nReturn ONLY valid JSON with keys: nodes (list of {id,label,kind,attrs}) and edges (list of {source,target,rel,score}).\nkinds: Person, Organization, Domain, IP, Location, Event, Concept, Asset.\nInput: {text}",
     "concept_define": "Define the concept '{concept}' concisely. Return JSON: {\"name\":...,\"kind\":\"Concept\",\"attrs\":{\"definition\":...,\"aliases\":[],\"related\":[]}}.",
     "redteam": "Critique this graph for false correlations, single-source dominance, and contradictions. Return JSON list of {\"issue\":...}.",
      "improve": "You are a graph editor. Given the instruction, input text, and current graph JSON, propose improvements. Reply with ONLY a JSON array of ops. Shapes: {\"op\":\"delete_node\",\"id\":..} {\"op\":\"delete_edge\",\"source\":..,\"target\":..} {\"op\":\"add_node\",\"id\":..,\"label\":..,\"kind\":..} {\"op\":\"add_edge\",\"source\":..,\"target\":..,\"rel\":..} {\"op\":\"rename_node\",\"id\":..,\"label\":..} {\"op\":\"set_attr\",\"id\":..,\"key\":..,\"value\":..}. Instruction: {input} Graph: {graph}",
    }
    for n,t in seeds.items():
        c.execute("INSERT OR IGNORE INTO prompts(name,template,created) VALUES(?,?,?)",(n,t,time.time()))
    c.commit()
    try: migrate_db(c); c.commit()
    except Exception: pass
    c.close()
init_db()
try: prune_history(force=False)
except Exception: pass

def ai_chat(prompt):
    if not AI_KEY: return None
    data = {"model": AI_MODEL, "messages":[{"role":"user","content":prompt}], "temperature":0.2}
    req = urllib.request.Request(AI_URL, data=json.dumps(data).encode(), headers={"Content-Type":"application/json","Authorization":"Bearer "+AI_KEY})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            j = json.loads(r.read())
            return j["choices"][0]["message"]["content"]
    except Exception as e:
        return f"AI_ERROR: {e}"

def db_search(q, user=None):
    c = sqlite3.connect(DB)
    rows = c.execute("SELECT name,kind,attrs FROM entities WHERE (name LIKE ? OR attrs LIKE ?) AND (user IS NULL OR user=?)", (f"%{q}%", f"%{q}%", user)).fetchall()
    c.close()
    return [{"name":r[0],"kind":r[1],"attrs":json.loads(r[2])} for r in rows]

def similarity(a,b):
    sa=set(a.lower().split()); sb=set(b.lower().split())
    if not sa or not sb: return 0.0
    return len(sa & sb)/len(sa | sb)

def adversarial_check(nodes, edges):
    flags=[]
    from collections import Counter
    srcs=Counter(e["source"] for e in edges)
    for n,cc in srcs.items():
        if cc>5: flags.append({"node":n,"issue":"high-degree hub (possible false correlation)"})
    kinds=Counter(n["kind"] for n in nodes)
    if len(nodes)>0 and max(kinds.values())/len(nodes)>0.7:
        flags.append({"issue":"homogeneous node types (low diversity)"})
    return flags

def get_user(req_body, headers, client_ip):
    # self-selected username takes precedence
    u = req_body.get("username") if isinstance(req_body,dict) else None
    if not u:
        u = headers.get("X-Username")
    if u:
        c=sqlite3.connect(DB); c.execute("INSERT OR IGNORE INTO users(username,ip,created) VALUES(?,?,?)",(u,client_ip,time.time())); c.commit(); c.close()
        return u
    # fallback to ip-based
    ipname = "ip:"+client_ip
    c=sqlite3.connect(DB); c.execute("INSERT OR IGNORE INTO users(username,ip,created) VALUES(?,?,?)",(ipname,client_ip,time.time())); c.commit(); c.close()
    return ipname

def cache_get(key):
    if MEM:
        try:
            hit = CACHE.get(key)
            if hit is not None:
                return json.loads(hit)
        except Exception:
            pass
    c=sqlite3.connect(DB); r=c.execute("SELECT result FROM concept_cache WHERE key=?",(key,)).fetchone(); c.close()
    val = json.loads(r[0]) if r else None
    if val is not None and MEM:
        try: CACHE.set(key, json.dumps(val))
        except Exception: pass
    return val

def cache_set(key, result):
    if MEM:
        try: CACHE.set(key, json.dumps(result))
        except Exception: pass
    c=sqlite3.connect(DB); c.execute("INSERT OR REPLACE INTO concept_cache(key,result,created) VALUES(?,?,?)",(key,json.dumps(result),time.time())); c.commit(); c.close()

def load_prompt(name):
    c=sqlite3.connect(DB); r=c.execute("SELECT template FROM prompts WHERE name=?",(name,)).fetchone(); c.close()
    return r[0] if r else None

# ---- feature-request forum: vote board + email notify (generic catch-all) ----
def send_feature_email(subject, body_text):
    """Best-effort email. Uses SMTP_* env; no-op (logged) when unconfigured."""
    host = os.environ.get("SMTP_HOST", "")
    to = os.environ.get("FEATURE_NOTIFY_TO", "") or os.environ.get("SMTP_USER", "") or os.environ.get("NOTIFY_EMAIL", "")
    if not host or not to:
        print(f"[features] no SMTP configured; would send to={to or '(unset)'} subj={subject}\n{body_text[:500]}")
        return {"sent": False, "reason": "smtp-not-configured"}
    try:
        import smtplib
        from email.message import EmailMessage
        msg = EmailMessage()
        msg["Subject"] = subject
        msg["From"] = os.environ.get("SMTP_FROM", os.environ.get("SMTP_USER", "cvm@localhost"))
        msg["To"] = to
        msg.set_content(body_text)
        port = int(os.environ.get("SMTP_PORT", "587"))
        user = os.environ.get("SMTP_USER", "")
        pw = os.environ.get("SMTP_PASS", "") or os.environ.get("SMTP_PASSWORD", "")
        with smtplib.SMTP(host, port, timeout=15) as s:
            try: s.starttls()
            except Exception: pass
            if user and pw:
                try: s.login(user, pw)
                except Exception as e: return {"sent": False, "reason": f"smtp-login: {e}"}
            s.send_message(msg)
        return {"sent": True, "to": to}
    except Exception as e:
        print(f"[features] email failed: {e}")
        return {"sent": False, "reason": str(e)[:200]}

def feature_list(limit=100):
    c = sqlite3.connect(DB)
    rows = c.execute("SELECT id,title,detail,contact,votes,status,created FROM feature_requests ORDER BY votes DESC, id DESC LIMIT ?", (limit,)).fetchall()
    c.close()
    return [{"id": r[0], "title": r[1], "detail": r[2], "contact": r[3], "votes": r[4], "status": r[5], "created": r[6]} for r in rows]

def feature_create(title, detail="", contact=""):
    title = (title or "").strip()[:200]
    if not title:
        return {"ok": False, "error": "title required"}
    c = sqlite3.connect(DB)
    cur = c.execute("INSERT INTO feature_requests(title,detail,contact,votes,status,created) VALUES(?,?,?,?,?,?)",
                    (title, (detail or "")[:4000], (contact or "")[:200], 1, "open", time.time()))
    rid = cur.lastrowid
    c.commit(); c.close()
    mail = send_feature_email(f"[cvm] feature request #{rid}: {title}",
                              f"New feature request #{rid}\ntitle: {title}\ncontact: {contact}\n\n{detail}\n")
    return {"ok": True, "id": rid, "votes": 1, "email": mail}

def feature_vote(req_id, voter="anon"):
    try: req_id = int(req_id)
    except Exception: return {"ok": False, "error": "bad id"}
    voter = (voter or "anon")[:120]
    c = sqlite3.connect(DB)
    row = c.execute("SELECT id,votes,title FROM feature_requests WHERE id=?", (req_id,)).fetchone()
    if not row:
        c.close(); return {"ok": False, "error": "unknown request"}
    try:
        c.execute("INSERT INTO feature_votes(req_id,voter,created) VALUES(?,?,?)", (req_id, voter, time.time()))
        c.execute("UPDATE feature_requests SET votes=votes+1 WHERE id=?", (req_id,))
        c.commit()
        first = True
    except Exception:
        first = False  # already voted: idempotent
    votes = c.execute("SELECT votes FROM feature_requests WHERE id=?", (req_id,)).fetchone()[0]
    c.close()
    out = {"ok": True, "id": req_id, "votes": votes, "duplicate": not first}
    if first and votes in (5, 10, 25, 50, 100):
        out["email"] = send_feature_email(f"[cvm] #{req_id} hit {votes} votes: {row[2]}",
                                          f"Request #{req_id} reached {votes} votes.\ntitle: {row[2]}")
    return out

# ---- redundant sync: DO (#1, realtime) + SpacetimeDB (#2, durable) ----
# Python backend has no WS upgrade in stdlib server, so it acts as the
# local-dev twin of the DO: POST publish stores latest snapshot, GET state
# polls it. The browser races this against /api/spacetime/publish.
_SYNC = {}
def sync_publish(uuid, doc):
    uuid = (uuid or "").strip()
    if not uuid:
        return {"ok": False, "error": "uuid required"}
    seq = int(_SYNC.get(uuid, {}).get("seq", 0)) + 1
    _SYNC[uuid] = {"seq": seq, "doc": doc, "at": int(time.time() * 1000)}
    return {"ok": True, "uuid": uuid, "seq": seq, "via": "do"}

def sync_state(uuid):
    s = _SYNC.get((uuid or "").strip(), {"seq": 0, "doc": None, "at": 0})
    return {"ok": True, "uuid": uuid, "seq": s["seq"], "doc": s["doc"], "at": s["at"], "via": "do"}

def spacetime_publish(uuid, doc):
    # Best-effort: forwards to SpacetimeDB when SPACETIME_* env is configured,
    # otherwise honest skip so the race UI never shows a false win.
    host = os.environ.get("SPACETIME_HOST", "")
    if not host:
        return {"ok": False, "skipped": True, "via": "spacetime", "reason": "SPACETIME_HOST not configured"}
    try:
        r = _st_call("ingest_snapshot", {"snapId": uuid, "data": json.dumps(doc)[:20000], "user": ""})
        return {"ok": True, "via": "spacetime", "host": host, "upstream": bool(r)}
    except Exception as e:
        return {"ok": False, "via": "spacetime", "error": str(e)[:200]}

# ---- structured ingest: define array -> find-or-create table -> insert rows -> sort/render ----
FIELD_TYPES = {"text", "number", "bool", "type", "date", "json"}
def parse_fields(raw):
    """Accept [{name,type}] or 'label:text, score:number' or ['label',...]."""
    out = []
    if isinstance(raw, str):
        raw = [p.strip() for p in raw.replace("\n", ",").split(",") if p.strip()]
    for f in raw or []:
        if isinstance(f, str):
            name, _, typ = f.partition(":")
            f = {"name": name.strip(), "type": (typ.strip() or "text")}
        name = "".join(ch for ch in str(f.get("name", "")).strip() if ch.isalnum() or ch in "_- ").replace(" ", "_")
        typ = str(f.get("type", "text")).strip().lower()
        if name:
            out.append({"name": name[:60], "type": typ if typ in FIELD_TYPES else "text"})
    return out[:24] or [{"name": "label", "type": "text"}, {"name": "kind", "type": "type"}]

def ai_propose_fields(definition, table_name):
    ai = ai_chat("Propose a table schema for ingesting this data. Reply ONLY JSON array of "
                 '{"name":..,"type":"text|number|bool|type|date|json"}. '
                 f"Table: {table_name}\nDefinition: {str(definition)[:800]}")
    try:
        s = (ai or "").strip().strip("`")
        if s.startswith("json"): s = s[4:]
        return parse_fields(json.loads(s))
    except Exception:
        return parse_fields(definition)

def find_or_create_table(user, name, fields, constraints_text="", definition=""):
    name = "".join(ch for ch in (name or "").strip().lower() if ch.isalnum() or ch in "_- ").replace(" ", "_")[:60] or "entities"
    c = sqlite3.connect(DB)
    row = c.execute("SELECT id, fields FROM user_tables WHERE name=? AND user IS ?", (name, user)).fetchone()
    created = False
    if row and not fields:
        fields = json.loads(row[1])  # find, don't redefine
    elif not fields:
        fields = ai_propose_fields(definition or constraints_text, name)
    else:
        fields = parse_fields(fields)
    if row:
        tid = row[0]
        if fields:
            c.execute("UPDATE user_tables SET fields=?, constraints_text=? WHERE id=?", (json.dumps(fields), constraints_text or "", tid))
    else:
        tid = c.execute("INSERT INTO user_tables(name,fields,constraints_text,user,created) VALUES(?,?,?,?,?)",
                        (name, json.dumps(fields), constraints_text or "", user, time.time())).lastrowid
        created = True
    c.commit(); c.close()
    if os.environ.get("SPACETIME_HOST"):
        try: _st_call("define_table", {"name": name, "fields": json.dumps(fields), "user": user or ""})
        except Exception: pass
    return {"ok": True, "table": {"id": tid, "name": name, "fields": fields, "constraints": constraints_text or ""}, "created": created}

def insert_table_row(user, table_name, row):
    # never AI-propose or overwrite fields on insert — reuse the def from step 2
    c0 = sqlite3.connect(DB)
    exists = c0.execute("SELECT id FROM user_tables WHERE name=? AND user IS ?",
                        ("".join(ch for ch in (table_name or "").strip().lower() if ch.isalnum() or ch in "_- ").replace(" ", "_")[:60] or "entities", user)).fetchone()
    c0.close()
    t = {"table": {"id": exists[0], "name": table_name}} if exists else \
        find_or_create_table(user, table_name, [{"name": "label", "type": "text"}, {"name": "kind", "type": "type"}])
    row = {k: v for k, v in (row or {}).items() if not str(k).startswith("_")}
    c = sqlite3.connect(DB)
    rid = c.execute("INSERT INTO table_rows(table_id,row,user,created) VALUES(?,?,?,?)",
                    (t["table"]["id"], json.dumps(row), user, time.time())).lastrowid
    c.commit(); c.close()
    if os.environ.get("SPACETIME_HOST"):
        try: _st_call("insert_table_row", {"tableName": t["table"]["name"], "row": json.dumps(row), "user": user or ""})
        except Exception: pass
    return {"ok": True, "id": rid, "table": t["table"]["name"], "row": row}

def list_table_rows(user, table_name, sort="label"):
    c = sqlite3.connect(DB)
    t = c.execute("SELECT id, fields FROM user_tables WHERE name=? AND user IS ?", (table_name, user)).fetchone()
    if not t:
        c.close(); return {"ok": False, "error": "table not found", "rows": []}
    rows = [{"id": r[0], **json.loads(r[1])} for r in
            c.execute("SELECT id, row FROM table_rows WHERE table_id=? ORDER BY id", (t[0],)).fetchall()]
    c.close()
    key = sort if sort in {f["name"] for f in json.loads(t[1])} | {"id"} else "id"
    rows.sort(key=lambda r: (r.get(key) is None, str(r.get(key, "")).lower()))
    return {"ok": True, "table": table_name, "fields": json.loads(t[1]), "sort": key, "rows": rows}

# ---- node pages + chat: sqlite now, SpacetimeDB dual-write (best-effort) ----
def _st_call(reducer, args):
    try:
        import importlib
        mod = importlib.import_module("backend.spacetime_sync")
    except Exception:
        try:
            import importlib as _i
            mod = _i.import_module("spacetime_sync")
        except Exception:
            return None
    try:
        return mod._call(reducer, args)
    except Exception:
        return None

def canon_key(node, label=""):
    # Wiki semantics: the SAME word => the SAME page, regardless of per-graph
    # node id (n0, n1...) or user. Canonical key derives from the human label.
    base = (label or node or "").strip()
    norm = " ".join(base.lower().split())
    norm = norm.strip("\"'").strip()
    if not norm:
        return node
    return "concept:" + norm

def wiki_seed(term):
    # Best-effort Wikipedia summary seed for a concept. Returns
    # {"title":..,"body":..,"url":..} or None. Short timeout, never raises.
    import urllib.parse as _up
    t = (term or "").strip()
    if t.lower().startswith("concept:"):
        t = t[len("concept:"):]
    if not t or len(t) > 120:
        return None
    try:
        url = "https://en.wikipedia.org/api/rest_v1/page/summary/" + _up.quote(t.replace(" ", "_"))
        req = urllib.request.Request(url, headers={"User-Agent": "cvm-living-pages/1.0 (contact: local)"})
        with urllib.request.urlopen(req, timeout=8) as r:
            j = json.loads(r.read())
        if j.get("type") == "disambiguation" and not j.get("extract"):
            return None
        extract = (j.get("extract") or "").strip()
        if not extract:
            return None
        title = j.get("title") or t
        page_url = (j.get("content_urls") or {}).get("desktop", {}).get("page") or ("https://en.wikipedia.org/wiki/" + _up.quote(title.replace(" ", "_")))
        body = extract[:4000] + f"\n\n— Source: Wikipedia “{title}” ({page_url}) — expand with your own notes above this line."
        return {"title": title, "body": body, "url": page_url}
    except Exception:
        return None

def commit_graph(uuid, user, name, doc, message=""):
    import secrets as _secrets
    uuid = (uuid or "").strip() or _secrets.token_hex(16)
    if isinstance(doc, str):
        try: doc = json.loads(doc)
        except Exception: doc = {"raw": doc}
    doc = doc or {}
    # normalize + cap: full document snapshot per commit
    try:
        blob = json.dumps(doc)[:500000]
    except Exception:
        blob = json.dumps({"error": "unserializable doc"})[:500000]
    message = (message or "")[:300]
    c = sqlite3.connect(DB)
    r = c.execute("SELECT COALESCE(MAX(version),0) FROM graph_versions WHERE uuid=?", (uuid,)).fetchone()
    ver = (r[0] or 0) + 1
    now = time.time()
    c.execute("INSERT INTO graph_versions(uuid,version,user,name,doc,message,created) VALUES(?,?,?,?,?,?,?)",
              (uuid, ver, user, (name or "")[:120], blob, message, now))
    c.commit(); c.close()
    try: prune_history()
    except Exception: pass
    return {"uuid": uuid, "version": ver, "created": now}

def get_graph(uuid, version=None):
    c = sqlite3.connect(DB)
    if version:
        r = c.execute("SELECT version,user,name,doc,message,created FROM graph_versions WHERE uuid=? AND version=?", (uuid, version)).fetchone()
    else:
        r = c.execute("SELECT version,user,name,doc,message,created FROM graph_versions WHERE uuid=? ORDER BY version DESC LIMIT 1", (uuid,)).fetchone()
    c.close()
    if not r: return None
    try: doc = json.loads(r[3])
    except Exception: doc = {}
    return {"uuid": uuid, "version": r[0], "user": r[1], "name": r[2], "doc": doc, "message": r[4], "created": r[5]}

def graph_history(uuid, limit=50):
    limit = max(1, min(int(limit or 50), 200))
    c = sqlite3.connect(DB)
    rows = c.execute("SELECT version,user,name,message,created,LENGTH(doc) FROM graph_versions WHERE uuid=? ORDER BY version DESC LIMIT ?", (uuid, limit)).fetchall()
    c.close()
    return [{"uuid": uuid, "version": r[0], "user": r[1], "name": r[2], "message": r[3], "created": r[4], "bytes": r[5]} for r in rows]

def node_page_get(node, user, label=""):
    ck = canon_key(node, label)
    c=sqlite3.connect(DB)
    # 1) exact per-user row (legacy / personal override)
    r=c.execute("SELECT title,kind,body,updated FROM node_pages WHERE node=? AND user=?",(node,user)).fetchone()
    if r:
        c.close()
        return {"node":node,"key":node,"shared_key":ck,"shared":False,"title":r[0] or "","kind":r[1] or "","body":r[2] or "","updated":r[3] or 0}
    # 2) canonical per-user row (same word, any graph)
    if ck != node:
        r=c.execute("SELECT title,kind,body,updated FROM node_pages WHERE node=? AND user=?",(ck,user)).fetchone()
        if r:
            c.close()
            return {"node":node,"key":ck,"shared_key":ck,"shared":False,"title":r[0] or "","kind":r[1] or "","body":r[2] or "","updated":r[3] or 0}
    # 3) shared wiki row (same word, all users)
    r=c.execute("SELECT title,kind,body,updated FROM node_pages WHERE node=? AND user=?",(ck,"")).fetchone()
    if r:
        c.close()
        return {"node":node,"key":ck,"shared_key":ck,"shared":True,"title":r[0] or "","kind":r[1] or "","body":r[2] or "","updated":r[3] or 0}
    c.close()
    # 4) seed from Wikipedia so common concepts start with a real page
    seed = wiki_seed(label or node)
    if seed:
        try:
            node_page_save(node, "", seed["title"], "", seed["body"], label=label, shared=True, message="wikipedia seed")
        except Exception:
            pass
        return {"node":node,"key":ck,"shared_key":ck,"shared":True,"seeded":"wikipedia","url":seed.get("url"),"title":seed["title"],"kind":"","body":seed["body"],"updated":time.time()}
    return {"node":node,"key":ck,"shared_key":ck,"shared":True,"title":"","kind":"","body":"","updated":0}

def prune_history(force=False):
    """Age out old history rows per retention env (runs at most once/24h unless forced).
    Keeps the newest version of each series even if older than the cutoff."""
    try:
        c = sqlite3.connect(DB)
        if not force:
            r = c.execute("SELECT v FROM meta WHERE k='last_prune'").fetchone()
            if r and (time.time() - float(r[0] or 0)) < 86400:
                c.close(); return {"pruned": False}
        out = {}
        if GRAPH_HISTORY_DAYS > 0:
            cut = time.time() - GRAPH_HISTORY_DAYS * 86400
            # per uuid: delete rows older than cutoff except the latest version
            rows = c.execute("SELECT uuid, MAX(version) FROM graph_versions GROUP BY uuid").fetchall()
            n = 0
            for uuid, mx in rows:
                cur = c.execute("DELETE FROM graph_versions WHERE uuid=? AND version<? AND created<?", (uuid, mx, cut))
                n += cur.rowcount
            out["graph_versions"] = n
        if PAGE_HISTORY_DAYS > 0:
            cut = time.time() - PAGE_HISTORY_DAYS * 86400
            rows = c.execute("SELECT node, user, MAX(version) FROM page_versions GROUP BY node, user").fetchall()
            n = 0
            for node, user, mx in rows:
                cur = c.execute("DELETE FROM page_versions WHERE node=? AND user=? AND version<? AND created<?", (node, user, mx, cut))
                n += cur.rowcount
            out["page_versions"] = n
        c.execute("INSERT INTO meta(k,v) VALUES('last_prune',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", (str(time.time()),))
        c.commit(); c.close()
        out["pruned"] = True
        return out
    except Exception as e:
        return {"pruned": False, "error": str(e)[:200]}

def node_page_save(node, user, title, kind, body, label="", shared=True, message=""):
    title=(title or "")[:200]; kind=(kind or "")[:40]; body=(body or "")[:20000]
    now=time.time()
    ck = canon_key(node, label or title)
    c=sqlite3.connect(DB)
    c.execute("INSERT INTO node_pages(node,user,title,kind,body,updated) VALUES(?,?,?,?,?,?) ON CONFLICT(node,user) DO UPDATE SET title=excluded.title,kind=excluded.kind,body=excluded.body,updated=excluded.updated",(node,user,title,kind,body,now))
    # wiki behaviour: also persist the shared canonical page so every graph
    # that mentions the same word lands on the same page.
    if shared and ck and ck != node:
        c.execute("INSERT INTO node_pages(node,user,title,kind,body,updated) VALUES(?,?,?,?,?,?) ON CONFLICT(node,user) DO UPDATE SET title=excluded.title,kind=excluded.kind,body=excluded.body,updated=excluded.updated",(ck,"",title,kind,body,now))
    # version history for every row written (git-like; retention prunes by age)
    message = (message or "")[:300]
    for vn, vu in ((node, user), (ck, "") if (shared and ck and ck != node) else (None, None)):
        if not vn: continue
        r = c.execute("SELECT COALESCE(MAX(version),0) FROM page_versions WHERE node=? AND user=?", (vn, vu)).fetchone()
        c.execute("INSERT INTO page_versions(node,user,version,title,kind,body,message,created) VALUES(?,?,?,?,?,?,?,?)",
                  (vn, vu, (r[0] or 0) + 1, title, kind, body, message, now))
    c.commit(); c.close()
    try: prune_history()
    except Exception: pass
    _st_call("upsert_node_page", {"node":node,"user":user,"title":title,"kind":kind,"body":body})
    if shared and ck and ck != node:
        _st_call("upsert_node_page", {"node":ck,"user":"","title":title,"kind":kind,"body":body})
    return {"node":node,"key":ck,"shared_key":ck,"shared":shared,"title":title,"kind":kind,"body":body,"updated":now}

def page_history(node, user, label="", limit=50):
    ck = canon_key(node, label)
    limit = max(1, min(int(limit or 50), 200))
    # same fallback chain as node_page_get: exact -> canonical -> shared
    cands = [(node, user)]
    if ck != node:
        cands.append((ck, user))
    cands.append((ck, ""))
    c = sqlite3.connect(DB)
    for vn, vu in cands:
        rows = c.execute("SELECT version,title,kind,message,created,LENGTH(body) FROM page_versions WHERE node=? AND user=? ORDER BY version DESC LIMIT ?",
                         (vn, vu, limit)).fetchall()
        if rows:
            c.close()
            return {"node": node, "key": vn, "shared": vu == "",
                    "versions": [{"version": r[0], "title": r[1], "kind": r[2], "message": r[3], "created": r[4], "bytes": r[5]} for r in rows]}
    c.close()
    return {"node": node, "key": ck, "shared": True, "versions": []}

def get_page_version(node, user, version, label=""):
    ck = canon_key(node, label)
    cands = [(node, user)] + ([(ck, user)] if ck != node else []) + [(ck, "")]
    c = sqlite3.connect(DB)
    for vn, vu in cands:
        r = c.execute("SELECT title,kind,body,message,created FROM page_versions WHERE node=? AND user=? AND version=?",
                      (vn, vu, version)).fetchone()
        if r:
            c.close()
            return {"node": node, "key": vn, "title": r[0] or "", "kind": r[1] or "", "body": r[2] or "",
                    "message": r[3] or "", "created": r[4] or 0, "version": version}
    c.close()
    return None

def node_chat_list(node, user, limit=200, label=""):
    limit=max(1,min(int(limit or 200),500))
    node = canon_key(node, label) if label else node
    c=sqlite3.connect(DB)
    rows=c.execute("SELECT id,role,text,created FROM node_msgs WHERE node=? AND user=? ORDER BY id ASC LIMIT ?",(node,user,limit)).fetchall()
    c.close()
    return [{"id":r[0],"role":r[1],"text":r[2],"created":r[3]} for r in rows]

def node_chat_add(node, user, role, text, label=""):
    role="assistant" if role=="assistant" else "user"
    text=(text or "")[:4000]
    node = canon_key(node, label) if label else node
    if not text.strip() or not node:
        return None
    now=time.time()
    c=sqlite3.connect(DB)
    cur=c.execute("INSERT INTO node_msgs(node,user,role,text,created) VALUES(?,?,?,?,?)",(node,user,role,text,now))
    mid=cur.lastrowid; c.commit(); c.close()
    _st_call("add_node_chat", {"node":node,"user":user,"role":role,"text":text})
    return {"id":mid,"role":role,"text":text,"created":now}

def define_concept(concept):
    key="concept:"+concept.lower().strip()
    cached=cache_get(key)
    if cached: return cached
    tpl=load_prompt("concept_define")
    prompt=tpl.replace("{concept}", concept)
    ai=ai_chat(prompt)
    res=None
    if ai and not ai.startswith("AI_ERROR"):
        try:
            s=ai.strip()
            if s.startswith("```"): s=s.split("```")[1]; 
            if s.startswith("json"): s=s[4:]
            res=json.loads(s)
        except Exception:
            res={"name":concept,"kind":"Concept","attrs":{"definition":ai}}
    if not res:
        res={"name":concept,"kind":"Concept","attrs":{"definition":concept}}
    cache_set(key,res)
    return res

def build_network(text, user, schema=None):
    prompt_tpl=load_prompt("entity_extract")
    prompt=prompt_tpl.replace("{text}", text)
    # Structured mode: caller constrains extraction to caller-defined types.
    # schema = {"types": "Person, Asset", "constraints": "only APT actors"}
    if schema and (schema.get("types") or schema.get("constraints")):
        prompt+=("\n\n[STRUCTURED MODE — extract ONLY entities whose kind is one of: "
                + (schema.get("types") or "(any, but keep kinds tight)")
                + ". Additional constraints: " + (schema.get("constraints") or "none")
                + (". Data description: " + schema["definition"] if schema.get("definition") else "")
                + ". Skip anything that does not fit. Put provided constraints in attrs.]")
    ai=ai_chat(prompt)
    nodes=[]; edges=[]
    if ai and not ai.startswith("AI_ERROR"):
        try:
            s=ai.strip()
            if s.startswith("```"):
                s=s.split("```")[1]
                if s.startswith("json"): s=s[4:]
            obj=json.loads(s)
            nodes=obj.get("nodes",[]); edges=obj.get("edges",[])
        except Exception:
            nodes=[]; edges=[]
    if not nodes:
        toks=[w for w in text.split() if len(w)>3]
        for i,t in enumerate(toks[:12]):
            nodes.append({"id":f"n{i}","label":t,"kind":"Concept","attrs":{}})
        for i in range(len(nodes)-1):
            edges.append({"source":nodes[i]["id"],"target":nodes[i+1]["id"],"rel":"co-occurs","score":0.4})
    # concept enrichment + cache
    for i,n in enumerate(nodes):
        n["offset"]=i
        if n.get("kind")=="Concept":
            d=define_concept(n["label"])
            n.setdefault("attrs",{}).update(d.get("attrs",{}))
    # db similarity
    for n in nodes:
        hits=db_search(n["label"], user)
        n["attrs"]["db_hits"]=len(hits)
        for h in hits:
            if h["name"]!=n["label"]:
                edges.append({"source":n["id"],"target":h["name"],"rel":"similar-to (db)","score":round(similarity(n["label"],h["name"]),2)})
    # structured ingest step 3: AI-found/created table gets one row per entity
    table_info=None
    if schema and schema.get("table"):
        table_info=find_or_create_table(user, schema["table"], schema.get("fields"), schema.get("constraints",""))
        for n in nodes:
            row={"label":n.get("label",""),"kind":n.get("kind","")}
            row.update({k:v for k,v in (n.get("attrs") or {}).items() if isinstance(v,(str,int,float,bool))})
            insert_table_row(user, schema["table"], row)
    # persist
    c=sqlite3.connect(DB)
    for n in nodes:
        c.execute("INSERT INTO entities(name,kind,attrs,user) VALUES(?,?,?,?)",(n["label"],n["kind"],json.dumps(n.get("attrs",{})),user))
    for e in edges:
        c.execute("INSERT INTO relations(src,dst,rel,score,evidence,user) VALUES(?,?,?,?,?,?)",(e["source"],e["target"],e["rel"],e.get("score",0.5),"",user))
    c.commit(); c.close()
    flags=adversarial_check(nodes,edges)
    for n in nodes:
        n["data"]={"id":n["id"],"label":n["label"],"kind":n["kind"],"offset":n.get("offset",0)}
    for e in edges:
        e["data"]={"source":e["source"],"target":e["target"],"label":e["rel"],"score":e.get("score",0.5)}
    # save graph
    c=sqlite3.connect(DB)
    c.execute("INSERT INTO graphs(user,text,nodes,edges,flags,created) VALUES(?,?,?,?,?,?)",(user,text,json.dumps(nodes),json.dumps(edges),json.dumps(flags),time.time()))
    c.commit(); c.close()
    return {"nodes":nodes,"edges":edges,"adversarial":flags,"ai_raw":ai,"user":user,"table":table_info}

def run_exec(lang, code):
    # Exec finalized on a Debian sandbox: EXEC_MODE=sandbox runs every snippet in a
    # throwaway Docker container (debian-based image, no network, capped CPU/RAM).
    # local/ssh modes remain for dev; Workers have no subprocess (disabled there).
    mode = os.environ.get("EXEC_MODE","sandbox").lower()
    # Sandbox is the finalized prod env: it ONLY runs with EXEC_ENABLED=1.
    # (Legacy local/ssh bypass the flag for dev; sandbox never does.)
    if mode == "sandbox" and os.environ.get("EXEC_ENABLED", "0") != "1":
        return {"ok": False, "code": -1, "output": "exec disabled (EXEC_ENABLED=0)", "mode": "disabled"}
    if os.environ.get("EXEC_ENABLED", "0") != "1" and mode not in ("local", "ssh", "sandbox"):
        return {"ok": False, "code": -1, "output": "exec disabled (EXEC_ENABLED=0)", "mode": "disabled"}
    allow = (os.environ.get("EXEC_ALLOW", "python3,node,bash") or "").split(",")
    lang = (lang or "bash").lower()
    if lang in ("js", "node", "nodejs"): lang = "node"
    elif lang in ("bash", "sh", "shell"): lang = "bash"
    else: lang = "python3"
    if lang not in [a.strip() for a in allow] and allow != [""]:
        # still permit python3/node/bash via explicit mode; block unexpected langs
        pass
    if not code or len(code) > 8000:
        return {"ok": False, "code": -1, "output": "code empty or exceeds 8KB", "mode": "blocked"}
    if mode == "sandbox":
        return _run_exec_sandbox(lang, code)
    if lang=="js":
        if mode=="ssh":
            cmd = ["ssh","-p",os.environ.get("SSH_PORT","22"),f"{os.environ.get('SSH_USER','root')}@{os.environ.get('SSH_HOST','')}", "bash","-lc", f"node -e {json.dumps(code)}"]
        else:
            cmd = ["bash","-lc", f"node -e {json.dumps(code)}"]
    else:
        if mode=="ssh":
            cmd = ["ssh","-p",os.environ.get("SSH_PORT","22"),f"{os.environ.get('SSH_USER','root')}@{os.environ.get('SSH_HOST','')}", "bash","-lc", code]
        else:
            cmd = ["bash","-lc", code]
    try:
        p=subprocess.run(cmd, capture_output=True, text=True, timeout=EXEC_TIMEOUT)
        out=(p.stdout or "")+(("\nSTDERR:\n"+p.stderr) if p.stderr else "")
        if len(out)>EXEC_MAX_OUT: out=out[:EXEC_MAX_OUT]+"\n...[truncated]"
        return {"ok": p.returncode==0, "code": p.returncode, "output": out, "mode": mode}
    except subprocess.TimeoutExpired:
        return {"ok":False,"code":-1,"output":"timeout","mode":mode}
    except Exception as e:
        return {"ok":False,"code":-1,"output":str(e),"mode":mode}

def _run_exec_sandbox(lang, code):
    """One-shot Debian container per snippet. No network, capped CPU/RAM/PIDs,
    read-only rootfs + small tmpfs, dropped capabilities, run as nobody."""
    import shutil, tempfile
    if not shutil.which("docker"):
        return {"ok": False, "code": -1, "output": "sandbox unavailable: docker not found on this host", "mode": "sandbox"}
    image = os.environ.get("SANDBOX_IMAGE", "cvm-sandbox:debian")
    timeout = int(os.environ.get("SANDBOX_TIMEOUT", str(EXEC_TIMEOUT)))
    mem = os.environ.get("SANDBOX_MEM", "256m")
    cpus = os.environ.get("SANDBOX_CPUS", "0.5")
    net = os.environ.get("SANDBOX_NET", "none")  # keep 'none'; open only if you mean it
    entry = {"python3": ["python3", "/work/code"], "node": ["node", "/work/code"], "bash": ["bash", "/work/code"]}[lang]
    tmpd = tempfile.mkdtemp(prefix="tpsbx_")
    try:
        with open(os.path.join(tmpd, "code"), "w") as f:
            f.write(code)
        cmd = ["docker", "run", "--rm", "-i",
               "--network", net, "--memory", mem, "--cpus", cpus,
               "--pids-limit", "64", "--read-only",
               "--tmpfs", "/tmp:rw,size=64m,noexec",
               "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
               "--user", "nobody", "-v", f"{tmpd}/code:/work/code:ro", "-w", "/work",
               image] + entry
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout + 10)
        out = (p.stdout or "") + (("\nSTDERR:\n" + p.stderr) if p.stderr else "")
        if len(out) > EXEC_MAX_OUT: out = out[:EXEC_MAX_OUT] + "\n...[truncated]"
        return {"ok": p.returncode == 0, "code": p.returncode, "output": out, "mode": "sandbox"}
    except subprocess.TimeoutExpired:
        try: subprocess.run(["docker", "kill", ""], capture_output=True, timeout=5)
        except Exception: pass
        return {"ok": False, "code": -1, "output": "sandbox timeout", "mode": "sandbox"}
    except Exception as e:
        return {"ok": False, "code": -1, "output": str(e), "mode": "sandbox"}
    finally:
        try: shutil.rmtree(tmpd, ignore_errors=True)
        except Exception: pass

def build_offline_db(doc, meta=None):
    """Snapshot the graph exactly as the user sees it into a portable sqlite file.
    Tables: meta, nodes, edges, flags, pages (living wiki pages of visible
    concepts), chat (recent thread per concept). Returns the file path."""
    import tempfile
    doc = doc or {}
    nodes = doc.get("nodes", []) or []
    edges = doc.get("edges", []) or []
    flags = doc.get("adversarial", doc.get("flags", [])) or []
    meta = meta or {}
    fd, path = tempfile.mkstemp(prefix="graph-offline_", suffix=".db")
    os.close(fd)
    c = sqlite3.connect(path)
    c.execute("CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT)")
    c.execute("CREATE TABLE nodes (id TEXT PRIMARY KEY, label TEXT, kind TEXT, layer TEXT, attrs TEXT)")
    c.execute("CREATE TABLE edges (source TEXT, target TEXT, rel TEXT, score REAL)")
    c.execute("CREATE TABLE flags (node TEXT, issue TEXT)")
    c.execute("CREATE TABLE pages (key TEXT PRIMARY KEY, title TEXT, kind TEXT, body TEXT, updated REAL)")
    c.execute("CREATE TABLE chat (id INTEGER PRIMARY KEY AUTOINCREMENT, node TEXT, role TEXT, text TEXT, created REAL)")
    c.execute("CREATE INDEX IF NOT EXISTS idx_chat_node ON chat(node, id)")
    for n in nodes:
        c.execute("INSERT OR REPLACE INTO nodes(id,label,kind,layer,attrs) VALUES(?,?,?,?,?)",
                  (n.get("id"), n.get("label"), n.get("kind"), n.get("layer"),
                   json.dumps(n.get("attrs", {}))[:20000]))
    for e in edges:
        c.execute("INSERT INTO edges(source,target,rel,score) VALUES(?,?,?,?)",
                  (e.get("source"), e.get("target"), e.get("rel"), e.get("score", 0.5)))
    for f in flags:
        if isinstance(f, dict):
            c.execute("INSERT INTO flags(node,issue) VALUES(?,?)", (f.get("node"), f.get("issue")))
        else:
            c.execute("INSERT INTO flags(node,issue) VALUES(?,?)", ("", str(f)))
    # living pages + recent chat for every visible concept (shared wiki rows first)
    try:
        src = sqlite3.connect(DB)
        labels = {(n.get("label") or n.get("id") or "") for n in nodes}
        for lab in sorted(l for l in labels if l):
            ck = canon_key("", lab)
            r = (src.execute("SELECT title,kind,body,updated FROM node_pages WHERE node=? AND user=''",
                            (ck,)).fetchone()
                 or src.execute("SELECT title,kind,body,updated FROM node_pages WHERE node=? AND user=''",
                                (lab,)).fetchone())
            if r:
                c.execute("INSERT OR REPLACE INTO pages(key,title,kind,body,updated) VALUES(?,?,?,?,?)",
                          (ck, r[0], r[1], r[2], r[3]))
                for m in src.execute("SELECT role,text,created FROM node_msgs WHERE node=? ORDER BY id DESC LIMIT 200",
                                     (ck,)).fetchall():
                    c.execute("INSERT INTO chat(node,role,text,created) VALUES(?,?,?,?)", (ck, m[0], m[1], m[2]))
        src.close()
    except Exception:
        pass
    meta_rows = {"app": "cvm-offline", "version": "1", "exported": time.time(),
                 "uuid": meta.get("uuid", ""), "name": meta.get("name", ""),
                 "graph_version": meta.get("version", 0), "message": meta.get("message", "")}
    for k, v in meta_rows.items():
        c.execute("INSERT OR REPLACE INTO meta(k,v) VALUES(?,?)", (k, str(v)))
    c.commit(); c.close()
    return path

def check_auth(headers):
    import hmac
    if not AUTH_TOKEN: return True
    return hmac.compare_digest(headers.get("X-Auth-Token", ""), AUTH_TOKEN)

# ---- rate limiting (fina good bit) ----
import time as _t
_RATE = {}
def _rate_allow(key, per_min=60):
    now = _t.time()
    lst = _RATE.get(key, [])
    lst = [x for x in lst if now - x < 60]
    if len(lst) >= per_min:
        _RATE[key] = lst
        return False
    lst.append(now); _RATE[key] = lst
    return True

def _tools_allow(body):
    """Cohesive tools param: {web:bool, exec:bool}, or the string "none".
    Defaults: web ON, exec OFF. "none" = answer directly, no tool turns
    (for calls like page-refine where all context is pre-injected)."""
    t = body.get("tools", {}) or {}
    if t == "none":
        return set()
    if not isinstance(t, dict):
        t = {}
    allow = {"graph_search"}
    if t.get("web", True):
        allow |= {"web_search", "fetch_url"}
    if t.get("exec", False):
        allow.add("exec_code")
    if t.get("tools_off", False) or t.get("none", False):
        return set()
    return allow

def _ai_begin(route, body):
    """Shared entry for AI routes: tools allowlist + timed cache lookup.
    Returns (allow, t0, ckey, hit-or-None). Hit already marked cached."""
    allow = _tools_allow(body); t0 = time.time()
    ck = _ai_cache_key(route, body); hit = cache_get(ck)
    if hit: hit["cached"] = True; hit["ms"] = 0
    return allow, t0, ck, hit

def _ai_stamp(out, allow, t0):
    """Shared exit for AI routes: tools/ms/model envelope."""
    out.update({"tools": sorted(allow), "cached": False,
                "ms": int((time.time() - t0) * 1000),
                "model": os.environ.get("AI_MODEL", "muse-spark-1.3")})
    return out

def _ai_cache_key(route, body):
    h = hashlib.sha256(json.dumps({
        "r": route,
        "n": body.get("nodes"), "e": body.get("edges"),
        "i": body.get("input") or body.get("instruction") or body.get("label"),
        "t": body.get("tools"),
        "m": os.environ.get("AI_MODEL", "muse-spark-1.3"),
    }, sort_keys=True, default=str).encode()).hexdigest()[:32]
    return "ai:" + h

class Handler(http.server.BaseHTTPRequestHandler):
    def _client_ip(self):
        return self.client_address[0]
    def do_OPTIONS(self):
        self.send_response(200); self._cors(); self.end_headers()
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin","*")
        self.send_header("Access-Control-Allow-Methods","GET,POST,OPTIONS")
        self.send_header("Access-Control-Allow-Headers","Content-Type,X-Username")
    def do_GET(self):
        if self.path=="/health":
            self._json({"status":"ok"})
        elif self.path=="/info":
            import socket
            lan=None
            try:
                s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM); s.connect(("8.8.8.8",80)); lan=s.getsockname()[0]; s.close()
            except: lan="127.0.0.1"
            pub=None
            try:
                with urllib.request.urlopen("https://api.ipify.org",timeout=5) as r: pub=r.read().decode().strip()
            except: pub=None
            self._json({"lan_ip":lan,"public_ip":pub,"port":int(os.environ.get("PORT",3334)),"exec_mode":os.environ.get("EXEC_MODE","local")})
        elif self.path.startswith("/api/tables"):
            q=parse_qs(urlparse(self.path).query)
            user=q.get("user",[""])[0] or self.headers.get("X-Username") or ""
            self._json(list_table_rows(user, q.get("table",[""])[0], q.get("sort",["id"])[0]))
        elif self.path.startswith("/search"):
            q=parse_qs(urlparse(self.path).query).get("q",[""])[0]
            self._json({"results":db_search(q)})
        elif self.path=="/api/agent-manifest":
            self._json({"name":"cvm","version":2,"tools":[
              {"name":"build","method":"POST /build","in":{"text":"str"},"out":"{nodes,edges,adversarial}"},
              {"name":"recommend","method":"POST /recommend","in":{"nodes":[],"edges":[],"tools":{"web":True,"exec":False}},"out":"{ok,recs,tools,ms,cached}"},
              {"name":"improve","method":"POST /improve","in":{"input":"str","nodes":[],"edges":[],"tools":{},"prompt":"optional"},"out":"{ok,ops,tools,ms,cached}"},
              {"name":"duel","method":"POST /duel","in":{"input":"str","directive":"str (steers both agents)","nodes":[],"edges":[],"tools":{}},"out":"{ok,ops,std,vision,tools,ms,cached}"},
              {"name":"investigate","method":"POST /investigate","in":{"label":"str","tools":{}},"out":"{ok,report,turns,ms}"},
              {"name":"graph","method":"GET /api/graph?user=","out":"{nodes,edges}"},
              {"name":"node-page","method":"GET|POST /api/node-page","in":"{node,user?,title?,kind?,body?}","out":"{node,title,kind,body,updated}"},
              {"name":"page-history","method":"GET /api/node-page/versions?node=&label=&user=","out":"{versions:[{version,message,created}]}"},
              {"name":"graph-commit","method":"POST /api/graph/commit","in":"{uuid?,name,doc,message}","out":"{ok,uuid,version,created}"},
              {"name":"graph-read","method":"GET /api/graph?id=<uuid>&v=","out":"{ok,uuid,version,doc,message,created}"},
              {"name":"graph-history","method":"GET /api/graph/versions?uuid=","out":"{versions:[{version,message,created}]}"},
              {"name":"node-chat","method":"GET|POST /api/node-chat","in":"{node,user?,role?,text?,limit?}","out":"{msgs:[{role,text,created}]}"},
              {"name":"export","method":"GET /api/export?format=jsonld|cyjs","out":"graph file"},
              {"name":"export-offline","method":"POST /api/export/offline","in":"{uuid?,doc?}","out":"sqlite .db file (meta,nodes,edges,flags,pages,chat)"}],
              "hints":"POST /build with {text}; tools param gates agent tools (web default on, exec default off); recommend/improve responses are cached."})
        elif self.path.startswith("/api/graph/versions"):
            q=parse_qs(urlparse(self.path).query)
            self._json({"versions":graph_history(q.get("uuid",[""])[0], q.get("limit",["50"])[0])})
        elif self.path.startswith("/api/graph"):
            q=parse_qs(urlparse(self.path).query)
            gid=q.get("id",[""])[0] or q.get("uuid",[""])[0]
            if gid:
                # capability read: whoever knows the uuid can view the graph
                g=get_graph(gid, (q.get("v",[""])[0] or None))
                if g: self._json({"ok":True, **g})
                else: self._json({"ok":False,"error":"unknown graph id"})
                return
            u=q.get("user",[""])[0]
            import sqlite3 as _s
            c=_s.connect(DB); rows=c.execute("SELECT nodes,edges,flags FROM graphs WHERE user=? ORDER BY id DESC LIMIT 1",(u,)).fetchone(); c.close()
            if rows: self._json({"nodes":json.loads(rows[0]),"edges":json.loads(rows[1]),"flags":json.loads(rows[2])})
            else: self._json({"nodes":[],"edges":[],"flags":[]})
        elif self.path.startswith("/api/export"):
            fmt=parse_qs(urlparse(self.path).query).get("format",["cyjs"])[0]
            c=sqlite3.connect(DB); rows=c.execute("SELECT nodes,edges FROM graphs ORDER BY id DESC LIMIT 1").fetchone(); c.close()
            nodes=json.loads(rows[0]) if rows else []; edges=json.loads(rows[1]) if rows else []
            if fmt=="jsonld":
                self._json({"@context":"https://schema.org","@graph":[{"@type":n.get("kind"),"name":n.get("label"),"identifier":n.get("id")} for n in nodes]})
            else:
                self._json({"elements":{"nodes":[{"data":{"id":n["id"],"label":n["label"]}} for n in nodes],"edges":[{"data":{"source":e["source"],"target":e["target"],"label":e.get("rel")}} for e in edges]}})
        elif self.path=="/prompts":
            c=sqlite3.connect(DB); rows=c.execute("SELECT name,template FROM prompts").fetchall(); c.close()
            self._json({"prompts":[{"name":r[0],"template":r[1]} for r in rows]})
        elif self.path.startswith("/graphs"):
            u=parse_qs(urlparse(self.path).query).get("user",[""])[0]
            c=sqlite3.connect(DB); rows=c.execute("SELECT id,text,created FROM graphs WHERE user=? ORDER BY id DESC LIMIT 20",(u,)).fetchall(); c.close()
            self._json({"graphs":[{"id":r[0],"text":r[1],"created":r[2]} for r in rows]})
        elif self.path.startswith("/api/node-page/versions"):
            q=parse_qs(urlparse(self.path).query)
            self._json(page_history(q.get("node",[""])[0], q.get("user",[""])[0], q.get("label",[""])[0], q.get("limit",["50"])[0]))
        elif self.path.startswith("/api/node-page/version"):
            q=parse_qs(urlparse(self.path).query)
            g=get_page_version(q.get("node",[""])[0], q.get("user",[""])[0], int(q.get("v",["0"])[0] or 0), q.get("label",[""])[0])
            self._json({"ok":True, **g} if g else {"ok":False,"error":"unknown page version"})
        elif self.path.startswith("/api/node-page"):
            q=parse_qs(urlparse(self.path).query)
            self._json(node_page_get(q.get("node",[""])[0], q.get("user",[""])[0], q.get("label",[""])[0]))
        elif self.path.startswith("/api/node-chat"):
            q=parse_qs(urlparse(self.path).query)
            self._json({"msgs":node_chat_list(q.get("node",[""])[0], q.get("user",[""])[0], q.get("limit",["200"])[0], q.get("label",[""])[0])})
        elif self.path.startswith("/api/features"):
            # GET vote board (POST lives in do_POST)
            lim = parse_qs(urlparse(self.path).query).get("limit", ["100"])[0]
            try: self._json({"ok": True, "requests": feature_list(int(lim))})
            except Exception: self._json({"ok": True, "requests": feature_list()})
            return
        elif self.path.startswith("/api/sync/state"):
            q=parse_qs(urlparse(self.path).query)
            self._json(sync_state(q.get("uuid",[""])[0])); return
        elif self.path=="/api/sync/ping":
            self._json({"ok": True, "via": "do", "at": int(time.time()*1000)}); return
        else:
            root=os.path.join(os.path.dirname(os.path.dirname(__file__)), "pwa")  # one PWA folder: both backends serve the same files
            path=self.path.split("?")[0]
            if path=="/" or path=="": path="/index.html"
            if path=="/styles.css": path="/styles.txt"  # .txt so Workers Text-rules apply; still CSS
            if path=="/manifest.webmanifest": path="/manifest.txt"  # .txt so Workers Text-rules apply; still JSON
            fpath=os.path.join(root, path.lstrip("/"))
            if os.path.isfile(fpath):
                with open(fpath,"rb") as f: data=f.read()
                ctype="text/html" if fpath.endswith(".html") else ("image/svg+xml" if fpath.endswith(".svg") else "application/octet-stream")
                if fpath.endswith(".js"): ctype="application/javascript"
                if fpath.endswith("sync-client.txt"): ctype="application/javascript"  # .txt so Workers Text-rules apply; still JS
                if fpath.endswith("styles.txt"): ctype="text/css"  # .txt so Workers Text-rules apply; still CSS
                if fpath.endswith(".webmanifest") or fpath.endswith("manifest.txt"): ctype="application/manifest+json"
                if fpath.endswith(".css"): ctype="text/css"
                if fpath.endswith(".svg"): ctype="image/svg+xml"
                self.send_response(200); self._cors()
                self.send_header("Content-Type",ctype)
                self.send_header("Content-Length",str(len(data)))
                self.end_headers(); self.wfile.write(data)
            else:
                self.send_response(404); self.end_headers()
    def do_POST(self):
        n=int(self.headers.get("Content-Length",0))
        body=json.loads(self.rfile.read(n) or b"{}")
        if self.path=="/login":
            tok=body.get("token","")
            uname=body.get("username","").strip() or "anon"
            if AUTH_TOKEN and tok != AUTH_TOKEN:
                self._json({"ok":False,"error":"bad token"}); return
            c=sqlite3.connect(DB); c.execute("INSERT OR IGNORE INTO users(username,ip,created) VALUES(?,?,?)",(uname,self._client_ip(),time.time())); c.commit(); c.close()
            self._json({"ok":True,"user":uname}); return
        if self.path=="/build":
            if not check_auth(self.headers):
                self._json({"error":"unauthorized: bad/missing token"}); return
            user=get_user(body, self.headers, self._client_ip())
            res=build_network(body.get("text",""), user, body.get("schema"))
            self._json(res)
        elif self.path=="/define":
            concept=body.get("concept","")
            res=define_concept(concept)
            self._json(res)
        elif self.path=="/recommend":
            nodes=body.get("nodes",[])
            edges=body.get("edges",[])
            user=get_user(body, self.headers, self._client_ip())
            allow, t0, ck, hit = _ai_begin("recommend", body)
            if hit:
                self._json(hit); return
            recs=[]
            agent_used=False
            if AI_AGENT:
                try:
                    recs=agent_recommend(nodes, user, allow) or []
                    agent_used=True
                except Exception:
                    recs=[]
            if not recs:  # fallback: local heuristic pairs (no key / agent miss)
                names=[n.get("label") or n.get("id") for n in nodes]
                have={(e.get("source"),e.get("target")) for e in edges}
                for i in range(len(names)):
                    for j in range(i+1,len(names)):
                        if (names[i],names[j]) in have or (names[j],names[i]) in have: continue
                        s1=similarity(str(names[i]),str(names[j]))
                        recs.append({"source":names[i],"target":names[j],
                                     "rel":"similar-to" if s1>0.25 else "co-occurs",
                                     "reason":f"local heuristic (name-sim {s1})"})
                        if len(recs)>=5: break
                    if len(recs)>=5: break
            out={"ok":True,"recs":recs[:5],"agent":agent_used,
                        "ai_configured":bool((os.environ.get("MODEL_API_KEY") or os.environ.get("AI_API_KEY")))}
            _ai_stamp(out, allow, t0)
            if agent_used and recs: cache_set(ck, out)
            self._json(out)
        elif self.path=="/improve":
            instruction=body.get("input","") or body.get("instruction","")
            nodes=body.get("nodes",[]); edges=body.get("edges",[])
            allow, t0, ck, hit = _ai_begin("improve", body)
            if hit:
                self._json(hit); return
            tpl=load_prompt("improve") or ""
            custom=body.get("prompt","")
            if custom:
                try:
                    c=sqlite3.connect(DB); c.execute("INSERT OR REPLACE INTO prompts(name,template,created) VALUES(?,?,?)",("improve",custom,time.time())); c.commit(); c.close()
                except Exception: pass
                tpl=custom
            if AI_AGENT:
                r=agent_improve(instruction, {"nodes":nodes,"edges":edges}, tpl, allow)
                r["ok"]=True; r["agent"]=True
                _ai_stamp(r, allow, t0)
                if r.get("ops"): cache_set(ck, r)
                self._json(r)
            else:
                self._json({"ok":False,"ops":[],"error":"agent module missing"})
        elif self.path=="/duel":
            # reductionist adversarial round: standardizer (clean) vs visionary (expand)
            instruction=body.get("input","") or body.get("instruction","")
            directive=body.get("directive","") or ""
            nodes=body.get("nodes",[]); edges=body.get("edges",[])
            allow, t0, ck, hit = _ai_begin("duel", body)
            if hit:
                self._json(hit); return
            if AI_AGENT:
                try:
                    from backend.meta_ai import agent_duel
                except ImportError:
                    from meta_ai import agent_duel
                r=agent_duel(instruction, {"nodes":nodes,"edges":edges}, allow, directive)
                r["ok"]=True
                _ai_stamp(r, allow, t0)
                if r.get("ops"): cache_set(ck, r)
                self._json(r)
            else:
                self._json({"ok":False,"ops":[],"error":"agent module missing"})
        elif self.path=="/investigate":
            label=body.get("label","") or body.get("entity","")
            user=get_user(body, self.headers, self._client_ip())
            allow, t0, ck, hit = _ai_begin("investigate", body)
            if AI_AGENT:
                r=agent_investigate(label, user, allow)
                r["ok"]=True
                _ai_stamp(r, allow, t0)
                self._json(r)
            else:
                self._json({"ok":False,"error":"agent module missing"})
        elif self.path=="/exec":
            lang=body.get("lang","bash")
            code=body.get("code","")
            self._json(run_exec(lang, code))
        elif self.path=="/zero":
            # secret eval: one request in, model executes/searches as needed, <30s
            q=body.get("q","") or body.get("prompt","") or body.get("text","")
            if not q.strip():
                self._json({"ok":False,"error":"empty q"}); return
            if (body.get("format") or "")=="json":
                q+=("\n[output instruction: reply with ONLY valid JSON, no markdown fences, no prose. "
                    "Shape: {\"answer\": \"<natural-language user-facing answer>\", "
                    "\"ops\": [<graph edits>]}. "
                    "ops use only these shapes: {\"op\":\"add_node\",\"id\":..,\"label\":..,\"kind\":..}, "
                    "{\"op\":\"add_edge\",\"source\":..,\"target\":..,\"rel\":..}. "
                    "Only propose ops the user actually described (their connections enrich the graph); "
                    "make the edits faithfully — same labels, no invented relations. "
                    "If the user described no graph change, use \"ops\": [].]")
            allow=_tools_allow(body)
            user=get_user(body, self.headers, self._client_ip())
            t0=time.time()
            try:
                from backend.meta_ai import agent_zero
            except ImportError:
                from meta_ai import agent_zero
            try:
                r=agent_zero(q, allow, budget=28, ctx=body.get("ctx","") or "",
                             history=body.get("history") or None)
                r["ok"]=True; r["user"]=user
                r["ms"]=int((time.time()-t0)*1000)
                self._json(r)
            except Exception as e:
                self._json({"ok":False,"error":str(e)[:300],
                            "ms":int((time.time()-t0)*1000)})
        elif self.path=="/api/export/offline":
            # offline snapshot: the graph as the user sees it, as a sqlite .db file.
            # Client sends the visible {nodes,edges,adversarial}; server attaches
            # living pages + chat from its store. ?uuid= alone re-exports a version.
            user=get_user(body, self.headers, self._client_ip())
            doc=body.get("doc") or {"nodes":body.get("nodes",[]),"edges":body.get("edges",[]),
                                    "adversarial":body.get("adversarial",body.get("flags",[]))}
            uuid=(body.get("uuid") or "").strip()
            name=body.get("name",""); version=0; message=""
            if uuid and not (doc.get("nodes") or doc.get("edges")):
                g=get_graph(uuid, (body.get("v") or None))
                if g:
                    doc=g["doc"]; name=g.get("name",""); version=g.get("version",0); message=g.get("message","")
            if not uuid:
                c0=commit_graph("", user, name or "offline export", doc, "offline export")
                uuid=c0["uuid"]; version=c0["version"]
            path=build_offline_db(doc, {"uuid":uuid,"name":name,"version":version,"message":message})
            short=uuid[:8] if uuid else "graph"
            self._file(path, f"graph-{short}-v{version}.db")
        elif self.path=="/prompt":
            name=body.get("name"); template=body.get("template")
            c=sqlite3.connect(DB)
            c.execute("INSERT OR REPLACE INTO prompts(name,template,created) VALUES(?,?,?)",(name,template,time.time()))
            c.commit(); c.close()
            self._json({"ok":True})
        elif self.path=="/api/graph/commit":
            # git-like commit: full JSON document snapshot + time + graph id.
            # uuid identifies the graph series; each call appends a new version.
            user=get_user(body, self.headers, self._client_ip())
            doc=body.get("doc") or {"nodes":body.get("nodes",[]),"edges":body.get("edges",[]),"adversarial":body.get("adversarial",body.get("flags",[]))}
            r=commit_graph(body.get("uuid",""), user, body.get("name",""), doc, body.get("message",""))
            r["ok"]=True
            try: sync_publish(r.get("uuid",""), doc)
            except Exception: pass
            self._json(r)
        elif self.path=="/api/sync/publish":
            self._json(sync_publish(body.get("uuid",""), body.get("doc")))
        elif self.path=="/api/spacetime/publish":
            self._json(spacetime_publish(body.get("uuid",""), body.get("doc")))
        elif self.path=="/api/tables":
            user=get_user(body, self.headers, self._client_ip())
            self._json(find_or_create_table(user, body.get("table",""), body.get("fields"),
                                            body.get("constraints",""), body.get("definition","")))
        elif self.path=="/api/tables/rows":
            user=get_user(body, self.headers, self._client_ip())
            rows=body.get("rows") or [body.get("row") or {}]
            self._json({"ok":True,"inserted":[insert_table_row(user, body.get("table",""), r) for r in rows]})
        elif self.path=="/api/node-page":
            user=get_user(body, self.headers, self._client_ip())
            self._json(node_page_save(body.get("node",""), user, body.get("title",""), body.get("kind",""), body.get("body",""), label=body.get("label",""), shared=body.get("shared", True) is not False, message=body.get("message","")))
        elif self.path=="/api/node-chat":
            user=get_user(body, self.headers, self._client_ip())
            m=node_chat_add(body.get("node",""), user, body.get("role","user"), body.get("text",""), label=body.get("label",""))
            if m: self._json({"ok":True,"msg":m})
            else: self._json({"ok":False,"error":"empty node/text"})
        elif self.path=="/api/features":
            self._json(feature_create(body.get("title",""), body.get("detail",""), body.get("contact","") or body.get("username","")))
        elif self.path=="/api/features/vote":
            voter=(body.get("voter") or body.get("username") or self.headers.get("X-Username") or self._client_ip())
            self._json(feature_vote(body.get("id"), voter))
        else:
            self.send_response(404); self.end_headers()
    def _json(self,obj):
        b=json.dumps(obj).encode()
        self.send_response(200); self._cors()
        self.send_header("Content-Type","application/json")
        self.send_header("Content-Length",str(len(b)))
        self.end_headers(); self.wfile.write(b)
    def _file(self, path, filename, ctype="application/x-sqlite3"):
        try:
            with open(path,"rb") as f: data=f.read()
        except Exception as e:
            self.send_response(500); self.end_headers(); return
        self.send_response(200); self._cors()
        self.send_header("Content-Type",ctype)
        self.send_header("Content-Length",str(len(data)))
        self.send_header("Content-Disposition",f'attachment; filename="{filename}"')
        self.end_headers(); self.wfile.write(data)
        try: os.remove(path)
        except Exception: pass
    def log_message(self,*a): pass

if __name__=="__main__":
    host=os.environ.get("HOST","0.0.0.0")
    port=int(os.environ.get("PORT",3334))
    socketserver.TCPServer.allow_reuse_address=True
    with socketserver.TCPServer((host,port),Handler) as httpd:
        print("listening",host,port); httpd.serve_forever()