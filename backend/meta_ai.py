"""Minimal Muse agent (stdlib only, no extra deps).

Talks to https://api.meta.ai/v1 with the OpenAI-compatible shape:
- POST {base}/responses  (preferred, tool loop)
- fallback POST {base}/chat/completions

Tools are developer-defined; the model returns tool calls, we execute
them locally, feed results back, and repeat (max MAX_TURNS).
Built-in web search runs server-side via DuckDuckGo (no key).
"""
import json
import os
import sqlite3
import urllib.parse
import urllib.request

BASE = os.environ.get("AI_BASE_URL", "https://api.meta.ai/v1").rstrip("/")
KEY = os.environ.get("MODEL_API_KEY", "") or os.environ.get("AI_API_KEY", "")
MODEL = os.environ.get("AI_MODEL", "muse-spark-1.3")
MAX_TURNS = 4
TIMEOUT = 60

DB = os.path.join(os.path.dirname(__file__), "osint.db")

# ---------- local tools ----------

def tool_graph_search(query, user=""):
    """Search the local OSINT sqlite graph."""
    try:
        c = sqlite3.connect(DB)
        rows = c.execute(
            "SELECT name,kind,attrs FROM entities WHERE name LIKE ? LIMIT 10",
            (f"%{query}%",)).fetchall()
        c.close()
        return [{"name": r[0], "kind": r[1]} for r in rows]
    except Exception as e:
        return {"error": str(e)}


def tool_web_search(query):
    """Server-side web search (no key). Tries DDG instant API, then DDG html."""
    import re as _re
    # 1) instant answer API (fast, often empty for news)
    try:
        q = urllib.parse.urlencode({"q": query, "format": "json", "no_html": 1})
        req = urllib.request.Request("https://api.duckduckgo.com/?" + q,
                                     headers={"User-Agent": "osint-graph/1.0"})
        with urllib.request.urlopen(req, timeout=15) as r:
            j = json.loads(r.read())
        out = []
        if j.get("AbstractText"):
            out.append({"text": j["AbstractText"], "url": j.get("AbstractURL")})
        for t in (j.get("RelatedTopics") or [])[:5]:
            if isinstance(t, dict) and t.get("Text"):
                out.append({"text": t["Text"], "url": t.get("FirstURL")})
        if out:
            return out
    except Exception:
        pass
    # 2) DDG html endpoint scrape (works for news/general queries)
    try:
        q = urllib.parse.urlencode({"q": query})
        req = urllib.request.Request("https://html.duckduckgo.com/html/?" + q,
                                     headers={"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36"})
        with urllib.request.urlopen(req, timeout=15) as r:
            raw = r.read().decode("utf-8", "ignore")
        out = []
        import html as _html
        for m in _re.finditer(r'<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)</a>.*?<a[^>]*class="result__snippet"[^>]*>(.*?)</a>', raw, _re.S):
            url, title, snip = m.group(1), m.group(2), m.group(3)
            url = urllib.parse.unquote(url)
            mm = _re.search(r"[?&]uddg=([^&]+)", url)
            if mm:
                url = urllib.parse.unquote(mm.group(1))
            title = _html.unescape(_re.sub(r"<[^>]+>", "", title)).strip()
            snip = _html.unescape(_re.sub(r"<[^>]+>", "", snip)).strip()
            if url.startswith("http"):
                out.append({"text": (title + " — " + snip)[:300], "url": url})
            if len(out) >= 5:
                break
        if out:
            return out
    except Exception as e:
        return {"error": str(e)[:200]}
    return [{"text": "no results"}]


def tool_fetch_url(url):
    """Fetch a URL, return first 4k chars of text."""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "osint-graph/1.0"})
        with urllib.request.urlopen(req, timeout=20) as r:
            raw = r.read()[:6000].decode("utf-8", "ignore")
        # strip tags crudely
        import re
        txt = re.sub(r"<script.*?</script>", " ", raw, flags=re.S | re.I)
        txt = re.sub(r"<style.*?</style>", " ", txt, flags=re.S | re.I)
        txt = re.sub(r"<[^>]+>", " ", txt)
        txt = re.sub(r"\s+", " ", txt).strip()
        return {"url": url, "text": txt[:4000]}
    except Exception as e:
        return {"error": str(e)}


