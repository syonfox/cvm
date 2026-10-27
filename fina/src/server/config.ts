/** Fail-closed config. The console refuses to start without AUTH_TOKEN. */
function str(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

function int(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function bool(name: string, fallback = false): boolean {
  const v = (process.env[name] ?? '').toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes') return true;
  if (v === '0' || v === 'false' || v === 'no') return false;
  return fallback;
}

export type Config = {
  host: string;
  port: number;
  authToken: string;
  spacetimeHost: string;
  spacetimeDb: string;
  spacetimeToken: string;
  aiBaseUrl: string;
  aiKey: string;
  aiModel: string;
  execEnabled: boolean;
  execAllowPrefixes: string[];
  execTimeoutSecs: number;
  execMaxOut: number;
  rateLimitPerMin: number;
  bodyMaxBytes: number;
  agentBudgetSecs: number;
};

export function loadConfig(): Config {
  const authToken = str('AUTH_TOKEN');
  if (!authToken) {
    throw new Error('AUTH_TOKEN is required (fail-closed auth). Copy .env.example to .env and set it.');
  }
  if (authToken.length < 32 || /change-me/i.test(authToken)) {
    throw new Error('AUTH_TOKEN is still the placeholder — set a real secret (>=32 chars).');
  }
  const port = int('PORT', 8443);
  if (port < 1 || port > 65535) throw new Error(`PORT out of range: ${port}`);
  const host = str('HOST', '127.0.0.1');
  if (!host) throw new Error('HOST is required (use 127.0.0.1 unless behind a reverse proxy).');
  if (host === '0.0.0.0' || host === '::') {
    console.warn('[config] WARNING: HOST binds all interfaces — only use behind a firewall/reverse proxy with TLS.');
  }
  const spacetimeDb = str('SPACETIME_DB', 'finadb').trim();
  const spacetimeIdentity = str('SPACETIME_IDENTITY', '').trim();
  if (!/^[0-9a-f]{64}$/i.test(spacetimeDb) && !/^[0-9a-f]{64}$/i.test(spacetimeIdentity)) {
    console.warn('[config] WARNING: no hex SPACETIME_DB/SPACETIME_IDENTITY set — Maincloud deploys should pin the database identity.');
  }
  return {
    host,
    port,
    authToken,
    spacetimeHost: str('SPACETIME_HOST', 'https://maincloud.spacetimedb.com').replace(/\/$/, ''),
    spacetimeDb: str('SPACETIME_DB', 'finadb'),
    spacetimeToken: str('SPACETIME_TOKEN'),
    aiBaseUrl: str('AI_BASE_URL', 'https://api.meta.ai/v1').replace(/\/$/, ''),
    aiKey: str('AI_API_KEY') || str('MODEL_API_KEY'),
    aiModel: str('AI_MODEL', 'muse-spark-1.3'),
    execEnabled: bool('EXEC_ENABLED', false),
    execAllowPrefixes: str('EXEC_ALLOW', 'python3 -c,node -e').split(',').map((s) => s.trim()).filter(Boolean),
    execTimeoutSecs: int('EXEC_TIMEOUT_SECS', 15),
    execMaxOut: int('EXEC_MAX_OUT', 4000),
    rateLimitPerMin: int('RATE_LIMIT_PER_MIN', 60),
    bodyMaxBytes: int('BODY_MAX_BYTES', 1024 * 1024),
    agentBudgetSecs: int('AGENT_BUDGET_SECS', 28),
  };
}
