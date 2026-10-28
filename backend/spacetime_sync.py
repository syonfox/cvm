"""SpacetimeDB host shim — modeled on ~/oc/oc local-console pattern.

The local backend NEVER exposes SpacetimeDB credentials to the browser.
Browser -> this backend (/api/spacetime/*) -> SpacetimeDB HTTP route.
memcache.py stays L1; sqlite stays cold backup (see SPACETIMEDB_MIGRATION.md).

Usage (once `spacetime` CLI is pointed at maincloud or local):
    from spacetime_sync import dual_write_entity, dual_write_relation, backfill, proxy_stats

Env:
    SPACETIME_HOST  e.g. https://maincloud.spacetimedb.com
    SPACETIME_DB    e.g. osintdb  (matches spacetime.json database)
    SPACETIME_TOKEN bearer token (server-side only, never sent to client)
"""
import json
import os
import urllib.request

HOST = os.environ.get("SPACETIME_HOST", "https://maincloud.spacetimedb.com")
DB = os.environ.get("SPACETIME_DB", "osintdb")
TOKEN = os.environ.get("SPACETIME_TOKEN", "")


def _call(reducer, args):
    url = f"{HOST}/v1/database/{DB}/call/{reducer}"
    req = urllib.request.Request(url, data=json.dumps(args).encode(),
                                 headers={"Content-Type": "application/json",
                                          **({"Authorization": f"Bearer {TOKEN}"} if TOKEN else {})})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read().decode() or "{}")


def dual_write_entity(name, kind, attrs, user):
    try:
        return _call("ingest_entity", {"name": name, "kind": kind,
                                       "attrs": json.dumps(attrs), "user": user})
    except Exception as e:
        return {"error": str(e)[:200]}


def dual_write_relation(src, dst, rel, score, evidence, user):
    try:
        return _call("ingest_relation", {"src": src, "dst": dst, "rel": rel,
                                         "score": score, "evidence": evidence, "user": user})
    except Exception as e:
        return {"error": str(e)[:200]}


def backfill(sqlite_path="backend/cvm.db", batch=500):
    """One-off: SELECT * per table -> reducer calls in batches (see migration doc §3)."""
    import sqlite3
    con = sqlite3.connect(sqlite_path)
    out = {"entities": 0, "relations": 0}
    for tbl in ("entities", "relations"):
        try:
            rows = con.execute(f"SELECT * FROM {tbl}").fetchall()
        except Exception:
            continue
        cols = [d[0] for d in con.execute(f"SELECT * FROM {tbl} LIMIT 0").description]
        for i in range(0, len(rows), batch):
            for r in rows[i:i + batch]:
                d = dict(zip(cols, r))
                if tbl == "entities":
                    dual_write_entity(d.get("name", ""), d.get("kind", "Concept"),
                                      json.loads(d.get("attrs") or "{}"), d.get("user", ""))
                else:
                    dual_write_relation(d.get("src", ""), d.get("dst", ""), d.get("rel", "related"),
                                        float(d.get("score") or 0), d.get("evidence", ""), d.get("user", ""))
            out[tbl] += len(rows[i:i + batch])
    return out


def proxy_stats():
    return {"host": HOST, "db": DB, "mode": "proxy-only, creds server-side"}
