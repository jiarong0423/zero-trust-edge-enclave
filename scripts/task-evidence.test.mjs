import test from 'node:test';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { advanceFileJobs, ADVICE_SOURCE } from '../file-worker.js';
import { newTask, confirmFirst, confirmSecond } from '../snapshot-lifecycle.js';
import { sealFileBytes } from '../public/file-envelope.js';
import { syntheticFileAdvice } from '../file-routing.js';
import { taskEvidence, countRealValues } from '../task-evidence.js';

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

test('the leak check ignores case and finds identifiers embedded in keys or longer strings', () => {
  const id = crypto.randomUUID();
  const real = ['recipient-one', id, 'A1'];
  assert.equal(countRealValues({ note: 'RECIPIENT-ONE' }, real), 1);
  assert.equal(countRealValues({ note: 'send to recipient-one today' }, real), 1);
  assert.equal(countRealValues({ 'recipient-one': true }, real), 1);
  assert.equal(countRealValues({ list: ['x', { deep: id.toUpperCase() }] }, real), 1);
  assert.equal(countRealValues({ code: 'a1' }, real), 1, 'a short value counts as a whole string');
  // A short value inside a longer string is coincidence, not a leak.
  assert.equal(countRealValues({ taskAlias: 'ffa1' + crypto.randomUUID().slice(4).replace(/a1/g, 'b2') }, real), 0);
  assert.equal(countRealValues({ channels: ['email'], attempts: 0 }, real), 0);
});

test('a refused answer appears as a refusal, with no answer', async () => {
  const task = await routedTask(async () => {
    throw Object.assign(new Error('Unsupported request fields'), { status: 422, adviceRejected: true });
  });
  const [entry] = taskEvidence(task).trail;
  assert.equal(entry.answer, null);
  assert.deepEqual(entry.refusal, { reasonCode: 'ADVICE_INVALID', detail: 'Unsupported request fields' });
});

test('each trail entry names the outlet that answered, and only fixed labels are kept', async () => {
  const task = await routedTask(async metadata => Object.assign(syntheticFileAdvice(metadata),
    { [ADVICE_SOURCE]: 'local_openai_compatible' }));
  assert.equal(taskEvidence(task).trail[0].source, 'local_openai_compatible');
  const odd = await routedTask(async metadata => Object.assign(syntheticFileAdvice(metadata), { [ADVICE_SOURCE]: 'anything else' }));
  assert.equal(taskEvidence(odd).trail[0].source, null);
  const failed = await routedTask(async () => {
    throw Object.assign(new Error('timeout'), { [ADVICE_SOURCE]: 'nebius_token_factory' });
  });
  assert.equal(taskEvidence(failed).trail[0].source, 'nebius_token_factory');
});

test('a delivery with no validated route maps nobody back', async () => {
  const task = await routedTask(async () => {
    throw Object.assign(new Error('Unsupported request fields'), { status: 422, adviceRejected: true });
  });
  const evidence = taskEvidence(task);
  assert.equal(evidence.mappedBack.channel, null);
  assert.deepEqual(evidence.mappedBack.recipients, []);
});

test('mapping back follows the delivery that was prepared, not the adviser answer', async () => {
  const task = await routedTask();
  assert.equal(task.jobs[0].status, 'DRY_RUN_PREPARED');
  // Stopped after a ROUTE answer (for example authority reloaded and revoked): no delivery record.
  const stopped = structuredClone(task);
  delete stopped.jobs[0].delivery;
  stopped.jobs[0].status = 'PAUSED';
  assert.deepEqual(taskEvidence(stopped).mappedBack, { channel: null, recipients: [] });
  // A task stored before the trail existed still maps back from its delivery record.
  const older = structuredClone(task);
  delete older.jobs[0].adviceTrail;
  assert.deepEqual(taskEvidence(older).mappedBack.recipients.map(route => route.recipientId), ['recipient-one']);
});

test('approved channel names are compared whole, so they do not count as leaks', () => {
  assert.equal(countRealValues({ channels: ['internal_queue'] }, ['internal'], ['internal_queue']), 0);
  assert.equal(countRealValues({ note: 'via internal desk' }, ['internal'], ['internal_queue']), 1);
});
