/**
 * L1 cache ported from the demo's backend/memcache.py, with two fixes:
 *  - O(1) LRU eviction via Map insertion order (the demo rescanned the
 *    whole order dict with min() on every insert past capacity).
 *  - Timestamps are injectable (now() param) so expiry is unit-testable.
 *
 * Semantics preserved: string keys/values, per-key TTL, LRU eviction,
 * compact(), snapshot()/restore() for migration, stats().
 */
export type Snapshot = Record<string, { value: string; ttlLeft: number | null }>;

type Entry = { value: string; expiresAt: number | null; size: number; hits: number };

export class LruCache {
  private data = new Map<string, Entry>();
  private bytes = 0;
  private evictions = 0;
  private hits = 0;
  private misses = 0;

  constructor(readonly maxBytes: number = 1024 ** 3) {}

  private size(key: string, value: string): number {
    return Buffer.byteLength(key) + Buffer.byteLength(value) + 64;
  }

  get(key: string, now: number = Date.now()): string | null {
    const e = this.data.get(key);
    if (!e) {
      this.misses += 1;
      return null;
    }
    if (e.expiresAt !== null && e.expiresAt < now) {
      this.drop(key);
      this.misses += 1;
      return null;
    }
    e.hits += 1;
    // Refresh recency: re-insert at the tail (Map preserves insertion order).
    this.data.delete(key);
    this.data.set(key, e);
    this.hits += 1;
    return e.value;
  }

  /** Returns false when a single item exceeds the cap (refused, not stored). */
  set(key: string, value: string, ttlSecs?: number, now: number = Date.now()): boolean {
    if (typeof value !== 'string') value = JSON.stringify(value);
    const prev = this.data.get(key);
    if (prev) {
      this.bytes -= prev.size;
      this.data.delete(key);
    }
    const size = this.size(key, value);
    if (size > this.maxBytes) {
      if (prev) this.data.set(key, prev); // restore; failed writes change nothing
      this.bytes += prev ? prev.size : 0;
      return false;
    }
    const expiresAt = ttlSecs ? now + ttlSecs * 1000 : null;
    this.data.set(key, { value, expiresAt, size, hits: 0 });
    this.bytes += size;
    // Evict least-recently-used (head of the Map) until under cap.
    while (this.bytes > this.maxBytes) {
      const oldest = this.data.keys().next();
      if (oldest.done) break;
      this.drop(oldest.value);
      this.evictions += 1;
    }
    return true;
  }

  delete(key: string): boolean {
    if (!this.data.has(key)) return false;
    this.drop(key);
    return true;
  }

  private drop(key: string): void {
    const e = this.data.get(key);
    if (!e) return;
    this.data.delete(key);
    this.bytes -= e.size;
  }

  compact(now: number = Date.now()): { removedExpired: number; keys: number; bytes: number; evictions: number } {
    let removedExpired = 0;
    for (const [k, e] of this.data) {
      if (e.expiresAt !== null && e.expiresAt < now) {
        this.drop(k);
        removedExpired += 1;
      }
    }
    return { removedExpired, keys: this.data.size, bytes: this.bytes, evictions: this.evictions };
  }

  snapshot(now: number = Date.now()): Snapshot {
    const out: Snapshot = {};
    for (const [k, e] of this.data) {
      if (e.expiresAt === null || e.expiresAt > now) {
        out[k] = { value: e.value, ttlLeft: e.expiresAt === null ? null : (e.expiresAt - now) / 1000 };
      }
    }
    return out;
  }

  restore(snap: Snapshot, now: number = Date.now()): void {
    for (const [k, item] of Object.entries(snap)) {
      const ttl = item.ttlLeft;
      this.set(k, item.value, ttl && ttl > 0 ? ttl : undefined, now);
    }
  }

  stats(): {
    keys: number;
    bytes: number;
    maxBytes: number;
    pct: number;
    hits: number;
    misses: number;
    evictions: number;
  } {
    return {
      keys: this.data.size,
      bytes: this.bytes,
      maxBytes: this.maxBytes,
      pct: Math.round((100 * this.bytes) / this.maxBytes * 100) / 100,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
    };
  }
}