def tool_exec_code(code, lang="python3"):
    """Run code in a short-lived sandbox (timeout + output cap)."""
    import subprocess
    lang = (lang or "python3").lower()
    if lang in ("js", "node", "nodejs"):
        cmd = ["node", "-e", code]
    elif lang in ("bash", "sh", "shell"):
        cmd = ["bash", "-lc", code]
    else:
        cmd = ["python3", "-c", code]
    to = int(os.environ.get("EXEC_TIMEOUT", "15"))
    cap = int(os.environ.get("EXEC_MAX_OUT", "4000"))
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=to)
        out = (p.stdout or "") + (("\nSTDERR:\n" + p.stderr) if p.stderr else "")
        if len(out) > cap:
            out = out[:cap] + "\n...[truncated]"
        return {"ok": p.returncode == 0, "code": p.returncode, "output": out}
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "timeout after %ss" % to}
    except Exception as e:
        return {"ok": False, "error": str(e)[:200]}


TOOLS = {
    "graph_search": (tool_graph_search,
                     "Search the local OSINT graph DB for entities.",
                     {"query": "search string", "user": "username (optional)"}),
    "web_search": (tool_web_search,
                   "Search the public web for fresh info beyond training data.",
                   {"query": "search string"}),
    "fetch_url": (tool_fetch_url,
                  "Fetch a URL and return its text content.",
                  {"url": "https://..."}),
    "exec_code": (tool_exec_code,
                  "Execute code (python3/node/bash) in a sandbox with timeout. Use for calculations, parsing, verification.",
                  {"code": "code to run", "lang": "python3|node|bash"}),
}


DEFAULT_ALLOW = {"graph_search", "web_search", "fetch_url"}  # exec off unless asked

def _tool_defs(allow=None):
    allow = set(allow) if allow else set(DEFAULT_ALLOW)
    defs = []
    for name, (_, desc, params) in TOOLS.items():
        if name not in allow:
            continue
        defs.append({"type": "function", "name": name, "description": desc,
                     "parameters": {"type": "object",
                                    "properties": {k: {"type": "string", "description": k}
                                                   for k in params},
                                    "required": list(params),
                                    "additionalProperties": False}})
    return defs


def _post(path, payload):
    if not KEY:
        raise RuntimeError("MODEL_API_KEY is not set")
    req = urllib.request.Request(
        BASE + path, data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + KEY})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return json.loads(r.read())


def _run_tools(calls):
    """Execute tool calls locally, return [{name, result}]."""
    out = []
    for c in calls:
        name = c.get("name") or c.get("function", {}).get("name", "")
        args = c.get("arguments") or c.get("function", {}).get("arguments", {})
        if isinstance(args, str):
            try:
                args = json.loads(args)
            except Exception:
                args = {}
        fn = TOOLS.get(name, (None,))[0]
        if not fn:
            out.append({"name": name, "result": {"error": "unknown tool"}})
            continue
        try:
            res = fn(**{k: v for k, v in args.items() if isinstance(v, str)})
        except TypeError:
            res = fn(args.get("query", args.get("url", "")))
        except Exception as e:
            res = {"error": str(e)}
        out.append({"name": name, "result": res})
    return out


def _extract_calls(resp):
    """Pull tool calls out of a Responses- or Chat-style payload."""
    calls = []
    # Responses API: output array with function_call items
    for item in resp.get("output", []) or []:
        if item.get("type") in ("function_call", "tool_call"):
            calls.append({"name": item.get("name"),
                          "arguments": item.get("arguments", {}),
                          "call_id": item.get("call_id", item.get("id", ""))})
    # Chat Completions: choices[0].message.tool_calls
    try:
        tc = resp["choices"][0]["message"].get("tool_calls") or []
        for t in tc:
            calls.append({"name": t["function"]["name"],
                          "arguments": t["function"].get("arguments", {}),
                          "call_id": t.get("id", "")})
    except Exception:
        pass
    return calls


def _extract_text(resp):
    # Responses API
    for item in resp.get("output", []) or []:
        if item.get("type") == "message":
            for c in item.get("content", []) or []:
                if c.get("type") in ("output_text", "text") and c.get("text"):
                    return c["text"]
    if isinstance(resp.get("output_text"), str):
        return resp["output_text"]
    try:
        return resp["choices"][0]["message"].get("content", "")
    except Exception:
        return ""


