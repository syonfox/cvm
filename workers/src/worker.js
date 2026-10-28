// Cloudflare Worker port of backend/server.py. Same routes, same JSON shapes.
// sqlite -> D1, memcache -> in-memory L1 Map + D1 kv table, exec -> disabled.
// Static frontend (index.html / 0shot.html) is bundled via Text imports so the
// Worker serves the whole app from one isolate pool (uptime: no single box).

import { agentRecommend, agentImprove, agentInvestigate, agentZero, agentDuel, DEFAULT_ALLOW } from "./agent.js";
import { GraphSync } from "./sync.js";
export { GraphSync };
import indexHtml from "../../pwa/index.html";
import shotHtml from "../../pwa/0shot.html";
import viewerHtml from "../../pwa/viewer.html";
import syncClientTxt from "../../pwa/sync-client.txt";
import stylesTxt from "../../pwa/styles.txt";
import manifestWm from "../../pwa/manifest.txt";
import iconSvg from "../../pwa/icon.svg";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS entities (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, kind TEXT, attrs TEXT, embedding TEXT, user TEXT);
CREATE TABLE IF NOT EXISTS relations (id INTEGER PRIMARY KEY AUTOINCREMENT, src TEXT, dst TEXT, rel TEXT, score REAL, evidence TEXT, user TEXT);
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, ip TEXT, created REAL);
CREATE TABLE IF NOT EXISTS graphs (id INTEGER PRIMARY KEY AUTOINCREMENT, user TEXT, text TEXT, nodes TEXT, edges TEXT, flags TEXT, created REAL);
CREATE TABLE IF NOT EXISTS concept_cache (key TEXT PRIMARY KEY, result TEXT, created REAL);
CREATE TABLE IF NOT EXISTS prompts (name TEXT PRIMARY KEY, template TEXT, created REAL);
CREATE TABLE IF NOT EXISTS node_pages (node TEXT NOT NULL, user TEXT NOT NULL DEFAULT '', title TEXT DEFAULT '', kind TEXT DEFAULT '', body TEXT DEFAULT '', updated REAL, PRIMARY KEY (node, user));
CREATE TABLE IF NOT EXISTS node_msgs (id INTEGER PRIMARY KEY AUTOINCREMENT, node TEXT NOT NULL, user TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT 'user', text TEXT NOT NULL DEFAULT '', created REAL);
CREATE INDEX IF NOT EXISTS idx_node_msgs ON node_msgs(node, user, id);
CREATE TABLE IF NOT EXISTS graph_versions (uuid TEXT NOT NULL, version INTEGER NOT NULL, user TEXT, name TEXT, doc TEXT, message TEXT, created REAL, PRIMARY KEY (uuid, version));
CREATE INDEX IF NOT EXISTS idx_graph_versions ON graph_versions(uuid, version);
CREATE TABLE IF NOT EXISTS page_versions (node TEXT NOT NULL, user TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL, title TEXT, kind TEXT, body TEXT, message TEXT, created REAL, PRIMARY KEY (node, user, version));
CREATE INDEX IF NOT EXISTS idx_page_versions ON page_versions(node, user, version);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS feature_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, detail TEXT DEFAULT '', contact TEXT DEFAULT '', votes INTEGER NOT NULL DEFAULT 1, status TEXT DEFAULT 'open', created REAL);
CREATE TABLE IF NOT EXISTS feature_votes (req_id INTEGER NOT NULL, voter TEXT NOT NULL, created REAL, PRIMARY KEY (req_id, voter));
`;

const SEEDS = {
  entity_extract: "You are a CVM (Cache Variable Memory) graph builder. Given free-text input, extract a knowledge graph.\nReturn ONLY valid JSON with keys: nodes (list of {id,label,kind,attrs}) and edges (list of {source,target,rel,score}).\nkinds: Person, Organization, Domain, IP, Location, Event, Concept, Asset.\nInput: {text}",
  concept_define: "Define the concept '{concept}' concisely. Return JSON: {\"name\":...,\"kind\":\"Concept\",\"attrs\":{\"definition\":...,\"aliases\":[],\"related\":[]}}.",
  redteam: "Critique this graph for false correlations, single-source dominance, and contradictions. Return JSON list of {\"issue\":...}.",
  improve: "You are a graph editor. Given the instruction, input text, and current graph JSON, propose improvements. Reply with ONLY a JSON array of ops. Shapes: {\"op\":\"delete_node\",\"id\":..} {\"op\":\"delete_edge\",\"source\":..,\"target\":..} {\"op\":\"add_node\",\"id\":..,\"label\":..,\"kind\":..} {\"op\":\"add_edge\",\"source\":..,\"target\":..,\"rel\":..} {\"op\":\"rename_node\",\"id\":..,\"label\":..} {\"op\":\"set_attr\",\"id\":..,\"key\":..,\"value\":..}. Instruction: {input} Graph: {graph}",
};

let dbReady = null;
async function ensureDb(env) {
  if (!dbReady) {
    dbReady = (async () => {
      for (const stmt of SCHEMA.split(";").map((s) => s.trim()).filter(Boolean)) {
        await env.DB.prepare(stmt).run();
      }
      const now = Date.now() / 1000;
      for (const [n, t] of Object.entries(SEEDS)) {
        await env.DB.prepare("INSERT OR IGNORE INTO prompts(name,template,created) VALUES(?,?,?)").bind(n, t, now).run();
      }
    })().catch((e) => { dbReady = null; throw e; });
  }
  return dbReady;
}

// ---- L1 cache (per-isolate Map with TTL; D1 is L2) ----
const L1 = new Map();
function l1Get(k) {
  const v = L1.get(k);
  if (!v) return null;
  if (v.exp < Date.now()) { L1.delete(k); return null; }
  return v.val;
}
function l1Set(k, val, ttlMs = 300000) {
  if (L1.size > 2000) for (const key of L1.keys().slice(0, 200)) L1.delete(key);
  L1.set(k, { val, exp: Date.now() + ttlMs });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type,X-Username,X-Auth-Token" } });
}
function html(body) {
  return new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}
function checkAuth(req, env) {
  if (!env.AUTH_TOKEN) return true;
  const a = req.headers.get("X-Auth-Token") || "";
  if (a.length !== env.AUTH_TOKEN.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ env.AUTH_TOKEN.charCodeAt(i);
  return d === 0;
}
const RL = new Map();
function rateAllow(key, perMin = 60) {
  const now = Date.now();
  const lst = (RL.get(key) || []).filter((x) => now - x < 60000);
  if (lst.length >= perMin) { RL.set(key, lst); return false; }
  lst.push(now); RL.set(key, lst);
  return true;
}
function toolsAllow(body) {
  const t = body.tools || {};
  const allow = new Set(["graph_search"]);
  if (t.web !== false) { allow.add("web_search"); allow.add("fetch_url"); }
  // exec intentionally never allowed on Workers (no subprocess)
  return allow;
}
async function aiCacheKey(route, body, env) {
  const raw = JSON.stringify({ r: route, n: body.nodes, e: body.edges, i: body.input || body.instruction || body.label, t: body.tools, m: env.AI_MODEL || "muse-spark-1.3" });
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return "ai:" + [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}
async function cacheGet(env, key) {
  const hit = l1Get(key);
  if (hit) return hit;
  const row = await env.DB.prepare("SELECT result FROM concept_cache WHERE key=?").bind(key).first();
  if (!row) return null;
  try {
    const v = JSON.parse(row.result);
    l1Set(key, v);
    return v;
  } catch (_) { return null; }
}
async function cacheSet(env, key, val) {
  l1Set(key, val);
  await env.DB.prepare("INSERT OR REPLACE INTO concept_cache(key,result,created) VALUES(?,?,?)").bind(key, JSON.stringify(val), Date.now() / 1000).run();
}
async function getUser(env, body, req) {
  const u = (body && body.username) || req.headers.get("X-Username");
  const ip = req.headers.get("CF-Connecting-IP") || "unknown";
  const name = u || "ip:" + ip;
  await env.DB.prepare("INSERT OR IGNORE INTO users(username,ip,created) VALUES(?,?,?)").bind(name, ip, Date.now() / 1000).run();
  return name;
}
function similarity(a, b) {
  const sa = new Set(String(a).toLowerCase().split(/\s+/).filter(Boolean));
  const sb = new Set(String(b).toLowerCase().split(/\s+/).filter(Boolean));
  if (!sa.size || !sb.size) return 0;
  const inter = [...sa].filter((x) => sb.has(x)).length;
  return inter / new Set([...sa, ...sb]).size;
}
function adversarialCheck(nodes, edges) {
  const flags = [];
  const srcs = {};
  for (const e of edges) srcs[e.source] = (srcs[e.source] || 0) + 1;
  for (const [n, c] of Object.entries(srcs)) if (c > 5) flags.push({ node: n, issue: "high-degree hub (possible false correlation)" });
  const kinds = {};
  for (const n of nodes) kinds[n.kind] = (kinds[n.kind] || 0) + 1;
  const vals = Object.values(kinds);
  if (nodes.length && Math.max(...vals) / nodes.length > 0.7) flags.push({ issue: "homogeneous node types (low diversity)" });
  return flags;
}
async function aiChat(env, prompt) {
  const key = env.MODEL_API_KEY || env.AI_API_KEY || "";
  if (!key) return null;
  const base = (env.AI_BASE_URL || "https://api.meta.ai/v1").replace(/\/$/, "");
  try {
    const r = await fetch(base + "/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
      body: JSON.stringify({ model: env.AI_MODEL || "muse-spark-1.3", messages: [{ role: "user", content: prompt }], temperature: 0.2 }),
      signal: AbortSignal.timeout(55000),
    });
    const j = await r.json();
    return j.choices?.[0]?.message?.content ?? null;
  } catch (e) {
    return "AI_ERROR: " + String(e).slice(0, 200);
  }
}
function parseLooseJson(ai) {
  if (!ai || ai.startsWith("AI_ERROR")) return null;
  try {
    let s = ai.trim();
    if (s.startsWith("```")) { s = s.split("```")[1] || ""; if (s.startsWith("json")) s = s.slice(4); }
    return JSON.parse(s.trim());
  } catch (_) { return null; }
}
async function defineConcept(env, concept) {
  const key = "concept:" + concept.toLowerCase().trim();
  const cached = await cacheGet(env, key);
  if (cached) return cached;
  const tpl = (await env.DB.prepare("SELECT template FROM prompts WHERE name='concept_define'").first())?.template || "";
  const ai = await aiChat(env, tpl.replace("{concept}", concept));
  const obj = parseLooseJson(ai);
  const res = obj || { name: concept, kind: "Concept", attrs: { definition: ai || concept } };
  await cacheSet(env, key, res);
  return res;
}
async function buildNetwork(env, text, user, schema) {
  let tpl = (await env.DB.prepare("SELECT template FROM prompts WHERE name='entity_extract'").first())?.template || "";
  if (schema && (schema.types || schema.constraints)) {
    tpl += "\n\n[STRUCTURED MODE — extract ONLY entities whose kind is one of: "
      + (schema.types || "(any, but keep kinds tight)")
      + ". Additional constraints: " + (schema.constraints || "none")
      + (schema.definition ? ". Data description: " + schema.definition : "")
      + ". Skip anything that does not fit. Put provided constraints in attrs.]";
  }
  const ai = await aiChat(env, tpl.replace("{text}", text));
  const obj = parseLooseJson(ai);
  let nodes = obj?.nodes || [], edges = obj?.edges || [];
  if (!nodes.length) {
    const toks = text.split(/\s+/).filter((w) => w.length > 3);
    toks.slice(0, 12).forEach((t, i) => nodes.push({ id: `n${i}`, label: t, kind: "Concept", attrs: {} }));
    for (let i = 0; i < nodes.length - 1; i++) edges.push({ source: nodes[i].id, target: nodes[i + 1].id, rel: "co-occurs", score: 0.4 });
  }
  for (let i = 0; i < nodes.length; i++) {
    nodes[i].offset = i;
    if (nodes[i].kind === "Concept") {
      const d = await defineConcept(env, nodes[i].label);
      nodes[i].attrs = { ...(nodes[i].attrs || {}), ...(d.attrs || {}) };
    }
  }
  for (const n of nodes) {
    const hits = await env.DB.prepare("SELECT name FROM entities WHERE (name LIKE ? OR attrs LIKE ?) AND (user IS NULL OR user=?)").bind(`%${n.label}%`, `%${n.label}%`, user).all();
    const rows = hits.results || [];
    n.attrs = n.attrs || {};
    n.attrs.db_hits = rows.length;
    for (const h of rows) {
      if (h.name !== n.label) edges.push({ source: n.id, target: h.name, rel: "similar-to (db)", score: Math.round(similarity(n.label, h.name) * 100) / 100 });
    }
  }
  // structured ingest step 3: one row per entity in the user table
  let tableInfo = null;
  if (schema?.table) {
    const tname = String(schema.table).toLowerCase().replace(/[^a-z0-9_-]+/g, "_").slice(0, 60) || "entities";
    const fields = Array.isArray(schema.fields) && schema.fields.length ? schema.fields : [{ name: "label", type: "text" }, { name: "kind", type: "type" }];
    await env.DB.prepare("INSERT OR IGNORE INTO user_tables(name,fields,constraints_text,user,created) VALUES(?,?,?,?,?)").bind(tname, JSON.stringify(fields), schema.constraints || "", user, Date.now() / 1000).run();
    const t = await env.DB.prepare("SELECT id FROM user_tables WHERE name=? AND user=?").bind(tname, user).first();
    tableInfo = { table: { id: t?.id, name: tname, fields } };
    if (t) for (const n of nodes) {
      const row = { label: n.label, kind: n.kind, ...Object.fromEntries(Object.entries(n.attrs || {}).filter(([, v]) => ["string", "number", "boolean"].includes(typeof v))) };
      await env.DB.prepare("INSERT INTO table_rows(table_id,row,user,created) VALUES(?,?,?,?)").bind(t.id, JSON.stringify(row), user, Date.now() / 1000).run();
    }
  }
  const now = Date.now() / 1000;
  for (const n of nodes) await env.DB.prepare("INSERT INTO entities(name,kind,attrs,user) VALUES(?,?,?,?)").bind(n.label, n.kind, JSON.stringify(n.attrs || {}), user).run();
  for (const e of edges) await env.DB.prepare("INSERT INTO relations(src,dst,rel,score,evidence,user) VALUES(?,?,?,?,?,?)").bind(e.source, e.target, e.rel, e.score || 0.5, "", user).run();
  const flags = adversarialCheck(nodes, edges);
  for (const n of nodes) n.data = { id: n.id, label: n.label, kind: n.kind, offset: n.offset || 0 };
  for (const e of edges) e.data = { source: e.source, target: e.target, label: e.rel, score: e.score || 0.5 };
  await env.DB.prepare("INSERT INTO graphs(user,text,nodes,edges,flags,created) VALUES(?,?,?,?,?,?)").bind(user, text, JSON.stringify(nodes), JSON.stringify(edges), JSON.stringify(flags), now).run();
  return { nodes, edges, adversarial: flags, ai_raw: ai, user, table: tableInfo };
}

// ---- minimal sqlite3 writer: rowid tables, leaf pages + single interior root ----
// TEXT (UTF-8), REAL, INTEGER, NULL only. No indexes. Callee truncates; throws past ~40k rows/table.
const _PS = 4096;
function _varint(v) {
  if (v < 0 || !Number.isSafeInteger(v)) throw new Error("bad varint");
  if (v === 0) return [0];
  const out = [];
  while (v > 0) { out.unshift(v & 0x7f); v = Math.floor(v / 128); }
  for (let i = 0; i < out.length - 1; i++) out[i] |= 0x80;
  return out;
}
function _beInt(v, n) {
  const b = new Array(n);
  for (let i = n - 1; i >= 0; i--) { b[i] = v & 0xff; v = Math.floor(v / 256); }
  return b;
}
function _intSerial(v) {
  if (v === 0) return [8, []];
  if (v === 1) return [9, []];
  for (const [n, st] of [[1, 1], [2, 2], [3, 3], [4, 4], [6, 5], [8, 6]]) {
    if (v >= -(2 ** (8 * n - 1)) && v <= 2 ** (8 * n - 1) - 1) {
      let u = v < 0 ? v + 2 ** (8 * n) : v;
      return [st, _beInt(u, n)];
    }
  }
  throw new Error("int too big");
}
function _record(vals) {
  const serials = [], bdy = [];
  const te = new TextEncoder();
  for (const v of vals) {
    if (v === null || v === undefined) serials.push(0);
    else if (typeof v === "number") {
      if (Number.isInteger(v)) { const [st, b] = _intSerial(v); serials.push(st); bdy.push(...b); }
      else { serials.push(7); const buf = new ArrayBuffer(8); new DataView(buf).setFloat64(0, v, false); bdy.push(...new Uint8Array(buf)); }
    } else { const raw = te.encode(String(v)); serials.push(13 + raw.length * 2); bdy.push(...raw); }
  }
  const hdr = [];
  for (const st of serials) hdr.push(..._varint(st));
  return [..._varint(hdr.length + 1), ...hdr, ...bdy];
}
function _leaf(pack, base) {
  // pack: [{cell:[..], rowid}] -> {pg, count}
  const pg = new Uint8Array(_PS), dv = new DataView(pg.buffer);
  let area = _PS;
  const ptrs = pack.map((p) => { area -= p.cell.length; return area; });
  const o = base;
  pg[o] = 0x0d;
  dv.setUint16(o + 1, 0); dv.setUint16(o + 3, pack.length); dv.setUint16(o + 5, area); pg[o + 7] = 0;
  for (let i = 0; i < pack.length; i++) { dv.setUint16(o + 8 + 2 * i, ptrs[i]); pg.set(pack[i].cell, ptrs[i]); }
  return { pg, count: pack.length };
}
function buildDb(tables) {
  const enc = (rowid, payload) => [..._varint(payload.length), ..._varint(rowid), ...payload];
  const packRows = (rows) => {
    const pages = [];
    let cur = [], used = 0;
    const cap = _PS - 8;
    rows.forEach((r, k) => {
      const cell = enc(k + 1, _record(r));
      if (cell.length + 2 > cap) throw new Error("single row too large (" + cell.length + " bytes)");
      if (used + cell.length + 2 > cap && cur.length) { pages.push(cur); cur = []; used = 0; }
      cur.push({ cell }); used += cell.length + 2;
    });
    if (cur.length) pages.push(cur);
    return pages.map((p) => _leaf(p, 0));
  };
  const blobs = [], master = [];
  let next = 2;
  for (const t of tables) {
    const leaves = packRows(t.rows);
    if (leaves.length > 600) throw new Error("table " + t.name + " too large");
    if (leaves.length <= 1) {
      const lp = leaves.length ? leaves[0] : _leaf([], 0);
      blobs.push({ page: next, bytes: lp.pg });
      master.push(["table", t.name, t.name, next, t.sql]); next++;
    } else {
      const nos = leaves.map(() => next++);
      const root = next++;
      let acc = 0;
      const kids = leaves.map((l, i) => { acc += l.count; return { page: nos[i], maxKey: acc }; });
      const rp = new Uint8Array(_PS), dv = new DataView(rp.buffer);
      rp[0] = 0x05;
      let area = _PS;
      const cells = kids.slice(0, -1).map((k) => [..._beInt(k.page, 4), ..._varint(k.maxKey)]);
      const ptrs = cells.map((c) => { area -= c.length; return area; });
      dv.setUint16(1, 0); dv.setUint16(3, cells.length); dv.setUint16(5, area); rp[7] = 0;
      dv.setUint32(8, kids[kids.length - 1].page);
      for (let i = 0; i < cells.length; i++) { dv.setUint16(12 + 2 * i, ptrs[i]); rp.set(cells[i], ptrs[i]); }
      leaves.forEach((l, i) => blobs.push({ page: nos[i], bytes: l.pg }));
      blobs.push({ page: root, bytes: rp });
      master.push(["table", t.name, t.name, root, t.sql]);
    }
  }
  const total = next - 1;
  const file = new Uint8Array(_PS * total);
  const hdr = new Uint8Array(100);
  hdr.set(new TextEncoder().encode("SQLite format 3\0"), 0);
  const dv = new DataView(hdr.buffer);
  dv.setUint16(16, _PS); dv.setUint8(18, 1); dv.setUint8(19, 1);
  dv.setUint8(21, 64); dv.setUint8(22, 32); dv.setUint8(23, 32);
  dv.setUint32(28, total); dv.setUint32(40, 4); dv.setUint32(56, 1);
  const mCells = master.map((r, i) => ({ cell: enc(i + 1, _record(r)) }));
  const mp = _leaf(mCells, 100).pg;
  file.set(hdr, 0); file.set(mp.slice(100), 100);
  for (const b of blobs) file.set(b.bytes, _PS * (b.page - 1));
  return file;
}
const OFFLINE_SCHEMA = [
  { name: "meta", sql: "CREATE TABLE meta(k TEXT, v TEXT)" },
  { name: "nodes", sql: "CREATE TABLE nodes(id TEXT, label TEXT, kind TEXT, layer TEXT, attrs TEXT)" },
  { name: "edges", sql: "CREATE TABLE edges(source TEXT, target TEXT, rel TEXT, score REAL)" },
  { name: "flags", sql: "CREATE TABLE flags(node TEXT, issue TEXT)" },
  { name: "pages", sql: "CREATE TABLE pages(key TEXT, title TEXT, kind TEXT, body TEXT, updated REAL)" },
  { name: "chat", sql: "CREATE TABLE chat(node TEXT, role TEXT, text TEXT, created REAL)" },
];
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return json({});
    try { await ensureDb(env); } catch (e) { return json({ ok: false, error: "db init: " + String(e).slice(0, 200) }, 500); }

    // ---- static ----
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) return html(indexHtml);
    if (req.method === "GET" && url.pathname === "/0shot.html") return html(shotHtml);
    if (req.method === "GET" && (url.pathname === "/viewer" || url.pathname === "/viewer.html")) return html(viewerHtml);
    if (req.method === "GET" && (url.pathname === "/sync-client.js" || url.pathname === "/sync-client.txt"))
      return new Response(syncClientTxt, { headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "public, max-age=300" } });
    if (req.method === "GET" && (url.pathname === "/styles.css" || url.pathname === "/styles.txt"))
      return new Response(stylesTxt, { headers: { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "public, max-age=300" } });
    if (req.method === "GET" && url.pathname === "/manifest.webmanifest")
      return new Response(manifestWm, { headers: { "Content-Type": "application/manifest+json; charset=utf-8", "Cache-Control": "public, max-age=300" } });
    if (req.method === "GET" && (url.pathname === "/icon.svg" || url.pathname === "/favicon.ico"))
      return new Response(iconSvg, { headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" } });
    if (req.method === "GET" && url.pathname === "/health") return json({ status: "ok", runtime: "cloudflare-workers" });
    if (req.method === "GET" && url.pathname === "/info") return json({ lan_ip: null, public_ip: null, port: 443, exec_mode: "disabled", runtime: "cloudflare-workers" });
    if (req.method === "GET" && url.pathname.startsWith("/search")) {
      const q = url.searchParams.get("q") || "";
      const r = await env.DB.prepare("SELECT name,kind,attrs FROM entities WHERE name LIKE ? LIMIT 20").bind(`%${q}%`).all();
      return json({ results: (r.results || []).map((x) => ({ name: x.name, kind: x.kind, attrs: JSON.parse(x.attrs || "{}") })) });
    }
    if (req.method === "GET" && url.pathname === "/api/agent-manifest") {
      return json({
        name: "cvm", version: 3, runtime: "cloudflare-workers",
        tools: [
          { name: "build", method: "POST /build", in: { text: "str" }, out: "{nodes,edges,adversarial}" },
          { name: "recommend", method: "POST /recommend", in: { nodes: [], edges: [], tools: { web: true } }, out: "{ok,recs,tools,ms,cached}" },
          { name: "improve", method: "POST /improve", in: { input: "str", nodes: [], edges: [], tools: {}, prompt: "optional" }, out: "{ok,ops,tools,ms,cached}" },
          { name: "duel", method: "POST /duel", in: { input: "str", directive: "str", nodes: [], edges: [], tools: {} }, out: "{ok,ops,std,vision,tools,ms,cached}" },
          { name: "investigate", method: "POST /investigate", in: { label: "str", tools: {} }, out: "{ok,report,turns,ms}" },
          { name: "graph", method: "GET /api/graph?user=", out: "{nodes,edges}" },
          { name: "node-page", method: "GET|POST /api/node-page", out: "{node,title,kind,body,updated}" },
          { name: "node-chat", method: "GET|POST /api/node-chat", out: "{msgs}" },
          { name: "export", method: "GET /api/export?format=jsonld|cyjs", out: "graph file" },
          { name: "export-offline", method: "POST /api/export/offline", in: "{uuid?,doc?}", out: "sqlite .db (meta,nodes,edges,flags,pages,chat)" },
        ],
        notes: "exec is disabled on Workers (no subprocess). tools.web gates web_search+fetch_url.",
      });
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/graph/versions")) {
      const uuid = url.searchParams.get("uuid") || "";
      const r = await env.DB.prepare("SELECT version,user,name,message,created,LENGTH(doc) AS bytes FROM graph_versions WHERE uuid=? ORDER BY version DESC LIMIT 50").bind(uuid).all();
      return json({ versions: r.results || [] });
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/graph")) {
      const gid = url.searchParams.get("id") || url.searchParams.get("uuid") || "";
      if (gid) {
        const v = url.searchParams.get("v") || "";
        const row = v
          ? await env.DB.prepare("SELECT version,user,name,doc,message,created FROM graph_versions WHERE uuid=? AND version=?").bind(gid, Number(v)).first()
          : await env.DB.prepare("SELECT version,user,name,doc,message,created FROM graph_versions WHERE uuid=? ORDER BY version DESC LIMIT 1").bind(gid).first();
        if (!row) return json({ ok: false, error: "unknown graph id" });
        return json({ ok: true, uuid: gid, version: row.version, user: row.user, name: row.name, doc: JSON.parse(row.doc), message: row.message, created: row.created });
      }
      const u = url.searchParams.get("user") || "";
      const row = await env.DB.prepare("SELECT nodes,edges,flags FROM graphs WHERE user=? ORDER BY id DESC LIMIT 1").bind(u).first();
      if (row) return json({ nodes: JSON.parse(row.nodes), edges: JSON.parse(row.edges), flags: JSON.parse(row.flags) });
      return json({ nodes: [], edges: [], flags: [] });
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/export")) {
      const fmt = url.searchParams.get("format") || "cyjs";
      const row = await env.DB.prepare("SELECT nodes,edges FROM graphs ORDER BY id DESC LIMIT 1").first();
      const nodes = row ? JSON.parse(row.nodes) : [], edges = row ? JSON.parse(row.edges) : [];
      if (fmt === "jsonld") return json({ "@context": "https://schema.org", "@graph": nodes.map((n) => ({ "@type": n.kind, name: n.label, identifier: n.id })) });
      return json({ elements: { nodes: nodes.map((n) => ({ data: { id: n.id, label: n.label } })), edges: edges.map((e) => ({ data: { source: e.source, target: e.target, label: e.rel } })) } });
    }
    if (req.method === "GET" && url.pathname === "/prompts") {
      const r = await env.DB.prepare("SELECT name,template FROM prompts").all();
      return json({ prompts: (r.results || []).map((x) => ({ name: x.name, template: x.template })) });
    }
    if (req.method === "GET" && url.pathname.startsWith("/graphs")) {
      const u = url.searchParams.get("user") || "";
      const r = await env.DB.prepare("SELECT id,text,created FROM graphs WHERE user=? ORDER BY id DESC LIMIT 20").bind(u).all();
      return json({ graphs: (r.results || []).map((x) => ({ id: x.id, text: x.text, created: x.created })) });
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/node-page/versions")) {
      const node = url.searchParams.get("node") || "", user = url.searchParams.get("user") || "", label = url.searchParams.get("label") || "";
      const norm = (" " + (label || node).toLowerCase() + " ").replace(/\s+/g, " ").trim();
      const ck = norm ? "concept:" + norm : node;
      const cands = [[node, user]].concat(ck !== node ? [[ck, user]] : []).concat([[ck, ""]]);
      for (const [vn, vu] of cands) {
        const r = await env.DB.prepare("SELECT version,title,kind,message,created,LENGTH(body) AS bytes FROM page_versions WHERE node=? AND user=? ORDER BY version DESC LIMIT 50").bind(vn, vu).all();
        if ((r.results || []).length) return json({ node, key: vn, shared: vu === "", versions: r.results });
      }
      return json({ node, key: ck, shared: true, versions: [] });
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/node-page/version")) {
      const node = url.searchParams.get("node") || "", user = url.searchParams.get("user") || "", label = url.searchParams.get("label") || "";
      const v = Number(url.searchParams.get("v") || 0);
      const norm = (" " + (label || node).toLowerCase() + " ").replace(/\s+/g, " ").trim();
      const ck = norm ? "concept:" + norm : node;
      const cands = [[node, user]].concat(ck !== node ? [[ck, user]] : []).concat([[ck, ""]]);
      for (const [vn, vu] of cands) {
        const row = await env.DB.prepare("SELECT title,kind,body,message,created FROM page_versions WHERE node=? AND user=? AND version=?").bind(vn, vu, v).first();
        if (row) return json({ ok: true, node, key: vn, version: v, ...row });
      }
      return json({ ok: false, error: "unknown page version" });
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/node-page")) {
      const node = url.searchParams.get("node") || "", user = url.searchParams.get("user") || "", label = url.searchParams.get("label") || "";
      const norm = (" " + (label || node).toLowerCase() + " ").replace(/\s+/g, " ").trim().replace(/^["']+|["']+$/g, "");
      const ck = norm ? "concept:" + norm : node;
      let row = await env.DB.prepare("SELECT title,kind,body,updated FROM node_pages WHERE node=? AND user=?").bind(node, user).first();
      if (row) return json({ node, key: node, shared_key: ck, shared: false, ...row });
      if (ck !== node) { row = await env.DB.prepare("SELECT title,kind,body,updated FROM node_pages WHERE node=? AND user=?").bind(ck, user).first(); if (row) return json({ node, key: ck, shared_key: ck, shared: false, ...row }); }
      row = await env.DB.prepare("SELECT title,kind,body,updated FROM node_pages WHERE node=? AND user=?").bind(ck, "").first();
      if (row) return json({ node, key: ck, shared_key: ck, shared: true, ...row });
      // Wikipedia seed for common concepts (best-effort, cached as shared row)
      const term = (label || node).replace(/^concept:/, "").trim();
      if (term && term.length <= 120) {
        try {
          const wr = await fetch("https://en.wikipedia.org/api/rest_v1/page/summary/" + encodeURIComponent(term.replace(/ /g, "_")), { headers: { "User-Agent": "cvm-living-pages/1.0" } });
          if (wr.ok) {
            const wj = await wr.json();
            if (wj.extract) {
              const title = wj.title || term;
              const pageUrl = wj.content_urls?.desktop?.page || ("https://en.wikipedia.org/wiki/" + encodeURIComponent(title.replace(/ /g, "_")));
              const body = String(wj.extract).slice(0, 4000) + `\n\n— Source: Wikipedia “${title}” (${pageUrl}) — expand with your own notes above this line.`;
              const now = Date.now() / 1000;
              await env.DB.prepare("INSERT INTO node_pages(node,user,title,kind,body,updated) VALUES(?,?,?,?,?,?) ON CONFLICT(node,user) DO UPDATE SET title=excluded.title,kind=excluded.kind,body=excluded.body,updated=excluded.updated").bind(ck, "", title, "", body, now).run();
              return json({ node, key: ck, shared_key: ck, shared: true, seeded: "wikipedia", url: pageUrl, title, kind: "", body, updated: now });
            }
          }
        } catch (_) {}
      }
      return json({ node, key: ck, shared_key: ck, shared: true, title: "", kind: "", body: "", updated: 0 });
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/node-chat")) {
      const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get("limit") || "200", 10) || 200));
      let cnode = url.searchParams.get("node") || "";
      const clabel = url.searchParams.get("label") || "";
      if (clabel) { const n2 = (" " + clabel.toLowerCase() + " ").replace(/\s+/g, " ").trim(); if (n2) cnode = "concept:" + n2; }
      const r = await env.DB.prepare("SELECT id,role,text,created FROM node_msgs WHERE node=? AND user=? ORDER BY id ASC LIMIT ?").bind(cnode, url.searchParams.get("user") || "", limit).all();
      return json({ msgs: (r.results || []).map((m) => ({ id: m.id, role: m.role, text: m.text, created: m.created })) });
    }
    if (req.method === "GET" && url.pathname === "/api/features") {
      const lim = Math.min(200, Math.max(1, parseInt(url.searchParams.get("limit") || "100", 10) || 100));
      const r = await env.DB.prepare("SELECT id,title,detail,contact,votes,status,created FROM feature_requests ORDER BY votes DESC, id DESC LIMIT ?").bind(lim).all();
      return json({ ok: true, requests: r.results || [], email: "edge has no SMTP — votes stored, wire a mail webhook for notify" });
    }

    // ---- redundant sync servers: DO (#1, realtime) + SpacetimeDB (#2, durable) ----
    // Clients race both and show which acked first.
    if (url.pathname === "/api/sync/ws" || url.pathname === "/api/sync/state" || url.pathname === "/api/sync/publish") {
      if (!env.GRAPH_SYNC) return json({ ok: false, error: "GRAPH_SYNC binding missing (add [[durable_objects]] to wrangler.toml)" }, 500);
      const uuid = url.pathname === "/api/sync/publish"
        ? "" // uuid comes from POST body; route by a temp id then re-route inside DO
        : (url.searchParams.get("uuid") || "default");
      // For publish-by-POST we still need a DO id: peek body uuid without consuming for DO fetch.
      // Simplest: always route via the uuid (query or body) to the per-graph stub.
      let target = uuid;
      if (url.pathname === "/api/sync/publish" && req.method === "POST") {
        try {
          const peek = await req.clone().json();
          target = (peek.uuid || "default").trim() || "default";
        } catch (_) { target = "default"; }
      }
      const id = env.GRAPH_SYNC.idFromName("graph:" + target);
      const stub = env.GRAPH_SYNC.get(id);
      const fwd = new URL(req.url);
      if (url.pathname === "/api/sync/ws") fwd.pathname = "/api/sync/ws";
      else if (url.pathname === "/api/sync/state") fwd.pathname = "/api/sync/state";
      else fwd.pathname = "/api/sync/publish";
      return stub.fetch(new Request(fwd.toString(), req));
    }
    if (url.pathname === "/api/spacetime/publish") {
      // Real proxy: browser -> Worker -> SpacetimeDB reducer. Creds stay server-side.
      if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
      const host = (env.SPACETIME_HOST || "").replace(/\/$/, "");
      if (!host) return json({ ok: false, skipped: true, via: "spacetime", reason: "SPACETIME_HOST not configured" });
      let body = {};
      try { body = await req.json(); } catch (_) {}
      const db = env.SPACETIME_DB || "osintdb";
      try {
        const r = await fetch(`${host}/v1/database/${db}/call/ingest_snapshot`, {
          method: "POST",
          headers: { "Content-Type": "application/json",
            ...(env.SPACETIME_TOKEN ? { Authorization: "Bearer " + env.SPACETIME_TOKEN } : {}) },
          body: JSON.stringify({ snapId: String(body.uuid || ""), data: JSON.stringify(body.doc || {}).slice(0, 20000), user: "" }),
          signal: AbortSignal.timeout(15000),
        });
        const txt = await r.text();
        if (!r.ok) return json({ ok: false, via: "spacetime", error: txt.slice(0, 200), host });
        return json({ ok: true, via: "spacetime", host, upstream: txt.slice(0, 200) });
      } catch (e) {
        return json({ ok: false, via: "spacetime", error: String(e).slice(0, 200), host });
      }
    }
    if (req.method === "GET" && url.pathname === "/api/sync/ping") return json({ ok: true, via: "do", at: Date.now() });
    if (req.method === "GET" && url.pathname === "/api/tables") {
      const user = url.searchParams.get("user") || "", tname = url.searchParams.get("table") || "";
      const t = await env.DB.prepare("SELECT id, fields FROM user_tables WHERE name=? AND user=?").bind(tname, user).first();
      if (!t) return json({ ok: false, error: "table not found", rows: [] });
      const rr = await env.DB.prepare("SELECT id, row FROM table_rows WHERE table_id=? ORDER BY id").bind(t.id).all();
      const fields = JSON.parse(t.fields || "[]");
      const rows = (rr.results || []).map((r) => ({ id: r.id, ...JSON.parse(r.row || "{}") }));
      const sort = fields.some((f) => f.name === url.searchParams.get("sort")) ? url.searchParams.get("sort") : "id";
      rows.sort((a, b) => String(a[sort] ?? "").toLowerCase().localeCompare(String(b[sort] ?? "").toLowerCase()));
      return json({ ok: true, table: tname, fields, sort, rows });
    }

    // ---- POST ----
    if (req.method === "POST") {
      let body = {};
      try { body = await req.json(); } catch (_) {}
      const ip = req.headers.get("CF-Connecting-IP") || "unknown";
      if (!rateAllow("ip:" + ip, 120)) return json({ ok: false, error: "rate limited, slow down" }, 429);

      if (url.pathname === "/login") {
        const tok = body.token || "";
        if (env.AUTH_TOKEN && tok !== env.AUTH_TOKEN) return json({ ok: false, error: "bad token" });
        const uname = (body.username || "").trim() || "anon";
        await env.DB.prepare("INSERT OR IGNORE INTO users(username,ip,created) VALUES(?,?,?)").bind(uname, ip, Date.now() / 1000).run();
        return json({ ok: true, user: uname });
      }
      if (url.pathname === "/build") {
        if (!checkAuth(req, env)) return json({ error: "unauthorized: bad/missing token" }, 401);
        const user = await getUser(env, body, req);
        return json(await buildNetwork(env, body.text || "", user, body.schema || null));
      }
      if (url.pathname === "/api/tables" || url.pathname === "/api/tables/rows") {
        const user = await getUser(env, body, req);
        const parseFields = (raw) => {
          const list = Array.isArray(raw) ? raw : String(raw || "").split(",").map((s) => s.trim()).filter(Boolean)
            .map((s) => { const [name, type] = s.split(":"); return { name: (name || "").trim().replace(/\s+/g, "_"), type: (type || "text").trim() }; });
          return (list.length ? list : [{ name: "label", type: "text" }, { name: "kind", type: "type" }]).slice(0, 24);
        };
        const name = String(body.table || "entities").toLowerCase().replace(/[^a-z0-9_-]+/g, "_").slice(0, 60) || "entities";
        const fields = parseFields(body.fields);
        await env.DB.prepare("INSERT INTO user_tables(name,fields,constraints_text,user,created) VALUES(?,?,?,?,?) ON CONFLICT(name,user) DO UPDATE SET fields=excluded.fields, constraints_text=excluded.constraints_text")
          .bind(name, JSON.stringify(fields), body.constraints || "", user, Date.now() / 1000).run();
        const t = await env.DB.prepare("SELECT id FROM user_tables WHERE name=? AND user=?").bind(name, user).first();
        if (url.pathname === "/api/tables") return json({ ok: true, created: true, table: { id: t.id, name, fields, constraints: body.constraints || "" } });
        const rows = body.rows || [body.row || {}];
        for (const r of rows) await env.DB.prepare("INSERT INTO table_rows(table_id,row,user,created) VALUES(?,?,?,?)").bind(t.id, JSON.stringify(r), user, Date.now() / 1000).run();
        return json({ ok: true, inserted: rows.map((row) => ({ table: name, row })) });
      }
      if (url.pathname === "/define") {
        return json(await defineConcept(env, body.concept || ""));
      }
      if (url.pathname === "/recommend") {
        const nodes = body.nodes || [], edges = body.edges || [];
        const user = await getUser(env, body, req);
        const allow = toolsAllow(body);
        const t0 = Date.now();
        const ck = await aiCacheKey("recommend", body, env);
        const hit = await cacheGet(env, ck);
        if (hit) { hit.cached = true; hit.ms = 0; return json(hit); }
        let recs = [];
        try { recs = await agentRecommend(env, env.DB, nodes, user); } catch (_) { recs = []; }
        if (!recs.length) {
          const names = nodes.map((n) => n.label || n.id);
          const have = new Set(edges.map((e) => `${e.source}>${e.target}`));
          for (let i = 0; i < names.length && recs.length < 5; i++) {
            for (let j = i + 1; j < names.length && recs.length < 5; j++) {
              if (have.has(`${names[i]}>${names[j]}`) || have.has(`${names[j]}>${names[i]}`)) continue;
              const s = similarity(names[i], names[j]);
              recs.push({ source: names[i], target: names[j], rel: s > 0.25 ? "similar-to" : "co-occurs", reason: `local heuristic (name-sim ${s})` });
            }
          }
        }
        const out = { ok: true, recs: recs.slice(0, 5), agent: true, ai_configured: !!(env.MODEL_API_KEY || env.AI_API_KEY), model: env.AI_MODEL || "muse-spark-1.3", tools: [...allow], cached: false, ms: Date.now() - t0 };
        if (recs.length) await cacheSet(env, ck, out);
        return json(out);
      }
      if (url.pathname === "/improve") {
        const instruction = body.input || body.instruction || "";
        const allow = toolsAllow(body);
        const t0 = Date.now();
        const ck = await aiCacheKey("improve", body, env);
        const hit = await cacheGet(env, ck);
        if (hit) { hit.cached = true; hit.ms = 0; return json(hit); }
        let tpl = (await env.DB.prepare("SELECT template FROM prompts WHERE name='improve'").first())?.template || "";
        if (body.prompt) {
          await env.DB.prepare("INSERT OR REPLACE INTO prompts(name,template,created) VALUES(?,?,?)").bind("improve", body.prompt, Date.now() / 1000).run();
          tpl = body.prompt;
        }
        const r = await agentImprove(env, env.DB, instruction, { nodes: body.nodes || [], edges: body.edges || [] }, tpl);
        r.ok = true; r.agent = true; r.model = env.AI_MODEL || "muse-spark-1.3";
        r.tools = [...allow]; r.cached = false; r.ms = Date.now() - t0;
        if (r.ops?.length) await cacheSet(env, ck, r);
        return json(r);
      }
      if (url.pathname === "/duel") {
        const allow = toolsAllow(body);
        const t0 = Date.now();
        const ck = await aiCacheKey("duel", body, env);
        const hit = await cacheGet(env, ck);
        if (hit) { hit.cached = true; hit.ms = 0; return json(hit); }
        const r = await agentDuel(env, env.DB, body.input || body.instruction || "", { nodes: body.nodes || [], edges: body.edges || [] }, allow, body.directive || "");
        r.ok = true; r.model = env.AI_MODEL || "muse-spark-1.3";
        r.tools = [...allow]; r.cached = false; r.ms = Date.now() - t0;
        if (r.ops?.length) await cacheSet(env, ck, r);
        return json(r);
      }
      if (url.pathname === "/investigate") {
        const user = await getUser(env, body, req);
        const allow = toolsAllow(body);
        const t0 = Date.now();
        const r = await agentInvestigate(env, env.DB, body.label || body.entity || "", user, allow);
        r.ok = true; r.tools = [...allow]; r.ms = Date.now() - t0;
        return json(r);
      }
      if (url.pathname === "/exec") {
        return json({ ok: false, code: -1, output: "exec disabled on Workers (no subprocess)", mode: "disabled" });
      }
      if (url.pathname === "/zero") {
        const q = body.q || body.prompt || body.text || "";
        if (!q.trim()) return json({ ok: false, error: "empty q" });
        let prompt = q;
        if ((body.format || "") === "json") {
          prompt += "\n[output instruction: reply with ONLY valid JSON, no markdown fences, no prose. Shape: {\"answer\": \"<natural-language user-facing answer>\", \"ops\": [<graph edits>]}. ops use only these shapes: {\"op\":\"add_node\",\"id\":..,\"label\":..,\"kind\":..}, {\"op\":\"add_edge\",\"source\":..,\"target\":..,\"rel\":..}. Only propose ops the user actually described (their connections enrich the graph); make the edits faithfully — same labels, no invented relations. If the user described no graph change, use \"ops\": [].]";
        }
        const user = await getUser(env, body, req);
        const t0 = Date.now();
        try {
          const r = await agentZero(env, env.DB, prompt, new Set(["graph_search", "web_search", "fetch_url"]), { budget: 25, ctx: body.ctx || "", history: body.history || null });
          r.ok = true; r.user = user; r.ms = Date.now() - t0;
          return json(r);
        } catch (e) {
          return json({ ok: false, error: String(e).slice(0, 300), ms: Date.now() - t0 });
        }
      }
      if (url.pathname === "/prompt") {
        await env.DB.prepare("INSERT OR REPLACE INTO prompts(name,template,created) VALUES(?,?,?)").bind(body.name, body.template, Date.now() / 1000).run();
        return json({ ok: true });
      }
      if (url.pathname === "/api/export/offline") {
        // offline snapshot: the graph as the user sees it, as a real sqlite .db
        // (built byte-for-byte in-JS: rowid tables, leaf pages + interior root).
        const user = await getUser(env, body, req);
        let doc = body.doc || { nodes: body.nodes || [], edges: body.edges || [], adversarial: body.adversarial || body.flags || [] };
        let uuid = (body.uuid || "").trim(), name = body.name || "", version = 0, message = "";
        if (uuid && !(doc.nodes || []).length && !(doc.edges || []).length) {
          const v = body.v || "";
          const g = v
            ? await env.DB.prepare("SELECT version,name,doc,message FROM graph_versions WHERE uuid=? AND version=?").bind(uuid, Number(v)).first()
            : await env.DB.prepare("SELECT version,name,doc,message FROM graph_versions WHERE uuid=? ORDER BY version DESC LIMIT 1").bind(uuid).first();
          if (g) { doc = JSON.parse(g.doc); name = g.name || name; version = g.version; message = g.message || ""; }
        }
        if (!uuid) {
          const b = new Uint8Array(16); crypto.getRandomValues(b);
          uuid = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
          const blob = JSON.stringify(doc).slice(0, 500000), now = Date.now() / 1000;
          await env.DB.prepare("INSERT INTO graph_versions(uuid,version,user,name,doc,message,created) VALUES(?,?,?,?,?,?,?)").bind(uuid, 1, user, String(name || "offline export").slice(0, 120), blob, "offline export", now).run();
          version = 1; message = "offline export";
        }
        const nodes = doc.nodes || [], edges = doc.edges || [], flags = doc.adversarial || doc.flags || [];
        const rows = {
          meta: [["app", "cvm-offline"], ["version", "1"], ["exported", String(Date.now() / 1000)], ["uuid", uuid], ["name", String(name || "")], ["graph_version", String(version)], ["message", String(message || "")]],
          nodes: nodes.map((n) => [String(n.id ?? ""), String(n.label ?? ""), String(n.kind ?? ""), String(n.layer ?? ""), JSON.stringify(n.attrs || {}).slice(0, 2000)]),
          edges: edges.map((e) => [String(e.source ?? ""), String(e.target ?? ""), String(e.rel ?? ""), Number(e.score ?? 0.5)]),
          flags: flags.map((f) => (typeof f === "object" ? [String(f.node ?? ""), String(f.issue ?? "")] : ["", String(f)])),
          pages: [], chat: [],
        };
        const labels = [...new Set(nodes.map((n) => String(n.label || n.id || "")).filter(Boolean))];
        for (const lab of labels) {
          const norm = (" " + lab.toLowerCase() + " ").replace(/\s+/g, " ").trim();
          const ck = norm ? "concept:" + norm : lab;
          const pg = await env.DB.prepare("SELECT title,kind,body,updated FROM node_pages WHERE node=? AND user=''").bind(ck).first()
            || await env.DB.prepare("SELECT title,kind,body,updated FROM node_pages WHERE node=? AND user=''").bind(lab).first();
          if (pg) {
            rows.pages.push([ck, String(pg.title || ""), String(pg.kind || ""), String(pg.body || "").slice(0, 8000), Number(pg.updated || 0)]);
            const ms = await env.DB.prepare("SELECT role,text,created FROM node_msgs WHERE node=? ORDER BY id DESC LIMIT 100").bind(ck).all();
            for (const m of (ms.results || [])) rows.chat.push([ck, String(m.role), String(m.text).slice(0, 2000), Number(m.created || 0)]);
          }
        }
        let bytes;
        try {
          bytes = buildDb(OFFLINE_SCHEMA.map((t) => ({ ...t, rows: rows[t.name] || [] })));
        } catch (e) { return json({ ok: false, error: "snapshot too large: " + String(e.message || e).slice(0, 160) }); }
        const short = uuid.slice(0, 8) || "graph";
        return new Response(bytes, { headers: { "Content-Type": "application/x-sqlite3", "Content-Disposition": `attachment; filename="graph-${short}-v${version}.db"`, "Content-Length": String(bytes.length) } });
      }
      if (url.pathname === "/api/graph/commit") {
        const user = await getUser(env, body, req);
        let uuid = (body.uuid || "").trim();
        if (!uuid) { const b = new Uint8Array(16); crypto.getRandomValues(b); uuid = [...b].map((x) => x.toString(16).padStart(2, "0")).join(""); }
        const doc = body.doc || { nodes: body.nodes || [], edges: body.edges || [], adversarial: body.adversarial || body.flags || [] };
        const blob = JSON.stringify(doc).slice(0, 500000);
        const row = await env.DB.prepare("SELECT COALESCE(MAX(version),0) AS m FROM graph_versions WHERE uuid=?").bind(uuid).first();
        const ver = Number(row?.m || 0) + 1, now = Date.now() / 1000;
        await env.DB.prepare("INSERT INTO graph_versions(uuid,version,user,name,doc,message,created) VALUES(?,?,?,?,?,?,?)").bind(uuid, ver, user, String(body.name || "").slice(0, 120), blob, String(body.message || "").slice(0, 300), now).run();
        return json({ ok: true, uuid, version: ver, created: now });
      }
      if (url.pathname === "/api/node-page") {
        const user = await getUser(env, body, req);
        const now = Date.now() / 1000;
        const title = (body.title || "").slice(0, 200), kind = (body.kind || "").slice(0, 40), b = (body.body || "").slice(0, 20000);
        await env.DB.prepare("INSERT INTO node_pages(node,user,title,kind,body,updated) VALUES(?,?,?,?,?,?) ON CONFLICT(node,user) DO UPDATE SET title=excluded.title,kind=excluded.kind,body=excluded.body,updated=excluded.updated").bind(body.node || "", user, title, kind, b, now).run();
        const norm = (" " + String(body.label || body.title || body.node || "").toLowerCase() + " ").replace(/\s+/g, " ").trim();
        const ck = norm ? "concept:" + norm : (body.node || "");
        if (body.shared !== false && ck && ck !== (body.node || "")) {
          await env.DB.prepare("INSERT INTO node_pages(node,user,title,kind,body,updated) VALUES(?,?,?,?,?,?) ON CONFLICT(node,user) DO UPDATE SET title=excluded.title,kind=excluded.kind,body=excluded.body,updated=excluded.updated").bind(ck, "", title, kind, b, now).run();
        }
        const msg = String(body.message || "").slice(0, 300);
        for (const [vn, vu] of [[body.node || "", user]].concat((body.shared !== false && ck && ck !== (body.node || "")) ? [[ck, ""]] : [])) {
          const mx = await env.DB.prepare("SELECT COALESCE(MAX(version),0) AS m FROM page_versions WHERE node=? AND user=?").bind(vn, vu).first();
          await env.DB.prepare("INSERT INTO page_versions(node,user,version,title,kind,body,message,created) VALUES(?,?,?,?,?,?,?,?)").bind(vn, vu, Number(mx?.m || 0) + 1, title, kind, b, msg, now).run();
        }
        return json({ node: body.node || "", key: ck, shared_key: ck, title, kind, body: b, updated: now });
      }
      if (url.pathname === "/api/node-chat") {
        const user = await getUser(env, body, req);
        const role = body.role === "assistant" ? "assistant" : "user";
        const text = (body.text || "").slice(0, 4000);
        if (!text.trim() || !body.node) return json({ ok: false, error: "empty node/text" });
        let cnode = body.node;
        if (body.label) { const n2 = (" " + String(body.label).toLowerCase() + " ").replace(/\s+/g, " ").trim(); if (n2) cnode = "concept:" + n2; }
        const now = Date.now() / 1000;
        const r = await env.DB.prepare("INSERT INTO node_msgs(node,user,role,text,created) VALUES(?,?,?,?,?)").bind(cnode, user, role, text, now).run();
        return json({ ok: true, msg: { id: Number(r.meta.last_row_id), role, text, created: now } });
      }
      if (url.pathname === "/api/features") {
        const title = String(body.title || "").trim().slice(0, 200);
        if (!title) return json({ ok: false, error: "title required" });
        const now = Date.now() / 1000;
        const r = await env.DB.prepare("INSERT INTO feature_requests(title,detail,contact,votes,status,created) VALUES(?,?,?,?,?,?)")
          .bind(title, String(body.detail || "").slice(0, 4000), String(body.contact || body.username || "").slice(0, 200), 1, "open", now).run();
        return json({ ok: true, id: Number(r.meta.last_row_id), votes: 1, email: { sent: false, reason: "smtp-not-configured-on-edge" } });
      }
      if (url.pathname === "/api/features/vote") {
        const reqId = Number(body.id || 0);
        if (!reqId) return json({ ok: false, error: "bad id" });
        const voter = String(body.voter || body.username || req.headers.get("X-Username") || req.headers.get("CF-Connecting-IP") || "anon").slice(0, 120);
        const row = await env.DB.prepare("SELECT id,votes FROM feature_requests WHERE id=?").bind(reqId).first();
        if (!row) return json({ ok: false, error: "unknown request" });
        try {
          await env.DB.prepare("INSERT INTO feature_votes(req_id,voter,created) VALUES(?,?,?)").bind(reqId, voter, Date.now() / 1000).run();
          await env.DB.prepare("UPDATE feature_requests SET votes=votes+1 WHERE id=?").bind(reqId).run();
          const v = await env.DB.prepare("SELECT votes FROM feature_requests WHERE id=?").bind(reqId).first();
          return json({ ok: true, id: reqId, votes: v.votes, duplicate: false });
        } catch (_) {
          return json({ ok: true, id: reqId, votes: row.votes, duplicate: true });
        }
      }
      return new Response("not found", { status: 404 });
    }
    return new Response("not found", { status: 404 });
  },
};
