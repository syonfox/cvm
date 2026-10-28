"""Storage demo: how do full JSON snapshots grow vs deltas vs gzip vs git vs sqlite?

Simulates N versions of a ~50-node graph with small edits per version and
reports total bytes + write time for each strategy:

  a) full JSON file per version            (naive snapshots)
  b) gzipped full JSON per version
  c) incremental delta JSON per version    (base snapshot + per-version diff)
  d) git repo (one commit per version)     (git's own pack/delta compression)
  e) sqlite table of full snapshots       (what CVM uses)

Run:  python3 backend/storage_demo.py [N] [nodes]
"""
import gzip
import json
import os
import random
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time

N = int(sys.argv[1]) if len(sys.argv) > 1 else 200
NNODES = int(sys.argv[2]) if len(sys.argv) > 2 else 50
rnd = random.Random(42)


def gen_graph(n):
    nodes = [{"id": f"n{i}", "label": f"Concept {i} " + "x" * 12,
              "kind": rnd.choice(["Person", "Concept", "Location", "Event"]),
              "attrs": {"note": "lorem ipsum dolor sit amet " * 4, "v": 0}} for i in range(n)]
    edges = [{"source": f"n{rnd.randrange(n)}", "target": f"n{rnd.randrange(n)}",
              "rel": rnd.choice(["knows", "near", "owns", "cites"])} for _ in range(n)]
    return {"nodes": nodes, "edges": edges}


def mutate(doc):
    d = json.loads(json.dumps(doc))
    for _ in range(3):
        n = rnd.choice(d["nodes"])
        n["attrs"]["v"] += 1
        n["label"] = n["label"][: -1] + rnd.choice("abcdef") if len(n["label"]) > 5 else n["label"] + "z"
    e = rnd.choice(d["edges"])
    e["rel"] = rnd.choice(["knows", "near", "owns", "cites", "links"])
    if rnd.random() < 0.3:
        i = len(d["nodes"])
        d["nodes"].append({"id": f"n{i}", "label": f"New concept {i}", "kind": "Concept",
                           "attrs": {"note": "fresh", "v": 0}})
    return d


def diff_docs(a, b):
    """Minimal delta: changed/added nodes + replaced edge list if different."""
    an = {n["id"]: n for n in a["nodes"]}
    changed = [n for n in b["nodes"] if an.get(n["id"]) != n]
    removed = [i for i in an if i not in {n["id"] for n in b["nodes"]}]
    d = {"nodes_upsert": changed}
    if removed:
        d["nodes_del"] = removed
    if a["edges"] != b["edges"]:
        d["edges"] = b["edges"]
    return d


def dirsize(p):
    tot = 0
    for dp, _, fns in os.walk(p):
        for f in fns:
            tot += os.path.getsize(os.path.join(dp, f))
    return tot


def main():
    versions = []
    doc = gen_graph(NNODES)
    versions.append(doc)
    for _ in range(N - 1):
        doc = mutate(doc)
        versions.append(doc)
    v0 = json.dumps(versions[0])
    print(f"versions={N} nodes~{NNODES}  single snapshot={len(v0) / 1024:.1f} KB")

    tmp = tempfile.mkdtemp(prefix="storagedemo_")
    res = {}
    try:
        # a) full json files
        t0 = time.time()
        pa = os.path.join(tmp, "full")
        os.makedirs(pa)
        for i, v in enumerate(versions):
            with open(os.path.join(pa, f"v{i:04d}.json"), "w") as f:
                json.dump(v, f)
        res["a full JSON files"] = (dirsize(pa), time.time() - t0)

        # b) gzipped full json
        t0 = time.time()
        pb = os.path.join(tmp, "gz")
        os.makedirs(pb)
        for i, v in enumerate(versions):
            with gzip.open(os.path.join(pb, f"v{i:04d}.json.gz"), "wt") as f:
                json.dump(v, f)
        res["b gzipped full JSON"] = (dirsize(pb), time.time() - t0)

        # c) incremental deltas
        t0 = time.time()
        pc = os.path.join(tmp, "delta")
        os.makedirs(pc)
        with open(os.path.join(pc, "v0000.json"), "w") as f:
            json.dump(versions[0], f)
        for i in range(1, N):
            with open(os.path.join(pc, f"v{i:04d}.delta.json"), "w") as f:
                json.dump(diff_docs(versions[i - 1], versions[i]), f)
        res["c incremental deltas"] = (dirsize(pc), time.time() - t0)

        # d) git repo
        if shutil.which("git"):
            t0 = time.time()
            pg = os.path.join(tmp, "gitrepo")
            os.makedirs(pg)
            subprocess.run(["git", "init", "-q", pg], check=True)
            subprocess.run(["git", "-C", pg, "config", "user.email", "demo@local"],
                           check=True, capture_output=True)
            subprocess.run(["git", "-C", pg, "config", "user.name", "demo"],
                           check=True, capture_output=True)
            gp = os.path.join(pg, "graph.json")
            for i, v in enumerate(versions):
                with open(gp, "w") as f:
                    json.dump(v, f)
                subprocess.run(["git", "-C", pg, "add", "graph.json"],
                               check=True, capture_output=True)
                subprocess.run(["git", "-C", pg, "commit", "-qm", f"v{i}"],
                               check=True, capture_output=True)
            subprocess.run(["git", "-C", pg, "gc", "-q"], check=True, capture_output=True)
            res["d git repo (.git)"] = (dirsize(os.path.join(pg, ".git")),
                                         time.time() - t0)
        else:
            res["d git repo"] = None

        # e) sqlite full snapshots
        t0 = time.time()
        db = os.path.join(tmp, "t.db")
        c = sqlite3.connect(db)
        c.execute("CREATE TABLE v (id INTEGER PRIMARY KEY, doc TEXT, created REAL)")
        for i, v in enumerate(versions):
            c.execute("INSERT INTO v(doc,created) VALUES(?,?)",
                      (json.dumps(v), time.time()))
        c.commit()
        # read-back check: latest version
        latest = json.loads(c.execute("SELECT doc FROM v ORDER BY id DESC LIMIT 1").fetchone()[0])
        assert latest == versions[-1]
        c.close()
        res["e sqlite snapshots"] = (os.path.getsize(db), time.time() - t0)
    finally:
        pass
    print(f"\n{'strategy':24s} {'bytes':>12s} {'/version':>10s} {'write s':>8s}")
    for k, v in res.items():
        if v is None:
            print(f"{k:24s} {'(git missing)':>12s}")
        else:
            b, t = v
            print(f"{k:24s} {b:12d} {b / N:10.0f} {t:8.2f}")
    print(f"\nartifacts kept at {tmp} (delete when done)")
    print("takeaway: sqlite full snapshots win on simplicity+queryability; "
          "deltas/gzip save bytes at restore-complexity cost; git compresses "
          "well but brings a binary dependency + poor concurrent-write story.")


if __name__ == "__main__":
    main()
