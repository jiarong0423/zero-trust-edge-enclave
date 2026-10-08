import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceFileJobs, advanceFollowups } from '../file-worker.js';
import { newTask, confirmFirst, confirmSecond } from '../snapshot-lifecycle.js';
import { sealFileBytes } from '../public/file-envelope.js';
import { auditProjection } from '../audit-boundary.js';
import { taskEvidence } from '../task-evidence.js';
import { applyFloor, followupFloorEnabled } from '../followup-floor.js';

const HOUR = 3600000;
const actor = { id: 'sender', kind: 'operator' };
// A 40 hour window: +1h is WINDOW_FULL, +25h WINDOW_MOST, +32h WINDOW_LITTLE, +37h WINDOW_LAST.
const AT = { WINDOW_FULL: HOUR, WINDOW_MOST: 25 * HOUR, WINDOW_LITTLE: 32 * HOUR, WINDOW_LAST: 37 * HOUR };

async function prepared({ span = 40 * HOUR, now = Date.now() } = {}) {
  const expiresAt = new Date(now + span).toISOString();
  const grant = { id: 'grant', version: 1, operatorId: actor.id, recipients: ['a', 'b'], channels: ['email'],
    maxAttempts: 2, expiresAt, simulatedOutcomes: ['prepared'] };
  const config = { grants: [grant], principals: [actor, { id: 'a', kind: 'recipient' }, { id: 'b', kind: 'recipient' }] };
  const sealed = await sealFileBytes(new Uint8Array([1, 2, 3]), 'mock.csv');
  const draft = newTask(actor, grant, {
    documentHash: sealed.commitment, recipients: ['a', 'b'], channels: ['email'], expiresAt,
    deliveryDeadline: expiresAt, deliveryMode: 'REQUIRED_ACK', downloadUntil: null
  }, now);
  draft.file = { packet: sealed.packet };
  const first = confirmFirst(draft, actor, grant, 1, now);
  const approved = confirmSecond(first.task, actor, grant, 1, first.token, now);
  const task = await advanceFileJobs(approved, config, now);
  assert.equal(task.jobs[0].status, 'DRY_RUN_PREPARED');
  return { task, config, now };
}

const answer = (action, reasonCode) => metadata => ({ taskAlias: metadata.taskAlias,
  snapshotVersion: metadata.snapshotVersion, action, reasonCode });
const passive = answer('WAIT', 'INSUFFICIENT_INFORMATION');

const receipt = (now, subject) => ({ version: 1, subject, code: 'DOWNLOAD_REQUESTED',
  evidence: 'CLIENT_REPORTED', reportedAt: new Date(now).toISOString() });
const withPickup = (task, now, subjects) => ({ ...task,
  fileKeyReleases: subjects.map(subject => ({ version: 1, subject })),
  fileReceipts: subjects.map(subject => receipt(now, subject)) });

async function withFloor(value, run) {
  const previous = process.env.FOLLOWUP_FLOOR;
  if (value === undefined) delete process.env.FOLLOWUP_FLOOR; else process.env.FOLLOWUP_FLOOR = value;
  try { return await run(); } finally {
    if (previous === undefined) delete process.env.FOLLOWUP_FLOOR; else process.env.FOLLOWUP_FLOOR = previous;
  }
}

test('applyFloor is pure: only an enabled WAIT at WINDOW_LAST without full pickup is replaced', () => {
  const advice = { taskAlias: 't', snapshotVersion: 1, action: 'WAIT', reasonCode: 'INSUFFICIENT_INFORMATION' };
  const frozen = Object.freeze({ ...advice });
  const last = { timeCode: 'WINDOW_LAST', pickupCode: 'PICKUP_NONE' };
  assert.deepEqual(applyFloor(frozen, last, true),
    { advice: { ...advice, action: 'ESCALATE', reasonCode: 'DEADLINE_NEAR' }, floored: true });
  assert.equal(applyFloor(frozen, last, false).floored, false);
  assert.equal(applyFloor(frozen, last, 'true').floored, false, 'only the boolean true enables it');
  assert.equal(applyFloor(frozen, { ...last, pickupCode: 'PICKUP_ALL' }, true).floored, false);
  assert.equal(applyFloor({ ...advice, action: 'REMIND' }, last, true).floored, false);
  assert.equal(applyFloor({ ...advice, action: 'ESCALATE' }, last, true).floored, false);
  assert.equal(applyFloor(frozen, { ...last, timeCode: 'WINDOW_LITTLE' }, true).floored, false);
  assert.equal(frozen.action, 'WAIT', 'the input is never mutated');
});

test('the flag is on only for the exact string true, read at call time', () => {
  assert.equal(followupFloorEnabled({ FOLLOWUP_FLOOR: 'true' }), true);
  for (const value of [undefined, '', 'TRUE', 'True', '1', 'yes', 'false', ' true', 'true ']) {
    assert.equal(followupFloorEnabled({ FOLLOWUP_FLOOR: value }), false, `enabled by ${JSON.stringify(value)}`);
  }
});

