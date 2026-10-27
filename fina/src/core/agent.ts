/**
 * Agent loop ported from the demo's backend/meta_ai.py agent_zero, minus the
 * demo's flaws (unbounded history, regex HTML scraping, exec on by default).
 *
 * Design:
 *  - Tool allowlist is explicit per request: { web, exec }. Exec defaults OFF.
 *  - Hard time budget with resumable history + a forced final no-tools pass,
 *    so callers never get a dead-end "(continued…)" stub.
 *  - The LLM transport is injected (chat fn), so this file has no network
 *    dependency and is fully unit-testable.
 */
import { createHash } from 'node:crypto';

export type ToolName = 'graph_search' | 'fetch_url' | 'exec_code';
export const DEFAULT_ALLOW: ReadonlySet<ToolName> = new Set(['graph_search', 'fetch_url']);

export function toolsAllow(t?: { web?: boolean; exec?: boolean }): Set<ToolName> {
  const allow = new Set<ToolName>(['graph_search']);
  if (t?.web ?? true) allow.add('fetch_url');
  if (t?.exec ?? false) allow.add('exec_code');
  return allow;
}

export type ChatMessage = {
  role: string;
  content: string;
  tool_calls?: Array<{ id?: string; name: string; args: unknown }>;
  tool_call_id?: string;
};

export type ToolResult = { name: string; result: unknown };

export type ToolExecutor = (
  name: ToolName,
  args: Record<string, unknown>,
) => Promise<unknown> | unknown;

export type ChatFn = (
  messages: ChatMessage[],
  tools: ToolName[],
  opts: { final: boolean },
) => Promise<{ text: string; calls: Array<{ id: string; name: string; args: unknown }> }>;

export type AgentTrace = Array<{
  turn: number;
  calls?: Array<{ name: string; args: unknown }>;
  results?: string[];
  answer?: string;
  final?: boolean;
  error?: string;
}>;

export const ZERO_SYSTEM =
  'You are a zero-shot task agent. Answer the user request directly in plain ' +
  'natural language for a non-technical reader: short sentences, no jargon, ' +
  'no tool-talk, no trace dumps. Use tools when they help, then give a clear ' +
  'user-facing answer in short markdown.';

export function aiCacheKey(route: string, body: unknown, model: string): string {
  const b = body as Record<string, unknown>;
  const h = createHash('sha256')
    .update(JSON.stringify({ r: route, n: b['nodes'], e: b['edges'], i: b['input'] ?? b['instruction'] ?? b['label'], t: b['tools'], m: model }))
    .digest('hex')
    .slice(0, 32);
  return 'ai:' + h;
}

/** Strip markdown fences the model sometimes wraps JSON in. */
export function extractJson(raw: string): unknown {
  let s = (raw ?? '').trim();
  if (s.startsWith('```')) {
    s = s.split('```')[1] ?? '';
    if (s.startsWith('json')) s = s.slice(4);
  }
  return JSON.parse(s.trim());
}

export async function agentZero(
  prompt: string,
  deps: {
    chat: ChatFn;
    execTool: ToolExecutor;
    allow?: Set<ToolName>;
    budgetSecs?: number;
    ctx?: string;
    history?: ChatMessage[];
    maxTurns?: number;
  },
): Promise<{
  text: string;
  turns: number;
  trace: AgentTrace;
  ms: number;
  timedOut: boolean;
  done: boolean;
  canContinue: boolean;
  history: ChatMessage[];
  tools: ToolName[];
}> {
  const t0 = Date.now();
  const budget = (deps.budgetSecs ?? 28) * 1000;
  const allow = deps.allow ?? new Set(DEFAULT_ALLOW);
  const tools = [...allow];
  const trace: AgentTrace = [];
  let history: ChatMessage[] =
    deps.history && Array.isArray(deps.history)
      ? deps.history.filter((m) => m && typeof m.role === 'string').slice(0, 30)
      : [{ role: 'user', content: deps.ctx ? `${deps.ctx}\n\n${prompt}` : prompt }];
  const maxTurns = deps.maxTurns ?? Math.max(6, 6);
  let turns = 0;
  let text = '';
  let timedOut = false;
  let done = false;

  const remainMs = (): number => budget - (Date.now() - t0);

  for (let i = 0; i < (history.length > 1 ? Math.max(maxTurns, 8) : maxTurns); i++) {
    if (remainMs() < 4000) {
      timedOut = true;
      break;
    }
    turns += 1;
    let resp;
    try {
      resp = await deps.chat([{ role: 'system', content: ZERO_SYSTEM }, ...history], tools, { final: false });
    } catch (e) {
      trace.push({ turn: turns, error: String(e).slice(0, 200) });
      text = text || 'ERROR: ' + String(e).slice(0, 200);
      break;
    }
    if (!resp.calls || resp.calls.length === 0) {
      text = resp.text;
      trace.push({ turn: turns, answer: (text || '').slice(0, 500) });
      done = true;
      break;
    }
    const calls = resp.calls;
    const results: ToolResult[] = [];
    for (const c of calls) {
      if (!allow.has(c.name as ToolName)) {
        results.push({ name: c.name, result: { error: `tool '${c.name}' is not allowed for this request` } });
        continue;
      }
      try {
        const args = (c.args ?? {}) as Record<string, unknown>;
        const out = await deps.execTool(c.name as ToolName, args);
        results.push({ name: c.name, result: out });
      } catch (e) {
        results.push({ name: c.name, result: { error: String(e).slice(0, 200) } });
      }
    }
    trace.push({
      turn: turns,
      calls: calls.map((c) => ({ name: c.name, args: c.args })),
      results: results.map((r) => JSON.stringify(r.result).slice(0, 500)),
    });
    history.push({ role: 'assistant', content: '', tool_calls: calls.map((c) => ({ id: c.id, name: c.name, args: c.args })) });
    for (let k = 0; k < calls.length; k++) {
      history.push({ role: 'tool', content: JSON.stringify(results[k]?.result).slice(0, 4000), tool_call_id: calls[k]?.id });
    }
  }

  // Forced final no-tools pass: never leave the caller with a dead end.
  if (!done && remainMs() > 6000) {
    try {
      const resp = await deps.chat(
        [
          { role: 'system', content: ZERO_SYSTEM },
          ...history,
          { role: 'user', content: 'Tool budget exhausted. Using the tool results above, give your best final answer now (note gaps briefly).' },
        ],
        [],
        { final: true },
      );
      if (resp.text) {
        text = resp.text;
        trace.push({ turn: turns + 1, answer: text.slice(0, 500), final: true });
        done = true;
      }
    } catch (e) {
      trace.push({ turn: turns + 1, error: 'final-pass: ' + String(e).slice(0, 150) });
    }
  }

  const ms = Date.now() - t0;
  const canContinue = !done && history.length > 0;
  if (!done && !text) {
    text = `(paused after ${turns} tool turn(s)${timedOut ? ' (time budget hit)' : ''} — resume with the returned history)`;
  }
  const slim = history.map((m) => ({
    ...m,
    content: typeof m.content === 'string' && m.content.length > 4000 ? m.content.slice(0, 4000) : m.content,
  }));
  return { text, turns, trace, ms, timedOut, done, canContinue, history: slim, tools };
}
