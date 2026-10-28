// Port of backend/meta_ai.py to Workers (fetch-native, D1-backed tools).
// Same prompts, same op shapes, same tool loop. exec_code is disabled
// (Workers can't spawn processes) and always excluded from tool defs.

export const MODEL_DEFAULT = "muse-spark-1.3";

export const SYS_RECO =
  "You are a CVM (Cache Variable Memory) link-prediction agent. You have tools: " +
  "graph_search (local DB), web_search (live web), fetch_url. " +
  "Use them to ground each recommendation. Reply with ONLY a JSON " +
  "array of exactly 5 objects {source,target,rel,reason} using the " +
  "given entity names verbatim.";

export const SYS_INVEST =
  "You are a CVM (Cache Variable Memory) investigator with tools: graph_search, " +
  "web_search, fetch_url. Investigate the entity, use tools for " +
  "live facts, then reply with short markdown: summary, " +
  "key findings (bullets), suggested graph links.";

export const SYS_IMPROVE =
  "You are a graph editor with tools: graph_search, web_search, " +
  "fetch_url. Use them to verify facts, then reply with ONLY a JSON " +
  "array of ops using these shapes: " +
  '{"op":"delete_node","id":..}, ' +
  '{"op":"delete_edge","source":.. ,"target":..}, ' +
  '{"op":"add_node","id":..,"label":..,"kind":..}, ' +
  '{"op":"add_edge","source":..,"target":..,"rel":..}, ' +
  '{"op":"rename_node","id":..,"label":..}, ' +
  '{"op":"set_attr","id":..,"key":..,"value":..}.';

export const STANDARDIZER_SYS =
  "You are the STANDARDIZER: group and standardize. Merge " +
  "duplicates, unify labels (Title Case), normalize kinds, drop junk " +
  "nodes, collapse redundant edges. Reply with ONLY a JSON array of ops: " +
  '{"op":"delete_node","id":..}, ' +
  '{"op":"delete_edge","source":..,"target":..}, ' +
  '{"op":"rename_node","id":..,"label":..}, ' +
  '{"op":"set_attr","id":..,"key":..,"value":..}, ' +
  '{"op":"add_edge","source":..,"target":..,"rel":..} ' +
  "(add_edge only to reconnect orphans). Be aggressive about merging.";

export const VISIONARY_SYS =
  "You are the VISIONARY: expand and enrich. Propose NEW nodes " +
  "and missing links the graph should have, grounded by tools " +
  "(graph_search, web_search, fetch_url). Reply with ONLY a JSON array of " +
  'ops: {"op":"add_node","id":..,"label":..,"kind":..}, ' +
  '{"op":"add_edge","source":..,"target":..,"rel":..}. ' +
  "Every add_edge must reference a node that exists or that you add in the " +
  "same reply. Max 8 ops. No deletions, no renames.";

export const ZERO_SYS =
  "You are a zero-shot task agent. Answer the user request directly in " +
  "plain natural language for a non-technical reader: short sentences, " +
  "no jargon, no tool-talk, no trace dumps. " +
  "You have tools: graph_search (local DB), web_search (live web), " +
  "fetch_url (page text). " +
  "Use tools when they help (search as needed), " +
  "then give a clear user-facing answer in short markdown.";

export const DEFAULT_ALLOW = new Set(["graph_search", "web_search", "fetch_url"]);

function baseUrl(env) {
  return (env.AI_BASE_URL || "https://api.meta.ai/v1").replace(/\/$/, "");
}
function model(env) {
  return env.AI_MODEL || MODEL_DEFAULT;
}
function apiKey(env) {
  return env.MODEL_API_KEY || env.AI_API_KEY || "";
}

async function toolGraphSearch(db, query, user) {
  try {
    const r = await db
      .prepare("SELECT name,kind FROM entities WHERE name LIKE ? LIMIT 10")
      .bind(`%${query}%`)
      .all();
    return (r.results || []).map((x) => ({ name: x.name, kind: x.kind }));
  } catch (e) {
    return { error: String(e).slice(0, 200) };
  }
}

