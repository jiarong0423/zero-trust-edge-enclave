import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

// POST /api/tasks/status-check on the real server, with deliveries written straight into the task file in
// states the worker leaves alone, and a stand-in for the loopback model as the second opinion.
const root = path.resolve(import.meta.dirname, '..');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'enclave-state-test-'));
const tokens = {};
let base; let server; let model; let grantId;
const seen = [];
const ids = { blocked: '11111111-0000-4000-8000-000000000001', unknown: '11111111-0000-4000-8000-000000000002',
  prepared: '11111111-0000-4000-8000-000000000003', fresh: '11111111-0000-4000-8000-000000000004', old: '11111111-0000-4000-8000-000000000005',
  foreign: '11111111-0000-4000-8000-000000000006' };

before(async () => {
  model = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const request = JSON.parse(body); const input = JSON.parse(request.messages[1].content);
      seen.push(input);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ model: 'stand-in', choices: [{ message: { content: JSON.stringify({
        taskAlias: input.taskAlias, snapshotVersion: input.snapshotVersion, severity: 'NEEDS_HUMAN', reasonCode: 'INSUFFICIENT_INFORMATION' }) } }] }));
    });
  });
  model.listen(0, '127.0.0.1');
  await once(model, 'listening');
  const env = { PATH: process.env.PATH, HOME: dir, SKIP_LOCAL_ENV: 'true', DATA_DIR: dir, PORT: '0', COORDINATOR_PROVIDER: 'synthetic_fixture',
    STATE_AI_REVIEW: 'local', LOCAL_MODEL_BASE_URL: `http://127.0.0.1:${model.address().port}/v1`, LOCAL_MODEL_NAME: 'stand-in' };
  const setup = spawn(process.execPath, ['scripts/setup-local.mjs', dir], { cwd: root, env, stdio: 'ignore' });
  assert.equal((await once(setup, 'exit'))[0], 0);
  for (const id of ['operator', 'recipient-a']) tokens[id] = (await fs.readFile(path.join(dir, `${id}.token`), 'utf8')).trim();
  grantId = JSON.parse(await fs.readFile(path.join(dir, 'access.json'), 'utf8')).grants[0].id;
  const now = Date.now(); const iso = offset => new Date(now + offset).toISOString();
  const task = (id, owner, job) => ({ id, ownerId: owner, grantId, jobs: [{ version: 1, revision: 0, ...job }],
    snapshots: [{ version: 1, status: 'APPROVED', approvedAt: iso(-3600_000), confirmedAt: iso(-3600_000),
      content: { recipients: ['recipient-a'], channels: ['email'], deliveryMode: 'TIME_LIMITED', downloadUntil: iso(3600_000), expiresAt: iso(7200_000) } }] });
  const tasks = [
    task(ids.blocked, 'operator', { status: 'PAUSED', attempts: 3, reasonCode: 'RETRY_EXHAUSTED', updatedAt: iso(-60_000) }),
    task(ids.unknown, 'operator', { status: 'OUTCOME_UNKNOWN', attempts: 1, reasonCode: 'OUTCOME_UNKNOWN', updatedAt: iso(-60_000) }),
    task(ids.prepared, 'operator', { status: 'DRY_RUN_PREPARED', attempts: 1, updatedAt: iso(-3600_000) }),
    task(ids.fresh, 'operator', { status: 'PAUSED', attempts: 0, reasonCode: 'ADVICE_PAUSED', updatedAt: iso(-60_000) }),
    task(ids.old, 'operator', { status: 'PAUSED', attempts: 0, reasonCode: 'ADVICE_PAUSED', updatedAt: iso(-3 * 3600_000) }),
    task(ids.foreign, 'recipient-a', { status: 'PAUSED', attempts: 0, updatedAt: iso(-60_000) })
  ];
  await fs.writeFile(path.join(dir, 'tasks.json'), JSON.stringify(tasks));
  await fs.writeFile(path.join(dir, 'packages.json'), '[]');
  await fs.writeFile(path.join(dir, 'audit.json'), '[]');
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

const check = async (taskId, id = 'operator', body = { taskId }) => {
  const response = await fetch(base + '/api/tasks/status-check', { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens[id]}` }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
};

test('a blocked delivery needs a person and is never sent to the adviser', async () => {
  seen.length = 0;
  const { status, body } = await check(ids.blocked);
  assert.equal(status, 200);
  assert.deepEqual([body.checks[0].severity, body.checks[0].reason, body.checks[0].disagreement], ['NEEDS_HUMAN', 'BLOCKED', false]);
  assert.equal(seen.length, 0);
  assert.equal(body.checks[0].message, 'Blocked by a condition that retrying will not fix.');
  assert.deepEqual(body.checks[0].codes, { stateCode: 'PAUSED', ageCode: 'AGE_FRESH', triesCode: 'TRIES_MANY', causeCode: 'CAUSE_BLOCKING', pickupCode: 'PICKUP_NA', windowCode: 'WINDOW_NA' });
});

test('an unknown outcome needs a person', async () => {
  const { body } = await check(ids.unknown);
  assert.deepEqual([body.checks[0].severity, body.checks[0].reason], ['NEEDS_HUMAN', 'NEEDS_DECISION']);
});

test('a delivery that is simply waiting is normal in the table, and the adviser can raise it one step', async () => {
  seen.length = 0;
  const { body } = await check(ids.prepared);
  const result = body.checks[0];
  assert.deepEqual([result.tableSeverity, result.severity, result.disagreement, result.reason], ['NORMAL', 'WATCH', true, 'WAITING_FOR_PICKUP']);
  assert.deepEqual(result.sources, [{ source: 'local', status: 'RAISES', severity: 'NEEDS_HUMAN' }]);
  assert.equal(seen.length, 1);
  assert.deepEqual(Object.keys(seen[0]).sort(), ['ageCode', 'causeCode', 'pickupCode', 'snapshotVersion', 'stateCode', 'taskAlias', 'triesCode', 'windowCode']);
  const text = JSON.stringify(seen[0]);
  for (const forbidden of [ids.prepared, 'operator', 'recipient', grantId, '@']) assert.equal(text.includes(forbidden), false, forbidden);
});

test('a paused delivery waiting for advice is watched at first and needs a person once it is older', async () => {
  const fresh = (await check(ids.fresh)).body.checks[0];
  const old = (await check(ids.old)).body.checks[0];
  assert.deepEqual([fresh.tableSeverity, old.tableSeverity, old.reason], ['WATCH', 'NEEDS_HUMAN', 'NEEDS_DECISION']);
  assert.equal(fresh.severity, 'NEEDS_HUMAN');
});

test('only the owner may check a task, and bad requests are refused', async () => {
  assert.equal((await check(ids.foreign)).status, 404);
  assert.equal((await check(ids.blocked, 'recipient-a')).status, 403);
  assert.equal((await check('not-a-task')).status, 422);
  assert.equal((await check(ids.blocked, 'operator', { taskId: ids.blocked, extra: 1 })).status, 422);
  assert.equal((await check('00000000-0000-4000-8000-00000000ffff')).status, 404);
  const anonymous = await fetch(base + '/api/tasks/status-check', { method: 'POST', body: '{}' });
  assert.equal(anonymous.status, 401);
});

test('the check changes nothing: the task file is byte for byte the same afterwards', async () => {
  const before = await fs.readFile(path.join(dir, 'tasks.json'), 'utf8');
  for (const id of [ids.blocked, ids.prepared, ids.old]) await check(id);
  assert.equal(await fs.readFile(path.join(dir, 'tasks.json'), 'utf8'), before);
});
