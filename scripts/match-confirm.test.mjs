import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CANDIDATE_CODES, KEY_CODES, NARROW_CODES, REVERSE_CODES, ATTEMPT_CODES, MATCH_ACTIONS, MATCH_REASONS,
  legalMatchActions, matchTable, validateMatchAdvice, matchProjection, reviewMatch, createMatchReviewer, acceptsMatchMetadata
} from '../match-confirm.js';
import { requestFileAdvice, ADVICE_KINDS } from '../file-adviser.js';

const ALIAS = '11111111-1111-4111-8111-111111111111';
const cell = (candidateCode, keyCode, reverseCode, attemptCode = 'ATTEMPT_FIRST', narrowCode = 'NARROW_NOT_USED') =>
  ({ taskAlias: ALIAS, snapshotVersion: 1, candidateCode, keyCode, narrowCode, reverseCode, attemptCode });
const everyCell = () => CANDIDATE_CODES.flatMap(c => KEY_CODES.flatMap(k => NARROW_CODES.flatMap(n => REVERSE_CODES.flatMap(r => ATTEMPT_CODES.map(a => cell(c, k, r, a, n))))));

test('the table answers every one of the 405 combinations, and every answer is legal and coherent', () => {
  const cells = everyCell();
  assert.equal(cells.length, CANDIDATE_CODES.length * KEY_CODES.length * NARROW_CODES.length * REVERSE_CODES.length * ATTEMPT_CODES.length);
  assert.equal(cells.length, 405);
  for (const metadata of cells) {
    const answer = matchTable(metadata);
    assert.ok(legalMatchActions(metadata).includes(answer.action), JSON.stringify(metadata));
    assert.deepEqual(validateMatchAdvice(answer, metadata), answer, JSON.stringify(metadata));
    assert.ok(acceptsMatchMetadata(metadata));
  }
});

test('CONFIRM exists in exactly one family of cells: one person, checked both ways, name verified', () => {
  const confirming = everyCell().filter(m => matchTable(m).action === 'CONFIRM');
  assert.ok(confirming.length > 0);
  for (const m of confirming) {
    assert.deepEqual([m.candidateCode, m.reverseCode], ['CANDIDATE_ONE', 'REVERSE_PASS']);
    assert.ok(!['KEY_ID_NAME_UNLISTED', 'KEY_ALIAS'].includes(m.keyCode));
  }
  // The number of earlier failures never changes the answer.
  for (const m of everyCell()) {
    assert.equal(matchTable({ ...m, attemptCode: 'ATTEMPT_LAST' }).action, matchTable({ ...m, attemptCode: 'ATTEMPT_FIRST' }).action);
  }
});

test('the four situations of the owner example come out as designed', () => {
  assert.equal(matchTable(cell('CANDIDATE_ONE', 'KEY_NAME', 'REVERSE_PASS')).action, 'CONFIRM');              // 劉慶龍
  assert.equal(matchTable(cell('CANDIDATE_MANY', 'KEY_NAME', 'REVERSE_NOT_APPLICABLE')).action, 'ASK_HUMAN'); // two 劉文祥
  assert.equal(matchTable(cell('CANDIDATE_ONE', 'KEY_ID', 'REVERSE_PASS')).action, 'CONFIRM');                // 劉文祥 plus a number
  assert.equal(matchTable(cell('CANDIDATE_ONE', 'KEY_ID_NAME_UNLISTED', 'REVERSE_PASS')).reasonCode, 'NAME_UNVERIFIED'); // 劉先生 plus a number
  assert.equal(matchTable(cell('CANDIDATE_NONE', 'KEY_NONE', 'REVERSE_FAIL')).reasonCode, 'REVERSE_FAILED');  // name and number disagree
  assert.equal(matchTable(cell('CANDIDATE_ONE', 'KEY_ALIAS', 'REVERSE_PASS')).reasonCode, 'NAME_UNVERIFIED');  // a nickname
  assert.equal(matchTable(cell('CANDIDATE_ONE', 'KEY_NAME', 'REVERSE_PASS', 'ATTEMPT_FIRST', 'NARROW_DECISIVE')).action, 'CONFIRM');  // tags made the shared name unique
});

