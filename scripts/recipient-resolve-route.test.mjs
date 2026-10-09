import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

// The sender's matching route and the administrator's quarantine, against the real server on a loopback
// port with the synthetic adviser. Two people carry the Chinese name 劉文祥, one carries 劉慶龍, and a
// fourth person with a unique name exists in the directory but is not on the sender's authorization.
const root = path.resolve(import.meta.dirname, '..');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'enclave-resolve-test-'));
const tokens = {};
let base;
let server;
let grantId;

before(async () => {
  const env = { PATH: process.env.PATH, HOME: dir, SKIP_LOCAL_ENV: 'true', DATA_DIR: dir, PORT: '0', COORDINATOR_PROVIDER: 'synthetic_fixture' };
  const setup = spawn(process.execPath, ['scripts/setup-local.mjs', dir], { cwd: root, env, stdio: 'ignore' });
  assert.equal((await once(setup, 'exit'))[0], 0);
  for (const id of ['operator', 'recipient-a', 'recipient-b', 'coordinator']) tokens[id] = (await fs.readFile(path.join(dir, `${id}.token`), 'utf8')).trim();
  tokens.admin = crypto.randomBytes(32).toString('base64url');
  const hash = token => crypto.createHash('sha256').update(token).digest('hex');
  const registry = JSON.parse(await fs.readFile(path.join(dir, 'access.json'), 'utf8'));
  const named = (id, nameZh, tags) => {
    const person = registry.principals.find(item => item.id === id);
    Object.assign(person, { nameZh, tags });
  };
  named('recipient-a', '劉文祥', { region: 'north' });
  named('recipient-b', '劉文祥', { region: 'south' });
  registry.principals.push({ id: 'recipient-c', kind: 'recipient', nameZh: '劉慶龍', tokenHash: hash('c'.repeat(43)) });
  registry.principals.push({ id: 'recipient-x', kind: 'recipient', nameZh: '王外部', tokenHash: hash('x'.repeat(43)) });
  registry.principals.push({ id: 'admin', kind: 'administrator', tokenHash: hash(tokens.admin) });
  grantId = registry.grants[0].id;
  registry.grants[0].recipients = [...new Set([...registry.grants[0].recipients, 'recipient-a', 'recipient-b', 'recipient-c'])];
  await fs.writeFile(path.join(dir, 'access.json'), JSON.stringify(registry, null, 2));
  Object.assign(process.env, env);
  const createServer = http.createServer;
  http.createServer = (...args) => { server = createServer(...args); return server; };
  const log = console.log;
  console.log = () => {};
  try { await import('../server.js'); } finally { console.log = log; http.createServer = createServer; }
  if (!server.listening) await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await fs.rm(dir, { recursive: true, force: true });
});

