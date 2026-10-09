import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

// POST /api/directory/understand with NOTE_AI=local and a stand-in for the loopback model.
const root = path.resolve(import.meta.dirname, '..');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'enclave-note-test-'));
const tokens = {};
let base; let server; let model; let grantId;
const seen = [];
let answer = {}; let broken = false;

before(async () => {
  model = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      seen.push(JSON.parse(JSON.parse(body).messages[1].content));
      if (broken) { res.statusCode = 500; res.end('no'); return; }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ department: 'NONE', region: 'NONE', team: 'NONE', role: 'NONE', surname: '', nameZh: '', employeeId: '', ...answer }) } }] }));
    });
  });
  model.listen(0, '127.0.0.1');
  await once(model, 'listening');
  const env = { PATH: process.env.PATH, HOME: dir, SKIP_LOCAL_ENV: 'true', DATA_DIR: dir, PORT: '0', COORDINATOR_PROVIDER: 'synthetic_fixture',
    NOTE_AI: 'local', LOCAL_MODEL_BASE_URL: `http://127.0.0.1:${model.address().port}/v1`, LOCAL_MODEL_NAME: 'stand-in' };
  const setup = spawn(process.execPath, ['scripts/setup-local.mjs', dir], { cwd: root, env, stdio: 'ignore' });
  assert.equal((await once(setup, 'exit'))[0], 0);
  for (const id of ['operator', 'recipient-a']) tokens[id] = (await fs.readFile(path.join(dir, `${id}.token`), 'utf8')).trim();
  const hash = token => crypto.createHash('sha256').update(token).digest('hex');
  const registry = JSON.parse(await fs.readFile(path.join(dir, 'access.json'), 'utf8'));
  for (const d of [['sales', '業務部'], ['accounting', '會計部'], ['hr', '人事部']]) if (!registry.departments.some(item => item.id === d[0])) registry.departments.push({ id: d[0], displayName: d[1] });
  const set = (id, fields) => Object.assign(registry.principals.find(item => item.id === id), fields);
  set('recipient-a', { nameZh: '劉文祥', department: 'sales', tags: { region: '北區' } });
  set('recipient-b', { nameZh: '劉文祥', department: 'sales', tags: { region: '南區' } });
  registry.principals.push({ id: 'recipient-c', kind: 'recipient', department: 'sales', nameZh: '劉慶龍', tags: { region: '北區' }, tokenHash: hash('c'.repeat(43)) });
  registry.principals.push({ id: 'recipient-d', kind: 'recipient', department: 'accounting', nameZh: '王小明', tokenHash: hash('d'.repeat(43)) });
  registry.principals.push({ id: 'recipient-x', kind: 'recipient', department: 'hr', nameZh: '外部人員', tags: { region: '東區' }, tokenHash: hash('x'.repeat(43)) });
  registry.principals.push({ id: 'admin', kind: 'administrator', tokenHash: hash('a'.repeat(43)) });
  grantId = registry.grants[0].id;
  registry.grants[0].recipients = [...new Set([...registry.grants[0].recipients, 'recipient-a', 'recipient-b', 'recipient-c', 'recipient-d'])];
  await fs.writeFile(path.join(dir, 'access.json'), JSON.stringify(registry, null, 2));
  Object.assign(process.env, env);
  const createServer = http.createServer;
  http.createServer = (...args) => { server = createServer(...args); return server; };
  const log = console.log; console.log = () => {};
  try { await import('../server.js'); } finally { console.log = log; http.createServer = createServer; }
  if (!server.listening) await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  model.closeAllConnections();
  await new Promise(resolve => model.close(resolve));
  await fs.rm(dir, { recursive: true, force: true });
});