async function toolWebSearch(query) {
  // DDG instant API, then html scrape fallback (same as meta_ai.py).
  try {
    const u = "https://api.duckduckgo.com/?" + new URLSearchParams({ q: query, format: "json", no_html: "1" });
    const r = await fetch(u, { headers: { "User-Agent": "cvm/1.0" }, signal: AbortSignal.timeout(12000) });
    const j = await r.json();
    const out = [];
    if (j.AbstractText) out.push({ text: j.AbstractText, url: j.AbstractURL });
    for (const t of (j.RelatedTopics || []).slice(0, 5)) {
      if (t && typeof t === "object" && t.Text) out.push({ text: t.Text, url: t.FirstURL });
    }
    if (out.length) return out;
  } catch (_) {}
  try {
    const u = "https://html.duckduckgo.com/html/?" + new URLSearchParams({ q: query });
    const r = await fetch(u, { headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36" }, signal: AbortSignal.timeout(12000) });
    const raw = await r.text();
    const out = [];
    const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>.*?<a[^>]*class="result__snippet"[^>]*>(.*?)<\/a>/gs;
    let m;
    while ((m = re.exec(raw)) && out.length < 5) {
      let url = decodeURIComponent(m[1]);
      const mm = url.match(/[?&]uddg=([^&]+)/);
      if (mm) url = decodeURIComponent(mm[1]);
      const strip = (s) => s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").trim();
      if (url.startsWith("http")) out.push({ text: (strip(m[2]) + " — " + strip(m[3])).slice(0, 300), url });
    }
    if (out.length) return out;
  } catch (e) {
    return { error: String(e).slice(0, 200) };
  }
  return [{ text: "no results" }];
}

function blockedHost(host) {
  if (!host) return true;
  const h = host.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    if (h.startsWith("127.") || h.startsWith("10.") || h.startsWith("192.168.") || h === "169.254.169.254") return true;
    const p = h.split(".").map(Number);
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
  }
  return false;
}

async function toolFetchUrl(url) {
  try {
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return { error: "url must be http(s)" };
    const host = new URL(url).hostname;
    if (blockedHost(host)) return { error: "blocked: private/loopback host" };
    let cur = url;
    for (let i = 0; i < 4; i++) {
      const r = await fetch(cur, { headers: { "User-Agent": "cvm/1.0" }, redirect: "manual", signal: AbortSignal.timeout(15000) });
      if ([301, 302, 303, 307, 308].includes(r.status)) {
        const loc = r.headers.get("location");
        if (!loc) return { error: "redirect without location" };
        cur = new URL(loc, cur).toString();
        if (blockedHost(new URL(cur).hostname)) return { error: "blocked: private/loopback host" };
        continue;
      }
      const ctype = r.headers.get("content-type") || "";
      if (!/text|json/.test(ctype)) return { error: `blocked content-type: ${ctype.slice(0, 80)}` };
      let txt = (await r.text()).slice(0, 6000);
      txt = txt.replace(/<script.*?<\/script>/gsi, " ").replace(/<style.*?<\/style>/gsi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      return { url, text: txt.slice(0, 4000) };
    }
    return { error: "too many redirects" };
  } catch (e) {
    return { error: String(e).slice(0, 200) };
  }
}

const TOOL_DEFS = [
  { name: "graph_search", desc: "Search the local graph DB for entities.", params: ["query", "user"] },
  { name: "web_search", desc: "Search the public web for fresh info beyond training data.", params: ["query"] },
  { name: "fetch_url", desc: "Fetch a URL and return its text content.", params: ["url"] },
];

function toolDefs(allow) {
  const set = allow ? new Set(allow) : DEFAULT_ALLOW;
  return TOOL_DEFS.filter((t) => set.has(t.name)).map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.desc,
      parameters: {
        type: "object",
        properties: Object.fromEntries(t.params.map((p) => [p, { type: "string", description: p }])),
        required: t.params,
        additionalProperties: false,
      },
    },
  }));
}

async function runTools(calls, db) {
  const out = [];
  for (const c of calls) {
    const name = c.name;
    let args = c.arguments || {};
    if (typeof args === "string") {
      try { args = JSON.parse(args); } catch (_) { args = {}; }
    }
    try {
      if (name === "graph_search") out.push({ name, result: await toolGraphSearch(db, args.query || "", args.user || "") });
      else if (name === "web_search") out.push({ name, result: await toolWebSearch(args.query || "") });
      else if (name === "fetch_url") out.push({ name, result: await toolFetchUrl(args.url || "") });
      else out.push({ name, result: { error: "unknown tool (exec disabled on Workers)" } });
    } catch (e) {
      out.push({ name, result: { error: String(e).slice(0, 200) } });
    }
  }
  return out;
}

