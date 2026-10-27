/**
 * Structural graph checks ported from the demo's adversarial_check().
 * Kept because they are cheap, deterministic, and need no LLM call —
 * they run before any expensive agent pass and gate what gets persisted.
 */
export type GraphNode = { id: string; label?: string; kind?: string };
export type GraphEdge = { source: string; target: string; rel?: string; score?: number };
export type Flag = { node?: string; issue: string };

export const HUB_DEGREE_THRESHOLD = 5;
export const HOMOGENEITY_THRESHOLD = 0.7;

export function adversarialCheck(nodes: GraphNode[], edges: GraphEdge[]): Flag[] {
  const flags: Flag[] = [];
  const degree = new Map<string, number>();
  for (const e of edges) degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
  for (const [node, count] of degree) {
    if (count > HUB_DEGREE_THRESHOLD) {
      flags.push({ node, issue: 'high-degree hub (possible false correlation)' });
    }
  }
  if (nodes.length > 0) {
    const kinds = new Map<string, number>();
    for (const n of nodes) kinds.set(n.kind ?? 'Unknown', (kinds.get(n.kind ?? 'Unknown') ?? 0) + 1);
    const top = Math.max(...kinds.values());
    if (top / nodes.length > HOMOGENEITY_THRESHOLD) {
      flags.push({ issue: 'homogeneous node types (low diversity)' });
    }
  }
  return flags;
}

/** Name similarity the demo used for local link recommendations (Jaccard). */
export function nameSimilarity(a: string, b: string): number {
  const sa = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const sb = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter += 1;
  return inter / (sa.size + sb.size - inter);
}
