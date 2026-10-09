import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

// The ranking route with RECIPIENT_RANKING=vector and a stand-in for the embedding model on loopback.
const root = path.resolve(import.meta.dirname, '..');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'enclave-rank-test-'));
const tokens = {};
let base; let server; let model; let grantId;
const inputs = [];
let broken = false;
const vectorOf = text => {
  const v = new Array(128).fill(0);
  const chars = [...text.replace(/^search_(query|document): /, '')];
  chars.forEach((c, i) => { v[c.codePointAt(0) % 128] += 1; if (i) v[(c.codePointAt(0) * 31 + chars[i - 1].codePointAt(0)) % 128] += 0.5; });
  return v;
};

before(async () => {
  model = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      if (broken) { res.statusCode = 500; res.end('no'); return; }
      const request = JSON.parse(body);
      inputs.push({ url: req.url, input: request.input });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: request.input.map((text, index) => ({ index, embedding: vectorOf(text) })) }));
    });
  });
  model.listen(0, '127.0.0.1');
  await once(model, 'listening');
  const env = { PATH: process.env.PATH, HOME: dir, SKIP_LOCAL_ENV: 'true', DATA_DIR: dir, PORT: '0', COORDINATOR_PROVIDER: 'synthetic_fixture',
    RECIPIENT_RANKING: 'vector', EMBEDDING_MODEL_NAME: 'stand-in', LOCAL_MODEL_BASE_URL: `http://127.0.0.1:${model.address().port}/v1` };
  const setup = spawn(process.execPath, ['scripts/setup-local.mjs', dir], { cwd: root, env, stdio: 'ignore' });
  assert.equal((await once(setup, 'exit'))[0], 0);
  for (const id of ['operator', 'recipient-a']) tokens[id] = (await fs.readFile(path.join(dir, `${id}.token`), 'utf8')).trim();
  const hash = token => crypto.createHash('sha256').update(token).digest('hex');
  const registry = JSON.parse(await fs.readFile(path.join(dir, 'access.json'), 'utf8'));
  for (const d of [['sales', '業務部'], ['accounting', '會計部']]) if (!registry.departments.some(item => item.id === d[0])) registry.departments.push({ id: d[0], displayName: d[1] });
  const set = (id, fields) => Object.assign(registry.principals.find(item => item.id === id), fields);
  set('recipient-a', { nameZh: '劉文祥', displayName: 'Wen Liu', department: 'sales', tags: { region: '北區' } });
  set('recipient-b', { nameZh: '劉文祥', displayName: 'Wen Liu', department: 'sales', tags: { region: '南區' } });
  registry.principals.push({ id: 'recipient-c', kind: 'recipient', department: 'sales', nameZh: '劉慶龍', displayName: 'Q Liu', tags: { region: '北區' }, tokenHash: hash('c'.repeat(43)) });
  registry.principals.push({ id: 'recipient-d', kind: 'recipient', department: 'accounting', nameZh: '王小明', displayName: 'Ming Wang', tokenHash: hash('d'.repeat(43)) });
  registry.principals.push({ id: 'recipient-x', kind: 'recipient', department: 'sales', nameZh: '外部人員', displayName: 'Outside Person', tokenHash: hash('x'.repeat(43)) });
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
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens[id]}` },
    body: JSON.stringify({ authorizationId: grantId, ...body }) });
  return { status: response.status, body: await response.json() };
};
const rank = (text, extra = {}) => call('/api/directory/rank', { text, ...extra });

test('the best match is first, only people on the authorization appear, and the answer is an order and nothing else', async () => {
  const answer = await rank('業務部 劉慶龍');
  assert.equal(answer.status, 200);
  assert.deepEqual(Object.keys(answer.body).sort(), ['fallback', 'method', 'ok', 'order']);
  assert.deepEqual([answer.body.method, answer.body.fallback], ['vector', null]);
  assert.equal(answer.body.order[0], 'recipient-c');
  assert.deepEqual([...answer.body.order].sort(), ['recipient-a', 'recipient-b', 'recipient-c', 'recipient-d']);
});

test('the person outside the authorization is never ranked and never sent to the model', async () => {
  await rank('業務部');   // every text embedded so far in this file, the first full ranking included
  const sent = JSON.stringify(inputs);
  assert.ok(inputs.length > 0);
  for (const secret of ['外部', 'Outside', 'recipient-x']) assert.equal(sent.includes(secret), false, secret);
  assert.equal(inputs.every(item => item.url === '/v1/embeddings'), true);
});

test('department and tags narrow the pool', async () => {
  assert.deepEqual((await rank('劉', { department: 'accounting' })).body.order, ['recipient-d']);
  assert.deepEqual((await rank('劉', { department: 'sales', tags: { region: '北區' } })).body.order.sort(), ['recipient-a', 'recipient-c']);
});

test('only the operator of the authorization may rank, and bad input is refused', async () => {
  assert.equal((await call('/api/directory/rank', { text: '劉' }, 'recipient-a')).status, 403);
  assert.equal((await rank('')).status, 422);
  assert.equal((await rank('x'.repeat(101))).status, 422);
  assert.equal((await rank('劉', { tags: { colour: 'red' } })).status, 422);
  assert.equal((await rank('劉', { department: 5 })).status, 422);
  assert.equal((await rank('劉', { extra: 1 })).status, 422);
  assert.equal((await call('/api/directory/rank', { text: '劉', authorizationId: 'no-such' })).status, 403);
});

test('ranking does not touch the failure count of matching', async () => {
  for (let i = 0; i < 5; i++) await rank('不存在的人');
  const answer = await call('/api/directory/resolve', { nameZh: '劉慶龍' });
  assert.equal(answer.body.attemptsLeft, 3);
});

test('when the embedding model is down the order is fixed, the status is 200 and matching is unaffected', async () => {
  broken = true;
  try {
    const answer = await rank('業務部 劉慶龍');
    assert.deepEqual([answer.status, answer.body.method, answer.body.fallback], [200, 'fixed', 'EMBEDDING_UNAVAILABLE']);
    assert.equal(answer.body.order.length, 4);
    const matched = await call('/api/directory/resolve', { nameZh: '劉慶龍' });
    assert.equal(matched.body.status, 'MATCHED');
  } finally { broken = false; }
});

test('the typed text is not stored: the audit trail holds the method only', async () => {
  const text = await fs.readFile(path.join(dir, 'audit.json'), 'utf8');
  const reasons = new Set(JSON.parse(text).filter(event => event.type === 'MATCH_ATTEMPT').flatMap(event => event.reasons));
  assert.ok(reasons.has('MATCH_RANK_VECTOR') && reasons.has('MATCH_RANK_FIXED'));
  assert.equal(reasons.has('UNCLASSIFIED'), false);
  for (const secret of ['業務部', '不存在的人', '劉慶龍', 'recipient-']) assert.equal(text.includes(secret), false, secret);
});