test('default off: a passive WAIT at WINDOW_LAST with nothing collected stays WAIT', async () => {
  await withFloor(undefined, async () => {
    const { task, config, now } = await prepared();
    const result = await advanceFollowups(task, config, now + AT.WINDOW_LAST, passive);
    const job = result.jobs[0];
    assert.equal(job.followupAdvice.action, 'WAIT');
    assert.equal(job.followupAdvice.floor, undefined);
    assert.equal(job.followups[0].floor, undefined);
    assert.equal(result.deliveryEscalations, undefined);
  });
});

test('values other than the exact string true keep the floor off', async () => {
  for (const value of ['TRUE', '1', 'yes', 'false', '']) {
    await withFloor(value, async () => {
      const { task, config, now } = await prepared();
      const result = await advanceFollowups(task, config, now + AT.WINDOW_LAST, passive);
      assert.equal(result.jobs[0].followupAdvice.action, 'WAIT', `floored by ${JSON.stringify(value)}`);
      assert.equal(result.deliveryEscalations, undefined);
    });
  }
});

test('enabled: WAIT at WINDOW_LAST is escalated for PICKUP_NONE and PICKUP_SOME', async () => {
  await withFloor('true', async () => {
    for (const subjects of [[], ['a']]) {
      const { task, config, now } = await prepared();
      const at = now + AT.WINDOW_LAST;
      const result = await advanceFollowups(withPickup(task, now, subjects), config, at, passive);
      const job = result.jobs[0];
      assert.equal(job.followupAdvice.action, 'ESCALATE');
      assert.equal(job.followupAdvice.reasonCode, 'DEADLINE_NEAR');
      assert.equal(job.followupAdvice.floor, true);
      assert.deepEqual(job.followups.map(entry => [entry.action, entry.reasonCode, entry.floor]),
        [['ESCALATE', 'DEADLINE_NEAR', true]]);
      assert.equal(result.deliveryEscalations.length, 1);
      assert.equal(result.deliveryEscalations[0].code, 'FOLLOWUP_ESCALATED');
      assert.equal(job.notice.subjectCode, 'SEALED_DOCUMENT_AVAILABLE', 'an escalation prepares no reminder');
      assert.equal(job.followupPausedBy, undefined);
    }
  });
});

test('enabled: no floor before WINDOW_LAST', async () => {
  await withFloor('true', async () => {
    for (const band of ['WINDOW_FULL', 'WINDOW_MOST', 'WINDOW_LITTLE']) {
      const { task, config, now } = await prepared();
      const result = await advanceFollowups(task, config, now + AT[band], passive);
      assert.equal(result.jobs[0].followupAdvice.action, 'WAIT', band);
      assert.equal(result.jobs[0].followupAdvice.floor, undefined, band);
      assert.equal(result.deliveryEscalations, undefined, band);
    }
  });
});

test('enabled: PICKUP_ALL never reaches the adviser, so there is no call and no floor', async () => {
  await withFloor('true', async () => {
    const { task, config, now } = await prepared();
    const everyone = withPickup(task, now, ['a', 'b']);
    let asked = 0;
    const result = await advanceFollowups(everyone, config, now + AT.WINDOW_LAST,
      metadata => { asked += 1; return passive(metadata); });
    assert.equal(asked, 0);
    assert.equal(result, everyone);
  });
});

test('enabled: REMIND and ESCALATE answers are left exactly as the adviser gave them', async () => {
  await withFloor('true', async () => {
    const remind = await prepared();
    const reminded = await advanceFollowups(remind.task, remind.config, remind.now + AT.WINDOW_LAST,
      answer('REMIND', 'NO_PICKUP_YET'));
    assert.equal(reminded.jobs[0].followupAdvice.action, 'REMIND');
    assert.equal(reminded.jobs[0].followupAdvice.floor, undefined);
    assert.equal(reminded.jobs[0].followups[0].floor, undefined);
    assert.equal(reminded.jobs[0].notice.subjectCode, 'SEALED_DOCUMENT_REMINDER');

    const escalate = await prepared();
    const escalated = await advanceFollowups(escalate.task, escalate.config, escalate.now + AT.WINDOW_LAST,
      answer('ESCALATE', 'INSUFFICIENT_INFORMATION'));
    assert.equal(escalated.jobs[0].followupAdvice.reasonCode, 'INSUFFICIENT_INFORMATION', 'the adviser reason is kept');
    assert.equal(escalated.jobs[0].followupAdvice.floor, undefined);
    assert.equal(escalated.jobs[0].followups[0].floor, undefined);
  });
});