function extractCalls(resp) {
  try {
    return (resp.choices?.[0]?.message?.tool_calls || []).map((t) => ({
      name: t.function?.name, arguments: t.function?.arguments || {}, call_id: t.id || "",
    }));
  } catch (_) {
    return [];
  }
}
function extractText(resp) {
  try {
    return resp.choices?.[0]?.message?.content || "";
  } catch (_) {
    return "";
  }
}

async function chat(env, messages, tools) {
  const r = await fetch(baseUrl(env) + "/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey(env) },
    body: JSON.stringify({ model: model(env), messages, tools, temperature: 0.2 }),
    signal: AbortSignal.timeout(55000),
  });
  if (!r.ok) throw new Error(`AI ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

export async function agentRun(env, db, userMsg, context, allow, maxTurns = 4) {
  const tools = toolDefs(allow);
  let history = context ? [{ role: "system", content: context }, { role: "user", content: userMsg }] : [{ role: "user", content: userMsg }];
  let turns = 0;
  for (let i = 0; i < maxTurns; i++) {
    turns++;
    const resp = await chat(env, history, tools);
    const calls = extractCalls(resp);
    if (!calls.length) return { text: extractText(resp), turns };
    history.push(resp.choices[0].message);
    const results = await runTools(calls, db);
    for (let k = 0; k < calls.length; k++) {
      history.push({ role: "tool", tool_call_id: calls[k].call_id, content: JSON.stringify(results[k].result).slice(0, 4000) });
    }
  }
  const last = history[history.length - 1];
  return { text: typeof last?.content === "string" ? last.content : "", turns };
}

export function parseOps(text) {
  let s = (text || "").trim();
  if (s.startsWith("```")) {
    s = s.split("```")[1] || "";
    if (s.startsWith("json")) s = s.slice(4);
  }
  try {
    const ops = JSON.parse(s.trim() || "[]");
    const list = Array.isArray(ops) ? ops : ops.ops || ops.std || ops.vision || [];
    return Array.isArray(list) ? list.filter((o) => o && typeof o === "object" && o.op) : [];
  } catch (_) {
    return [];
  }
}

export async function agentRecommend(env, db, nodes, user) {
  const names = nodes.map((n) => n.label || n.id);
  if (!names.length) return [];
  try {
    const out = await agentRun(env, db, `Entities: ${JSON.stringify(names)}. Suggest exactly 5 likely relationships as JSON array {source,target,rel,reason}.`, SYS_RECO, null);
    let recs = parseOps(out.text);
    if (!Array.isArray(recs)) recs = [];
    return recs.slice(0, 5);
  } catch (_) {
    return [];
  }
}

export async function agentImprove(env, db, instruction, graph, tmplExtra) {
  let msg = `Instruction: ${instruction || "(no instruction - clean up the graph: merge duplicates, drop junk nodes, add obvious missing links)"}\nCurrent graph JSON: ${JSON.stringify(graph).slice(0, 8000)}`;
  if (tmplExtra) msg = tmplExtra.replace("{input}", instruction || "").replace("{graph}", JSON.stringify(graph).slice(0, 8000));
  try {
    const out = await agentRun(env, db, msg, SYS_IMPROVE, null);
    return { ops: parseOps(out.text).filter((o) => o.op), turns: out.turns };
  } catch (e) {
    return { ops: [], error: String(e).slice(0, 200) };
  }
}

export async function agentInvestigate(env, db, label, allow) {
  try {
    const out = await agentRun(env, db, `Investigate this entity: ${label}`, SYS_INVEST, allow);
    return { report: out.text, turns: out.turns };
  } catch (e) {
    return { error: String(e).slice(0, 300) };
  }
}

