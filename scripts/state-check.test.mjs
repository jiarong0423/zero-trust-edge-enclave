import test from 'node:test';
import assert from 'node:assert/strict';
import {
  JOB_STATES, AGE_CODES, TRIES_CODES, CAUSE_CODES, PICKUP_STATUS_CODES, WINDOW_STATUS_CODES, SEVERITIES, STATE_REASONS, STATE_MESSAGES,
  ageCodeFor, stateProjection, stateTable, validateStateAdvice, reviewState, createStateReviewer, acceptsStateMetadata
} from '../state-check.js';
import { requestFileAdvice, ADVICE_KINDS } from '../file-adviser.js';

const ALIAS = '22222222-2222-4222-8222-222222222222';
const cell = (stateCode, ageCode = 'AGE_FRESH', triesCode = 'TRIES_NONE', causeCode = 'CAUSE_NONE', pickupCode = 'PICKUP_NA', windowCode = 'WINDOW_NA') =>
  ({ taskAlias: ALIAS, snapshotVersion: 1, stateCode, ageCode, triesCode, causeCode, pickupCode, windowCode });
const everyCell = () => JOB_STATES.flatMap(s => AGE_CODES.flatMap(a => TRIES_CODES.flatMap(t => CAUSE_CODES.flatMap(c =>
  PICKUP_STATUS_CODES.flatMap(p => WINDOW_STATUS_CODES.map(w => cell(s, a, t, c, p, w)))))));
const level = answer => SEVERITIES.indexOf(answer.severity);

test('the table answers all 4500 combinations and every answer passes the validator', () => {
  const cells = everyCell();
  assert.equal(cells.length, 5 * 3 * 3 * 5 * 4 * 5);
  for (const m of cells) {
    assert.ok(acceptsStateMetadata(m));
    const answer = stateTable(m);
    assert.deepEqual(validateStateAdvice(answer, m), answer, JSON.stringify(m));
  }
});

test('invariants of the table: older is never less serious, blocked and unknown always need a person', () => {
  for (const m of everyCell()) {
    const fresh = level(stateTable({ ...m, ageCode: 'AGE_FRESH' })); const aging = level(stateTable({ ...m, ageCode: 'AGE_AGING' })); const stale = level(stateTable({ ...m, ageCode: 'AGE_STALE' }));
    assert.ok(fresh <= aging && aging <= stale, JSON.stringify(m));
    if (m.stateCode === 'OUTCOME_UNKNOWN') assert.equal(stateTable(m).severity, 'NEEDS_HUMAN');
    if (m.stateCode === 'PAUSED' && m.causeCode === 'CAUSE_BLOCKING') assert.deepEqual([stateTable(m).severity, stateTable(m).reasonCode], ['NEEDS_HUMAN', 'BLOCKED']);
    if (m.stateCode === 'DRY_RUN_PREPARED' && m.pickupCode === 'PICKUP_ALL') assert.equal(stateTable(m).severity, 'NORMAL');
    if (m.stateCode === 'DRY_RUN_PREPARED' && m.pickupCode !== 'PICKUP_ALL' && m.windowCode === 'WINDOW_LAST') assert.equal(stateTable(m).severity, 'NEEDS_HUMAN');
    // More tries never lowers the level.
    assert.ok(level(stateTable({ ...m, triesCode: 'TRIES_MANY' })) >= level(stateTable({ ...m, triesCode: 'TRIES_NONE' })));
  }
});

test('the ordinary cases read the way a person would read them', () => {
  assert.deepEqual([stateTable(cell('PENDING_CHECK')).severity, stateTable(cell('PENDING_CHECK', 'AGE_AGING')).reasonCode, stateTable(cell('PENDING_CHECK', 'AGE_STALE')).reasonCode], ['NORMAL', 'SLOW', 'STUCK']);
  assert.deepEqual([stateTable(cell('RETRY_WAIT')).severity, stateTable(cell('RETRY_WAIT', 'AGE_FRESH', 'TRIES_MANY')).severity, stateTable(cell('RETRY_WAIT', 'AGE_STALE')).severity], ['NORMAL', 'WATCH', 'NEEDS_HUMAN']);
  assert.equal(stateTable(cell('PAUSED', 'AGE_FRESH', 'TRIES_NONE', 'CAUSE_ADVICE_PAUSE')).severity, 'WATCH');
  assert.equal(stateTable(cell('PAUSED', 'AGE_AGING', 'TRIES_NONE', 'CAUSE_ADVICE_PAUSE')).severity, 'NEEDS_HUMAN');
  assert.equal(stateTable(cell('DRY_RUN_PREPARED', 'AGE_FRESH', 'TRIES_NONE', 'CAUSE_NONE', 'PICKUP_NONE', 'WINDOW_MOST')).reasonCode, 'WAITING_FOR_PICKUP');
});

