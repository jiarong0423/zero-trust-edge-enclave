import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ADVICE_KINDS, FOLLOWUP_ADVISER_BOUNDARY, FOLLOWUP_JUDGEMENT_DIRECTIVE, followupBoundary, requestFileAdvice } from '../file-adviser.js';
import { MAX_NUDGES } from '../delivery-followup.js';

// The follow-up prompt as it stood before the opt-in profile existed (HEAD of 2026-10-08).
const ORIGINAL_SHA256 = '4cd4068ef06d241994df9e0b1879617a279e845bbb3769d5902ff55ee926d13f';
const ORIGINAL_LENGTH = 3988;
const sha = text => createHash('sha256').update(text).digest('hex');
const paragraphs = text => text.split('\n');
const judgement = text => paragraphs(text).findIndex(line => line.startsWith('JUDGEMENT:'));

test('default prompt is byte-identical to the original and ADVICE_KINDS.followup.boundary stays a string', () => {
  assert.equal(typeof ADVICE_KINDS.followup.boundary, 'string');
  assert.equal(ADVICE_KINDS.followup.boundary, FOLLOWUP_ADVISER_BOUNDARY);
  assert.equal(FOLLOWUP_ADVISER_BOUNDARY.length, ORIGINAL_LENGTH);
  assert.equal(sha(FOLLOWUP_ADVISER_BOUNDARY), ORIGINAL_SHA256);
  assert.equal(followupBoundary({}), FOLLOWUP_ADVISER_BOUNDARY);
  assert.equal(followupBoundary({ FOLLOWUP_PROMPT: undefined }), FOLLOWUP_ADVISER_BOUNDARY);
});

test('only the exact string directive activates the profile', () => {
  for (const value of ['Directive', 'DIRECTIVE', 'directive ', ' directive', 'directive\n', 'directives', 'direct', '1', 'true', 'on', '', 'current', 'principles', 'table', 'default']) {
    assert.equal(followupBoundary({ FOLLOWUP_PROMPT: value }), FOLLOWUP_ADVISER_BOUNDARY, JSON.stringify(value));
  }
  assert.notEqual(followupBoundary({ FOLLOWUP_PROMPT: 'directive' }), FOLLOWUP_ADVISER_BOUNDARY);
  assert.equal(followupBoundary(undefined) , followupBoundary(process.env));
});

test('directive swaps only the JUDGEMENT paragraph', () => {
  const original = paragraphs(FOLLOWUP_ADVISER_BOUNDARY);
  const swapped = paragraphs(followupBoundary({ FOLLOWUP_PROMPT: 'directive' }));
  assert.equal(swapped.length, original.length);
  const at = judgement(FOLLOWUP_ADVISER_BOUNDARY);
  assert.equal(judgement(followupBoundary({ FOLLOWUP_PROMPT: 'directive' })), at);
  swapped.forEach((line, index) => {
    if (index === at) assert.notEqual(line, original[index]);
    else assert.equal(line, original[index], 'line ' + index);
  });
  assert.equal(swapped[at], FOLLOWUP_JUDGEMENT_DIRECTIVE);
  const text = swapped.join('\n');
  // The KEY and REASON KEY blocks, the LIMITS line and the OUTPUT line are untouched.
  for (const heading of ['LIMITS:', 'KEY:', 'REASON KEY:', 'OUTPUT:', 'HUMAN AUTHORITY:', 'FIXED CODE AUTHORITY:', 'PRIVACY:']) {
    const index = original.findIndex(line => line.startsWith(heading));
    assert.ok(index >= 0);
    assert.equal(swapped[index], original[index], heading);
  }
  const keyStart = original.findIndex(line => line.startsWith('KEY:'));
  assert.deepEqual(swapped.slice(keyStart), original.slice(keyStart));
  assert.ok(text.includes('nudgeCount is ' + MAX_NUDGES), 'the budget is interpolated from the fixed constant');
});

