#!/usr/bin/env node
// Moves the end date of the hosted demo's authorizations later, through the administrator interface. Run by the owner in
// their own terminal: it asks for the judge sign-in and reads the administrator token from the private token directory, so
// no credential passes through a chat. It prints no token, password or cookie.
//
//   node scripts/hosted-extend-grants.mjs                   dry run: shows what would change, writes nothing
//   node scripts/hosted-extend-grants.mjs --apply           writes it
//   node scripts/hosted-extend-grants.mjs --until 2027-01-15T23:59:00+08:00 --apply
//
// Only a later date is ever written (an authorization already ending later is left alone), and a revoked one is left alone.
// Changing an authorization moves its version on, so deliveries approved under the old version stop opening and the inbox
// shows them as expired; new deliveries are unaffected. The registry on the hosted volume is the one that counts: the
// HOSTED_REGISTRY_B64 environment variable is read only when the volume has none.
// Exit codes: 0 done (or dry run), 1 a step failed, 2 configuration or usage error.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { withDefaults, DEFAULT_TOKEN_DIR } from './hosted-wedge-probe.mjs';

export const DEFAULT_UNTIL = '2026-12-31T23:59:00+08:00';
const TIMEOUT_MS = 20_000;
const out = line => process.stdout.write(line + '\n');
class UsageError extends Error {}

export function parseArguments(argv) {
  const options = { apply: false, until: DEFAULT_UNTIL };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--apply') options.apply = true;
    else if (argv[index] === '--until' && argv[index + 1]) options.until = argv[++index];
    else throw new UsageError(`unknown argument: ${argv[index]}`);
  }
  const time = Date.parse(options.until);
  if (!Number.isFinite(time) || time <= Date.now()) throw new UsageError('--until must be a future date');
  if (time > Date.parse('2027-12-31T00:00:00Z')) throw new UsageError('--until is too far away');
  options.untilIso = new Date(time).toISOString();
  return options;
}

// Which authorizations to move: those ending before the new date and not revoked.
export function planExtension(grants, untilIso) {
  const until = Date.parse(untilIso);
  return grants.filter(grant => !grant.revoked && Date.parse(grant.expiresAt) < until);
}

const asValue = (grant, expiresAt) => ({ id: grant.id, operatorId: grant.operatorId, coordinatorId: grant.coordinatorId, recipients: grant.recipients,
  channels: grant.channels, expiresAt, maxAttempts: grant.maxAttempts, maxOpens: grant.maxOpens, revoked: false });

export async function extendGrants({ origin, gate, adminToken, untilIso, apply, fetchImpl = fetch, write = out }) {
  const call = async (method, pathname, { headers = {}, body } = {}) => {
    const response = await fetchImpl(origin + pathname, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(TIMEOUT_MS) }).catch(() => null);
    return response;
  };
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
    const response = await call('GET', '/api/admin/directory', { headers });
    return response?.ok ? response.json().catch(() => null) : { error: response ? `HTTP ${response.status}` : 'no answer' };
  };
  let directory = await read();
  if (!directory || directory.error || !Array.isArray(directory.grants)) { write(`FAIL read-directory: ${directory?.error || 'unexpected answer'}`); return 1; }
  write(`INFO target ${origin} revision=${directory.revision}`);
  const plan = planExtension(directory.grants, untilIso);
  for (const grant of directory.grants) {
    const moving = plan.includes(grant);
    write(`INFO ${grant.id.padEnd(14)} v${grant.version}  ends ${grant.expiresAt}  ${moving ? '-> ' + untilIso : grant.revoked ? '(revoked, left alone)' : '(already later, left alone)'}`);
  }
  if (!plan.length) { write('SUMMARY nothing to change'); return 0; }
  if (!apply) { write(`SUMMARY DRY RUN: ${plan.length} authorization(s) would move to ${untilIso}. Add --apply to write.`); return 0; }
  let revision = directory.revision;
  for (const grant of plan) {
    const response = await call('POST', '/api/admin/directory', { headers, body: { expectedRevision: revision, operation: 'grant.update', value: asValue(grant, untilIso) } });
    const body = response ? await response.json().catch(() => ({})) : {};
    if (!response?.ok) { write(`FAIL update ${grant.id}: ${response ? 'HTTP ' + response.status : 'no answer'}${body.error ? ' ' + body.error : ''}`); return 1; }
    revision = body.revision;
    write(`PASS update ${grant.id}`);
  }
  directory = await read();
  const wrong = plan.filter(grant => Date.parse(directory.grants?.find(item => item.id === grant.id)?.expiresAt) !== Date.parse(untilIso));
  if (wrong.length) { write(`FAIL verify: ${wrong.map(grant => grant.id).join(', ')} did not take the new date`); return 1; }
  for (const grant of plan) write(`INFO ${grant.id} now v${directory.grants.find(item => item.id === grant.id).version}, ends ${untilIso}`);
  write(`SUMMARY PASS grants=${plan.length} extended to ${untilIso}; deliveries approved before the change no longer open`);
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
  write(parsed.apply ? 'MODE apply (writes)' : 'MODE dry run (writes nothing)');
  return extendGrants({ origin: origin.replace(/\/$/, ''), gate, adminToken, untilIso: parsed.untilIso, apply: parsed.apply, fetchImpl: options.fetchImpl || fetch, write });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) process.exit(await main());
