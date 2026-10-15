#!/usr/bin/env node
// Shows which senders of the hosted demo are locked after seven failed or ambiguous recipient matches, and clears the locks on request.
// A judge who mistypes a name seven times in a row locks their sender for that authorization (423 MATCH_QUARANTINED); the administrator
// token is not in the judge package and the page has no button for it, so the owner clears it here. Run by the owner in their own
// terminal: it asks for the judge sign-in and reads the administrator token from the private token directory, so no credential passes
// through a chat. It prints no token, password or cookie.
//
//   node scripts/hosted-match-guard.mjs            lists who is locked or has failures; writes nothing
//   node scripts/hosted-match-guard.mjs --clear    clears every lock that is set (a failure count that is not yet a lock is left alone)
// Exit codes: 0 done (or nothing locked), 1 a step failed, 2 configuration or usage error.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { withDefaults, DEFAULT_TOKEN_DIR } from './hosted-wedge-probe.mjs';

const TIMEOUT_MS = 20_000;
const out = line => process.stdout.write(line + '\n');

export function parseArguments(argv) {
  const options = { clear: false };
  for (const argument of argv) {
    if (argument === '--clear') options.clear = true;
    else throw Object.assign(new Error(`unknown argument: ${argument}`), { usage: true });
  }
  return options;
}

export async function matchGuard({ origin, gate, adminToken, clear, fetchImpl = fetch, write = out }) {
  const call = (method, pathname, { headers = {}, body } = {}) => fetchImpl(origin + pathname, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(TIMEOUT_MS) }).catch(() => null);
  const health = await call('GET', '/api/health');
  if (!health?.ok) { write(`FAIL health: ${health ? 'HTTP ' + health.status : 'no answer'}`); return 1; }
  write('PASS health');
  const headers = { authorization: `Bearer ${adminToken}` };
  if (gate) {
    const login = await call('POST', '/api/judge-login', { body: { user: gate.user, password: gate.password } });
    const raw = login?.headers.getSetCookie?.().find(value => value.startsWith('enclave_gate='));
    if (!login?.ok || !raw) { write(`FAIL judge-signin: ${login ? 'HTTP ' + login.status : 'no answer'}`); return 1; }
    headers.cookie = raw.split(';')[0];
    write('PASS judge-signin');
  }
  const read = async () => {
    const response = await call('GET', '/api/admin/match-guard', { headers });
    return response?.ok ? response.json().catch(() => null) : { error: response ? `HTTP ${response.status}` : 'no answer' };
  };
  const state = await read();
  if (!state || state.error || !Array.isArray(state.entries)) { write(`FAIL read-match-guard: ${state?.error || 'unexpected answer'}`); return 1; }
  const locked = state.entries.filter(entry => entry.quarantined);
  if (!state.entries.length) write('INFO no sender has a failed match on record');
  for (const entry of state.entries) write(`INFO ${String(entry.operatorId).padEnd(18)} authorization ${String(entry.grantId).padEnd(12)} failures ${entry.fails}/${state.limit}  ${entry.quarantined ? 'LOCKED' : 'not locked'}`);
  if (!locked.length) { write('SUMMARY nobody is locked'); return 0; }
  if (!clear) { write(`SUMMARY ${locked.length} lock(s) set. Add --clear to remove them.`); return 0; }
  for (const entry of locked) {
    const response = await call('POST', '/api/admin/match-guard', { headers, body: { operatorId: entry.operatorId, authorizationId: entry.grantId } });
    const body = response ? await response.json().catch(() => ({})) : {};
    if (!response?.ok) { write(`FAIL clear ${entry.operatorId}/${entry.grantId}: ${response ? 'HTTP ' + response.status : 'no answer'}${body.error ? ' ' + body.error : ''}`); return 1; }
    write(`PASS clear ${entry.operatorId}/${entry.grantId}: unlocked=${body.unlocked}`);
  }
  const after = await read();
  const still = (after?.entries || []).filter(entry => entry.quarantined);
  if (after?.error || still.length) { write(`FAIL verify: ${after?.error || still.length + ' lock(s) remain'}`); return 1; }
  write(`SUMMARY PASS cleared=${locked.length}`);
  return 0;
}

export async function main(env = process.env, argv = process.argv.slice(2), options = {}) {
  const write = options.write || out;
  let parsed;
  try { parsed = parseArguments(argv); } catch (error) { write(`ERROR ${error.message}`); return 2; }
  const filled = await withDefaults(env, options.prompts || {});
  const origin = filled.SMOKE_BASE_URL;
  try {
    const url = new URL(origin);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === '127.0.0.1')) throw new Error();
    if (url.pathname !== '/' || url.search || url.hash || url.username) throw new Error();
  } catch { write('ERROR SMOKE_BASE_URL must be an https origin'); return 2; }
  const gate = filled.SMOKE_GATE_USER || filled.SMOKE_GATE_PASSWORD ? { user: filled.SMOKE_GATE_USER, password: filled.SMOKE_GATE_PASSWORD } : null;
  let adminToken;
  try { adminToken = (await fs.readFile(path.join(path.resolve(filled.SMOKE_TOKEN_DIR || DEFAULT_TOKEN_DIR), 'admin.token'), 'utf8')).trim(); }
  catch { write('ERROR the administrator token file was not found in the token directory'); return 2; }
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(adminToken)) { write('ERROR the administrator token file does not look like a token'); return 2; }
  write(parsed.clear ? 'MODE clear (writes)' : 'MODE list (writes nothing)');
  return matchGuard({ origin: origin.replace(/\/$/, ''), gate, adminToken, clear: parsed.clear, fetchImpl: options.fetchImpl || fetch, write });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) process.exit(await main());