test('the directive judgement states reasons in words and sends nothing beyond the existing vocabulary', () => {
  for (const word of FOLLOWUP_JUDGEMENT_DIRECTIVE.match(/\b[A-Z][A-Z_]{5,}\b/g)) {
    assert.ok(['JUDGEMENT', 'WINDOW_FULL', 'WINDOW_MOST', 'WINDOW_LITTLE', 'WINDOW_LAST', 'ESCALATE', 'REMIND', 'WAIT',
      'NUDGES_EXHAUSTED', 'DEADLINE_NEAR', 'WINDOW_EARLY'].includes(word), word);
  }
  assert.ok(FOLLOWUP_JUDGEMENT_DIRECTIVE.length < 1300);
});

test('no profile puts identifier-like content in the system text', () => {
  for (const env of [{}, { FOLLOWUP_PROMPT: 'directive' }]) {
    const text = followupBoundary(env);
    assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(text), 'uuid');
    assert.ok(!/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/.test(text), 'address');
    assert.ok(!/https?:|\/\//i.test(text), 'url');
    assert.ok(!/\b[0-9a-f]{12,}\b/i.test(text), 'long hex');
    assert.ok(!/\d{4,}/.test(text), 'long number');
    assert.ok(!/(?:^|\s)\/(?:Users|private|tmp|home)\b/.test(text), 'path');
  }
});

test('requestFileAdvice sends the selected prompt at call time and the schema and keys are unchanged', async () => {
  const metadata = { taskAlias: '12345678-1234-4234-8234-123456789012', snapshotVersion: 1,
    timeCode: 'WINDOW_MOST', nudgeCount: 0, pickupCode: 'PICKUP_NONE' };
  const options = { provider: 'local_openai_compatible', baseUrl: 'http://127.0.0.1:1234/v1', model: 'local-test', kind: 'followup' };
  const answer = { taskAlias: metadata.taskAlias, snapshotVersion: 1, action: 'REMIND', reasonCode: 'NO_PICKUP_YET' };
  const sent = [];
  const mock = async (url, init) => {
    sent.push(JSON.parse(init.body));
    return Response.json({ choices: [{ message: { content: JSON.stringify(answer) } }] });
  };
  const before = process.env.FOLLOWUP_PROMPT;
  try {
    delete process.env.FOLLOWUP_PROMPT;
    const base = await requestFileAdvice(metadata, options, mock);
    process.env.FOLLOWUP_PROMPT = 'directive';
    const directive = await requestFileAdvice(metadata, options, mock);
    process.env.FOLLOWUP_PROMPT = 'Directive';
    await requestFileAdvice(metadata, options, mock);
    delete process.env.FOLLOWUP_PROMPT;
    await requestFileAdvice(metadata, options, mock);
    assert.deepEqual(base.advice, answer);
    assert.deepEqual(directive.advice, answer);
  } finally {
    if (before === undefined) delete process.env.FOLLOWUP_PROMPT; else process.env.FOLLOWUP_PROMPT = before;
  }
  const system = body => body.messages[0].content;
  assert.equal(system(sent[0]), FOLLOWUP_ADVISER_BOUNDARY);
  assert.equal(system(sent[1]), followupBoundary({ FOLLOWUP_PROMPT: 'directive' }));
  assert.equal(system(sent[2]), FOLLOWUP_ADVISER_BOUNDARY);
  assert.equal(system(sent[3]), FOLLOWUP_ADVISER_BOUNDARY);
  assert.notEqual(system(sent[0]), system(sent[1]));
  // Same user message, same schema, same sampling: the profile changes nothing but the paragraph.
  assert.deepEqual(sent[0].messages[1], sent[1].messages[1]);
  assert.deepEqual(sent[0].response_format, sent[1].response_format);
  assert.deepEqual({ ...sent[0], messages: null }, { ...sent[1], messages: null });
  assert.deepEqual(ADVICE_KINDS.followup.keys, ['taskAlias', 'snapshotVersion', 'timeCode', 'nudgeCount', 'pickupCode']);
  assert.deepEqual(ADVICE_KINDS.followup.schema.required, ['taskAlias', 'snapshotVersion', 'action', 'reasonCode']);
});

test('the route kind prompt does not move', () => {
  assert.equal(typeof ADVICE_KINDS.route.boundary, 'string');
  assert.equal(ADVICE_KINDS.route.boundaryFor, undefined);
});
