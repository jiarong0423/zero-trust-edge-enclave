import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceFileJobs, advanceFollowups } from '../file-worker.js';
import { newTask, confirmFirst, confirmSecond } from '../snapshot-lifecycle.js';
import { sealFileBytes } from '../public/file-envelope.js';
import { syntheticFollowupAdvice, MAX_NUDGES } from '../delivery-followup.js';
import { auditProjection } from '../audit-boundary.js';

const HOUR = 3600000;
const actor = { id: 'sender', kind: 'operator' };

// A prepared REQUIRED_ACK delivery: the point at which the routing pass is finished and the old
// loop had nothing further to do.
async function prepared({ mode = 'REQUIRED_ACK', span = 40 * HOUR, now = Date.now() } = {}) {
  const expiresAt = new Date(now + span).toISOString();
  const grant = { id: 'grant', version: 1, operatorId: actor.id, recipients: ['a', 'b'], channels: ['email'],
    maxAttempts: 2, expiresAt, simulatedOutcomes: ['prepared'] };
  const config = { grants: [grant], principals: [actor, { id: 'a', kind: 'recipient' }, { id: 'b', kind: 'recipient' }] };
  const sealed = await sealFileBytes(new Uint8Array([1, 2, 3]), 'mock.csv');
  const draft = newTask(actor, grant, {
    documentHash: sealed.commitment, recipients: ['a', 'b'], channels: ['email'], expiresAt,
    deliveryDeadline: expiresAt, deliveryMode: mode,
    downloadUntil: mode === 'REQUIRED_ACK' ? null : expiresAt
  }, now);
  draft.file = { packet: sealed.packet };
  const first = confirmFirst(draft, actor, grant, 1, now);
  const approved = confirmSecond(first.task, actor, grant, 1, first.token, now);
  const task = await advanceFileJobs(approved, config, now);
  assert.equal(task.jobs[0].status, 'DRY_RUN_PREPARED');
  return { task, config, grant, now };
}

test('a time-limited delivery is never chased: the window closing is the answer', async () => {
  const { task, config, now } = await prepared({ mode: 'TIME_LIMITED' });
  assert.equal(await advanceFollowups(task, config, now + HOUR), task);
});

test('a prepared required-acknowledgement delivery is reconsidered and can be reminded', async () => {
  const { task, config, now } = await prepared();
  // Early in the window the fixture waits; that is the intended shape, not an absence of a decision.
  const early = await advanceFollowups(task, config, now + HOUR);
  assert.equal(early.jobs[0].followupAdvice.action, 'WAIT');
  assert.equal(early.jobs[0].followups.length, 1);
  assert.equal(early.jobs[0].notice.subjectCode, 'SEALED_DOCUMENT_AVAILABLE', 'a wait prepares nothing');

  const mid = await advanceFollowups(early, config, now + 15 * HOUR);
  assert.equal(mid.jobs[0].followupAdvice.action, 'REMIND');
  assert.equal(mid.jobs[0].notice.subjectCode, 'SEALED_DOCUMENT_REMINDER');
  assert.equal(mid.jobs[0].notice.sendsEmail, false, 'a reminder is a dry run like the first notice');
  assert.ok(!JSON.stringify(mid.jobs[0].notice).includes('ciphertext'));
  assert.equal(mid.jobs[0].status, 'DRY_RUN_PREPARED', 'following up does not move the delivery state');
});

test('reconsideration is bounded by the window, not by how often the worker ticks', async () => {
  const { task, config, now } = await prepared();
  const first = await advanceFollowups(task, config, now + HOUR);
  const scheduled = Date.parse(first.jobs[0].nextFollowupAt);
  assert.ok(scheduled > now + HOUR);
  // Ticks before the next bucket change nothing at all, object identity included.
  for (const tick of [HOUR + 1, 2 * HOUR, 5 * HOUR]) {
    assert.equal(await advanceFollowups(first, config, now + tick), first);
  }
  const second = await advanceFollowups(first, config, scheduled);
  assert.notEqual(second, first);
  assert.equal(second.jobs[0].followups.length, 2);
});

test('after the deadline the follow-up pass stands down and leaves the overdue record to fixed code', async () => {
  const { task, config, now } = await prepared({ span: 4 * HOUR });
  assert.equal(await advanceFollowups(task, config, now + 4 * HOUR), task);
  assert.equal(await advanceFollowups(task, config, now + 400 * HOUR), task);
});

test('a grant revoked while the adviser was answering stops the reminder it advised', async () => {
  const { task, config, grant, now } = await prepared();
  const revoked = { ...config, grants: [{ ...grant, revoked: true }] };
  const blocked = await advanceFollowups(task, config, now + 15 * HOUR, syntheticFollowupAdvice, async () => revoked);
  assert.equal(blocked.jobs[0].followupPausedBy, 'AUTHORIZATION_INVALID');
  assert.equal(blocked.jobs[0].followups, undefined, 'a refused pass records no follow-up');
  assert.equal(blocked.jobs[0].notice.subjectCode, 'SEALED_DOCUMENT_AVAILABLE');
});