test('the adviser original answer stays in the trail; the floor is recorded apart from it', async () => {
  await withFloor('true', async () => {
    const { task, config, now } = await prepared();
    const result = await advanceFollowups(task, config, now + AT.WINDOW_LAST, passive);
    const job = result.jobs[0];
    const entries = job.adviceTrail.filter(entry => entry.kind === 'followup');
    assert.equal(entries.length, 1);
    assert.deepEqual(Object.keys(entries[0].answer).sort(), ['action', 'reasonCode', 'snapshotVersion', 'taskAlias']);
    assert.equal(entries[0].answer.action, 'WAIT');
    assert.equal(entries[0].answer.reasonCode, 'INSUFFICIENT_INFORMATION');
    assert.equal(entries[0].answer.floor, undefined);
    assert.equal(entries[0].input.timeCode, 'WINDOW_LAST');
    const evidence = taskEvidence(result);
    const traced = evidence.trail.find(entry => entry.kind === 'followup');
    assert.equal(traced.answer.action, 'WAIT', 'the sender evidence shows what the adviser said');
    assert.equal(traced.realValuesInInput, 0);
    // The decision fixed code actually made is visible to the sender and marked as the floor's.
    assert.deepEqual(evidence.followups.map(entry => [entry.action, entry.reasonCode, entry.floor]), [['ESCALATE', 'DEADLINE_NEAR', true]]);
    assert.ok(!JSON.stringify(evidence.followups).includes('sender'), 'no identity in the decisions');
  });
  // Without the floor the same adviser answer is shown as made, with no floor mark.
  const { task: plain, config: plainConfig, now: plainNow } = await prepared();
  const unfloored = await advanceFollowups(plain, plainConfig, plainNow + AT.WINDOW_LAST, passive);
  assert.deepEqual(taskEvidence(unfloored).followups.map(entry => [entry.action, entry.floor]), [['WAIT', false]]);
});

test('the floor does not call the adviser again', async () => {
  await withFloor('true', async () => {
    const { task, config, now } = await prepared();
    let asked = 0;
    await advanceFollowups(task, config, now + AT.WINDOW_LAST, metadata => { asked += 1; return passive(metadata); });
    assert.equal(asked, 1);
  });
});

test('escalation is recorded once for a version, floored or not', async () => {
  await withFloor('true', async () => {
    // The adviser escalates on its own earlier in the window; the floor then escalates again in the
    // last band. Both are real escalation answers, and the version is recorded once.
    const { task, config, now } = await prepared();
    let current = await advanceFollowups(task, config, now + AT.WINDOW_LITTLE, answer('ESCALATE', 'INSUFFICIENT_INFORMATION'));
    assert.equal(current.deliveryEscalations.length, 1);
    const due = Date.parse(current.jobs[0].nextFollowupAt);
    assert.ok(due > now + AT.WINDOW_LITTLE && due <= now + 40 * HOUR);
    current = await advanceFollowups(current, config, Math.max(due, now + AT.WINDOW_LAST), passive);
    assert.equal(current.jobs[0].followups.length, 2);
    assert.equal(current.jobs[0].followups[0].floor, undefined);
    assert.equal(current.jobs[0].followups[1].floor, true);
    assert.equal(current.deliveryEscalations.length, 1, 'a floored escalation after an earlier one adds nothing');
  });
});

test('a floored escalation is recorded once, and a repeated pass at the same version adds no second record', async () => {
  await withFloor('true', async () => {
    const { task, config, now } = await prepared({ span: 400 * HOUR });
    const at = now + 400 * HOUR * 0.9;
    let current = await advanceFollowups(task, config, at, passive);
    assert.equal(current.deliveryEscalations.length, 1);
    assert.equal(current.jobs[0].followups[0].floor, true);
    current = await advanceFollowups(current, config, Date.parse(current.jobs[0].nextFollowupAt) - 1, passive);
    assert.equal(current.jobs[0].followups.length, 1, 'not due yet, so nothing changes');
    assert.equal(current.deliveryEscalations.length, 1);
  });
});

test('a floored escalation survives the audit projection with existing codes and no leak', async () => {
  await withFloor('true', async () => {
    const { task, config, now } = await prepared();
    const result = await advanceFollowups(task, config, now + AT.WINDOW_LAST, passive);
    const events = result.auditOutbox.filter(entry => entry.type === 'DELIVERY_FOLLOWUP');
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].reasons, ['FOLLOWUP_ESCALATE']);
    assert.equal(events[0].result, 'DENY');
    const projected = auditProjection(events[0]);
    assert.equal(projected.type, 'DELIVERY_FOLLOWUP');
    assert.deepEqual(projected.reasons, ['FOLLOWUP_ESCALATE']);
    assert.ok(!JSON.stringify(projected).includes('floor'));
  });
});

test('a grant revoked while the adviser was answering stops a floored escalation too', async () => {
  await withFloor('true', async () => {
    const { task, config, now } = await prepared();
    const revoked = { ...config, grants: [{ ...config.grants[0], revoked: true }] };
    const blocked = await advanceFollowups(task, config, now + AT.WINDOW_LAST, passive, async () => revoked);
    assert.equal(blocked.jobs[0].followupPausedBy, 'AUTHORIZATION_INVALID');
    assert.equal(blocked.jobs[0].followups, undefined);
    assert.equal(blocked.deliveryEscalations, undefined);
  });
});