async function call(url, body, id = 'operator', method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(base + url, { method,
    headers: { 'content-type': 'application/json', ...(id ? { authorization: `Bearer ${tokens[id]}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
const resolve = question => call('/api/directory/resolve', { authorizationId: grantId, ...question });
const unlock = () => call('/api/admin/match-guard', { operatorId: 'operator', authorizationId: grantId }, 'admin');

test('a unique Chinese name on the authorization matches directly and resets the count', async () => {
  const answer = await resolve({ nameZh: '劉慶龍' });
  assert.equal(answer.status, 200);
  assert.deepEqual([answer.body.status, answer.body.code, answer.body.person.id, answer.body.attemptsLeft], ['MATCHED', 'MATCH_BY_NAME', 'recipient-c', 3]);
});

test('a shared name lists only people on the authorization, then the employee number decides', async () => {
  const open = await resolve({ nameZh: '劉文祥' });
  assert.deepEqual([open.body.status, open.body.code], ['AMBIGUOUS', 'AMBIGUOUS_NEED_ID']);
  assert.deepEqual(open.body.candidates.map(person => person.id).sort(), ['recipient-a', 'recipient-b']);
  assert.equal(open.body.person, null);
  const decided = await resolve({ nameZh: '劉文祥', employeeId: 'recipient-b' });
  assert.deepEqual([decided.body.status, decided.body.person.id], ['MATCHED', 'recipient-b']);
  assert.deepEqual(decided.body.person.tags, { region: 'south' });
});

test('the tag narrows a shared name to one person', async () => {
  const answer = await resolve({ nameZh: '劉文祥', tags: { region: 'north' } });
  assert.deepEqual([answer.body.status, answer.body.person.id], ['MATCHED', 'recipient-a']);
});

test('a person who exists but is not on the authorization looks exactly like a person who does not exist', async () => {
  const outside = await resolve({ nameZh: '王外部' });
  const nobody = await resolve({ nameZh: '無此人' });
  assert.equal(outside.body.status, 'NONE');
  assert.equal(outside.body.person, null);
  assert.equal(outside.body.message, nobody.body.message);
  assert.deepEqual(outside.body.candidates, []);
  assert.equal(JSON.stringify(outside.body).includes('recipient-x'), false);
  await resolve({ nameZh: '劉慶龍' });   // a success clears the count so later tests start from zero
});

test('a name and a number that point at different people are refused', async () => {
  const answer = await resolve({ nameZh: '劉慶龍', employeeId: 'recipient-a' });
  assert.deepEqual([answer.body.status, answer.body.code, answer.body.person], ['CONFLICT', 'CONFLICT_ID_NAME', null]);
  await resolve({ nameZh: '劉慶龍' });
});

test('only the operator of that authorization may ask, and unknown fields are refused', async () => {
  assert.equal((await call('/api/directory/resolve', { authorizationId: grantId, nameZh: '劉慶龍' }, 'recipient-a')).status, 403);
  assert.equal((await call('/api/directory/resolve', { authorizationId: grantId, nameZh: '劉慶龍' }, null)).status, 401);
  assert.equal((await resolve({ nameZh: '劉慶龍', extra: 1 })).status, 422);
  assert.equal((await call('/api/directory/resolve', { authorizationId: 'no-such-grant', nameZh: '劉慶龍' })).status, 403);
});

test('a success in between resets the count, so scattered failures never quarantine', async () => {
  await resolve({ nameZh: '無此人' });
  const second = await resolve({ nameZh: '無此人' });
  assert.equal(second.body.attemptsLeft, 1);
  await resolve({ nameZh: '劉慶龍' });
  const after = await resolve({ nameZh: '無此人' });
  assert.deepEqual([after.body.quarantined, after.body.attemptsLeft], [false, 2]);
  await resolve({ nameZh: '劉慶龍' });
});

test('three failures in a row quarantine the pair; only an administrator unlocks it', async () => {
  const first = await resolve({ nameZh: '無此人' });
  const second = await resolve({ employeeId: 'nobody-1' });
  const third = await resolve({ nameZh: '劉文祥' });          // ambiguous counts as a failure
  assert.deepEqual([first.body.attemptsLeft, second.body.attemptsLeft, third.body.attemptsLeft], [2, 1, 0]);
  assert.equal(third.body.quarantined, true);
  const refused = await resolve({ nameZh: '劉慶龍' });
  assert.equal(refused.status, 423);
  assert.equal(refused.body.error, 'MATCH_QUARANTINED');

  const listed = await call('/api/admin/match-guard', undefined, 'admin');
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.entries.map(entry => [entry.operatorId, entry.grantId, entry.quarantined]), [['operator', grantId, true]]);
  assert.equal((await call('/api/admin/match-guard', { operatorId: 'operator', authorizationId: grantId }, 'operator')).status, 403);
  assert.equal((await call('/api/admin/match-guard', undefined, 'operator')).status, 403);
  assert.equal((await call('/api/admin/match-guard', { operatorId: 'operator', authorizationId: 'no-such' }, 'admin')).status, 404);
  assert.equal((await resolve({ nameZh: '劉慶龍' })).status, 423);

  assert.deepEqual((await unlock()).body, { ok: true, unlocked: true });
  assert.equal((await unlock()).body.unlocked, false);
  const again = await resolve({ nameZh: '劉慶龍' });
  assert.deepEqual([again.status, again.body.status], [200, 'MATCHED']);
});

test('the quarantine survives a restart of the guard because it is stored', async () => {
  for (let i = 0; i < 3; i++) await resolve({ nameZh: '無此人' });
  const text = await fs.readFile(path.join(dir, 'match-guard.json'), 'utf8');
  assert.equal(JSON.parse(text)[0].quarantined, true);
  assert.equal(((await fs.stat(path.join(dir, 'match-guard.json'))).mode & 0o077), 0);
  await unlock();
});

test('the audit trail holds outcome codes only, never a name or an employee number', async () => {
  const text = await fs.readFile(path.join(dir, 'audit.json'), 'utf8').catch(() => '[]');
  const events = JSON.parse(text).filter(event => event.type === 'MATCH_ATTEMPT');
  assert.ok(events.length >= 10);
  const reasons = new Set(events.flatMap(event => event.reasons));
  for (const wanted of ['MATCH_BY_NAME', 'MATCH_BY_ID', 'MATCH_AMBIGUOUS_NEED_ID', 'MATCH_NONE_NOT_FOUND', 'MATCH_NONE_NOT_AUTHORIZED', 'MATCH_CONFLICT_ID_NAME', 'MATCH_QUARANTINED', 'MATCH_REFUSED_WHILE_QUARANTINED', 'MATCH_UNLOCKED']) {
    assert.ok(reasons.has(wanted), wanted);
  }
  assert.equal(reasons.has('UNCLASSIFIED'), false);
  const everything = JSON.stringify(events);
  for (const secret of ['劉', '王外部', 'recipient-', '無此人', 'nobody-1']) assert.equal(everything.includes(secret), false, secret);
});
