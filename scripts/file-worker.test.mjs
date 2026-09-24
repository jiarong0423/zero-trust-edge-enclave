import test from 'node:test';
import assert from 'node:assert/strict';
import { ADVICE_NO_RETRY, advanceFileJobs } from '../file-worker.js';
import { newTask, confirmFirst, confirmSecond, revokeSnapshot } from '../snapshot-lifecycle.js';
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
  // An answer the validator refused pauses at once: the adviser answered, and the answer was wrong.
  const invalid = await advanceFileJobs(approved, config, now,
    async () => { throw Object.assign(new Error('Unsupported request fields'), { status: 422, adviceRejected: true }); });
  assert.equal(invalid.jobs[0].status, 'PAUSED');
  assert.equal(invalid.jobs[0].reasonCode, 'ADVICE_INVALID');
  // An adviser that never answered decided nothing: routing asks again three times, 30 seconds
  // apart, still PENDING_CHECK so the adviser's policy can route it, and pauses only after that.
  const down = async () => { throw Object.assign(new Error('FILE_PROVIDER_RESPONSE_REJECTED'), { status: 502 }); };
  // A ten-minute window, so every retry falls inside the grant.
  const longGrant = { ...grant, expiresAt: new Date(now + 600000).toISOString() };
  const longConfig = { ...config, grants: [longGrant] };
  const longDraft = newTask(actor, longGrant, { documentHash: sealed.commitment, recipients: ['a'], channels: ['email'],
    expiresAt: longGrant.expiresAt }, now);
  longDraft.file = { packet: sealed.packet };
  const longFirst = confirmFirst(longDraft, actor, longGrant, 1, now);
  let waiting = confirmSecond(longFirst.task, actor, longGrant, 1, longFirst.token, now);
  let calls = 0;
  const counting = async metadata => { calls++; return down(metadata); };
  let tick = now;
  for (let retry = 1; retry <= 3; retry++) {
    waiting = await advanceFileJobs(waiting, longConfig, tick, counting);
    assert.equal(waiting.jobs[0].status, 'PENDING_CHECK');
    assert.equal(waiting.jobs[0].reasonCode, 'ADVISER_UNAVAILABLE');
    assert.equal(waiting.jobs[0].adviceRetries, retry);
    const due = Date.parse(waiting.jobs[0].nextAdviceAt);
    assert.ok(due - tick >= 30000, 'the pause is at least 30 seconds, measured from the end of the attempt');
    // Not asked again before the pause has run out.
    assert.equal(await advanceFileJobs(waiting, longConfig, due - 1, counting), waiting);
    tick = due;
  }
  assert.equal(calls, 3);
  const exhausted = await advanceFileJobs(waiting, longConfig, tick, counting);
  assert.equal(calls, 4);
  assert.equal(exhausted.jobs[0].status, 'PAUSED');
  assert.equal(exhausted.jobs[0].reasonCode, 'ADVISER_UNAVAILABLE');
  assert.equal(exhausted.jobs[0].nextAdviceAt, undefined);
  // Revoking a delivery that is waiting to ask again ends the wait and drops the adviser reason.
  const revokedWhileWaiting = revokeSnapshot(waiting, actor, 1, now);
  assert.equal(revokedWhileWaiting.jobs[0].status, 'REVOKED');
  assert.equal(revokedWhileWaiting.jobs[0].reasonCode, null);
  assert.equal(revokedWhileWaiting.jobs[0].nextAdviceAt, undefined);
  // A failure before any request left (outlet disabled or misconfigured) is not retried.
  const misconfigured = await advanceFileJobs(confirmSecond(longFirst.task, actor, longGrant, 1, longFirst.token, now), longConfig, now,
    async () => { throw Object.assign(new Error('FILE_PROVIDER_UNAVAILABLE'), { [ADVICE_NO_RETRY]: true }); });
  assert.equal(misconfigured.jobs[0].status, 'PAUSED');
  assert.equal(misconfigured.jobs[0].adviceRetries, undefined);
  // A retry that reaches the adviser routes normally and clears the retry state.
  const recovered = await advanceFileJobs(waiting, longConfig, tick, async metadata => syntheticFileAdvice(metadata));
  // Routed and handed to delivery (this grant's first simulated outcome is transient).
  assert.equal(recovered.jobs[0].adviceTrail.at(-1).answer.action, 'ROUTE');
  assert.equal(recovered.jobs[0].delivery.attempts, 1);
  assert.equal(recovered.jobs[0].adviceRetries, undefined);
  assert.equal(recovered.jobs[0].nextAdviceAt, undefined);
  // The trail keeps what the adviser was given and what came of it, never identities or foreign text.
  const routed = await advanceFileJobs(approved, config, now, async metadata => syntheticFileAdvice(metadata));
  const [kept] = routed.jobs[0].adviceTrail;
  assert.equal(kept.kind, 'route');
  assert.deepEqual(Object.keys(kept.input).sort(), ['attempts', 'channels', 'snapshotVersion', 'state', 'taskAlias']);
  assert.ok(kept.answer && !kept.refusal);
  for (const value of [approved.id, ...grant.recipients]) assert.ok(!JSON.stringify(kept.input).includes(JSON.stringify(value)));
  const refused = await advanceFileJobs(approved, config, now,
    async () => { throw Object.assign(new Error('Unsupported request fields'), { status: 422, adviceRejected: true }); });
  assert.deepEqual(refused.jobs[0].adviceTrail.at(-1).refusal, { reasonCode: 'ADVICE_INVALID', detail: 'Unsupported request fields' });
  const foreign = await advanceFileJobs(approved, config, now, async () => { throw new Error('FOREIGN_TEXT_CANARY'); });
  assert.deepEqual(foreign.jobs[0].adviceTrail.at(-1).refusal, { reasonCode: 'ADVISER_UNAVAILABLE', detail: null });
  assert.ok(!JSON.stringify(foreign).includes('FOREIGN_TEXT_CANARY'));
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