const call = async (url, body, id = 'operator') => {
  const response = await fetch(base + url, { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens[id]}` }, body: JSON.stringify({ authorizationId: grantId, ...body }) });
  return { status: response.status, body: await response.json() };
};
const understand = (note, extra = {}, id) => call('/api/directory/understand', { note, ...extra }, id);

test('the directory listing tells the page the model reader is on', async () => {
  assert.equal((await call('/api/directory', {})).body.noteModel, true);
});

test('what the note supports and the authorization holds is returned, and nobody is selected', async () => {
  answer = { department: 'sales', region: '北區', nameZh: '劉慶龍' };
  const { status, body } = await understand('寄給業務部北區的劉慶龍');
  assert.equal(status, 200);
  assert.deepEqual([body.method, body.fallback], ['model', null]);
  assert.deepEqual(body.fields, { department: 'sales', tags: { region: '北區' }, nameZh: '劉慶龍', surname: null, employeeId: null });
  assert.deepEqual(Object.keys(body).sort(), ['fallback', 'fields', 'method', 'ok']);
});

test('the model sees the note and a vocabulary of the authorization, never a person', async () => {
  seen.length = 0;
  await understand('給業務部的人');
  const sent = seen.at(-1);
  assert.deepEqual(Object.keys(sent).sort(), ['departments', 'note', 'tags']);
  assert.deepEqual(sent.departments.map(entry => entry.id).sort(), ['accounting', 'sales']);
  assert.deepEqual(sent.tags, { region: ['北區', '南區'], team: [], role: [] });
  const text = JSON.stringify(sent);
  for (const forbidden of ['recipient-', '劉文祥', '劉慶龍', '王小明', '外部', '東區', 'hr', 'operator', grantId]) assert.equal(text.includes(forbidden), false, forbidden);
});

test('a name that is not on the authorization is not kept, and an honorific becomes a surname', async () => {
  answer = { department: 'sales', nameZh: '劉先生' };
  const { body } = await understand('業務部的劉先生');
  assert.deepEqual([body.fields.nameZh, body.fields.surname], [null, '劉']);
  answer = { nameZh: '外部人員', employeeId: 'recipient-x' };
  const outside = (await understand('外部人員 recipient-x')).body.fields;
  assert.deepEqual([outside.nameZh, outside.employeeId], [null, null]);
});

test('an invented department, tag or name is dropped before it reaches the page', async () => {
  answer = { department: 'accounting', region: '南區', role: 'lead', nameZh: '王小明' };
  const { body } = await understand('給業務的人');
  assert.deepEqual(body.fields, { department: null, tags: {}, nameZh: null, surname: null, employeeId: null });
});

test('when the model is down the answer is an explicit fallback, not an error', async () => {
  broken = true;
  try {
    const { status, body } = await understand('業務部的劉先生');
    assert.deepEqual([status, body.method, body.fallback, body.fields], [200, 'off', 'MODEL_UNAVAILABLE', null]);
  } finally { broken = false; }
});

test('only the operator of the authorization may ask, and bad input is refused', async () => {
  assert.equal((await understand('業務', {}, 'recipient-a')).status, 403);
  assert.equal((await understand('')).status, 422);
  assert.equal((await understand('x'.repeat(201))).status, 422);
  assert.equal((await understand('業務', { extra: 1 })).status, 422);
  assert.equal((await call('/api/directory/understand', { note: '業務', authorizationId: 'no-such' })).status, 403);
});

test('matching is untouched and the note is not stored', async () => {
  for (let i = 0; i < 4; i++) await understand('業務部');
  assert.equal((await call('/api/directory/resolve', { nameZh: '劉慶龍' })).body.attemptsLeft, 3);
  const text = await fs.readFile(path.join(dir, 'audit.json'), 'utf8');
  const reasons = new Set(JSON.parse(text).filter(event => event.type === 'MATCH_ATTEMPT').flatMap(event => event.reasons));
  assert.ok(reasons.has('MATCH_NOTE_MODEL'));
  assert.equal(reasons.has('UNCLASSIFIED'), false);
  for (const secret of ['業務部', '劉', 'recipient-']) assert.equal(text.includes(secret), false, secret);
});
