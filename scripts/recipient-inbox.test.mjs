import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { sealFileBytes } from '../public/file-envelope.js';
import { buildInbox, INBOX_LIMIT } from '../recipient-inbox.js';

// The recipient's inbox: what was approved for one token, and nothing else.
const config = { departments: [{ id: 'management', displayName: 'Management' }],
  principals: [{ id: 'boss', kind: 'operator', department: 'management' }, { id: 'ann', kind: 'recipient' }, { id: 'bob', kind: 'recipient' }] };
const approved = (version, recipients, extra = {}) => ({ version, status: 'APPROVED', approvedAt: `2026-10-10T0${version}:00:00Z`,
  content: { recipients, expiresAt: new Date(Date.now() + 3600000).toISOString(), documentHash: 'h'.repeat(64) }, ...extra });
const task = (id, snapshots, extra = {}) => ({ id, ownerId: 'boss', grantId: 'g', file: { name: 'SECRET-NAME.pdf' }, snapshots, ...extra });
const ann = { id: 'ann', kind: 'recipient' };

test('only deliveries approved for this recipient are listed, newest first', () => {
  const tasks = [task('t1', [approved(1, ['ann'])]), task('t2', [approved(2, ['bob'])]), task('t3', [approved(3, ['ann', 'bob'])]),
    task('t4', [{ ...approved(4, ['ann']), status: 'DRAFT' }]), task('t5', [approved(1, ['ann'])], { file: null })];
  const items = buildInbox(tasks, config, ann);
  assert.deepEqual(items.map(item => item.id), ['t3', 't1']);
  assert.deepEqual(buildInbox(tasks, config, { id: 'bob', kind: 'recipient' }).map(item => item.id), ['t3', 't2']);
  assert.deepEqual(buildInbox(tasks, config, { id: 'zed', kind: 'recipient' }), []);
});

test('an item carries the sending department and the state, and no file or recipient detail', () => {
  const [item] = buildInbox([task('t1', [approved(1, ['ann', 'bob'])])], config, ann);
  assert.deepEqual(Object.keys(item).sort(), ['approvedAt', 'expiresAt', 'fromDepartment', 'id', 'state', 'version']);
  assert.equal(item.fromDepartment, 'Management');
  const text = JSON.stringify(item);
  for (const secret of ['SECRET-NAME', 'bob', 'boss', 'h'.repeat(10)]) assert.ok(!text.includes(secret), secret);
});

test('state follows revocation, expiry and the recipient\'s own receipts', () => {
  const stateOf = (snapshot, extra = {}) => buildInbox([task('t', [snapshot], extra)], config, ann)[0].state;
  assert.equal(stateOf(approved(1, ['ann'])), 'WAITING');
  assert.equal(stateOf(approved(1, ['ann'], { revokedAt: '2026-10-10T01:00:00Z' })), 'REVOKED');
  assert.equal(stateOf({ ...approved(1, ['ann']), content: { recipients: ['ann'], expiresAt: new Date(Date.now() - 1000).toISOString() } }), 'EXPIRED');
  const release = { fileKeyReleases: [{ version: 1, subject: 'ann' }] };
  const receipt = code => ({ ...release, fileReceipts: [{ version: 1, subject: 'ann', code, evidence: 'CLIENT_REPORTED' }] });
  assert.equal(stateOf(approved(1, ['ann']), receipt('FILE_VERIFIED')), 'DOWNLOADED');
  assert.equal(stateOf(approved(1, ['ann']), receipt('ACKNOWLEDGED')), 'RECEIVED');
  // Somebody else's receipt, or a receipt with no key release behind it, does not count as this recipient's.
  assert.equal(stateOf(approved(1, ['ann']), { fileKeyReleases: [{ version: 1, subject: 'bob' }], fileReceipts: [{ version: 1, subject: 'bob', code: 'ACKNOWLEDGED', evidence: 'CLIENT_REPORTED' }] }), 'WAITING');
  assert.equal(stateOf(approved(1, ['ann']), { fileReceipts: [{ version: 1, subject: 'ann', code: 'ACKNOWLEDGED', evidence: 'CLIENT_REPORTED' }] }), 'WAITING');
});

test('only a recipient has an inbox, and it is capped', () => {
  assert.deepEqual(buildInbox([task('t1', [approved(1, ['ann'])])], config, { id: 'boss', kind: 'operator' }), []);
  const many = Array.from({ length: INBOX_LIMIT + 10 }, (_, index) => task(`t${index}`, [approved(1, ['ann'])]));
  assert.equal(buildInbox(many, config, ann).length, INBOX_LIMIT);
});