test('the validator refuses an action the codes do not allow and a reason that contradicts them', () => {
  const many = cell('CANDIDATE_MANY', 'KEY_NAME', 'REVERSE_NOT_APPLICABLE');
  const answer = (action, reasonCode, metadata) => ({ taskAlias: metadata.taskAlias, snapshotVersion: 1, action, reasonCode });
  assert.throws(() => validateMatchAdvice(answer('CONFIRM', 'ONE_CLEAR', many), many), e => e.message === 'MATCH_ACTION_NOT_ALLOWED');
  const none = cell('CANDIDATE_NONE', 'KEY_NONE', 'REVERSE_NOT_APPLICABLE');
  assert.throws(() => validateMatchAdvice(answer('ASK_HUMAN', 'INSUFFICIENT_INFORMATION', none), none), e => e.message === 'MATCH_ACTION_NOT_ALLOWED');
  const clear = cell('CANDIDATE_ONE', 'KEY_NAME', 'REVERSE_PASS');
  assert.throws(() => validateMatchAdvice(answer('CONFIRM', 'NEEDS_CHOICE', clear), clear), e => e.message === 'MATCH_REASON_INCOHERENT');
  assert.throws(() => validateMatchAdvice(answer('ASK_HUMAN', 'NEEDS_CHOICE', clear), clear), e => e.message === 'MATCH_REASON_INCOHERENT');
  assert.throws(() => validateMatchAdvice(answer('REFUSE', 'REVERSE_FAILED', clear), clear), e => e.message === 'MATCH_REASON_INCOHERENT');
  assert.throws(() => validateMatchAdvice({ ...answer('CONFIRM', 'ONE_CLEAR', clear), extra: 1 }, clear), e => e.status === 422);
  assert.throws(() => validateMatchAdvice({ ...answer('CONFIRM', 'ONE_CLEAR', clear), taskAlias: 'other' }, clear), e => e.status === 422);
  assert.equal(validateMatchAdvice(answer('ASK_HUMAN', 'INSUFFICIENT_INFORMATION', clear), clear).action, 'ASK_HUMAN');
  assert.ok(MATCH_ACTIONS.length === 3 && MATCH_REASONS.length === 6);
});

test('the projection carries codes only and maps each outcome of the resolver', () => {
  const p = (status, code, reversePass = false, failsBefore = 0) => matchProjection({ status, code }, { reversePass, failsBefore, alias: ALIAS });
  assert.deepEqual(Object.keys(p('MATCHED', 'MATCH_BY_NAME', true)).sort(),
    ['attemptCode', 'candidateCode', 'keyCode', 'narrowCode', 'reverseCode', 'snapshotVersion', 'taskAlias']);
  assert.equal(p('MATCHED', 'MATCH_BY_ALIAS', true).keyCode, 'KEY_ALIAS');
  assert.equal(matchProjection({ status: 'MATCHED', code: 'MATCH_BY_NAME', narrow: 'NARROW_DECISIVE' }, { reversePass: true, failsBefore: 0, alias: ALIAS }).narrowCode, 'NARROW_DECISIVE');
  assert.equal(matchProjection({ status: 'MATCHED', code: 'MATCH_BY_NAME', narrow: 'bogus' }, { reversePass: true, failsBefore: 0, alias: ALIAS }).narrowCode, 'NARROW_NOT_USED');
  assert.equal(p('MATCHED', 'MATCH_BY_NAME', true).keyCode, 'KEY_NAME');
  assert.equal(p('MATCHED', 'MATCH_BY_ID', true).keyCode, 'KEY_ID');
  assert.equal(p('MATCHED', 'MATCH_BY_ID_NAME_UNLISTED', true).keyCode, 'KEY_ID_NAME_UNLISTED');
  assert.equal(p('AMBIGUOUS', 'AMBIGUOUS_NEED_ID').candidateCode, 'CANDIDATE_MANY');
  assert.equal(p('NONE', 'NONE_NOT_FOUND').reverseCode, 'REVERSE_NOT_APPLICABLE');
  assert.equal(p('NONE', 'NONE_NOT_AUTHORIZED').reverseCode, 'REVERSE_FAIL');
  assert.equal(p('CONFLICT', 'CONFLICT_ID_NAME').reverseCode, 'REVERSE_FAIL');
  assert.deepEqual([0, 1, 2, 5].map(n => p('NONE', 'NONE_NOT_FOUND', false, n).attemptCode), ['ATTEMPT_FIRST', 'ATTEMPT_AGAIN', 'ATTEMPT_LAST', 'ATTEMPT_LAST']);
  assert.equal(JSON.stringify(p('MATCHED', 'MATCH_BY_NAME', true)).match(/[^\x00-\x7f]/), null);
});

