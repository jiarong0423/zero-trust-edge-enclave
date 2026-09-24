import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceFileJobs } from '../file-worker.js';
import { newTask, confirmFirst, confirmSecond } from '../snapshot-lifecycle.js';
import { sealFileBytes } from '../public/file-envelope.js';
import { syntheticFileAdvice } from '../file-routing.js';
import { taskEvidence } from '../task-evidence.js';

async function routedTask(advise = async metadata => syntheticFileAdvice(metadata)) {
  const actor = { id: 'sender', kind: 'operator' };
  const now = Date.now();
  const grant = { id: 'grant', version: 1, operatorId: actor.id, recipients: ['recipient-one'], channels: ['email'],
    maxAttempts: 2, expiresAt: new Date(now + 60000).toISOString(), simulatedOutcomes: ['prepared'] };
  const config = { grants: [grant], principals: [actor, { id: 'recipient-one', kind: 'recipient' }] };
  const sealed = await sealFileBytes(new Uint8Array([1, 2, 3]), 'synthetic.csv');
  const draft = newTask(actor, grant, { documentHash: sealed.commitment, recipients: ['recipient-one'],
    channels: ['email'], expiresAt: grant.expiresAt }, now);
  draft.file = { packet: sealed.packet };
  const first = confirmFirst(draft, actor, grant, 1, now);
  const approved = confirmSecond(first.task, actor, grant, 1, first.token, now);
  return advanceFileJobs(approved, config, now, advise);
}

test('the evidence chain runs from approval through the adviser back to real recipients', async () => {
  const task = await routedTask();
  task.fileKeyReleases = [{ subject: 'recipient-one', version: 1, at: '2026-09-24T00:00:00.000Z' }];
  task.fileReceipts = [{ subject: 'recipient-one', version: 1, code: 'ACKNOWLEDGED', reportedAt: '2026-09-24T00:00:01.000Z' }];
  const evidence = taskEvidence(task);
  assert.deepEqual(evidence.approved.recipients, ['recipient-one']);
  assert.equal(evidence.mapping.recipients[0].recipientId, 'recipient-one');
  assert.equal(evidence.trail.length, 1);
  assert.equal(evidence.trail[0].input.taskAlias, evidence.mapping.taskAlias);
  assert.equal(evidence.trail[0].realValuesInInput, 0);
  assert.equal(evidence.trail[0].answer.action, 'ROUTE');
  assert.deepEqual(evidence.mappedBack.recipients.map(route => route.recipientId), ['recipient-one']);
  assert.deepEqual(evidence.receipts.map(entry => entry.code), ['ACKNOWLEDGED']);
  assert.ok(!JSON.stringify(evidence).includes('endpointId'));
});

test('the leak check is live: a real identifier placed in an adviser input is counted', async () => {
  const task = await routedTask();
  task.jobs[0].adviceTrail[0].input.leaked = 'recipient-one';
  assert.equal(taskEvidence(task).trail[0].realValuesInInput, 1);
});

test('a refused answer appears as a refusal, with no answer', async () => {
  const task = await routedTask(async () => {
    throw Object.assign(new Error('Unsupported request fields'), { status: 422, adviceRejected: true });
  });
  const [entry] = taskEvidence(task).trail;
  assert.equal(entry.answer, null);
  assert.deepEqual(entry.refusal, { reasonCode: 'ADVICE_INVALID', detail: 'Unsupported request fields' });
});