def agent_run(user_msg, context="", allow=None):
    """Multi-turn tool loop. Returns {"text": final, "turns": n}."""
    tools = _tool_defs(allow)
    history = ([{"role": "system", "content": context}]
               + [{"role": "user", "content": user_msg}] if context
               else [{"role": "user", "content": user_msg}])
    turns = 0
    # api.meta.ai serves chat completions (no /responses) -> try that first
    use_responses = False
    for _ in range(MAX_TURNS):
        turns += 1
        if use_responses:
            try:
                resp = _post("/responses", {"model": MODEL, "input": history,
                                            "tools": tools})
            except Exception:
                use_responses = False
                continue
            calls = _extract_calls(resp)
            if not calls:
                return {"text": _extract_text(resp), "turns": turns}
            results = _run_tools(calls)
            history.append({"role": "assistant", "content": "",
                            "tool_calls": calls})
            for c, res in zip(calls, results):
                history.append({"role": "tool", "tool_call_id": c.get("call_id", ""),
                                "content": json.dumps(res["result"])[:4000]})
        else:
            cc_tools = [{"type": "function", "function": {
                "name": t["name"], "description": t["description"],
                "parameters": t["parameters"]}} for t in tools]
            resp = _post("/chat/completions",
                         {"model": MODEL, "messages": history, "tools": cc_tools,
                          "temperature": 0.2})
            calls = _extract_calls(resp)
            if not calls:
                return {"text": _extract_text(resp), "turns": turns}
            msg = dict(resp["choices"][0]["message"])
            history.append(msg)
            for c, res in zip(calls, _run_tools(calls)):
                history.append({"role": "tool", "tool_call_id": c.get("call_id", ""),
                                "content": json.dumps(res["result"])[:4000]})
    return {"text": history[-1].get("content", "") if isinstance(history[-1], dict) else "",
            "turns": turns}


SYS_RECO = ("You are an OSINT link-prediction agent. You have tools: "
            "graph_search (local DB), web_search (live web), fetch_url. "
            "Use them to ground each recommendation. Reply with ONLY a JSON "
            "array of exactly 5 objects {source,target,rel,reason} using the "
            "given entity names verbatim.")

SYS_INVEST = ("You are an OSINT investigator with tools: graph_search, "
              "web_search, fetch_url. Investigate the entity, use tools for "
              "live facts, then reply with short markdown: summary, "
              "key findings (bullets), suggested graph links.")


def agent_recommend(nodes, user="", allow=None):
    names = [n.get("label") or n.get("id") for n in nodes]
    if not names:
        return []
    msg = ("Entities: " + json.dumps(names) +
           ". Suggest exactly 5 likely relationships as JSON array "
           "{source,target,rel,reason}.")
    try:
        out = agent_run(msg, SYS_RECO, allow)
        s = (out.get("text") or "").strip()
        if s.startswith("```"):
            s = s.split("```")[1]
            if s.startswith("json"):
                s = s[4:]
        recs = json.loads(s)
        if isinstance(recs, dict):
            recs = recs.get("recs", recs.get("recommendations", []))
        return recs[:5] if isinstance(recs, list) else []
    except Exception:
        return []


SYS_IMPROVE = ("You are a graph editor with tools: graph_search, web_search, "
               "fetch_url. Use them to verify facts, then reply with ONLY a JSON "
               "array of ops using these shapes: "
               "{\"op\":\"delete_node\",\"id\":..}, "
               "{\"op\":\"delete_edge\",\"source\":.. ,\"target\":..}, "
               "{\"op\":\"add_node\",\"id\":..,\"label\":..,\"kind\":..}, "
               "{\"op\":\"add_edge\",\"source\":..,\"target\":..,\"rel\":..}, "
               "{\"op\":\"rename_node\",\"id\":..,\"label\":..}, "
               "{\"op\":\"set_attr\",\"id\":..,\"key\":..,\"value\":..}.")


def agent_improve(instruction, graph, tmpl_extra="", allow=None):
    msg = ("Instruction: " + (instruction or "(no instruction - clean up the graph: "
           "merge duplicates, drop junk nodes, add obvious missing links)") +
           "\nCurrent graph JSON: " + json.dumps(graph)[:8000])
    if tmpl_extra:
        msg = tmpl_extra.replace("{input}", instruction or "").replace(
            "{graph}", json.dumps(graph)[:8000])
    try:
        out = agent_run(msg, SYS_IMPROVE, allow)
        s = (out.get("text") or "").strip()
        if s.startswith("```"):
            s = s.split("```")[1]
            if s.startswith("json"):
                s = s[4:]
        ops = json.loads(s)
        if isinstance(ops, dict):
            ops = ops.get("ops", [])
        ops = [o for o in ops if isinstance(o, dict) and o.get("op")] if isinstance(ops, list) else []
        return {"ops": ops, "turns": out.get("turns", 0)}
    except Exception as e:
        return {"ops": [], "error": str(e)[:200]}


def agent_investigate(label, user="", allow=None):
    try:
        out = agent_run(f"Investigate this entity: {label}", SYS_INVEST, allow)
        return {"report": out.get("text", ""), "turns": out.get("turns", 0)}
    except Exception as e:
        return {"error": str(e)}


ZERO_SYS = ("You are a zero-shot task agent. Answer the user request directly in "
            "plain natural language for a non-technical reader: short sentences, "
            "no jargon, no tool-talk, no trace dumps. "
            "You have tools: graph_search (local DB), web_search (live web), "
            "fetch_url (page text), exec_code (python3/node/bash sandbox). "
            "Use tools when they help (search as needed, execute as needed), "
            "then give a clear user-facing answer in short markdown.")


