import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPrivateMapping } from '../private-mapping.js';
import { followupMetadata, validateFollowupAdvice, syntheticFollowupAdvice, MAX_NUDGES } from '../delivery-followup.js';

const HOUR = 3600000;
const taskId = randomUUID();

// A snapshot shaped like the ones snapshot-lifecycle produces, with the private mapping digest the
// projection re-checks. Building it here keeps these cases independent of the task store.
function snapshotFor({ mode = 'REQUIRED_ACK', approvedAt = 0, deadline = 24 * HOUR, recipients = ['recipient-a', 'recipient-b'] } = {}) {
  const content = {
    documentHash: 'a'.repeat(64), recipients: [...recipients].sort(), channels: ['email'],
    expiresAt: new Date(deadline).toISOString(), deliveryDeadline: new Date(deadline).toISOString(),
    deliveryMode: mode, downloadUntil: mode === 'REQUIRED_ACK' ? null : new Date(deadline).toISOString()
  };
  // The real constructor, so the digest these cases are checked against is the real one. A
  // hand-rolled mapping would pass a hand-rolled check and prove nothing.
  return { version: 1, status: 'APPROVED', approvedAt: new Date(approvedAt).toISOString(), content,
    privateMapping: createPrivateMapping(taskId, 1, content) };
}

const summaryFor = (collected, total) => ({ downloadReportCount: collected, recipientCount: total });
const jobFor = nudges => ({ status: 'DRY_RUN_PREPARED', followups: Array.from({ length: nudges }, () => ({ action: 'REMIND' })) });

// checkPrivateMapping is the real one, so a snapshot that does not verify would throw here and
// every case below would be vacuous. This asserts the fixture is actually exercising it.
test('the fixture snapshot passes the real private-mapping check', () => {
  assert.doesNotThrow(() => followupMetadata(snapshotFor(), jobFor(0), summaryFor(0, 2), HOUR));
});

test('follow-up does not apply to a time-limited delivery', () => {
  // The window shutting is the answer for TIME_LIMITED. Offering a chase decision there would
  // invent a choice the mode does not have.
  assert.throws(() => followupMetadata(snapshotFor({ mode: 'TIME_LIMITED' }), jobFor(0), summaryFor(0, 2), HOUR),
    error => error.message === 'FOLLOWUP_MODE_NOT_APPLICABLE');
});

test('the projection is exactly five fields and carries no recipient information', () => {
  // Counts chosen so they collide with nothing legitimate in the projection: the version is 1 and
  // the nudge count is 2, so a stray 3 or 7 could only have come from the receipt figures.
  const metadata = followupMetadata(snapshotFor(), jobFor(2), summaryFor(3, 7), 12 * HOUR);
  assert.deepEqual(Object.keys(metadata).sort(),
    ['nudges', 'pickupCode', 'snapshotVersion', 'taskAlias', 'timeCode']);
  const serialized = JSON.stringify(metadata);
  for (const leak of ['recipient-a', 'recipient-b', 'A1', 'A2', taskId]) {
    assert.ok(!serialized.includes(leak), `projection leaked ${leak}: ${serialized}`);
  }
  // A bare digit would match inside the alias UUID, so the receipt figures are excluded
  // structurally instead: the only numbers present are the version and the nudge count.
  assert.equal(metadata.pickupCode, 'PICKUP_SOME', 'the ordinal is all that survives');
  assert.deepEqual(Object.values(metadata).filter(value => typeof value === 'number'), [1, 2]);
});

test('an identical position in different windows yields the same code, so wall-clock never leaks', () => {
  // Two tasks, one two days long and one two months, sampled at the same fraction of their spans.
  const short = followupMetadata(snapshotFor({ deadline: 48 * HOUR }), jobFor(0), summaryFor(0, 2), 36 * HOUR);
  const long = followupMetadata(snapshotFor({ deadline: 1440 * HOUR }), jobFor(0), summaryFor(0, 2), 1080 * HOUR);
  assert.equal(short.timeCode, long.timeCode);
  assert.equal(short.timeCode, 'TIME_4');
});