const root = path.resolve(import.meta.dirname, '..');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'enclave-inbox-test-'));
const tokens = {};
let base;
let server;

before(async () => {
  const env = { PATH: process.env.PATH, HOME: dir, SKIP_LOCAL_ENV: 'true', DATA_DIR: dir, PORT: '0', COORDINATOR_PROVIDER: 'synthetic_fixture' };
  const setup = spawn(process.execPath, ['scripts/setup-local.mjs', dir], { cwd: root, env, stdio: 'ignore' });
  assert.equal((await once(setup, 'exit'))[0], 0);
  for (const id of ['operator', 'recipient-a', 'recipient-b', 'coordinator']) tokens[id] = (await fs.readFile(path.join(dir, `${id}.token`), 'utf8')).trim();
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
  server?.closeAllConnections();
  if (server) await new Promise(resolve => server.close(resolve));
  await fs.rm(dir, { recursive: true, force: true });
});

async function request(url, body, id = 'operator', method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(base + url, { method,
    headers: { 'content-type': 'application/json', ...(id ? { authorization: `Bearer ${tokens[id]}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

test('the inbox route: a recipient sees what was approved for them, nobody else does, and revocation shows', async () => {
  assert.equal((await request('/api/inbox', undefined, 'recipient-a')).body.items.length, 0);
  const sealed = await sealFileBytes(new TextEncoder().encode('MOCK_ONLY,amount\r\nrow,1\r\n'), 'INBOX_CANARY_NAME.csv');
  const intake = { authorizationId: 'local-review', recipients: ['recipient-a'], channels: ['email'],
    expiresAt: new Date(Date.now() + 600000).toISOString(), packet: sealed.packet, documentKey: Buffer.from(sealed.key).toString('hex') };
  const staged = await request('/api/file-tasks', intake);
  assert.equal(staged.status, 201);
  const taskUrl = `/api/tasks/${staged.body.task.id}`;
  // A draft is not approved: nothing in the inbox yet.
  assert.equal((await request('/api/inbox', undefined, 'recipient-a')).body.items.length, 0);
  const revised = await request(taskUrl + '/revise', { version: 1, content: { documentHash: sealed.commitment, recipients: ['recipient-a'],
    channels: ['email'], expiresAt: intake.expiresAt } });
  assert.equal(revised.status, 200);
  const first = await request(taskUrl + '/confirm-first', { version: 2 });
  assert.equal((await request(taskUrl + '/confirm-second', { version: 2, token: first.body.token })).status, 200);

  const mine = await request('/api/inbox', undefined, 'recipient-a');
  assert.equal(mine.status, 200);
  assert.deepEqual(Object.keys(mine.body), ['items']);
  assert.equal(mine.body.items.length, 1);
  assert.deepEqual([mine.body.items[0].id, mine.body.items[0].version, mine.body.items[0].state], [staged.body.task.id, 2, 'WAITING']);
  assert.ok(!JSON.stringify(mine.body).includes('INBOX_CANARY_NAME'));
  assert.deepEqual((await request('/api/inbox', undefined, 'recipient-b')).body.items, []);
  assert.equal((await request('/api/inbox', undefined, 'operator')).status, 403);
  assert.equal((await request('/api/inbox', undefined, 'coordinator')).status, 403);
  assert.equal((await request('/api/inbox', undefined, null)).status, 401);
  assert.equal((await request('/api/inbox', {}, 'recipient-a')).status, 403);

  assert.equal((await request(taskUrl + '/revoke', { version: 2 })).status, 200);
  assert.equal((await request('/api/inbox', undefined, 'recipient-a')).body.items[0].state, 'REVOKED');
});

test('the receiving calls take only a few bytes, however they are reached', async () => {
  const id = '00000000-0000-0000-0000-000000000000';
  const big = JSON.stringify({ version: 1, pad: 'x'.repeat(20_000) });
  // A signed-in recipient is refused for size; a request with no token is refused for that first. Either way the body
  // is read only up to the small cap, never the 7 MB an unsigned visitor could otherwise make the server buffer.
  for (const [who, status] of [['recipient-a', 413], [null, 401]]) {
    const response = await fetch(`${base}/api/file-access/${id}/key`, { method: 'POST',
      headers: { 'content-type': 'application/json', ...(who ? { authorization: `Bearer ${tokens[who]}` } : {}) }, body: big });
    assert.equal(response.status, status, String(who));
  }
  // A normal-sized body still reaches the handler (the delivery does not exist: 404, not 413).
  const small = await fetch(`${base}/api/file-access/${id}/receipt-status`, { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens['recipient-a']}` }, body: JSON.stringify({ version: 1 }) });
  assert.equal(small.status, 404);
});
