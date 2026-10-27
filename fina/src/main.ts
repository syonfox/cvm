import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import { loadConfig } from './server/config.js';
import { buildRouter } from './server/app.js';
import { serve } from './server/http.js';

// Minimal .env loader so `npm run dev` works without `source .env` (no deps).
function loadDotEnv(): void {
  const p = join(dirname(fileURLToPath(import.meta.url)), '..', '.env');
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(k in process.env)) process.env[k] = v;
  }
}
loadDotEnv();

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const cfg = loadConfig();
serve(buildRouter(cfg), { host: cfg.host, port: cfg.port, certDir: join(root, 'certs') });
