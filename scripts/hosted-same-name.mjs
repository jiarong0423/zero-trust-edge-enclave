#!/usr/bin/env node
// Gives three people of the hosted demo a Chinese name, so that the same-name finder has something to find: sales-a and sales-b both
// become 劉文祥 (told apart by region), sales-c becomes 劉慶龍. Synthetic people, the same ones as `scripts/demo-local-same-name.mjs`.
// Run by the owner in their own terminal: it asks for the judge sign-in and reads the administrator token from the private token
// directory, so no credential passes through a chat. It prints no token, password or cookie.
//
//   node scripts/hosted-same-name.mjs            dry run: shows what would change, writes nothing
//   node scripts/hosted-same-name.mjs --apply    writes it
//
// Only `nameZh` and `tags` of these three people are written; tokens, departments and authorizations are not touched. Changing a person
// moves the version of every authorization that lists them, so deliveries approved before the change stop opening (the inbox shows them
// as expired); deliveries made afterwards are unaffected. Exit codes: 0 done (or dry run), 1 a step failed, 2 configuration or usage error.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { withDefaults, DEFAULT_TOKEN_DIR } from './hosted-wedge-probe.mjs';

export const PEOPLE = [['sales-a', '劉文祥', { region: 'north' }], ['sales-b', '劉文祥', { region: 'south' }], ['sales-c', '劉慶龍', { region: 'north' }]];
const TIMEOUT_MS = 20_000;
const out = line => process.stdout.write(line + '\n');
const sameTags = (a, b) => JSON.stringify(Object.entries(a || {}).sort()) === JSON.stringify(Object.entries(b || {}).sort());

export function parseArguments(argv) {
  const options = { apply: false };
  for (const argument of argv) {
    if (argument === '--apply') options.apply = true;
    else throw Object.assign(new Error(`unknown argument: ${argument}`), { usage: true });
  }
  return options;
}

// Who needs a change: a person that exists and does not already carry exactly this name and these tags.
export function planNames(principals) {
  return PEOPLE.map(([id, nameZh, tags]) => ({ id, nameZh, tags, person: principals.find(item => item.id === id) }))
    .map(item => ({ ...item, missing: !item.person, current: item.person && item.person.nameZh === item.nameZh && sameTags(item.person.tags, item.tags) }));
}

export async function applyNames({ origin, gate, adminToken, apply, fetchImpl = fetch, write = out }) {
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
    const response = await call('GET', '/api/admin/directory', { headers });
    return response?.ok ? response.json().catch(() => null) : { error: response ? `HTTP ${response.status}` : 'no answer' };
  };
  let directory = await read();
  if (!directory || directory.error || !Array.isArray(directory.principals)) { write(`FAIL read-directory: ${directory?.error || 'unexpected answer'}`); return 1; }
  write(`INFO target ${origin} revision=${directory.revision}`);
  const plan = planNames(directory.principals);
  for (const item of plan) {
    const now = item.person ? `${item.person.nameZh || '(no Chinese name)'} ${JSON.stringify(item.person.tags || {})}` : 'NOT IN THE DIRECTORY';
    write(`INFO ${item.id.padEnd(8)} now ${now}  ${item.missing ? '-> cannot change' : item.current ? '(already set, left alone)' : `-> ${item.nameZh} ${JSON.stringify(item.tags)}`}`);
  }
  if (plan.some(item => item.missing)) { write('FAIL a person is missing from the hosted directory; nothing was changed'); return 1; }
  const todo = plan.filter(item => !item.current);
  if (!todo.length) { write('SUMMARY nothing to change'); return 0; }
  if (!apply) { write(`SUMMARY DRY RUN: ${todo.length} person(s) would change. Deliveries approved earlier would stop opening. Add --apply to write.`); return 0; }
  let revision = directory.revision;
  for (const item of todo) {
    const response = await call('POST', '/api/admin/directory', { headers, body: { expectedRevision: revision, operation: 'person.update', value: { id: item.id, nameZh: item.nameZh, tags: item.tags } } });
    const body = response ? await response.json().catch(() => ({})) : {};
    if (!response?.ok) { write(`FAIL update ${item.id}: ${response ? 'HTTP ' + response.status : 'no answer'}${body.error ? ' ' + body.error : ''}`); return 1; }
    revision = body.revision;
    write(`PASS update ${item.id}`);
  }
  directory = await read();
  const wrong = plan.filter(item => { const person = directory.principals?.find(entry => entry.id === item.id); return !person || person.nameZh !== item.nameZh || !sameTags(person.tags, item.tags); });
  if (wrong.length) { write(`FAIL verify: ${wrong.map(item => item.id).join(', ')} did not take the new name`); return 1; }
  write(`SUMMARY PASS people=${todo.length} named; the finder now has two 劉文祥 (north, south) and one 劉慶龍`);
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
  return applyNames({ origin: origin.replace(/\/$/, ''), gate, adminToken, apply: parsed.apply, fetchImpl: options.fetchImpl || fetch, write });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) process.exit(await main());
