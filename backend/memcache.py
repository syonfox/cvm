"""In-memory Redis-like cache: 1GB max, LRU eviction, TTL, compaction.

Drop-in layer in front of sqlite. Thread-safe. No deps.
Env:
  MEM_MAX_BYTES  cap in bytes (default 1073741824 = 1GB)
  MEM_COMPACT_SECS  background compact interval (default 300, 0=off)
"""
import os
import threading
import time
import json

MAX_BYTES = int(os.environ.get("MEM_MAX_BYTES", str(1024**3)))


class MemCache:
    def __init__(self, max_bytes=MAX_BYTES):
        self.max_bytes = max_bytes
        self._lock = threading.RLock()
        self._data = {}   # key -> [value(str), expires_at|None, size, hits]
        self._order = {}  # key -> last_access (LRU)
        self._bytes = 0
        self.evictions = 0
        self.hits = 0
        self.misses = 0

    def _size(self, k, v):
        return len(k.encode()) + len(v.encode()) + 64

    def get(self, key):
        with self._lock:
            e = self._data.get(key)
            if not e:
                self.misses += 1
                return None
            val, exp, size, hits = e
            if exp is not None and exp < time.time():
                self._drop(key)
                self.misses += 1
                return None
            e[3] += 1
            self._order[key] = time.time()
            self.hits += 1
            return val

    def set(self, key, value, ttl=None):
        if not isinstance(value, str):
            value = json.dumps(value, default=str)
        with self._lock:
            if key in self._data:
                self._bytes -= self._data[key][2]
            size = self._size(key, value)
            if size > self.max_bytes:
                return False  # single item bigger than cap: refuse
            exp = (time.time() + ttl) if ttl else None
            self._data[key] = [value, exp, size, 0]
            self._order[key] = time.time()
            self._bytes += size
            self._evict_locked()
            return True

    def delete(self, key):
        with self._lock:
            if key in self._data:
                self._drop(key)
                return True
            return False

    def _drop(self, key):
        e = self._data.pop(key, None)
        self._order.pop(key, None)
        if e:
            self._bytes -= e[2]

    def _evict_locked(self):
        # LRU: drop least-recently-used first until under cap
        while self._bytes > self.max_bytes and self._order:
            oldest = min(self._order, key=self._order.get)
            self._drop(oldest)
            self.evictions += 1

    def compact(self):
        """Remove expired entries + rebuild order index. Returns stats."""
        with self._lock:
            now = time.time()
            dead = [k for k, (v, exp, s, h) in self._data.items()
                    if exp is not None and exp < now]
            for k in dead:
                self._drop(k)
            # rebuild LRU order dict (drops stray keys, keeps memory tight)
            self._order = {k: self._order.get(k, now) for k in self._data}
            return {"removed_expired": len(dead), "keys": len(self._data),
                    "bytes": self._bytes, "evictions": self.evictions}

    def snapshot(self):
        """Serializable dump for migration / persistence (values only)."""
        with self._lock:
            now = time.time()
            return {k: {"value": v, "ttl_left": (e - now if e else None)}
                    for k, (v, e, s, h) in self._data.items()
                    if e is None or e > now}

    def restore(self, snap):
        with self._lock:
            for k, item in snap.items():
                ttl = item.get("ttl_left")
                self.set(k, item["value"],
                         ttl=ttl if ttl and ttl > 0 else None)

    def stats(self):
        with self._lock:
            return {"keys": len(self._data), "bytes": self._bytes,
                    "max_bytes": self.max_bytes,
                    "pct": round(100 * self._bytes / self.max_bytes, 2),
                    "hits": self.hits, "misses": self.misses,
                    "evictions": self.evictions}


CACHE = MemCache()

# optional background compactor
def _start_compactor(interval=None):
    secs = int(interval if interval is not None
               else os.environ.get("MEM_COMPACT_SECS", "300"))
    if secs <= 0:
        return None

    def loop():
        while True:
            time.sleep(secs)
            try:
                CACHE.compact()
            except Exception:
                pass

    t = threading.Thread(target=loop, daemon=True)
    t.start()
    return t
