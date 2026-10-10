#!/usr/bin/env node
// Read-only: how many staged file deliveries the instance holds, and how many more it will take. Nothing frees a slot (there is
// no time-based purge), so once the ceiling is reached every further delivery is refused with 507 until the limit is raised.
// Run by the owner in their own terminal: it asks for the judge sign-in and reads the administrator token from the private token
// directory. It prints no credential and writes nothing.
//
//   node scripts/hosted-capacity.mjs
// Exit codes: 0 plenty of room, 1 low on room or full or a step failed, 2 configuration or usage error.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { withDefaults, DEFAULT_TOKEN_DIR } from './hosted-wedge-probe.mjs';

const out = line => process.stdout.write(line + '\n');
export const LOW_ROOM = 20;
const TIMEOUT_MS = 20_000;

export async function checkCapacity({ origin, gate, adminToken, fetchImpl = fetch, write = out }) {
  const call = (method, pathname, headers = {}, body) => fetchImpl(origin + pathname, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(TIMEOUT_MS) }).catch(() => null);
  const health = await call('GET', '/api/health');
  if (!health?.ok) { write(`FAIL health: ${health ? 'HTTP ' + health.status : 'no answer'}`); return 1; }
  const limit = (await health.json().catch(() => ({}))).fileTaskLimit ?? null;
  const headers = { authorization: `Bearer ${adminToken}` };
  if (gate) {
    const login = await call('POST', '/api/judge-login', {}, { user: gate.user, password: gate.password });
    const raw = login?.headers.getSetCookie?.().find(value => value.startsWith('enclave_gate='));
    if (!login?.ok || !raw) { write(`FAIL judge-signin: ${login ? 'HTTP ' + login.status : 'no answer'}`); return 1; }
    headers.cookie = raw.split(';')[0];
  }
  const response = await call('GET', '/api/admin/retention', headers);
  const inventory = response?.ok ? await response.json().catch(() => null) : null;
  if (!inventory || !Array.isArray(inventory.items)) { write(`FAIL read-retention: ${response ? 'HTTP ' + response.status : 'no answer'}`); return 1; }
  const used = inventory.items.length;
  // An older server does not publish its ceiling; the built-in default was 50.
  const ceiling = limit ?? 50;
  const room = Math.max(0, ceiling - used);
  write(`INFO target ${origin}`);
  write(`INFO tasks on file: ${used} (kept ${inventory.retainedCount}, cleanup candidates ${inventory.candidateCount}); automatic deletion: ${inventory.automaticDeletion}`);
  write(`INFO ceiling: ${ceiling}${limit === null ? ' (the server does not publish it: the default of an older build)' : ''}; room left: ${room}`);
  if (room === 0) { write('SUMMARY FULL: every further delivery is refused (507) until FILE_TASK_LIMIT is raised'); return 1; }
  if (room < LOW_ROOM) { write(`SUMMARY LOW: only ${room} more deliveries fit; raise FILE_TASK_LIMIT before judging`); return 1; }
  write(`SUMMARY OK: ${room} more deliveries fit`);
  return 0;
}

export async function main(env = process.env, options = {}) {
  const write = options.write || out;
  const filled = await withDefaults(env, options.prompts || {});
  try { const url = new URL(filled.SMOKE_BASE_URL); if (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === '127.0.0.1')) throw new Error(); if (url.pathname !== '/' || url.search || url.hash || url.username) throw new Error(); }
  catch { write('ERROR SMOKE_BASE_URL must be an https origin'); return 2; }
  const gate = filled.SMOKE_GATE_USER || filled.SMOKE_GATE_PASSWORD ? { user: filled.SMOKE_GATE_USER, password: filled.SMOKE_GATE_PASSWORD } : null;
  let adminToken;
  try { adminToken = (await fs.readFile(path.join(path.resolve(filled.SMOKE_TOKEN_DIR || DEFAULT_TOKEN_DIR), 'admin.token'), 'utf8')).trim(); }
  catch { write('ERROR the administrator token file was not found in the token directory'); return 2; }
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(adminToken)) { write('ERROR the administrator token file does not look like a token'); return 2; }
  return checkCapacity({ origin: filled.SMOKE_BASE_URL.replace(/\/$/, ''), gate, adminToken, fetchImpl: options.fetchImpl || fetch, write });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) process.exit(await main());