test('age is judged against what is normal for each state, and an unreadable time is the oldest', () => {
  const now = Date.parse('2026-10-10T12:00:00Z'); const ago = ms => new Date(now - ms).toISOString();
  assert.deepEqual(['PENDING_CHECK', 'RETRY_WAIT', 'PAUSED'].map(s => ageCodeFor(s, ago(60_000), now)), ['AGE_FRESH', 'AGE_FRESH', 'AGE_FRESH']);
  assert.deepEqual(['PENDING_CHECK', 'RETRY_WAIT', 'PAUSED'].map(s => ageCodeFor(s, ago(15 * 60_000), now)), ['AGE_STALE', 'AGE_AGING', 'AGE_FRESH']);
  assert.deepEqual(['PENDING_CHECK', 'RETRY_WAIT', 'PAUSED'].map(s => ageCodeFor(s, ago(3 * 3600_000), now)), ['AGE_STALE', 'AGE_STALE', 'AGE_AGING']);
  assert.equal(ageCodeFor('DRY_RUN_PREPARED', ago(99 * 3600_000), now), 'AGE_FRESH');
  for (const bad of [undefined, null, 'soon', '']) assert.equal(ageCodeFor('PAUSED', bad, now), 'AGE_STALE');
  assert.equal(ageCodeFor('PAUSED', new Date(now + 5 * 3600_000).toISOString(), now), 'AGE_FRESH');
  assert.equal(ageCodeFor('NOT_A_STATE', ago(1), now), 'AGE_STALE');
});

test('the projection from a real task shape carries codes only', () => {
  const now = Date.parse('2026-10-10T12:00:00Z');
  const task = { id: 't', ownerId: 'sender', snapshots: [], jobs: [] };
  const snapshot = { version: 1, status: 'APPROVED', approvedAt: new Date(now - 3600_000).toISOString(),
    content: { recipients: ['r1'], channels: ['email'], deliveryMode: 'TIME_LIMITED', downloadUntil: new Date(now + 3600_000).toISOString(), expiresAt: new Date(now + 7200_000).toISOString() } };
  const job = { version: 1, status: 'RETRY_WAIT', attempts: 3, reasonCode: 'ADVISER_UNAVAILABLE', updatedAt: new Date(now - 10 * 60_000).toISOString() };
  const projection = stateProjection(task, snapshot, job, ALIAS, now);
  assert.deepEqual(projection, { taskAlias: ALIAS, snapshotVersion: 1, stateCode: 'RETRY_WAIT', ageCode: 'AGE_AGING', triesCode: 'TRIES_MANY',
    causeCode: 'CAUSE_RETRYABLE', pickupCode: 'PICKUP_NA', windowCode: 'WINDOW_NA' });
  assert.equal(stateProjection(task, snapshot, { ...job, reasonCode: 'SOMETHING_NEW' }, ALIAS, now).causeCode, 'CAUSE_UNKNOWN');
  assert.equal(stateProjection(task, snapshot, { ...job, reasonCode: undefined, attempts: 0 }, ALIAS, now).causeCode, 'CAUSE_NONE');
  assert.equal(stateProjection(task, snapshot, { ...job, status: 'WEIRD' }, ALIAS, now).stateCode, 'PAUSED');
});

