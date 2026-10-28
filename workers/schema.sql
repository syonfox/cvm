-- D1 schema for CVM (mirrors backend/server.py init_db).
-- Apply: wrangler d1 execute cvm --file workers/schema.sql
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
-- structured ingest: user table = stored definition + JSON rows (mirrors backend user_tables/table_rows)
CREATE TABLE IF NOT EXISTS user_tables (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, fields TEXT NOT NULL DEFAULT '[]', constraints_text TEXT DEFAULT '', user TEXT, created REAL, UNIQUE(name, user));
CREATE TABLE IF NOT EXISTS table_rows (id INTEGER PRIMARY KEY AUTOINCREMENT, table_id INTEGER NOT NULL, row TEXT NOT NULL DEFAULT '{}', user TEXT, created REAL);
CREATE INDEX IF NOT EXISTS idx_table_rows ON table_rows(table_id, id);