test('two-way review: the table has a veto and an adviser can only add care', () => {
  const confirm = { action: 'CONFIRM', reasonCode: 'ONE_CLEAR' };
  const ask = { action: 'ASK_HUMAN', reasonCode: 'NEEDS_CHOICE' };
  const refuse = { action: 'REFUSE', reasonCode: 'NO_CANDIDATE' };
  const answer = (source, advice) => ({ source, advice });
  assert.equal(reviewMatch(confirm, []).final, 'CONFIRM');
  assert.equal(reviewMatch(confirm, [answer('local', confirm)]).final, 'CONFIRM');
  const disagree = reviewMatch(confirm, [answer('local', ask)]);
  assert.deepEqual([disagree.final, disagree.disagreement, disagree.sources[0].status], ['ASK_HUMAN', true, 'DISAGREE']);
  assert.equal(reviewMatch(confirm, [answer('local', confirm), answer('hosted', refuse)]).final, 'ASK_HUMAN');
  // An adviser cannot loosen what the table holds back.
  assert.equal(reviewMatch(ask, [answer('local', confirm)]).final, 'ASK_HUMAN');
  assert.equal(reviewMatch(refuse, [answer('local', confirm), answer('hosted', confirm)]).final, 'REFUSE');
  // An adviser that could not answer is recorded and changes nothing.
  const down = reviewMatch(confirm, [{ source: 'local', advice: null, failed: true }]);
  assert.deepEqual([down.final, down.disagreement, down.sources[0].status], ['CONFIRM', false, 'UNAVAILABLE']);
});

test('the match kind goes through the shared request path: schema, codes in the prompt, validator on the way out', async () => {
  assert.ok(ADVICE_KINDS.match);
  const metadata = cell('CANDIDATE_ONE', 'KEY_NAME', 'REVERSE_PASS');
  const fixture = await requestFileAdvice(metadata, { kind: 'match', provider: 'synthetic_fixture' });
  assert.deepEqual([fixture.provider, fixture.advice.action], ['synthetic_fixture', 'CONFIRM']);
  let sent;
  const fake = answer => async (url, init) => {
    sent = JSON.parse(init.body);
    return new Response(JSON.stringify({ model: 'm', choices: [{ message: { content: JSON.stringify(answer) } }] }), { status: 200 });
  };
  const options = { kind: 'match', provider: 'local_openai_compatible', baseUrl: 'http://127.0.0.1:1234/v1', model: 'm' };
  const good = await requestFileAdvice(metadata, options, fake({ taskAlias: ALIAS, snapshotVersion: 1, action: 'CONFIRM', reasonCode: 'ONE_CLEAR' }));
  assert.equal(good.advice.action, 'CONFIRM');
  assert.deepEqual(JSON.parse(sent.messages[1].content), metadata);
  assert.equal(sent.response_format.json_schema.schema.properties.action.enum.join(), 'CONFIRM,ASK_HUMAN,REFUSE');
  const many = cell('CANDIDATE_MANY', 'KEY_NAME', 'REVERSE_NOT_APPLICABLE');
  await assert.rejects(requestFileAdvice(many, options, fake({ taskAlias: ALIAS, snapshotVersion: 1, action: 'CONFIRM', reasonCode: 'ONE_CLEAR' })),
    error => error.adviceRejected === true && error.message === 'MATCH_ACTION_NOT_ALLOWED');
  await assert.rejects(requestFileAdvice({ ...metadata, keyCode: 'KEY_UNKNOWN' }, options, fake({})), e => e.message === 'MATCH_METADATA_REJECTED');
  await assert.rejects(requestFileAdvice({ ...metadata, name: '劉文祥' }, options, fake({})), e => e.status === 422);
});

test('the reviewer exists only when MATCH_AI_REVIEW is exactly local or dual', async () => {
  for (const mode of [undefined, '', 'on', 'true', 'LOCAL', 'local ']) assert.equal(createMatchReviewer({ fileAdviser: async () => {}, mode }), null);
  const calls = [];
  const adviser = async (metadata, kind, options) => { calls.push([kind, options.outlet]); return { advice: { action: 'CONFIRM', reasonCode: 'ONE_CLEAR' } }; };
  const confirm = { action: 'CONFIRM', reasonCode: 'ONE_CLEAR' };
  assert.equal((await createMatchReviewer({ fileAdviser: adviser, mode: 'local' })({}, confirm)).sources.length, 1);
  assert.equal((await createMatchReviewer({ fileAdviser: adviser, mode: 'dual' })({}, confirm)).sources.length, 2);
  assert.deepEqual(calls, [['match', 'local'], ['match', 'local'], ['match', 'hosted']]);
});