def agent_zero(prompt, allow=None, budget=28, ctx="", history=None):
    """Single-request tool loop with hard time budget. Returns trace for eval.
    ctx: short pre-injected context (location id, local time, graph base...).
    history: prior message list from a previous /zero call to resume from."""
    import time as _t
    t0 = _t.time()
    allow = set(allow) if allow else set(DEFAULT_ALLOW)
    tools = _tool_defs(allow)
    trace = []
    if history and isinstance(history, list):
        history = [m for m in history if isinstance(m, dict) and m.get("role")][:30]
    else:
        history = [{"role": "user", "content": ((ctx + "\n\n" + prompt) if ctx else prompt)}]
    turns = 0
    text = ""
    timed_out = False
    done = False
    for _ in range(max(MAX_TURNS, 6) if not history else max(MAX_TURNS, 8)):
        if _t.time() - t0 > budget - 4:
            timed_out = True
            break
        turns += 1
        remain = max(5, int(budget - (_t.time() - t0) - 1))
        cc_tools = [{"type": "function", "function": {
            "name": t["name"], "description": t["description"],
            "parameters": t["parameters"]}} for t in tools]
        try:
            import urllib.request as _u
            req = _u.Request(
                BASE + "/chat/completions",
                data=json.dumps({"model": MODEL, "messages":
                                 [{"role": "system", "content": ZERO_SYS}] + history,
                                 "tools": cc_tools, "temperature": 0.2}).encode(),
                headers={"Content-Type": "application/json",
                         "Authorization": "Bearer " + KEY})
            with _u.urlopen(req, timeout=remain) as r:
                resp = json.loads(r.read())
        except Exception as e:
            trace.append({"turn": turns, "error": str(e)[:200]})
            text = text or ("ERROR: " + str(e)[:200])
            break
        calls = _extract_calls(resp)
        if not calls:
            text = _extract_text(resp)
            trace.append({"turn": turns, "calls": [], "answer": (text or "")[:500]})
            done = True
            break
        results = _run_tools(calls)
        trace.append({"turn": turns,
                      "calls": [{"name": c.get("name"),
                                 "arguments": c.get("arguments")} for c in calls],
                      "results": [str(res["result"])[:500] for res in results]})
        try:
            history.append(dict(resp["choices"][0]["message"]))
        except Exception:
            history.append({"role": "assistant", "content": ""})
        for c, res in zip(calls, results):
            history.append({"role": "tool", "tool_call_id": c.get("call_id", ""),
                            "content": json.dumps(res["result"])[:4000]})
        # no placeholder text: keep polling until the model answers or budget runs out
    # last resort: budget left but turns exhausted -> force a best-effort final
    # answer with NO tools so the user never gets a "(continued…)" dead end
    if not done and (_t.time() - t0) < budget - 6:
        try:
            import urllib.request as _u
            remain = max(5, int(budget - (_t.time() - t0) - 1))
            req = _u.Request(
                BASE + "/chat/completions",
                data=json.dumps({"model": MODEL, "messages":
                                 [{"role": "system", "content": ZERO_SYS}] + history +
                                  [{"role": "user", "content":
                                    "Tool budget exhausted. Using the tool results above, "
                                    "give your best final answer now (note gaps briefly)."}],
                                 "temperature": 0.3}).encode(),
                headers={"Content-Type": "application/json",
                         "Authorization": "Bearer " + KEY})
            with _u.urlopen(req, timeout=remain) as r:
                resp = json.loads(r.read())
            fb = _extract_text(resp)
            if fb:
                text = fb
                trace.append({"turn": turns + 1, "calls": [],
                              "answer": text[:500], "final": True})
                done = True
        except Exception as e:
            trace.append({"turn": turns + 1, "error": "final-pass: " + str(e)[:150]})
    ms = int((_t.time() - t0) * 1000)
    can_continue = (not done) and bool(history)
    if not done and not text:
        text = ("(paused after %d tool turn(s)%s — press Continue ▶ to resume)"
                % (turns, " (time budget hit)" if timed_out else ""))
    slim = []
    for m in history:
        m = dict(m)
        if isinstance(m.get("content"), str) and len(m["content"]) > 4000:
            m["content"] = m["content"][:4000]
        slim.append(m)
    return {"text": text, "turns": turns, "trace": trace,
            "ms": ms, "timed_out": timed_out, "done": done,
            "can_continue": can_continue, "history": slim,
            "model": MODEL, "tools": sorted(allow), "ctx": bool(ctx)}
