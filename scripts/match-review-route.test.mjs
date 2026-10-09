import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

// The resolve route with the optional second opinion switched on (MATCH_AI_REVIEW=local) and a stand-in
// for the loopback model. The stand-in answers whatever the test tells it to and records what it was sent.
const root = path.resolve(import.meta.dirname, '..');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'enclave-review-test-'));
const tokens = {};
let base; let server; let model; let grantId;
const seen = [];
let behaviour = 'agree';   // agree | ask | refuse | illegal | broken

before(async () => {
  model = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const request = JSON.parse(body);
      const input = JSON.parse(request.messages[1].content);
      seen.push({ system: request.messages[0].content, input });
      if (behaviour === 'broken') { res.statusCode = 500; res.end('no'); return; }
      const table = { agree: ['CONFIRM', 'ONE_CLEAR'], ask: ['ASK_HUMAN', 'INSUFFICIENT_INFORMATION'], refuse: ['REFUSE', 'INSUFFICIENT_INFORMATION'], illegal: ['CONFIRM', 'ONE_CLEAR'] }[behaviour];
      // "agree" answers what the codes call for; the others answer a fixed thing regardless.
      const wanted = behaviour === 'agree'
        ? (input.candidateCode === 'CANDIDATE_MANY' ? ['ASK_HUMAN', 'NEEDS_CHOICE'] : table) : table;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ model: 'stand-in', choices: [{ message: { content: JSON.stringify({
        taskAlias: input.taskAlias, snapshotVersion: input.snapshotVersion, action: wanted[0], reasonCode: wanted[1] }) } }] }));
    });
  });
  model.listen(0, '127.0.0.1');
  await once(model, 'listening');
  const env = { PATH: process.env.PATH, HOME: dir, SKIP_LOCAL_ENV: 'true', DATA_DIR: dir, PORT: '0', COORDINATOR_PROVIDER: 'synthetic_fixture',
    MATCH_AI_REVIEW: 'local', LOCAL_MODEL_BASE_URL: `http://127.0.0.1:${model.address().port}/v1`, LOCAL_MODEL_NAME: 'stand-in' };
  const setup = spawn(process.execPath, ['scripts/setup-local.mjs', dir], { cwd: root, env, stdio: 'ignore' });
  assert.equal((await once(setup, 'exit'))[0], 0);
  for (const id of ['operator']) tokens[id] = (await fs.readFile(path.join(dir, `${id}.token`), 'utf8')).trim();
  tokens.admin = crypto.randomBytes(32).toString('base64url');
  const hash = token => crypto.createHash('sha256').update(token).digest('hex');
  const registry = JSON.parse(await fs.readFile(path.join(dir, 'access.json'), 'utf8'));
  for (const [id, nameZh] of [['recipient-a', '劉文祥'], ['recipient-b', '劉文祥']]) Object.assign(registry.principals.find(item => item.id === id), { nameZh });
  registry.principals.push({ id: 'recipient-c', kind: 'recipient', nameZh: '劉慶龍', tokenHash: hash('c'.repeat(43)) });
  registry.principals.push({ id: 'admin', kind: 'administrator', tokenHash: hash(tokens.admin) });
  grantId = registry.grants[0].id;
  registry.grants[0].recipients = [...new Set([...registry.grants[0].recipients, 'recipient-a', 'recipient-b', 'recipient-c'])];
  await fs.writeFile(path.join(dir, 'access.json'), JSON.stringify(registry, null, 2));
  Object.assign(process.env, env);
  const createServer = http.createServer;
  http.createServer = (...args) => { server = createServer(...args); return server; };
  const log = console.log; const error = console.error;
  console.log = () => {}; console.error = () => {};
  try { await import('../server.js'); } finally { console.log = log; console.error = error; http.createServer = createServer; }
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

const resolve = async question => {
  const response = await fetch(base + '/api/directory/resolve', { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens.operator}` },
    body: JSON.stringify({ authorizationId: grantId, ...question }) });
  return { status: response.status, body: await response.json() };
};

test('an adviser that agrees leaves the table answer in place', async () => {
  behaviour = 'agree'; seen.length = 0;
  const answer = await resolve({ nameZh: '劉慶龍' });
  assert.deepEqual([answer.body.status, answer.body.review.final, answer.body.review.disagreement], ['MATCHED', 'CONFIRM', false]);
  assert.deepEqual(answer.body.review.sources, [{ source: 'local', status: 'AGREE', action: 'CONFIRM' }]);
  assert.equal(seen.length, 1);
});

test('what the adviser is sent is codes only', async () => {
  const sent = seen.at(-1).input;
  assert.deepEqual(Object.keys(sent).sort(), ['attemptCode', 'candidateCode', 'keyCode', 'reverseCode', 'snapshotVersion', 'taskAlias']);
  const text = JSON.stringify(sent);
  for (const forbidden of ['劉', 'recipient-', 'operator', grantId]) assert.equal(text.includes(forbidden), false, forbidden);
  assert.ok(seen.at(-1).system.includes('match-confirmation adviser'));
});

test('an adviser that disagrees turns CONFIRM into ASK_HUMAN, and it is recorded', async () => {
  behaviour = 'ask';
  const answer = await resolve({ nameZh: '劉慶龍' });
  assert.deepEqual([answer.body.status, answer.body.review.final, answer.body.review.disagreement], ['MATCHED', 'ASK_HUMAN', true]);
  assert.equal(answer.body.person.id, 'recipient-c');
});

test('an adviser that answers outside the table is treated as unavailable and the table stands', async () => {
  behaviour = 'illegal';
  const answer = await resolve({ nameZh: '劉文祥' });          // two people: CONFIRM is not allowed
  assert.deepEqual([answer.body.status, answer.body.review.final], ['AMBIGUOUS', 'ASK_HUMAN']);
  assert.equal(answer.body.review.sources[0].status, 'UNAVAILABLE');
});

test('an adviser that is down changes nothing and is recorded as unavailable', async () => {
  behaviour = 'broken';
  const answer = await resolve({ nameZh: '劉慶龍' });
  assert.deepEqual([answer.body.review.final, answer.body.review.disagreement, answer.body.review.sources[0].status], ['CONFIRM', false, 'UNAVAILABLE']);
});

test('an outcome the table already refuses is never sent to the adviser', async () => {
  behaviour = 'agree'; seen.length = 0;
  const answer = await resolve({ nameZh: '無此人' });
  assert.deepEqual([answer.body.status, answer.body.review.final, answer.body.review.sources], ['NONE', 'REFUSE', []]);
  assert.equal(seen.length, 0);
  await resolve({ nameZh: '劉慶龍' });   // a success clears the count
});

test('the audit trail records the review as codes', async () => {
  const text = await fs.readFile(path.join(dir, 'audit.json'), 'utf8');
  const reasons = new Set(JSON.parse(text).filter(event => event.type === 'MATCH_ATTEMPT').flatMap(event => event.reasons));
  for (const wanted of ['MATCH_REVIEW_CONFIRM', 'MATCH_REVIEW_ASK_HUMAN', 'MATCH_REVIEW_DISAGREE', 'MATCH_REVIEW_UNAVAILABLE']) assert.ok(reasons.has(wanted), wanted);
  assert.equal(reasons.has('UNCLASSIFIED'), false);
  assert.equal(/劉|recipient-/.test(text.slice(text.indexOf('MATCH_ATTEMPT'))), false);
});
