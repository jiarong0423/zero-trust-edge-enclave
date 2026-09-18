import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceFileJobs } from '../file-worker.js';
import { newTask, confirmFirst, confirmSecond } from '../snapshot-lifecycle.js';
import { sealFileBytes } from '../public/file-envelope.js';
import { syntheticFileAdvice } from '../file-routing.js';

test('file worker is approval-bound, finite and idempotent without browser calls', async () => {
  const actor = { id: 'sender', kind: 'operator' };
  const now = Date.now();
  const grant = { id: 'grant', version: 1, operatorId: actor.id, recipients: ['a'], channels: ['email'],
    maxAttempts: 2, expiresAt: new Date(now + 60000).toISOString(), simulatedOutcomes: ['transient', 'prepared'] };
  const config = { grants: [grant], principals: [actor, { id: 'a', kind: 'recipient' }] };
  const sealed = await sealFileBytes(new Uint8Array([1, 2, 3]), 'mock.csv');
  const draft = newTask(actor, grant, { documentHash: sealed.commitment, recipients: ['a'], channels: ['email'], expiresAt: grant.expiresAt }, now);
  draft.file = { packet: sealed.packet };
  assert.equal(await advanceFileJobs(draft, config, now), draft);
  const first = confirmFirst(draft, actor, grant, 1, now);
  const approved = confirmSecond(first.task, actor, grant, 1, first.token, now);
  const retry = await advanceFileJobs(approved, config, now);
  assert.equal(retry.jobs[0].status, 'RETRY_WAIT');
  assert.equal(await advanceFileJobs(retry, config, now + 10), retry);
  const done = await advanceFileJobs(retry, config, now + 2000);
  assert.equal(done.jobs[0].status, 'DRY_RUN_PREPARED');
  assert.equal(done.jobs[0].attempts, 2);
  assert.equal(done.jobs[0].notice.sendsEmail, false);
  assert.ok(!JSON.stringify(done.jobs[0].notice).includes('ciphertext'));
  assert.equal(await advanceFileJobs(done, config, now + 3000), done);
  for (const outcomes of [['unknown'], ['transient', 'transient']]) {
    const altered = { ...config, grants: [{ ...grant, simulatedOutcomes: outcomes }] };
    let task = await advanceFileJobs(approved, altered, now);
    task = await advanceFileJobs(task, altered, now + 2000);
    assert.equal(task.jobs[0].status, outcomes[0] === 'unknown' ? 'OUTCOME_UNKNOWN' : 'PAUSED');
    assert.equal(await advanceFileJobs(task, altered, now + 4000), task);
  }
  assert.equal((await advanceFileJobs(approved, { ...config, grants: [{ ...grant, revoked: true }] }, now)).jobs[0].status, 'PAUSED');
  const revokedAfterAdvice = await advanceFileJobs(approved, config, now, syntheticFileAdvice,
    async () => ({ ...config, grants: [{ ...grant, revoked: true }] }));
  assert.equal(revokedAfterAdvice.jobs[0].status, 'PAUSED');
  assert.equal(revokedAfterAdvice.jobs[0].delivery, undefined);
  const disabledDepartment = { ...config, departments: [{ id: 'unassigned', displayName: 'Unassigned', disabled: true }] };
  const departmentBlocked = await advanceFileJobs(approved, config, now, syntheticFileAdvice,
    async () => disabledDepartment);
  assert.equal(departmentBlocked.jobs[0].status, 'PAUSED');
  assert.equal(departmentBlocked.jobs[0].delivery, undefined);
  for (const change of [{ channel: 'external' }, { action: 'PAUSE' }, { recipient: 'unapproved' },
    { snapshotVersion: 2 }, { action: 'EXECUTE' }, { expiresAt: '2099-01-01' },
    { maxAttempts: 99999 }, { status: 'COMPLETED' }, { key: 'synthetic' }]) {
    const blocked = await advanceFileJobs(approved, config, now,
      async metadata => ({ ...syntheticFileAdvice(metadata), ...change }));
    assert.equal(blocked.jobs[0].status, 'PAUSED');
    assert.equal(blocked.jobs[0].delivery, undefined);
  }
  let expiredAdviserCalls = 0;
  const expired = await advanceFileJobs(approved, config, now + 60001, async metadata => {
    expiredAdviserCalls++;
    return syntheticFileAdvice(metadata);
  });
  assert.equal(expired.jobs[0].status, 'PAUSED');
  assert.equal(expired.jobs[0].delivery, undefined);
  assert.equal(expiredAdviserCalls, 0);
  const corrupt = structuredClone(approved);
  corrupt.file.packet.iv = 'AAAAAAAAAAAAAAAA';
  assert.equal((await advanceFileJobs(corrupt, config, now)).jobs[0].status, 'PAUSED');
  sealed.key.fill(0);
});