test('time codes advance across the window and clamp at both ends', () => {
  const at = now => followupMetadata(snapshotFor({ deadline: 40 * HOUR }), jobFor(0), summaryFor(0, 2), now).timeCode;
  assert.deepEqual([at(0), at(15 * HOUR), at(25 * HOUR), at(35 * HOUR)], ['TIME_1', 'TIME_2', 'TIME_3', 'TIME_4']);
  assert.equal(at(-100 * HOUR), 'TIME_1', 'a clock before approval cannot report a negative position');
  assert.equal(at(900 * HOUR), 'TIME_4', 'past the deadline stays in the final bucket');
});

test('a window with no positive span reports the final bucket rather than dividing by zero', () => {
  const metadata = followupMetadata(snapshotFor({ approvedAt: 5 * HOUR, deadline: 5 * HOUR }), jobFor(0), summaryFor(0, 2), 5 * HOUR);
  assert.equal(metadata.timeCode, 'TIME_4');
});

test('an unparseable window is refused instead of producing a code', () => {
  const snapshot = snapshotFor();
  snapshot.approvedAt = null;
  assert.throws(() => followupMetadata(snapshot, jobFor(0), summaryFor(0, 2), HOUR),
    error => error.message === 'FOLLOWUP_WINDOW_INVALID');
});

test('pickup is ordinal: none, some, all', () => {
  const code = (collected, total) => followupMetadata(snapshotFor(), jobFor(0), summaryFor(collected, total), 12 * HOUR).pickupCode;
  assert.equal(code(0, 3), 'PICKUP_NONE');
  assert.equal(code(1, 3), 'PICKUP_SOME');
  assert.equal(code(2, 3), 'PICKUP_SOME');
  assert.equal(code(3, 3), 'PICKUP_ALL');
  assert.equal(code(0, 0), 'PICKUP_NONE', 'an empty list is not a completed delivery');
});

test('the nudge count is reported but never above the ceiling', () => {
  assert.equal(followupMetadata(snapshotFor(), jobFor(2), summaryFor(0, 2), 12 * HOUR).nudges, 2);
  assert.equal(followupMetadata(snapshotFor(), jobFor(9), summaryFor(0, 2), 12 * HOUR).nudges, MAX_NUDGES);
});

test('only reminders count as nudges', () => {
  const job = { status: 'DRY_RUN_PREPARED', followups: [{ action: 'WAIT' }, { action: 'REMIND' }, { action: 'WAIT' }] };
  assert.equal(followupMetadata(snapshotFor(), job, summaryFor(0, 2), 12 * HOUR).nudges, 1);
});

const metadataAt = (options, job = jobFor(0), summary = summaryFor(0, 2), now = 12 * HOUR) =>
  followupMetadata(snapshotFor(options), job, summary, now);

test('advice must match the task it was asked about', () => {
  const metadata = metadataAt({});
  const valid = { taskAlias: metadata.taskAlias, snapshotVersion: 1, action: 'WAIT', reasonCode: 'WINDOW_EARLY' };
  assert.deepEqual(validateFollowupAdvice({ ...valid }, metadata), valid);
  assert.throws(() => validateFollowupAdvice({ ...valid, taskAlias: randomUUID() }, metadata),
    error => error.message === 'FOLLOWUP_ADVICE_REJECTED');
  assert.throws(() => validateFollowupAdvice({ ...valid, snapshotVersion: 2 }, metadata),
    error => error.message === 'FOLLOWUP_ADVICE_REJECTED');
});

test('actions and reasons outside the allowlist are refused', () => {
  const metadata = metadataAt({});
  const valid = { taskAlias: metadata.taskAlias, snapshotVersion: 1, action: 'WAIT', reasonCode: 'WINDOW_EARLY' };
  for (const action of ['ROUTE', 'DELIVER', 'wait', '', null, 0, ['WAIT']]) {
    assert.throws(() => validateFollowupAdvice({ ...valid, action }, metadata), 'accepted action ' + JSON.stringify(action));
  }
  for (const reasonCode of ['APPROVED_CHANNEL', 'BECAUSE', '', null]) {
    assert.throws(() => validateFollowupAdvice({ ...valid, reasonCode }, metadata), 'accepted reason ' + JSON.stringify(reasonCode));
  }
});

