import test from 'node:test';
import assert from 'node:assert/strict';
import { newTask, confirmFirst, confirmSecond } from '../snapshot-lifecycle.js';
import { sealFileBytes } from '../public/file-envelope.js';
import { advanceFileJobs } from '../file-worker.js';
import { resumeFileTask } from '../task-operations.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import { validateAccess } from '../access-control.js';

test('HTTP resume rejects foreign and concurrent replay, preserves retry ledger across restart', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'enclave-resume-http-'));
  const tokens = {};
  const principals = [['sender', 'operator'], ['foreign', 'operator'], ['recipient', 'recipient'], ['coordinator', 'coordinator']]
    .map(([id, kind]) => {
      tokens[id] = randomBytes(32).toString('base64url');
      return { id, kind, department: 'test', tokenHash: createHash('sha256').update(tokens[id]).digest('hex') };
    });
  const grant = { id: 'grant', version: 1, operatorId: 'sender', coordinatorId: 'coordinator', recipients: ['recipient'],
    channels: ['email'], expiresAt: new Date(Date.now() + 600000).toISOString(), maxAttempts: 3,
    maxOpens: 2, simulatedOutcomes: ['transient', 'prepared'] };
  const config = validateAccess({ schemaVersion: 2, revision: 1, departments: [{ id: 'test', displayName: 'Test' }], principals, grants: [grant] });
  const sealed = await sealFileBytes(new Uint8Array([1, 2, 3]), 'synthetic.csv');
  const draft = newTask(principals[0], grant, { documentHash: sealed.commitment,
    recipients: grant.recipients, channels: grant.channels, expiresAt: grant.expiresAt });
  draft.file = { packet: sealed.packet };
  const first = confirmFirst(draft, principals[0], grant, 1);
  const approved = confirmSecond(first.task, principals[0], grant, 1, first.token);
  const attempted = await advanceFileJobs(approved, config);
  const paused = await advanceFileJobs(attempted, config, Date.now() + 3000, async () => { throw Error('SYNTHETIC_UNAVAILABLE'); });
  assert.equal(paused.jobs[0].status, 'PAUSED');
  assert.equal(paused.jobs[0].attempts, 1);
  paused.jobs[0].delivery.nextAttemptAt = new Date(Date.now() + 300000).toISOString();
  const beforeLedger = structuredClone(paused.jobs[0].delivery);
  await fs.writeFile(path.join(dir, 'access.json'), JSON.stringify(config), { mode: 0o600 });
  for (const [name, value] of [['tasks', [paused]], ['packages', []], ['audit', []]]) {
    await fs.writeFile(path.join(dir, name + '.json'), JSON.stringify(value), { mode: 0o600 });
  }
  sealed.key.fill(0);
  let child;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); }
    await fs.rm(dir, { recursive: true, force: true });
  });
  const start = async () => {
    child = spawn(process.execPath, ['server.js'], { cwd: path.resolve(import.meta.dirname, '..'),
      env: { PATH: process.env.PATH, HOME: dir, DATA_DIR: dir, SKIP_LOCAL_ENV: 'true', LOCAL_ONLY: 'true', PORT: '0',
        COORDINATOR_PROVIDER: 'synthetic_fixture' }, stdio: ['ignore', 'pipe', 'ignore'] });
    return new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(Error('TEST_SERVER_TIMEOUT')), 10000);
      child.stdout.on('data', chunk => {
        output += chunk;
        const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
        if (match) { clearTimeout(timer); resolve(match[0]); }
      });
      child.once('exit', () => { clearTimeout(timer); reject(Error('TEST_SERVER_EXITED')); });
    });
  };
  let base = await start();
  const route = '/api/tasks/' + paused.id;
  const request = async (id, body, url = route + '/resume') => {
    const response = await fetch(base + url, { method: body ? 'POST' : 'GET',
      headers: { authorization: 'Bearer ' + tokens[id], 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  };
  const input = { version: 1, expectedRevision: paused.jobs[0].revision };
  assert.equal((await request('foreign', input)).status, 404);
  assert.equal((await request('recipient', input)).status, 403);
  assert.equal((await request('coordinator', input)).status, 403);
  assert.equal((await request('sender', { ...input, attempts: 0 })).status, 422);
  const results = await Promise.all([request('sender', input), request('sender', input)]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  const readTask = async () => JSON.parse(await fs.readFile(path.join(dir, 'tasks.json'), 'utf8'))[0];
  assert.deepEqual((await readTask()).jobs[0].delivery, beforeLedger);
  assert.equal((await request('foreign', undefined, route)).status, 404);
  assert.deepEqual((await request('foreign', undefined, '/api/tasks')).body.tasks, []);
  child.kill();
  await once(child, 'exit');
  base = await start();
  assert.equal((await request('sender', input)).status, 409);
  const persisted = await readTask();
  assert.equal(persisted.jobs[0].status, 'RETRY_WAIT');
  assert.equal(persisted.jobs[0].revision, input.expectedRevision + 1);
  assert.deepEqual(persisted.jobs[0].delivery, beforeLedger);
  assert.equal(persisted.jobs[0].attempts, 1);
  const status = await request('sender', undefined, route);
  assert.equal(status.status, 200);
  assert.ok(!JSON.stringify(status.body).includes(sealed.packet.ciphertext));
});

test('resume revalidates authority, retains budget and rejects unknown outcomes', async () => {
  const actor = { id: 'sender', kind: 'operator' };
  const grant = { id: 'grant', version: 1, operatorId: actor.id, recipients: ['recipient'], channels: ['email'],
    expiresAt: new Date(Date.now() + 600000).toISOString(), maxAttempts: 2, simulatedOutcomes: ['transient', 'prepared'] };
  const config = { grants: [grant], principals: [actor, { id: 'recipient', kind: 'recipient' }] };
  const sealed = await sealFileBytes(new Uint8Array([1, 2]), 'synthetic.csv');
  const draft = newTask(actor, grant, { documentHash: sealed.commitment, recipients: grant.recipients,
    channels: grant.channels, expiresAt: grant.expiresAt });
  draft.file = { packet: sealed.packet };
  const first = confirmFirst(draft, actor, grant, 1);
  const approved = confirmSecond(first.task, actor, grant, 1, first.token);
  const unavailable = async () => { throw Error('PRIVATE_FAILURE'); };
  // Three spaced retries run first; the fourth failure pauses for a person.
  let paused = approved;
  const start = Date.now();
  for (let tick = 0; tick < 4; tick++) paused = await advanceFileJobs(paused, config, start + tick * 30000, unavailable);
  assert.equal(paused.jobs[0].status, 'PAUSED');
  assert.equal(paused.jobs[0].reasonCode, 'ADVISER_UNAVAILABLE');
  assert.ok(!JSON.stringify(paused).includes('PRIVATE_FAILURE'));
  const resumed = await resumeFileTask(paused, actor, config, 1, paused.jobs[0].revision);
  assert.equal(resumed.jobs[0].status, 'PENDING_CHECK');
  assert.equal(resumed.jobs[0].attempts, 0);
  // A person resuming gives the adviser a fresh set of retries.
  assert.equal(resumed.jobs[0].adviceRetries, undefined);
  assert.equal(resumed.jobs[0].nextAdviceAt, undefined);
  assert.equal(paused.jobs[0].status, 'PAUSED');
  await assert.rejects(resumeFileTask(resumed, actor, config, 1, paused.jobs[0].revision));
  await assert.rejects(resumeFileTask(paused, { ...actor, id: 'foreign' }, config, 1, paused.jobs[0].revision));
  await assert.rejects(resumeFileTask(paused, actor, { ...config, grants: [{ ...grant, version: 2 }] }, 1, paused.jobs[0].revision));
  const corrupt = structuredClone(paused); corrupt.file.packet.iv = 'AAAAAAAAAAAAAAAA';
  await assert.rejects(resumeFileTask(corrupt, actor, config, 1, corrupt.jobs[0].revision));
  const tried = await advanceFileJobs(resumed, config);
  const failed = await advanceFileJobs(tried, config, Date.now() + 3000, unavailable);
  const retry = await resumeFileTask(failed, actor, config, 1, failed.jobs[0].revision);
  assert.equal(retry.jobs[0].attempts, 1);
  assert.deepEqual(retry.jobs[0].delivery.requests, tried.jobs[0].delivery.requests);
  assert.equal((await advanceFileJobs(retry, config, Date.now() + 3000)).jobs[0].attempts, 2);
  for (const [outcome, expected] of [['unknown', 'OUTCOME_UNKNOWN'], ['transient', 'RETRY_EXHAUSTED']]) {
    const other = { ...config, grants: [{ ...grant, maxAttempts: 1, simulatedOutcomes: [outcome] }] };
    const terminal = await advanceFileJobs(approved, other);
    assert.equal(terminal.jobs[0].reasonCode, expected);
    await assert.rejects(resumeFileTask(terminal, actor, other, 1, terminal.jobs[0].revision));
  }
  sealed.key.fill(0);
});