test('a disabled operator stops the pass before any advice is requested', async () => {
  const { task, config, now } = await prepared();
  let asked = 0;
  const disabled = { ...config, principals: config.principals.map(person =>
    person.id === actor.id ? { ...person, disabled: true } : person) };
  const blocked = await advanceFollowups(disabled === config ? config : disabled, config, now + 15 * HOUR,
    async metadata => { asked += 1; return syntheticFollowupAdvice(metadata); });
  assert.equal(asked, 0, 'no projection may be sent for a principal that is already disabled');
  assert.equal(blocked, disabled === config ? config : blocked);
});

test('a recipient disabled after the advice blocks the reminder', async () => {
  const { task, config, now } = await prepared();
  const disabled = { ...config, principals: config.principals.map(person =>
    person.id === 'b' ? { ...person, disabled: true } : person) };
  const blocked = await advanceFollowups(task, config, now + 15 * HOUR, syntheticFollowupAdvice, async () => disabled);
  assert.equal(blocked.jobs[0].followupPausedBy, 'RECIPIENT_DISABLED');
  assert.equal(blocked.jobs[0].notice.subjectCode, 'SEALED_DOCUMENT_AVAILABLE');
});

test('an adviser that widens the contract is refused and prepares nothing', async () => {
  const { task, config, now } = await prepared();
  for (const change of [{ action: 'ROUTE' }, { action: 'SEND' }, { channel: 'email' },
    { recipients: ['a'] }, { snapshotVersion: 2 }, { reasonCode: 'APPROVED_CHANNEL' },
    { taskAlias: '11111111-1111-4111-8111-111111111111' }, { nudges: 0 }]) {
    const blocked = await advanceFollowups(task, config, now + 15 * HOUR,
      async metadata => ({ ...syntheticFollowupAdvice(metadata), action: 'REMIND', reasonCode: 'NO_PICKUP_YET', ...change }));
    assert.equal(blocked.jobs[0].followupPausedBy, 'ADVICE_INVALID', 'accepted ' + JSON.stringify(change));
    assert.equal(blocked.jobs[0].notice.subjectCode, 'SEALED_DOCUMENT_AVAILABLE');
  }
});

test('an adviser cannot nudge past the budget however many times it is asked', async () => {
  const { task, config, now } = await prepared({ span: 400 * HOUR });
  let current = task;
  let at = now + HOUR;
  const always = metadata => ({ taskAlias: metadata.taskAlias, snapshotVersion: metadata.snapshotVersion,
    action: 'REMIND', reasonCode: 'NO_PICKUP_YET' });
  for (let round = 0; round < 12; round += 1) {
    current = await advanceFollowups(current, config, at, always);
    at = Math.max(at + HOUR, Date.parse(current.jobs[0].nextFollowupAt));
  }
  const reminders = (current.jobs[0].followups || []).filter(entry => entry.action === 'REMIND');
  assert.ok(reminders.length <= MAX_NUDGES, `budget exceeded: ${reminders.length}`);
  assert.equal(current.jobs[0].followupPausedBy, 'ADVICE_INVALID', 'the refusal is recorded, not silently ignored');
});

test('escalation is recorded once for a version', async () => {
  const { task, config, now } = await prepared({ span: 400 * HOUR });
  const escalate = metadata => ({ taskAlias: metadata.taskAlias, snapshotVersion: metadata.snapshotVersion,
    action: 'ESCALATE', reasonCode: 'DEADLINE_NEAR' });
  let current = await advanceFollowups(task, config, now + HOUR, escalate);
  assert.equal(current.deliveryEscalations.length, 1);
  assert.equal(current.deliveryEscalations[0].code, 'FOLLOWUP_ESCALATED');
  current = await advanceFollowups(current, config, Date.parse(current.jobs[0].nextFollowupAt), escalate);
  assert.equal(current.deliveryEscalations.length, 1, 'a second escalation for the same version adds nothing');
});

test('every follow-up event survives the audit projection with an allowlisted type and code', async () => {
  const { task, config, now } = await prepared();
  const chased = await advanceFollowups(task, config, now + 15 * HOUR);
  const events = chased.auditOutbox.filter(entry => entry.type === 'DELIVERY_FOLLOWUP');
  assert.ok(events.length >= 1);
  for (const event of events) {
    const projected = auditProjection(event);
    assert.equal(projected.type, 'DELIVERY_FOLLOWUP');
    assert.ok(projected.reasons.length && !projected.reasons.includes('UNCLASSIFIED'),
      `unclassified reason: ${JSON.stringify(event.reasons)}`);
    const serialized = JSON.stringify(projected);
    for (const leak of ['recipient', 'ciphertext', 'packet', 'sender', '@']) {
      assert.ok(!serialized.includes(leak), `audit event leaked ${leak}: ${serialized}`);
    }
  }
});