test('extra, missing and prototype-polluting fields are all refused', () => {
  const metadata = metadataAt({});
  const valid = { taskAlias: metadata.taskAlias, snapshotVersion: 1, action: 'WAIT', reasonCode: 'WINDOW_EARLY' };
  assert.throws(() => validateFollowupAdvice({ ...valid, channel: 'email' }, metadata));
  assert.throws(() => validateFollowupAdvice({ ...valid, recipients: ['recipient-a'] }, metadata));
  assert.throws(() => validateFollowupAdvice({ ...valid, nudges: 99 }, metadata));
  const { reasonCode, ...missing } = valid;
  assert.throws(() => validateFollowupAdvice(missing, metadata));
  // JSON.parse makes __proto__ an own property, so the exact-key check sees it as an extra field
  // and refuses the object outright rather than reading past it.
  const polluted = JSON.parse(`{"taskAlias":"${metadata.taskAlias}","snapshotVersion":1,"action":"WAIT","reasonCode":"WINDOW_EARLY","__proto__":{"action":"ESCALATE"}}`);
  assert.throws(() => validateFollowupAdvice(polluted, metadata));
  assert.equal(({}).action, undefined, 'validation must not have written through a prototype key');
});

test('the nudge ceiling is enforced by code, not by the prompt that states it', () => {
  const metadata = metadataAt({}, jobFor(MAX_NUDGES));
  const advice = { taskAlias: metadata.taskAlias, snapshotVersion: 1, action: 'REMIND', reasonCode: 'NO_PICKUP_YET' };
  assert.throws(() => validateFollowupAdvice(advice, metadata),
    error => error.message === 'FOLLOWUP_NUDGE_BUDGET_SPENT');
  // Escalation is still available once the budget is spent; that is the point of the budget.
  assert.doesNotThrow(() => validateFollowupAdvice({ ...advice, action: 'ESCALATE', reasonCode: 'NUDGES_EXHAUSTED' }, metadata));
});

test('a completed delivery cannot be chased', () => {
  const metadata = metadataAt({}, jobFor(0), summaryFor(2, 2));
  const advice = { taskAlias: metadata.taskAlias, snapshotVersion: 1, action: 'REMIND', reasonCode: 'NO_PICKUP_YET' };
  assert.throws(() => validateFollowupAdvice(advice, metadata), error => error.message === 'FOLLOWUP_NOT_REQUIRED');
  assert.throws(() => validateFollowupAdvice({ ...advice, action: 'ESCALATE', reasonCode: 'DEADLINE_NEAR' }, metadata),
    error => error.message === 'FOLLOWUP_NOT_REQUIRED');
  assert.doesNotThrow(() => validateFollowupAdvice({ ...advice, action: 'WAIT', reasonCode: 'WINDOW_EARLY' }, metadata));
});

test('the synthetic fixture validates in every reachable state', () => {
  for (const deadline of [4 * HOUR, 40 * HOUR, 1440 * HOUR]) {
    for (const nudges of [0, 1, 2, 3, 4]) {
      for (const [collected, total] of [[0, 2], [1, 2], [2, 2], [0, 0]]) {
        for (let step = 0; step <= 8; step += 1) {
          const now = Math.round(deadline * step / 8);
          const metadata = followupMetadata(snapshotFor({ deadline }), jobFor(nudges), summaryFor(collected, total), now);
          const advice = syntheticFollowupAdvice(metadata);
          assert.doesNotThrow(() => validateFollowupAdvice(advice, metadata),
            `deadline=${deadline} nudges=${nudges} pickup=${collected}/${total} now=${now} -> ${JSON.stringify(advice)}`);
        }
      }
    }
  }
});
