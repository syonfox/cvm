import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LruCache } from '../src/core/lru-cache.js';
import { adversarialCheck, nameSimilarity } from '../src/core/adversarial.js';
import { agentZero, aiCacheKey, extractJson, toolsAllow } from '../src/core/agent.js';

describe('lru-cache (ported from memcache.py)', () => {
  it('evicts least-recently-used first', () => {
    const c = new LruCache(260); // fits 2 x ~105B entries, not 3
    c.set('a', 'x'.repeat(40));
    c.set('b', 'y'.repeat(40));
    c.get('a'); // a is now most-recent
    c.set('c', 'z'.repeat(40)); // must evict b, not a
    assert.equal(c.get('a')?.slice(0, 1), 'x');
    assert.equal(c.get('b'), null);
    assert.equal(c.stats().evictions >= 1, true);
  });

  it('expires TTL entries and compacts them', () => {
    const c = new LruCache();
    c.set('k', 'v', 10, 1000);
    assert.equal(c.get('k', 5000), 'v');
    assert.equal(c.get('k', 20_000), null);
    c.set('k2', 'v', 10, 1000);
    const r = c.compact(20_000);
    assert.equal(r.removedExpired, 1);
  });

  it('refuses single items bigger than the cap', () => {
    const c = new LruCache(100);
    assert.equal(c.set('big', 'x'.repeat(1000)), false);
    assert.equal(c.get('big'), null);
  });

  it('snapshot/restore round-trips live entries only', () => {
    const c = new LruCache();
    c.set('keep', 'v', 100, 1000);
    c.set('dead', 'v', 1, 1000);
    const snap = c.snapshot(5000);
    assert.deepEqual(Object.keys(snap), ['keep']);
    const c2 = new LruCache();
    c2.restore(snap, 5000);
    assert.equal(c2.get('keep', 6000), 'v');
  });
});

describe('adversarial (ported from adversarial_check)', () => {
  it('flags high-degree hubs and homogeneous graphs', () => {
    const nodes = Array.from({ length: 8 }, (_, i) => ({ id: `n${i}`, kind: 'Concept' as const }));
    const edges = Array.from({ length: 6 }, (_, i) => ({ source: 'n0', target: `n${i + 1}` }));
    const flags = adversarialCheck(nodes, edges);
    assert.ok(flags.some((f) => f.node === 'n0'));
    assert.ok(flags.some((f) => /homogeneous/.test(f.issue)));
  });

  it('is quiet on diverse graphs', () => {
    const nodes = [
      { id: 'a', kind: 'Person' },
      { id: 'b', kind: 'Domain' },
      { id: 'c', kind: 'IP' },
      { id: 'd', kind: 'Event' },
    ];
    const edges = [{ source: 'a', target: 'b' }];
    assert.deepEqual(adversarialCheck(nodes, edges), []);
  });

  it('nameSimilarity matches Jaccard behavior', () => {
    assert.equal(nameSimilarity('acme corp', 'acme corp'), 1);
    assert.equal(nameSimilarity('', 'x'), 0);
    assert.ok(nameSimilarity('acme corp', 'acme labs') > 0.3);
  });
});

describe('agent core (ported from agent_zero)', () => {
  it('tools default to web-on / exec-off', () => {
    assert.deepEqual([...toolsAllow({})].sort(), ['fetch_url', 'graph_search']);
    assert.ok(toolsAllow({ exec: true }).has('exec_code'));
    assert.ok(!toolsAllow({ web: false }).has('fetch_url'));
  });

  it('cache keys are stable and route-scoped', () => {
    const a = aiCacheKey('recommend', { nodes: [1] }, 'm');
    const b = aiCacheKey('recommend', { nodes: [1] }, 'm');
    const c = aiCacheKey('improve', { nodes: [1] }, 'm');
    assert.equal(a, b);
    assert.notEqual(a, c);
    assert.ok(a.startsWith('ai:'));
  });

  it('extractJson strips fences', () => {
    assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
    assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  });

  it('runs a tool turn then answers', async () => {
    const seen: string[] = [];
    const r = await agentZero('hi', {
      chat: async (msgs, tools) => {
        if (msgs.some((m) => m.role === 'tool')) return { text: 'final answer', calls: [] };
        assert.ok(tools.includes('fetch_url'));
        return { text: '', calls: [{ id: '1', name: 'fetch_url', args: { url: 'https://example.com' } }] };
      },
      execTool: async (name, args) => {
        seen.push(name);
        return { url: args['url'], text: 'hello' };
      },
      budgetSecs: 20,
    });
    assert.equal(r.text, 'final answer');
    assert.equal(r.done, true);
    assert.deepEqual(seen, ['fetch_url']);
  });

  it('drops calls for tools outside the allowlist', async () => {
    let executed = 0;
    const r = await agentZero('hi', {
      chat: async (msgs) => {
        if (msgs.some((m) => m.role === 'tool')) return { text: 'done', calls: [] };
        return { text: '', calls: [{ id: '1', name: 'exec_code', args: {} }] };
      },
      execTool: async () => {
        executed += 1;
        return {};
      },
      allow: new Set(['fetch_url']),
      budgetSecs: 20,
    });
    assert.equal(executed, 0);
    assert.equal(r.text, 'done');
  });

  it('forced final pass rescues an exhausted turn budget', async () => {
    const r = await agentZero('hi', {
      chat: async (_msgs, tools, opts) => {
        if (opts.final) return { text: 'best-effort answer', calls: [] };
        return { text: '', calls: [{ id: '1', name: 'fetch_url', args: {} }] };
      },
      execTool: async () => ({}),
      budgetSecs: 30,
      maxTurns: 1,
    });
    assert.equal(r.text, 'best-effort answer');
    assert.equal(r.done, true);
  });
});