export async function agentDuel(env, db, instruction, graph, allow, directive) {
  const extra = (directive || "").trim() ? `\nUser directive (steers BOTH agents): ${directive}` : "";
  const stdMsg = `Instruction: ${instruction || "standardize this graph"}${extra}\nCurrent graph JSON: ${JSON.stringify(graph).slice(0, 8000)}`;
  let stdOps = [], stdTurns = 0;
  try {
    const std = await agentRun(env, db, stdMsg, STANDARDIZER_SYS, allow);
    stdOps = parseOps(std.text); stdTurns = std.turns;
  } catch (e) {
    return { ops: [], std: [], vision: [], error: String(e).slice(0, 200) };
  }
  const visMsg = `Standardizer plan (respect it, don't undo merges): ${JSON.stringify(stdOps).slice(0, 3000)}${extra}\nCurrent graph JSON: ${JSON.stringify(graph).slice(0, 8000)}`;
  let visOps = [], visTurns = 0;
  try {
    const vis = await agentRun(env, db, visMsg, VISIONARY_SYS, allow);
    visOps = parseOps(vis.text).filter((o) => o.op === "add_node" || o.op === "add_edge").slice(0, 8);
    visTurns = vis.turns;
  } catch (_) { visOps = []; }
  for (const o of stdOps) o.side = "std";
  for (const o of visOps) o.side = "vis";
  return { ops: [...stdOps, ...visOps], std: stdOps, vision: visOps, turns: stdTurns + visTurns };
}

export async function agentZero(env, db, prompt, allow, { budget = 25, ctx = "", history = null } = {}) {
  const t0 = Date.now();
  const tools = toolDefs(allow);
  const trace = [];
  let hist = Array.isArray(history) ? history.filter((m) => m && m.role).slice(0, 30)
    : [{ role: "user", content: (ctx ? ctx + "\n\n" + prompt : prompt) }];
  let turns = 0, text = "", done = false, timedOut = false;
  for (let i = 0; i < Math.max(6, 6); i++) {
    if (Date.now() - t0 > (budget - 4) * 1000) { timedOut = true; break; }
    turns++;
    const remain = Math.max(5, Math.floor(budget - (Date.now() - t0) / 1000) - 1);
    let resp;
    try {
      const r = await fetch(baseUrl(env) + "/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey(env) },
        body: JSON.stringify({ model: model(env), messages: [{ role: "system", content: ZERO_SYS }, ...hist], tools, temperature: 0.2 }),
        signal: AbortSignal.timeout(remain * 1000),
      });
      if (!r.ok) throw new Error(`AI ${r.status}`);
      resp = await r.json();
    } catch (e) {
      trace.push({ turn: turns, error: String(e).slice(0, 200) });
      text = text || "ERROR: " + String(e).slice(0, 200);
      break;
    }
    const calls = extractCalls(resp);
    if (!calls.length) {
      text = extractText(resp);
      trace.push({ turn: turns, calls: [], answer: (text || "").slice(0, 500) });
      done = true;
      break;
    }
    const results = await runTools(calls, db);
    trace.push({ turn: turns, calls: calls.map((c) => ({ name: c.name, arguments: c.arguments })), results: results.map((x) => String(x.result).slice(0, 500)) });
    try { hist.push(resp.choices[0].message); } catch (_) { hist.push({ role: "assistant", content: "" }); }
    for (let k = 0; k < calls.length; k++) {
      hist.push({ role: "tool", tool_call_id: calls[k].call_id, content: JSON.stringify(results[k].result).slice(0, 4000) });
    }
  }
  if (!done && Date.now() - t0 < (budget - 6) * 1000) {
    try {
      const remain = Math.max(5, Math.floor(budget - (Date.now() - t0) / 1000) - 1);
      const r = await fetch(baseUrl(env) + "/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey(env) },
        body: JSON.stringify({ model: model(env), messages: [{ role: "system", content: ZERO_SYS }, ...hist, { role: "user", content: "Tool budget exhausted. Using the tool results above, give your best final answer now (note gaps briefly)." }], temperature: 0.3 }),
        signal: AbortSignal.timeout(remain * 1000),
      });
      const fb = await r.json();
      const t = extractText(fb);
      if (t) { text = t; trace.push({ turn: turns + 1, calls: [], answer: t.slice(0, 500), final: true }); done = true; }
    } catch (e) {
      trace.push({ turn: turns + 1, error: "final-pass: " + String(e).slice(0, 150) });
    }
  }
  if (!done && !text) text = `(paused after ${turns} tool turn(s)${timedOut ? " (time budget hit)" : ""} — press Continue ▶ to resume)`;
  const slim = hist.map((m) => ({ ...m, content: typeof m.content === "string" && m.content.length > 4000 ? m.content.slice(0, 4000) : m.content }));
  return { text, turns, trace, ms: Date.now() - t0, timed_out: timedOut, done, can_continue: !done && !!hist.length, history: slim, model: model(env), tools: [...(allow || DEFAULT_ALLOW)], ctx: !!ctx };
}
