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

DB = os.path.join(os.path.dirname(__file__), "osint.db")
AI_URL = os.environ.get("AI_URL", "https://api.openai.com/v1/chat/completions")
AI_KEY = os.environ.get("MODEL_API_KEY", "") or os.environ.get("AI_API_KEY", "")
AI_MODEL = os.environ.get("AI_MODEL", "muse-spark-1.3")
AI_BASE = os.environ.get("AI_BASE_URL", "https://api.meta.ai/v1")
EXEC_TIMEOUT = int(os.environ.get("EXEC_TIMEOUT", "30"))
EXEC_MAX_OUT = int(os.environ.get("EXEC_MAX_OUT", "8000"))
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
    c.execute("""CREATE TABLE IF NOT EXISTS concept_cache (key TEXT PRIMARY KEY, result TEXT, created REAL)""")
    c.execute("""CREATE TABLE IF NOT EXISTS prompts (name TEXT PRIMARY KEY, template TEXT, created REAL)""")
    # seed prompts
    seeds = {
     "entity_extract": "You are an OSINT graph builder. Given free-text input, extract a knowledge graph.\nReturn ONLY valid JSON with keys: nodes (list of {id,label,kind,attrs}) and edges (list of {source,target,rel,score}).\nkinds: Person, Organization, Domain, IP, Location, Event, Concept, Asset.\nInput: {text}",
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

def build_network(text, user):
    prompt_tpl=load_prompt("entity_extract")
    prompt=prompt_tpl.replace("{text}", text)
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
    return {"nodes":nodes,"edges":edges,"adversarial":flags,"ai_raw":ai,"user":user}

def run_exec(lang, code):
    # configured runner
    mode = os.environ.get("EXEC_MODE","local").lower()
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

def check_auth(headers):
    if not AUTH_TOKEN: return True
    return headers.get("X-Auth-Token") == AUTH_TOKEN

def _tools_allow(body):
    """Cohesive tools param: {web:bool, exec:bool}. Defaults: web ON, exec OFF."""
    t = body.get("tools", {}) or {}
    allow = {"graph_search"}
    if t.get("web", True):
        allow |= {"web_search", "fetch_url"}
    if t.get("exec", False):
        allow.add("exec_code")
    return allow

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
        elif self.path.startswith("/search"):
            q=parse_qs(urlparse(self.path).query).get("q",[""])[0]
            self._json({"results":db_search(q)})
        elif self.path=="/api/agent-manifest":
            self._json({"name":"osint-graph","version":2,"tools":[
              {"name":"build","method":"POST /build","in":{"text":"str"},"out":"{nodes,edges,adversarial}"},
              {"name":"recommend","method":"POST /recommend","in":{"nodes":[],"edges":[],"tools":{"web":True,"exec":False}},"out":"{ok,recs,tools,ms,cached}"},
              {"name":"improve","method":"POST /improve","in":{"input":"str","nodes":[],"edges":[],"tools":{},"prompt":"optional"},"out":"{ok,ops,tools,ms,cached}"},
              {"name":"investigate","method":"POST /investigate","in":{"label":"str","tools":{}},"out":"{ok,report,turns,ms}"},
              {"name":"graph","method":"GET /api/graph?user=","out":"{nodes,edges}"},
              {"name":"export","method":"GET /api/export?format=jsonld|cyjs","out":"graph file"}],
              "hints":"POST /build with {text}; tools param gates agent tools (web default on, exec default off); recommend/improve responses are cached."})
        elif self.path.startswith("/api/graph"):
            u=parse_qs(urlparse(self.path).query).get("user",[""])[0]
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
        else:
            root=os.path.dirname(os.path.dirname(__file__))
            path=self.path.split("?")[0]
            if path=="/" or path=="": path="/index.html"
            fpath=os.path.join(root, path.lstrip("/"))
            if os.path.isfile(fpath):
                with open(fpath,"rb") as f: data=f.read()
                ctype="text/html" if fpath.endswith(".html") else "application/octet-stream"
                if fpath.endswith(".js"): ctype="application/javascript"
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
            res=build_network(body.get("text",""), user)
            self._json(res)
        elif self.path=="/ingest":
            user=get_user(body, self.headers, self._client_ip())
            c=sqlite3.connect(DB)
            c.execute("INSERT INTO entities(name,kind,attrs,user) VALUES(?,?,?,?)",(body.get("name"),body.get("kind","Concept"),json.dumps(body.get("attrs",{})),user))
            c.commit(); c.close()
            self._json({"ok":True,"user":user})
        elif self.path=="/define":
            concept=body.get("concept","")
            res=define_concept(concept)
            self._json(res)
        elif self.path=="/recommend":
            nodes=body.get("nodes",[])
            edges=body.get("edges",[])
            user=get_user(body, self.headers, self._client_ip())
            allow=_tools_allow(body)
            t0=time.time()
            ck=_ai_cache_key("recommend", body)
            hit=cache_get(ck)
            if hit:
                hit["cached"]=True; hit["ms"]=0
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
                        "ai_configured":bool((os.environ.get("MODEL_API_KEY") or os.environ.get("AI_API_KEY"))),
                        "model":os.environ.get("AI_MODEL","muse-spark-1.3"),
                        "tools":sorted(allow),"cached":False,"ms":int((time.time()-t0)*1000)}
            if agent_used and recs: cache_set(ck, out)
            self._json(out)
        elif self.path=="/improve":
            instruction=body.get("input","") or body.get("instruction","")
            nodes=body.get("nodes",[]); edges=body.get("edges",[])
            allow=_tools_allow(body)
            t0=time.time()
            ck=_ai_cache_key("improve", body)
            hit=cache_get(ck)
            if hit:
                hit["cached"]=True; hit["ms"]=0
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
                r["ok"]=True; r["agent"]=True; r["model"]=os.environ.get("AI_MODEL","muse-spark-1.3")
                r["tools"]=sorted(allow); r["cached"]=False; r["ms"]=int((time.time()-t0)*1000)
                if r.get("ops"): cache_set(ck, r)
                self._json(r)
            else:
                self._json({"ok":False,"ops":[],"error":"agent module missing"})
        elif self.path=="/investigate":
            label=body.get("label","") or body.get("entity","")
            user=get_user(body, self.headers, self._client_ip())
            allow=_tools_allow(body)
            t0=time.time()
            if AI_AGENT:
                r=agent_investigate(label, user, allow)
                r["ok"]=True; r["tools"]=sorted(allow); r["ms"]=int((time.time()-t0)*1000)
                self._json(r)
            else:
                self._json({"ok":False,"error":"agent module missing"})
        elif self.path=="/exec":
            lang=body.get("lang","bash")
            code=body.get("code","")
            self._json(run_exec(lang, code))
        elif self.path=="/mem":
            # mem cache ops: stats | compact | snapshot(meta only) | clear-expired
            op=(body.get("op") or "stats")
            if not MEM or CACHE is None:
                self._json({"ok":False,"error":"memcache unavailable"}); return
            if op=="compact":
                self._json({"ok":True, **CACHE.compact()}); return
            if op=="flush_expired":
                self._json({"ok":True, **CACHE.compact()}); return
            self._json({"ok":True, **CACHE.stats()})
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
            allow=_tools_allow({"tools":{"web":True,"exec":True}})
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
        elif self.path=="/prompt":
            name=body.get("name"); template=body.get("template")
            c=sqlite3.connect(DB)
            c.execute("INSERT OR REPLACE INTO prompts(name,template,created) VALUES(?,?,?)",(name,template,time.time()))
            c.commit(); c.close()
            self._json({"ok":True})
        else:
            self.send_response(404); self.end_headers()
    def _json(self,obj):
        b=json.dumps(obj).encode()
        self.send_response(200); self._cors()
        self.send_header("Content-Type","application/json")
        self.send_header("Content-Length",str(len(b)))
        self.end_headers(); self.wfile.write(b)
    def log_message(self,*a): pass

if __name__=="__main__":
    host=os.environ.get("HOST","0.0.0.0")
    port=int(os.environ.get("PORT",3334))
    socketserver.TCPServer.allow_reuse_address=True
    with socketserver.TCPServer((host,port),Handler) as httpd:
        print("listening",host,port); httpd.serve_forever()