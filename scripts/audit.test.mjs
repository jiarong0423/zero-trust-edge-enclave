import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initializeArrays, readArray, writeArray } from '../local-array-store.js';
import { queueAudit } from '../audit-outbox.js';
import { createAudit } from '../audit.js';
import { requestContext, currentRequest, setAuditTarget } from '../request-context.js';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'enclave-audit-module-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const auditsPath = path.join(dir, 'audit.json');
  const tasksPath = path.join(dir, 'tasks.json');
  await initializeArrays([auditsPath, tasksPath]);
  const readJson = file => readArray(file);
  const writeJson = (file, value) => writeArray(file, value);
  return { auditsPath, tasksPath, readJson, writeJson, ...createAudit({ auditsPath, readJson, writeJson }) };
}

const taskId = '11111111-1111-4111-8111-111111111111';

test('request context accessors return the live store, never a copy', async () => {
  assert.equal(currentRequest(), undefined);
  await requestContext.run({}, async () => {
    const store = currentRequest();
    Object.assign(currentRequest(), { principal: { id: 'p' } });
    setAuditTarget({ taskId });
    assert.equal(currentRequest(), store);
    assert.deepEqual(store.auditTarget, { taskId });
    assert.equal(store.principal.id, 'p');
  });
  assert.throws(() => setAuditTarget({ taskId }), TypeError);
});

test('appendAudit links the hash chain, merges the request audit target and deduplicates by id', async t => {
  const f = await fixture(t);
  const first = await requestContext.run({}, async () => { setAuditTarget({ taskId, snapshotVersion: 2 });
    return f.appendAudit({ type: 'SNAPSHOT_TRANSITION', result: 'INFO', reasons: ['STATE_CHANGED'] }); });
  assert.equal(first.previousHash, null);
  assert.equal(first.taskId, taskId);
  assert.equal(first.snapshotVersion, 2);
  const second = await f.appendAudit({ type: 'REQUEST_REJECTED', result: 'DENY', reasons: ['ACCESS_DENIED'] });
  assert.equal(second.previousHash, first.eventHash);
  assert.equal(second.taskId, null);
  const replay = await f.appendAudit({ id: first.id, type: 'REQUEST_REJECTED', result: 'DENY', reasons: ['ACCESS_DENIED'] });
  assert.deepEqual(replay, first);
  assert.equal((await readArray(f.auditsPath)).length, 2);
});

test('auditRejection records one REQUEST_REJECTED per request, only for an authenticated principal', async t => {
  const f = await fixture(t);
  await f.auditRejection(Object.assign(new Error('x'), { status: 403 }));
  await requestContext.run({}, () => f.auditRejection(Object.assign(new Error('x'), { status: 403 })));
  assert.equal((await readArray(f.auditsPath)).length, 0, 'no request or no principal: nothing recorded');
  await requestContext.run({}, async () => {
    Object.assign(currentRequest(), { principal: { id: 'p' } });
    setAuditTarget({ taskId, previousState: 'LOCKED' });
    await f.auditRejection(Object.assign(new Error('x'), { status: 409 }));
    await f.auditRejection(Object.assign(new Error('x'), { status: 500 }));
    assert.equal(currentRequest().rejectionRecorded, true);
  });
  const audits = await readArray(f.auditsPath);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].type, 'REQUEST_REJECTED');
  assert.deepEqual(audits[0].reasons, ['STATE_CONFLICT']);
  assert.equal(audits[0].nextState, 'LOCKED');
  assert.equal(audits[0].taskId, taskId);
  for (const [status, code] of [[422, 'INVALID_REQUEST'], [503, 'SERVICE_UNAVAILABLE'], [401, 'ACCESS_DENIED']]) {
    await requestContext.run({}, async () => {
      Object.assign(currentRequest(), { principal: { id: 'p' } });
      await f.auditRejection(Object.assign(new Error('x'), { status }));
    });
    assert.deepEqual((await readArray(f.auditsPath)).at(-1).reasons, [code]);
  }
});

test('recoverAudit appends a record outbox to the chain, then clears it from the record', async t => {
  const f = await fixture(t);
  const record = queueAudit({ id: taskId }, [{ taskId, snapshotVersion: 1, type: 'SNAPSHOT_TRANSITION', result: 'INFO', reasons: ['STATE_CHANGED'] }]);
  await f.writeJson(f.tasksPath, [record]);
  await f.recoverAudit(f.tasksPath);
  assert.equal((await readArray(f.auditsPath)).length, 1);
  assert.deepEqual((await readArray(f.tasksPath))[0].auditOutbox, []);
  await f.recoverAudit(f.tasksPath);
  assert.equal((await readArray(f.auditsPath)).length, 1, 'a second recovery adds nothing');
});