test('the validator refuses a lower level than the table and a reason that contradicts the codes', () => {
  const stuck = cell('PENDING_CHECK', 'AGE_STALE');
  const answer = (severity, reasonCode, m = stuck) => ({ taskAlias: m.taskAlias, snapshotVersion: 1, severity, reasonCode });
  assert.throws(() => validateStateAdvice(answer('WATCH', 'SLOW'), stuck), e => e.message === 'STATE_LEVEL_BELOW_TABLE');
  assert.throws(() => validateStateAdvice(answer('NORMAL', 'PROGRESSING'), stuck), e => e.message === 'STATE_LEVEL_BELOW_TABLE');
  const fresh = cell('PENDING_CHECK');
  assert.equal(validateStateAdvice(answer('WATCH', 'INSUFFICIENT_INFORMATION', fresh), fresh).severity, 'WATCH');   // raising is allowed
  assert.throws(() => validateStateAdvice(answer('WATCH', 'SLOW', fresh), fresh), e => e.message === 'STATE_REASON_INCOHERENT');   // SLOW needs an aging delivery
  assert.throws(() => validateStateAdvice(answer('NORMAL', 'BLOCKED', fresh), fresh), e => e.message === 'STATE_REASON_INCOHERENT');
  assert.throws(() => validateStateAdvice(answer('NORMAL', 'FINISHED', fresh), fresh), e => e.message === 'STATE_REASON_INCOHERENT');
  assert.throws(() => validateStateAdvice(answer('NEEDS_HUMAN', 'STUCK', fresh), fresh), e => e.message === 'STATE_REASON_INCOHERENT');
  assert.throws(() => validateStateAdvice({ ...answer('NORMAL', 'PROGRESSING', fresh), extra: 1 }, fresh), e => e.status === 422);
  assert.throws(() => validateStateAdvice({ ...answer('NORMAL', 'PROGRESSING', fresh), taskAlias: 'x' }, fresh), e => e.status === 422);
  assert.ok(STATE_REASONS.every(reason => typeof STATE_MESSAGES[reason] === 'string'));
});

test('two-way review: the table is the floor, an adviser raises by one step at most, a silent one changes nothing', () => {
  const floor = { severity: 'NORMAL', reasonCode: 'PROGRESSING' };
  const say = (source, severity) => ({ source, advice: { severity } });
  assert.equal(reviewState(floor, []).final, 'NORMAL');
  assert.equal(reviewState(floor, [say('local', 'NORMAL')]).final, 'NORMAL');
  const raised = reviewState(floor, [say('local', 'NEEDS_HUMAN')]);
  assert.deepEqual([raised.final, raised.disagreement, raised.sources[0].status], ['WATCH', true, 'RAISES']);
  assert.equal(reviewState({ severity: 'WATCH', reasonCode: 'SLOW' }, [say('local', 'NEEDS_HUMAN')]).final, 'NEEDS_HUMAN');
  assert.equal(reviewState({ severity: 'NEEDS_HUMAN', reasonCode: 'STUCK' }, [say('local', 'NEEDS_HUMAN')]).final, 'NEEDS_HUMAN');
  assert.deepEqual([reviewState(floor, [{ source: 'local', advice: null, failed: true }]).final, reviewState(floor, [{ source: 'local', advice: null, failed: true }]).sources[0].status], ['NORMAL', 'UNAVAILABLE']);
});

test('the state kind goes through the shared request path, and the reviewer exists only when asked for', async () => {
  assert.ok(ADVICE_KINDS.state);
  const metadata = cell('PENDING_CHECK', 'AGE_AGING');
  assert.equal((await requestFileAdvice(metadata, { kind: 'state', provider: 'synthetic_fixture' })).advice.severity, 'WATCH');
  let sent;
  const fake = answer => async (url, init) => { sent = JSON.parse(init.body); return new Response(JSON.stringify({ model: 'm', choices: [{ message: { content: JSON.stringify(answer) } }] }), { status: 200 }); };
  const options = { kind: 'state', provider: 'local_openai_compatible', baseUrl: 'http://127.0.0.1:1234/v1', model: 'm' };
  const good = await requestFileAdvice(metadata, options, fake({ taskAlias: ALIAS, snapshotVersion: 1, severity: 'NEEDS_HUMAN', reasonCode: 'INSUFFICIENT_INFORMATION' }));
  assert.equal(good.advice.severity, 'NEEDS_HUMAN');
  assert.deepEqual(JSON.parse(sent.messages[1].content), metadata);
  await assert.rejects(requestFileAdvice(metadata, options, fake({ taskAlias: ALIAS, snapshotVersion: 1, severity: 'NORMAL', reasonCode: 'PROGRESSING' })), e => e.adviceRejected === true);
  await assert.rejects(requestFileAdvice({ ...metadata, ageCode: 'AGE_ANCIENT' }, options, fake({})), e => e.message === 'STATE_METADATA_REJECTED');
  for (const mode of [undefined, '', 'on', 'LOCAL']) assert.equal(createStateReviewer({ fileAdviser: async () => {}, mode }), null);
  const calls = [];
  const adviser = async (m, kind, o) => { calls.push([kind, o.outlet]); return { advice: { severity: 'NORMAL' } }; };
  assert.equal((await createStateReviewer({ fileAdviser: adviser, mode: 'dual' })(metadata, { severity: 'NORMAL', reasonCode: 'PROGRESSING' })).sources.length, 2);
  assert.deepEqual(calls, [['state', 'local'], ['state', 'hosted']]);
});
