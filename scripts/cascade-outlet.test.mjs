import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createFileAdviser, cascadeReason, cascadeStartupProblem, tokenFactoryBudgetUsable, CASCADE_PROVIDER, KNOWN_PROVIDERS } from '../file-adviser-outlet.js';
import { requestFileAdvice } from '../file-adviser.js';
import { advanceFileJobs, advanceFollowups, adviceOrigin, normalizeCascade, ADVICE_SOURCE, ADVICE_NO_RETRY } from '../file-worker.js';
import { newTask, confirmFirst, confirmSecond } from '../snapshot-lifecycle.js';
import { sealFileBytes } from '../public/file-envelope.js';
import { syntheticFileAdvice } from '../file-routing.js';
import { syntheticFollowupAdvice } from '../delivery-followup.js';
import { taskEvidence } from '../task-evidence.js';
import { createBudget } from '../nebius-budget.js';

// No test in this file contacts a real host. Both outlets are answered by injected transports. The
// global fetch is replaced by a guard that only lets a loopback address through, so a call that
// escaped the injection would throw here instead of leaving the machine.
const realFetch = globalThis.fetch;
const escaped = [];
globalThis.fetch = (url, init) => {
  const target = new URL(String(url));
  if (target.hostname !== '127.0.0.1') { escaped.push(String(url)); throw new Error('TEST_NETWORK_GUARD'); }
  return realFetch(url, init);
};
const ledgerDir = await fs.mkdtemp(path.join(os.tmpdir(), 'enclave-cascade-ledger-'));
after(async () => { globalThis.fetch = realFetch; await fs.rm(ledgerDir, { recursive: true, force: true }); });

const TEST_KEY = 'nebius-key-for-this-test-only-0123456789';
const NEBIUS_BASE = 'https://api.tokenfactory.nebius.com/v1';
const NEBIUS_MODEL = 'nvidia/nemotron-3-super-120b-a12b';
const LOCAL_BASE = 'http://127.0.0.1:1234/v1';
const LOCAL_MODEL = 'nvidia-nemotron-3-nano-4b';

const routeMetadata = {
  taskAlias: '0b0c3c96-1a2b-4c3d-8e4f-5a6b7c8d9e0f', snapshotVersion: 1,
  channels: ['email', 'internal_queue'], state: 'PENDING_CHECK', attempts: 0,
};
const followupMetadata = {
  taskAlias: '0b0c3c96-1a2b-4c3d-8e4f-5a6b7c8d9e0f', snapshotVersion: 1,
  timeCode: 'WINDOW_LAST', nudgeCount: 2, pickupCode: 'PICKUP_NONE',
};
const routeAnswer = { taskAlias: routeMetadata.taskAlias, snapshotVersion: 1, action: 'ROUTE', channel: 'email', reasonCode: 'APPROVED_CHANNEL' };
const routePause = { ...routeAnswer, action: 'PAUSE', reasonCode: 'INSUFFICIENT_INFORMATION' };

const reply = (advice, model = LOCAL_MODEL) =>
  Response.json({ model, choices: [{ message: { content: JSON.stringify(advice) } }] });
const down = () => { throw new TypeError('fetch failed'); };
const timedOut = () => { throw new DOMException('The operation timed out.', 'TimeoutError'); };
const http500 = () => new Response('upstream error', { status: 500 });

// Answers whichever decision it is asked, from the projection in the request itself.
function validAnswer(call) {
  const projection = JSON.parse(call.body.messages.find(message => message.role === 'user').content);
  return reply('timeCode' in projection ? syntheticFollowupAdvice(projection) : syntheticFileAdvice(projection),
    call.body.model);
}

async function withEnv(vars, work) {
  const saved = Object.fromEntries(Object.keys(vars).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(vars)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  const logs = [];
  const errors = [];
  const original = { log: console.log, error: console.error };
  console.log = (...args) => logs.push(args.join(' '));
  console.error = (...args) => errors.push(args.join(' '));
  try { return await work({ logs, errors }); } finally {
    console.log = original.log;
    console.error = original.error;
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}

// The cascade refuses to start without a Token Factory ceiling, so every rig has one by default: a
// large limit and a ledger of its own, which nothing in these tests comes near.
const budgetEnv = { NEBIUS_BUDGET_USD: '100', NEBIUS_PRICE_INPUT_PER_M: '0.3', NEBIUS_PRICE_OUTPUT_PER_M: '0.9' };
let ledgers = 0;
const freshBudget = (env = budgetEnv) => createBudget(env, path.join(ledgerDir, `ledger-${++ledgers}.json`));

function rig({ local = validAnswer, hosted = validAnswer, localOnly = false, budget, realLocal = false, localBaseUrl = LOCAL_BASE,
  legacyHostedAdviceOff = true, cascadeDeadlineMs } = {}) {
  const calls = { local: [], hosted: [] };
  const record = (list, responder) => async (url, init) => {
    const call = { url: String(url), headers: init.headers, body: JSON.parse(init.body), signal: init.signal };
    list.push(call);
    return responder(call);
  };
  const adviser = createFileAdviser({
    nebiusBudget: budget || freshBudget(), legacyHostedAdviceOff, ...(cascadeDeadlineMs ? { cascadeDeadlineMs } : {}),
    localOnly, localModelBaseUrl: localBaseUrl, localModelName: LOCAL_MODEL, nebiusBaseUrl: NEBIUS_BASE, nebiusModel: NEBIUS_MODEL,
    ...(realLocal ? {} : { localRequest: record(calls.local, local) }),
    hostedRequest: record(calls.hosted, hosted),
  });
  return { adviser, calls };
}

const cascadeEnv = { COORDINATOR_PROVIDER: CASCADE_PROVIDER, NEBIUS_API_KEY: TEST_KEY, ...budgetEnv };
const userContent = call => call.body.messages.find(message => message.role === 'user').content;

test('a valid local answer is final and the hosted model is never asked', async () => {
  await withEnv(cascadeEnv, async ({ logs, errors }) => {
    const { adviser, calls } = rig();
    const result = await adviser(routeMetadata);
    assert.equal(result.provider, 'local_openai_compatible');
    assert.equal(result.advice[ADVICE_SOURCE], 'local_openai_compatible', 'a local answer carries no cascade marker');
    assert.equal(calls.local.length, 1);
    assert.equal(calls.hosted.length, 0);
    assert.equal(errors.length, 0);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /^adviser route local_openai_compatible nvidia-nemotron-3-nano-4b \d+ms ROUTE APPROVED_CHANNEL$/);
  });
});

test('WAIT, ESCALATE and PAUSE from the local model are valid answers, not a reason to ask again', async () => {
  await withEnv(cascadeEnv, async () => {
    for (const [metadata, kind, answer] of [
      [routeMetadata, 'route', routePause],
      [{ ...followupMetadata, timeCode: 'WINDOW_FULL', nudgeCount: 0 }, 'followup',
        { taskAlias: followupMetadata.taskAlias, snapshotVersion: 1, action: 'WAIT', reasonCode: 'WINDOW_EARLY' }],
      [followupMetadata, 'followup',
        { taskAlias: followupMetadata.taskAlias, snapshotVersion: 1, action: 'ESCALATE', reasonCode: 'NUDGES_EXHAUSTED' }],
    ]) {
      const { adviser, calls } = rig({ local: () => reply(answer) });
      const result = await adviser(metadata, kind);
      assert.equal(result.advice.action, answer.action);
      assert.equal(result.provider, 'local_openai_compatible');
      assert.equal(calls.local.length, 1);
      assert.equal(calls.hosted.length, 0, `${kind} ${answer.action}`);
    }
  });
});

test('an unreachable local model asks the hosted model exactly once and uses its answer', async () => {
  for (const [label, failure] of [['transport error', down], ['timeout', timedOut]]) {
    await withEnv(cascadeEnv, async ({ logs, errors }) => {
      const { adviser, calls } = rig({ local: failure });
      const result = await adviser(routeMetadata);
      assert.equal(result.provider, 'nebius_token_factory', label);
      assert.deepEqual(result.advice[ADVICE_SOURCE],
        { source: 'nebius_token_factory', cascade: { from: 'local_openai_compatible', reason: 'LOCAL_UNREACHABLE' } });
      assert.equal(calls.local.length, 1);
      assert.equal(calls.hosted.length, 1);
      assert.equal(calls.hosted[0].url, `${NEBIUS_BASE}/chat/completions`);
      assert.equal(calls.hosted[0].body.model, NEBIUS_MODEL);
      assert.equal(errors.length, 1);
      assert.match(errors[0], /^ERROR adviser route local_openai_compatible nvidia-nemotron-3-nano-4b \d+ms FILE_PROVIDER_UNREACHABLE cascade=LOCAL_UNREACHABLE$/);
      assert.equal(logs.length, 1);
      assert.match(logs[0], /^adviser route nebius_token_factory nvidia\/nemotron-3-super-120b-a12b \d+ms ROUTE APPROVED_CHANNEL cascade=LOCAL_UNREACHABLE$/);
    });
  }
});

test('a refused connection on a real loopback port cascades the same way', async () => {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  await withEnv(cascadeEnv, async () => {
    const { adviser, calls } = rig({ realLocal: true, localBaseUrl: `http://127.0.0.1:${port}/v1` });
    const result = await adviser(routeMetadata);
    assert.equal(result.provider, 'nebius_token_factory');
    assert.equal(result.advice[ADVICE_SOURCE].cascade.reason, 'LOCAL_UNREACHABLE');
    assert.equal(calls.hosted.length, 1);
  });
});

test('a local answer the validator or the envelope check refuses asks the hosted model once', async () => {
  const unusable = {
    'validator: unknown channel': () => reply({ ...routeAnswer, channel: 'sms' }),
    'validator: extra field': () => reply({ ...routeAnswer, extra: true }),
    'validator: stale version': () => reply({ ...routeAnswer, snapshotVersion: 2 }),
    'http error': http500,
    'not json': () => new Response('not json at all', { status: 200 }),
    'empty content': () => Response.json({ choices: [{ message: { content: '' } }] }),
  };
  for (const [label, local] of Object.entries(unusable)) {
    await withEnv(cascadeEnv, async () => {
      const { adviser, calls } = rig({ local });
      const result = await adviser(routeMetadata);
      assert.equal(result.provider, 'nebius_token_factory', label);
      assert.equal(result.advice[ADVICE_SOURCE].cascade.reason, 'LOCAL_REJECTED', label);
      assert.equal(calls.local.length, 1, label);
      assert.equal(calls.hosted.length, 1, label);
    });
  }
});

test('when both outlets fail the error names the outlet last asked and there is no third call', async () => {
  await withEnv(cascadeEnv, async ({ errors }) => {
    const { adviser, calls } = rig({ local: down, hosted: http500 });
    await assert.rejects(() => adviser(routeMetadata), error => {
      assert.equal(error.message, 'FILE_PROVIDER_RESPONSE_REJECTED');
      assert.deepEqual(error[ADVICE_SOURCE],
        { source: 'nebius_token_factory', cascade: { from: 'local_openai_compatible', reason: 'LOCAL_UNREACHABLE' } });
      assert.equal(error[ADVICE_NO_RETRY], undefined, 'a failure after a request was sent may be retried');
      return true;
    });
    assert.equal(calls.local.length, 1);
    assert.equal(calls.hosted.length, 1);
    assert.equal(errors.length, 2);
    assert.ok(errors.every(line => line.startsWith('ERROR adviser route ')), 'every failure line is greppable');
    assert.match(errors[1], /^ERROR adviser route nebius nvidia\/nemotron-3-super-120b-a12b \d+ms FILE_PROVIDER_RESPONSE_REJECTED cascade=LOCAL_UNREACHABLE$/);
  });
  await withEnv(cascadeEnv, async () => {
    const { adviser, calls } = rig({ local: () => reply({ ...routeAnswer, channel: 'sms' }), hosted: () => reply({ ...routeAnswer, action: 'SEND' }) });
    await assert.rejects(() => adviser(routeMetadata), error => {
      assert.equal(error.adviceRejected, true);
      assert.equal(error[ADVICE_SOURCE].source, 'nebius_token_factory');
      assert.equal(error[ADVICE_SOURCE].cascade.reason, 'LOCAL_REJECTED');
      return true;
    });
    assert.equal(calls.local.length, 1);
    assert.equal(calls.hosted.length, 1);
  });
});

test('a hosted call refused before it was sent reports the local failure, not a hosted one', async () => {
  await withEnv({ ...cascadeEnv, NEBIUS_API_KEY: undefined }, async ({ errors }) => {
    const { adviser, calls } = rig({ local: down });
    await assert.rejects(() => adviser(routeMetadata), error => {
      assert.equal(error.message, 'FILE_PROVIDER_UNREACHABLE');
      assert.equal(error[ADVICE_SOURCE], 'local_openai_compatible');
      assert.equal(error[ADVICE_NO_RETRY], undefined, 'the local outlet may come back, so the worker may ask again');
      return true;
    });
    assert.equal(calls.local.length, 1);
    assert.equal(calls.hosted.length, 0, 'no key means nothing was sent to the hosted endpoint');
    assert.ok(errors.some(line => line.includes('FILE_PROVIDER_UNAVAILABLE')));
  });
});

test('a spent Token Factory budget answers from the fixture after a local failure and sends nothing', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'enclave-cascade-'));
  const file = path.join(dir, 'spend.json');
  await fs.writeFile(file, JSON.stringify({ spentUsd: 5 }));
  const budget = createBudget({ NEBIUS_BUDGET_USD: '1', NEBIUS_PRICE_INPUT_PER_M: '0.3', NEBIUS_PRICE_OUTPUT_PER_M: '0.9' }, file);
  assert.equal(await budget.exhausted(), true);
  await withEnv(cascadeEnv, async ({ logs }) => {
    const { adviser, calls } = rig({ local: down, budget });
    const result = await adviser(routeMetadata);
    assert.equal(result.provider, 'synthetic_fixture');
    assert.deepEqual({ ...result.advice, [ADVICE_SOURCE]: undefined }, { ...syntheticFileAdvice(routeMetadata), [ADVICE_SOURCE]: undefined });
    assert.deepEqual(result.advice[ADVICE_SOURCE],
      { source: 'synthetic_fixture', cascade: { from: 'local_openai_compatible', reason: 'LOCAL_UNREACHABLE' } });
    assert.equal(calls.local.length, 1);
    assert.equal(calls.hosted.length, 0);
    assert.match(logs[0], /^adviser route synthetic_fixture - \d+ms ROUTE APPROVED_CHANNEL cascade=LOCAL_UNREACHABLE$/);
  });
  await withEnv(cascadeEnv, async () => {
    const { adviser, calls } = rig({ budget });
    const result = await adviser(routeMetadata);
    assert.equal(result.provider, 'local_openai_compatible', 'a spent budget does not touch a valid local answer');
    assert.equal(calls.hosted.length, 0);
  });
});

test('under LOCAL_ONLY the cascade never reaches the hosted outlet', async () => {
  // Refusing to start: the check runs when the adviser is built, which is server start-up.
  for (const localOnly of [true, null]) {
    await withEnv(cascadeEnv, async ({ errors }) => {
      assert.throws(() => rig({ localOnly }), /CASCADE_REQUIRES_LOCAL_ONLY_FALSE/);
      assert.match(errors[0], /^ERROR adviser local_then_nebius refused at start-up: CASCADE_REQUIRES_LOCAL_ONLY_FALSE$/);
    });
  }
  assert.equal(cascadeStartupProblem(CASCADE_PROVIDER, true), 'CASCADE_REQUIRES_LOCAL_ONLY_FALSE');
  const ready = { legacyHostedAdviceOff: true, env: budgetEnv };
  assert.equal(cascadeStartupProblem(CASCADE_PROVIDER, false, ready), null);
  assert.equal(cascadeStartupProblem('nebius', true), null, 'other providers keep their existing behaviour');
  // Defence in depth: if the environment is switched after start-up, the request path still refuses.
  const calls = { local: 0, hosted: 0 };
  let adviser;
  await withEnv({ COORDINATOR_PROVIDER: 'local_openai_compatible', NEBIUS_API_KEY: TEST_KEY }, async () => {
    adviser = createFileAdviser({ nebiusBudget: createBudget({}, 'unused'), localOnly: true, legacyHostedAdviceOff: true, localModelBaseUrl: LOCAL_BASE,
      localModelName: LOCAL_MODEL, nebiusBaseUrl: NEBIUS_BASE, nebiusModel: NEBIUS_MODEL,
      localRequest: async () => { calls.local += 1; return down(); },
      hostedRequest: async () => { calls.hosted += 1; return reply(routeAnswer); } });
  });
  await withEnv(cascadeEnv, async ({ errors }) => {
    await assert.rejects(() => adviser(routeMetadata), error => error.message === 'FILE_PROVIDER_UNREACHABLE' &&
      error[ADVICE_SOURCE] === 'local_openai_compatible');
    assert.equal(calls.local, 1);
    assert.equal(calls.hosted, 0);
    assert.match(errors[0], /FILE_PROVIDER_UNREACHABLE cascade=BLOCKED_LOCAL_ONLY$/);
  });
});

test('the hosted key is never sent to the local endpoint, on any path', async () => {
  const everything = [];
  for (const local of [validAnswer, down, timedOut, http500, () => reply({ ...routeAnswer, channel: 'sms' })]) {
    await withEnv(cascadeEnv, async ({ logs, errors }) => {
      const { adviser, calls } = rig({ local });
      await adviser(routeMetadata);
      for (const call of calls.local) {
        assert.deepEqual(Object.keys(call.headers), ['content-type'], 'the local request carries no credential header');
        everything.push(JSON.stringify({ url: call.url, headers: call.headers, body: call.body }));
      }
      assert.ok(![...logs, ...errors].some(line => line.includes(TEST_KEY)), 'the key is not logged');
      if (calls.hosted.length) assert.equal(calls.hosted[0].headers.authorization, `Bearer ${TEST_KEY}`);
    });
  }
  assert.equal(everything.length, 5);
  assert.ok(everything.every(text => !text.includes(TEST_KEY) && !text.includes('Bearer')));
  assert.ok(everything.every(text => text.includes('127.0.0.1:1234')));
});

test('the hosted model receives the identical five-field projection and boundary the local model received', async () => {
  for (const [metadata, kind, keys] of [
    [routeMetadata, 'route', ['attempts', 'channels', 'snapshotVersion', 'state', 'taskAlias']],
    [followupMetadata, 'followup', ['nudgeCount', 'pickupCode', 'snapshotVersion', 'taskAlias', 'timeCode']],
  ]) {
    await withEnv(cascadeEnv, async () => {
      const { adviser, calls } = rig({ local: down });
      await adviser(metadata, kind);
      assert.equal(calls.local.length, 1);
      assert.equal(calls.hosted.length, 1);
      assert.equal(userContent(calls.hosted[0]), userContent(calls.local[0]));
      assert.deepEqual(Object.keys(JSON.parse(userContent(calls.hosted[0]))).sort(), keys);
      const system = call => call.body.messages.find(message => message.role === 'system').content;
      assert.equal(system(calls.hosted[0]), system(calls.local[0]));
      assert.equal(calls.hosted[0].body.messages.length, 2);
    });
  }
});

test('a call refused before any request is not a cascade trigger', async () => {
  await withEnv(cascadeEnv, async () => {
    // A misconfigured local endpoint is an operator error. Sending the decision elsewhere would
    // change where data goes without anyone having chosen it.
    const { adviser, calls } = rig({ localBaseUrl: 'http://169.254.169.254/v1' });
    await assert.rejects(() => adviser(routeMetadata), error => error.message === 'FILE_PROVIDER_UNAVAILABLE' && error[ADVICE_NO_RETRY] === true);
    assert.equal(calls.local.length, 0);
    assert.equal(calls.hosted.length, 0);
    const bad = rig();
    await assert.rejects(() => bad.adviser({ ...routeMetadata, state: 'UNKNOWN' }), error => error.message === 'FILE_METADATA_REJECTED');
    assert.equal(bad.calls.local.length + bad.calls.hosted.length, 0);
  });
  assert.equal(cascadeReason(Object.assign(new Error('FILE_PROVIDER_UNREACHABLE'), { [ADVICE_NO_RETRY]: true })), null);
  assert.equal(cascadeReason(Object.assign(new Error('FILE_PROVIDER_UNAVAILABLE'), {})), null);
  assert.equal(cascadeReason(Object.assign(new Error('anything'), { adviceRejected: true })), 'LOCAL_REJECTED');
  assert.equal(cascadeReason(new Error('FILE_PROVIDER_UNREACHABLE')), 'LOCAL_UNREACHABLE');
  assert.equal(cascadeReason(null), null);
});

test('every other COORDINATOR_PROVIDER value behaves as before', async () => {
  await withEnv({ COORDINATOR_PROVIDER: 'local_openai_compatible', NEBIUS_API_KEY: TEST_KEY }, async () => {
    const { adviser, calls } = rig({ local: down });
    await assert.rejects(() => adviser(routeMetadata), error => error.message === 'FILE_PROVIDER_UNREACHABLE' &&
      error[ADVICE_SOURCE] === 'local_openai_compatible');
    assert.equal(calls.hosted.length, 0, 'the local provider never falls through to the hosted one');
  });
  await withEnv({ COORDINATOR_PROVIDER: 'nebius', NEBIUS_API_KEY: TEST_KEY }, async () => {
    const { adviser, calls } = rig();
    const result = await adviser(routeMetadata);
    assert.equal(result.provider, 'nebius_token_factory');
    assert.equal(result.advice[ADVICE_SOURCE], 'nebius_token_factory');
    assert.equal(calls.local.length, 0);
    assert.equal(calls.hosted.length, 1);
    const blocked = rig({ localOnly: true });
    await assert.rejects(() => blocked.adviser(routeMetadata), error => error.message === 'FILE_EXTERNAL_INFERENCE_DISABLED');
    assert.equal(blocked.calls.hosted.length, 0);
  });
  await withEnv({ COORDINATOR_PROVIDER: undefined, NEBIUS_API_KEY: TEST_KEY }, async () => {
    const { adviser, calls } = rig();
    const result = await adviser(routeMetadata);
    assert.equal(result.provider, 'synthetic_fixture');
    assert.equal(calls.local.length + calls.hosted.length, 0);
  });
});

async function routedTask(advise, mode = 'route') {
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

test('the evidence trail records the answering outlet and the cascade marker, and nothing else', async () => {
  await withEnv(cascadeEnv, async () => {
    const { adviser } = rig({ local: down });
    const task = await routedTask(async metadata => (await adviser(metadata)).advice);
    const [entry] = taskEvidence(task).trail;
    assert.equal(entry.source, 'nebius_token_factory');
    assert.deepEqual(entry.cascade, { from: 'local_openai_compatible', reason: 'LOCAL_UNREACHABLE' });
    assert.equal(entry.answer.action, 'ROUTE');
    assert.equal(entry.realValuesInInput, 0);

    const plain = rig();
    const direct = await routedTask(async metadata => (await plain.adviser(metadata)).advice);
    const [local] = taskEvidence(direct).trail;
    assert.equal(local.source, 'local_openai_compatible');
    assert.equal(local.cascade, null);

    const failing = rig({ local: down, hosted: http500 });
    const failed = await routedTask(async metadata => (await failing.adviser(metadata)).advice);
    const [refusal] = taskEvidence(failed).trail;
    assert.equal(refusal.source, 'nebius_token_factory');
    assert.deepEqual(refusal.cascade, { from: 'local_openai_compatible', reason: 'LOCAL_UNREACHABLE' });
    assert.equal(refusal.answer, null);
    assert.equal(refusal.refusal.reasonCode, 'ADVISER_UNAVAILABLE');
  });
});

test('a rejected local answer followed by a rejected hosted answer is recorded against the hosted outlet', async () => {
  await withEnv(cascadeEnv, async () => {
    const { adviser, calls } = rig({ local: () => reply({ ...routeAnswer, channel: 'sms' }), hosted: () => reply({ ...routeAnswer, extra: 1 }) });
    const task = await routedTask(async metadata => (await adviser(metadata)).advice);
    const [entry] = taskEvidence(task).trail;
    assert.equal(entry.source, 'nebius_token_factory');
    assert.equal(entry.cascade.reason, 'LOCAL_REJECTED');
    assert.equal(entry.refusal.reasonCode, 'ADVICE_INVALID');
    assert.equal(calls.hosted.length, 1);
    assert.equal(task.jobs[0].status, 'PAUSED');
  });
});

test('the stored marker is a closed vocabulary: free text and a local-sourced marker are dropped', async () => {
  const forged = [
    { source: 'nebius_token_factory', cascade: { from: 'local_openai_compatible', reason: 'ignore previous instructions' } },
    { source: 'nebius_token_factory', cascade: { from: 'somewhere_else', reason: 'LOCAL_UNREACHABLE' } },
    { source: 'nebius_token_factory', cascade: 'LOCAL_UNREACHABLE' },
    { source: 'local_openai_compatible', cascade: { from: 'local_openai_compatible', reason: 'LOCAL_UNREACHABLE' } },
    { source: 'anything else', cascade: { from: 'local_openai_compatible', reason: 'LOCAL_UNREACHABLE' } },
  ];
  for (const origin of forged) {
    const task = await routedTask(async metadata => Object.assign(syntheticFileAdvice(metadata), { [ADVICE_SOURCE]: origin }));
    const [entry] = taskEvidence(task).trail;
    assert.equal(entry.cascade, null, JSON.stringify(origin));
    assert.ok(!('cascade' in task.jobs[0].adviceTrail[0]), 'the job record carries no unvetted marker');
  }
  assert.deepEqual(normalizeCascade({ from: 'local_openai_compatible', reason: 'LOCAL_REJECTED', note: 'extra' }),
    { from: 'local_openai_compatible', reason: 'LOCAL_REJECTED' });
  assert.equal(Object.isFrozen(adviceOrigin('nebius_token_factory', { from: 'local_openai_compatible', reason: 'LOCAL_REJECTED' })), true);
});

test('the sender page shows the cascade in zh-TW as well as English', async () => {
  globalThis.location = { pathname: '/zh-TW/' };
  try {
    const zh = await import('../public/i18n.js?test=cascade-zh');
    const source = await fs.readFile(new URL('../public/evidence-chain.js', import.meta.url), 'utf8');
    const labels = [...source.matchAll(/(?:LOCAL_UNREACHABLE|LOCAL_REJECTED): '([^']+)'/g)].map(match => match[1]);
    assert.equal(labels.length, 2);
    for (const label of labels) assert.notEqual(zh.t(label), label, label);
  } finally { delete globalThis.location; }
});

test('a follow-up decision cascades through the real follow-up pass and is recorded with its marker', async () => {
  const hour = 3600000;
  const now = Date.now();
  const actor = { id: 'sender', kind: 'operator' };
  const expiresAt = new Date(now + 40 * hour).toISOString();
  const grant = { id: 'grant', version: 1, operatorId: actor.id, recipients: ['a', 'b'], channels: ['email'],
    maxAttempts: 2, expiresAt, simulatedOutcomes: ['prepared'] };
  const config = { grants: [grant], principals: [actor, { id: 'a', kind: 'recipient' }, { id: 'b', kind: 'recipient' }] };
  const sealed = await sealFileBytes(new Uint8Array([1, 2, 3]), 'mock.csv');
  const draft = newTask(actor, grant, { documentHash: sealed.commitment, recipients: ['a', 'b'], channels: ['email'],
    expiresAt, deliveryDeadline: expiresAt, deliveryMode: 'REQUIRED_ACK', downloadUntil: null }, now);
  draft.file = { packet: sealed.packet };
  const first = confirmFirst(draft, actor, grant, 1, now);
  const approved = confirmSecond(first.task, actor, grant, 1, first.token, now);
  const prepared = await advanceFileJobs(approved, config, now);
  assert.equal(prepared.jobs[0].status, 'DRY_RUN_PREPARED');
  await withEnv(cascadeEnv, async () => {
    const { adviser, calls } = rig({ local: http500 });
    const followed = await advanceFollowups(prepared, config, now + 25 * hour,
      async metadata => (await adviser(metadata, 'followup')).advice);
    assert.equal(calls.local.length, 1);
    assert.equal(calls.hosted.length, 1);
    const entry = taskEvidence(followed).trail.find(item => item.kind === 'followup');
    assert.equal(entry.source, 'nebius_token_factory');
    assert.deepEqual(entry.cascade, { from: 'local_openai_compatible', reason: 'LOCAL_REJECTED' });
    assert.equal(entry.answer.action, followed.jobs[0].followupAdvice.action);
    assert.equal(Object.keys(entry.input).sort().join(), 'nudgeCount,pickupCode,snapshotVersion,taskAlias,timeCode');
  });
});
// ---------------------------------------------------------------------------------------------
// Red-team follow-up (2026-10-08): start-up preconditions, the file_recommend tool, the spending
// cap, stored-value allowlists, the shared deadline, provider names and unusable keys.

const hang = call => new Promise((_, reject) => {
  call.signal.addEventListener('abort', () => reject(call.signal.reason), { once: true });
});

test('the cascade refuses to start without a usable Token Factory budget (A1)', async () => {
  const ready = { legacyHostedAdviceOff: true };
  const prices = { NEBIUS_PRICE_INPUT_PER_M: '0.3', NEBIUS_PRICE_OUTPUT_PER_M: '0.9' };
  for (const [label, env] of [
    ['no budget at all', {}],
    ['a limit without prices', { NEBIUS_BUDGET_USD: '5' }],
    ['prices without a limit', prices],
    ['a zero limit', { NEBIUS_BUDGET_USD: '0', ...prices }],
    ['an unreadable limit', { NEBIUS_BUDGET_USD: 'lots', ...prices }],
    ['a zero price', { NEBIUS_BUDGET_USD: '5', ...prices, NEBIUS_PRICE_OUTPUT_PER_M: '0' }],
  ]) {
    assert.equal(tokenFactoryBudgetUsable(env), false, label);
    assert.equal(cascadeStartupProblem(CASCADE_PROVIDER, false, { ...ready, env }), 'CASCADE_REQUIRES_TOKEN_FACTORY_BUDGET', label);
    await withEnv({ ...cascadeEnv, NEBIUS_BUDGET_USD: undefined, NEBIUS_PRICE_INPUT_PER_M: undefined, NEBIUS_PRICE_OUTPUT_PER_M: undefined, ...env },
      async ({ errors }) => {
        assert.throws(() => rig(), /CASCADE_REQUIRES_TOKEN_FACTORY_BUDGET/, label);
        assert.match(errors[0], /^ERROR adviser local_then_nebius refused at start-up: CASCADE_REQUIRES_TOKEN_FACTORY_BUDGET$/);
      });
  }
  assert.equal(tokenFactoryBudgetUsable(budgetEnv), true);
  assert.equal(cascadeStartupProblem(CASCADE_PROVIDER, false, { ...ready, env: budgetEnv }), null);
  // The adviser also needs a budget object that is configured, not only the variables.
  await withEnv(cascadeEnv, async () => {
    assert.throws(() => rig({ budget: createBudget({}, path.join(ledgerDir, 'unconfigured.json')) }), /CASCADE_REQUIRES_TOKEN_FACTORY_BUDGET/);
  });
  // Other providers do not need one.
  assert.equal(cascadeStartupProblem('nebius', false, { legacyHostedAdviceOff: false, env: {} }), null);
});

test('the cascade refuses to start while the legacy hosted paths are open (A2)', async () => {
  assert.equal(cascadeStartupProblem(CASCADE_PROVIDER, false, { env: budgetEnv }), 'CASCADE_REQUIRES_LEGACY_HOSTED_ADVICE_OFF',
    'an adviser built without the switch fails closed');
  for (const legacyHostedAdviceOff of [false, null, 'off', 1, 'true']) {
    assert.equal(cascadeStartupProblem(CASCADE_PROVIDER, false, { legacyHostedAdviceOff, env: budgetEnv }),
      'CASCADE_REQUIRES_LEGACY_HOSTED_ADVICE_OFF', String(legacyHostedAdviceOff));
    await withEnv(cascadeEnv, async ({ errors }) => {
      assert.throws(() => rig({ legacyHostedAdviceOff }), /CASCADE_REQUIRES_LEGACY_HOSTED_ADVICE_OFF/, String(legacyHostedAdviceOff));
      assert.match(errors[0], /^ERROR adviser local_then_nebius refused at start-up: CASCADE_REQUIRES_LEGACY_HOSTED_ADVICE_OFF$/);
    });
  }
  // LOCAL_ONLY is reported first when both are wrong, and the legacy switch does not matter off the cascade.
  assert.equal(cascadeStartupProblem(CASCADE_PROVIDER, true, { legacyHostedAdviceOff: false, env: {} }), 'CASCADE_REQUIRES_LOCAL_ONLY_FALSE');
  assert.equal(cascadeStartupProblem('nebius', false, { legacyHostedAdviceOff: false, env: {} }), null);
  await withEnv({ ...cascadeEnv, COORDINATOR_PROVIDER: 'local_openai_compatible' }, async () => {
    assert.doesNotThrow(() => rig({ legacyHostedAdviceOff: false }));
  });
});

test('file_recommend under the cascade is answered by the local outlet alone (A1)', async () => {
  await withEnv(cascadeEnv, async ({ errors }) => {
    const { adviser, calls } = rig({ local: down });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await assert.rejects(() => adviser(routeMetadata, 'route', { hosted: false }), error =>
        error.message === 'FILE_PROVIDER_UNREACHABLE' && error[ADVICE_SOURCE] === 'local_openai_compatible');
    }
    assert.equal(calls.local.length, 5);
    assert.equal(calls.hosted.length, 0, 'five calls with the local outlet down send nothing to the hosted model');
    assert.ok(errors.every(line => line.endsWith('cascade=NO_HOSTED_FOR_TOOL')), errors.join('\n'));
    // A valid local answer is returned unchanged; the delivery worker's own calls still cascade.
    const answered = rig();
    assert.equal((await answered.adviser(routeMetadata, 'route', { hosted: false })).provider, 'local_openai_compatible');
    const worker = rig({ local: down });
    assert.equal((await worker.adviser(routeMetadata)).provider, 'nebius_token_factory');
    assert.equal(worker.calls.hosted.length, 1);
  });
});

function hostedMock() {
  const log = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      log.push({ url: req.url, authorization: req.headers.authorization });
      const projection = JSON.parse(body.messages.find(message => message.role === 'user').content);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: body.model, choices: [{ message: { content: JSON.stringify(
        'timeCode' in projection ? syntheticFollowupAdvice(projection) : syntheticFileAdvice(projection)) } }] }));
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ log, port: server.address().port,
    close: () => { server.closeAllConnections(); return new Promise(done => server.close(done)); } })));
}
async function closedPort() {
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise(resolve => probe.close(resolve));
  return port;
}
// The real server.js in a child process. Its only way out of the machine is rewritten by a preload
// to the loopback mock, and any other non-loopback address is refused.
const serverRoot = path.resolve(import.meta.dirname, '..');
const redirectPreload = '--import=data:text/javascript,' + encodeURIComponent(
  `const real = globalThis.fetch; globalThis.fetch = (input, init) => { const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);` +
  `if (url.hostname === 'api.tokenfactory.nebius.com') return real('http://127.0.0.1:' + process.env.TEST_HOSTED_PORT + url.pathname, init);` +
  `if (url.hostname !== '127.0.0.1') return Promise.reject(new TypeError('TEST_NETWORK_GUARD')); return real(input, init); };`);
async function startRealServer(extra, { hostedPort = 9, wait = true } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'enclave-cascade-e2e-'));
  const env = { PATH: process.env.PATH, HOME: dir, SKIP_LOCAL_ENV: 'true', DATA_DIR: dir, PORT: '0', HOST: '127.0.0.1',
    NODE_OPTIONS: redirectPreload, TEST_HOSTED_PORT: String(hostedPort), ...extra };
  const setup = spawn(process.execPath, ['scripts/setup-local.mjs', dir], { cwd: serverRoot, env, stdio: 'ignore' });
  assert.equal((await once(setup, 'exit'))[0], 0);
  const child = spawn(process.execPath, ['server.js'], { cwd: serverRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const run = { dir, child, out: '', err: '' };
  child.stdout.on('data', chunk => { run.out += chunk; });
  child.stderr.on('data', chunk => { run.err += chunk; });
  run.stop = async () => {
    if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    await fs.rm(dir, { recursive: true, force: true });
  };
  if (!wait) return run;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server startup timeout: ' + run.err)), 8000);
    const poll = setInterval(() => {
      const match = run.out.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearInterval(poll); clearTimeout(timer); run.base = match[0]; resolve(); }
    }, 25);
    child.once('exit', () => { clearInterval(poll); clearTimeout(timer); reject(new Error('Server exited: ' + run.err)); });
  });
  return run;
}

test('the real server will not start the cascade without LEGACY_HOSTED_ADVICE=off or a budget (A1, A2)', async () => {
  const base = { LOCAL_ONLY: 'false', COORDINATOR_PROVIDER: CASCADE_PROVIDER, NEBIUS_API_KEY: TEST_KEY, ...budgetEnv };
  for (const [label, extra, code] of [
    ['legacy switch missing', { LEGACY_HOSTED_ADVICE: undefined }, 'CASCADE_REQUIRES_LEGACY_HOSTED_ADVICE_OFF'],
    ['legacy switch misspelled', { LEGACY_HOSTED_ADVICE: 'OFF' }, 'CASCADE_REQUIRES_LEGACY_HOSTED_ADVICE_OFF'],
    ['no budget', { LEGACY_HOSTED_ADVICE: 'off', NEBIUS_BUDGET_USD: undefined }, 'CASCADE_REQUIRES_TOKEN_FACTORY_BUDGET'],
  ]) {
    const env = Object.fromEntries(Object.entries({ ...base, ...extra }).filter(([, value]) => value !== undefined));
    const run = await startRealServer(env, { wait: false });
    try {
      const exited = await Promise.race([once(run.child, 'exit'), new Promise(resolve => setTimeout(resolve, 8000, null))]);
      assert.ok(exited, `${label}: the server must not come up`);
      assert.notEqual(exited[0], 0, label);
      assert.match(run.err, new RegExp(`ERROR adviser local_then_nebius refused at start-up: ${code}`), label);
      assert.ok(!run.err.includes(TEST_KEY), 'the key is not printed');
    } finally { await run.stop(); }
  }
});

test('the real server: file_recommend never reaches the hosted model, and everything else on the trail is recorded (A1, A2)', async () => {
  const hosted = await hostedMock();
  const run = await startRealServer({ LOCAL_ONLY: 'false', COORDINATOR_PROVIDER: CASCADE_PROVIDER, NEBIUS_API_KEY: TEST_KEY, ...budgetEnv,
    LEGACY_HOSTED_ADVICE: 'off', LOCAL_MODEL_BASE_URL: `http://127.0.0.1:${await closedPort()}/v1` }, { hostedPort: hosted.port });
  try {
    const tokens = {};
    for (const id of ['operator', 'coordinator']) tokens[id] = (await fs.readFile(path.join(run.dir, `${id}.token`), 'utf8')).trim();
    const call = async (url, body, id = 'operator') => {
      const response = await fetch(run.base + url, { method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens[id]}` }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, body: await response.json().catch(() => ({})) };
    };
    const sealed = await sealFileBytes(new TextEncoder().encode('MOCK_ONLY,1\r\n'), 'x.csv');
    const staged = await call('/api/file-tasks', { authorizationId: 'local-review', recipients: ['recipient-a'], channels: ['email'],
      expiresAt: new Date(Date.now() + 3600000).toISOString(), packet: sealed.packet, documentKey: Buffer.from(sealed.key).toString('hex') });
    assert.equal(staged.status, 201);
    const url = `/api/tasks/${staged.body.task.id}`;
    const first = await call(url + '/confirm-first', { version: 1 });
    assert.equal((await call(url + '/confirm-second', { version: 1, token: first.body.token })).status, 200);
    let view;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 100));
      view = await call(url);
      if (view.body.task.jobs[0]?.status !== 'PENDING_CHECK') break;
    }
    assert.notEqual(view.body.task.jobs[0].status, 'PENDING_CHECK');
    // The worker's decision went through the cascade, once, and is on the trail with its marker.
    assert.equal(hosted.log.length, 1);
    assert.equal(hosted.log[0].authorization, `Bearer ${TEST_KEY}`);
    const trail = (await call(url + '/evidence')).body.evidence.trail;
    assert.deepEqual(trail.map(entry => [entry.source, entry.cascade?.reason]), [['nebius_token_factory', 'LOCAL_UNREACHABLE']]);
    // Five coordinator recommendations with the local outlet down: no hosted request, no trail entry.
    const alias = JSON.parse(await fs.readFile(path.join(run.dir, 'tasks.json'), 'utf8')).find(task => task.id === staged.body.task.id).snapshots[0].privateMapping.taskAlias;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await call('/api/coordinator/call', { tool: 'file_recommend', arguments: { taskAlias: alias, snapshotVersion: 1 } }, 'coordinator');
      assert.notEqual(response.status, 200, 'the local outlet is down, so there is no recommendation to give');
    }
    assert.equal(hosted.log.length, 1, 'file_recommend sent nothing to the hosted model');
    assert.equal((await call(url + '/evidence')).body.evidence.trail.length, 1);
    // The legacy path is closed as well.
    const policy = await call('/api/policy/recommend', { policyMetadata: {} });
    assert.equal(policy.status, 200);
    assert.equal(policy.body.policy.provider, 'demo_fallback');
    assert.equal(hosted.log.length, 1);
    assert.ok(!run.out.includes(TEST_KEY) && !run.err.includes(TEST_KEY));
  } finally { await run.stop(); await hosted.close(); }
});

test('a refusal by the spending cap with budget left is treated like a spent budget (A3)', async () => {
  const file = path.join(ledgerDir, 'nearly-spent.json');
  await fs.writeFile(file, JSON.stringify({ spentUsd: 0.0049 }));
  const small = { NEBIUS_BUDGET_USD: '0.005', NEBIUS_PRICE_INPUT_PER_M: '0.3', NEBIUS_PRICE_OUTPUT_PER_M: '0.9' };
  const budget = createBudget(small, file);
  assert.equal(await budget.exhausted(), false, 'the ledger is below the limit, so only the reservation can refuse');
  await withEnv({ ...cascadeEnv, ...small }, async ({ logs, errors }) => {
    const { adviser, calls } = rig({ local: down, budget });
    for (const [metadata, kind] of [[routeMetadata, 'route'], [followupMetadata, 'followup']]) {
      const result = await adviser(metadata, kind);
      assert.equal(result.provider, 'synthetic_fixture', kind);
      assert.deepEqual(result.advice[ADVICE_SOURCE], { source: 'synthetic_fixture',
        cascade: { from: 'local_openai_compatible', reason: 'LOCAL_UNREACHABLE' } }, kind);
    }
    assert.equal(calls.hosted.length, 0, 'the cap refused before anything was sent');
    assert.ok(errors.some(line => /nebius .* FILE_PROVIDER_UNREACHABLE cascade=LOCAL_UNREACHABLE NEBIUS_BUDGET_EXHAUSTED$/.test(line)), errors.join('\n'));
    assert.ok(logs.every(line => / cascade=LOCAL_UNREACHABLE$/.test(line)));
    assert.match(logs[0], /^adviser route synthetic_fixture - \d+ms ROUTE APPROVED_CHANNEL cascade=LOCAL_UNREACHABLE$/);
  });
  // Through the worker: the delivery is decided and recorded, not retried and paused.
  await withEnv({ ...cascadeEnv, ...small }, async () => {
    const { adviser } = rig({ local: down, budget });
    const task = await routedTask(async metadata => (await adviser(metadata)).advice);
    const [entry] = taskEvidence(task).trail;
    assert.equal(entry.source, 'synthetic_fixture');
    assert.deepEqual(entry.cascade, { from: 'local_openai_compatible', reason: 'LOCAL_UNREACHABLE' });
    assert.equal(entry.answer.action, 'ROUTE');
    assert.equal(task.jobs[0].status, 'DRY_RUN_PREPARED');
  });
  // A hosted failure that is not the cap (a 500) is still a hosted failure.
  await withEnv(cascadeEnv, async () => {
    const { adviser } = rig({ local: down, hosted: http500 });
    await assert.rejects(() => adviser(routeMetadata), error => error[ADVICE_SOURCE].source === 'nebius_token_factory');
  });
});

test('taskEvidence shows only allowlisted outlets and drops a marker that does not belong (A4)', async () => {
  const marker = { from: 'local_openai_compatible', reason: 'LOCAL_UNREACHABLE' };
  const task = await routedTask();
  const stored = task.jobs[0].adviceTrail;
  stored.length = 0;
  const entry = (source, cascade) => ({ kind: 'route', at: new Date().toISOString(), source, ...(cascade ? { cascade } : {}),
    input: { ...routeMetadata }, answer: { action: 'PAUSE' }, refusal: null });
  stored.push(entry('nebius_token_factory', marker), entry('synthetic_fixture', marker), entry('local_openai_compatible', marker),
    entry('local_openai_compatible'), entry(null, marker), entry(undefined, marker),
    ...['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 'something else', '<img src=x onerror=1>'].map(name => entry(name, marker)),
    entry({ toString: () => 'nebius_token_factory' }, marker), entry(['nebius_token_factory'], marker), entry(7, marker));
  const seen = taskEvidence(task).trail.map(item => [item.source, item.cascade]);
  assert.deepEqual(seen.slice(0, 6), [
    ['nebius_token_factory', marker], ['synthetic_fixture', marker], ['local_openai_compatible', null],
    ['local_openai_compatible', null], [null, null], [null, null]]);
  assert.ok(seen.slice(6).every(([source, cascade]) => source === null && cascade === null), JSON.stringify(seen.slice(6)));
  assert.equal(seen.length, stored.length);
});

test('the sender page reads outlet and cascade labels as own properties only (A4)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'enclave-evidence-dom-'));
  try {
    let code = await fs.readFile(new URL('../public/evidence-chain.js', import.meta.url), 'utf8');
    code = code.replace("from './auth.js'", "from './auth-stub.mjs'").replace("from './i18n.js'", "from './i18n-stub.mjs'");
    await fs.writeFile(path.join(dir, 'evidence-chain.mjs'), code);
    await fs.writeFile(path.join(dir, 'auth-stub.mjs'), 'export const authenticatedFetch = async () => ({ ok: true, json: async () => ({ evidence: globalThis.__evidence }) });');
    await fs.writeFile(path.join(dir, 'i18n-stub.mjs'), 'export const isChinese = false; export const t = value => value;' +
      "export function setText(node, value) { node.textContent = typeof value === 'function' ? value() : value; }");
    class Node_ {
      constructor(tag) { this.tag = tag; this.children = []; this.text = ''; this.className = ''; this.value = ''; this.options = []; this.disabled = false; this.listeners = {}; }
      set textContent(value) { this.text = String(value); this.children = []; }
      get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
      append(...nodes) { this.children.push(...nodes); }
      replaceChildren(...nodes) { this.children = nodes; this.text = ''; }
      addEventListener(name, handler) { this.listeners[name] = handler; }
    }
    const nodes = { '#evidenceTask': new Node_('select'), '#evidenceBtn': new Node_('button'), '#evidenceChain': new Node_('div'), '#evidenceStatus': new Node_('p') };
    globalThis.document = { querySelector: selector => nodes[selector], createElement: tag => new Node_(tag), createTextNode: text => Object.assign(new Node_('#text'), { text }) };
    globalThis.window = { addEventListener() {} };
    const entry = (source, reason) => ({ kind: 'route', at: '2026-10-08T00:00:00Z', source, cascade: reason ? { from: 'local_openai_compatible', reason } : null,
      input: {}, answer: { action: 'PAUSE' }, refusal: null, realValuesInInput: 0 });
    globalThis.__evidence = { taskId: 't', version: 1, status: 'PAUSED', reasonCode: null,
      approved: { recipients: [], channels: [], deliveryMode: null, deliveryDeadline: null, documentHash: 'h' }, mapping: { taskAlias: 'a', recipients: [] },
      trail: [entry('nebius_token_factory', 'LOCAL_UNREACHABLE'), entry('constructor', 'toString'), entry('__proto__', '__proto__'),
        entry('toString', 'hasOwnProperty'), entry('valueOf', 'valueOf'), entry(7, 7)],
      followups: [], mappedBack: { channel: null, recipients: [] }, keyReleases: [], receipts: [] };
    await import(path.join(dir, 'evidence-chain.mjs'));
    nodes['#evidenceTask'].value = 'task';
    nodes['#evidenceBtn'].disabled = false;
    await nodes['#evidenceBtn'].listeners.click();
    const metas = [];
    const walk = node => { if (node.className === 'evidence-meta') metas.push(node.textContent); node.children.forEach(walk); };
    walk(nodes['#evidenceChain']);
    assert.equal(metas.length, 12, 'one line for what was sent and one for the answer, six entries');
    assert.match(metas[0], /^Routing · Token Factory · After the local model gave no answer · /);
    assert.match(metas[6], /^Routing · Token Factory · After the local model gave no answer · /);
    for (const line of [...metas.slice(1, 6), ...metas.slice(7)]) {
      assert.match(line, /^Routing · Outlet not recorded · /, line);
      assert.ok(!/function|Object|\[object/.test(line), line);
    }
  } finally {
    delete globalThis.document;
    delete globalThis.window;
    delete globalThis.__evidence;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a cascaded call is bounded by one deadline across both outlets (A5)', async () => {
  await withEnv(cascadeEnv, async () => {
    // Both outlets stall until aborted: local may use 75% of the deadline, hosted the rest.
    const stalled = rig({ local: hang, hosted: hang, cascadeDeadlineMs: 800 });
    const started = performance.now();
    await assert.rejects(() => stalled.adviser(routeMetadata), error => error.message === 'FILE_PROVIDER_UNREACHABLE');
    const elapsed = performance.now() - started;
    assert.equal(stalled.calls.local.length, 1);
    assert.equal(stalled.calls.hosted.length, 1);
    assert.ok(elapsed >= 700 && elapsed < 1300, `one deadline, not the sum of two timeouts: ${Math.round(elapsed)}ms`);
    // A local stall still leaves the hosted outlet its remaining time, and it answers.
    const slow = rig({ local: hang, cascadeDeadlineMs: 800 });
    const answered = await slow.adviser(routeMetadata);
    assert.equal(answered.provider, 'nebius_token_factory');
    assert.equal(answered.advice[ADVICE_SOURCE].cascade.reason, 'LOCAL_UNREACHABLE');
    // A fast local failure leaves the hosted outlet its own 5 s limit; it is not cut to the local share.
    const failFast = rig({ local: down, hosted: hang, cascadeDeadlineMs: 800 });
    const begun = performance.now();
    await assert.rejects(() => failFast.adviser(routeMetadata), error => error.message === 'FILE_PROVIDER_UNREACHABLE');
    assert.ok(performance.now() - begun < 1000, 'the hosted call is cut at the deadline');
  });
  // The default is the 10 s a single local call is allowed.
  const { CASCADE_DEADLINE_MS } = await import('../file-adviser-outlet.js');
  assert.equal(CASCADE_DEADLINE_MS, 10000);
});

test('provider names that exist on every object are refused as unknown, once, without a retry (A6)', async () => {
  for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 'Nebius', 'nebius ', 'local-then-nebius']) {
    await withEnv({ COORDINATOR_PROVIDER: name, NEBIUS_API_KEY: TEST_KEY }, async ({ errors }) => {
      const { adviser, calls } = rig();
      assert.equal(errors.filter(line => line.startsWith('WARN adviser COORDINATOR_PROVIDER ')).length, 1, `${name}: one start-up warning`);
      assert.ok(!errors[0].includes(TEST_KEY));
      await assert.rejects(() => adviser(routeMetadata), error => error.message === 'FILE_PROVIDER_UNAVAILABLE' && error[ADVICE_NO_RETRY] === true, name);
      assert.equal(calls.local.length + calls.hosted.length, 0, name);
      assert.equal(errors.filter(line => line.startsWith('WARN')).length, 1, 'the warning is not repeated per call');
      const task = await routedTask(async metadata => (await adviser(metadata)).advice);
      assert.equal(task.jobs[0].status, 'PAUSED', name);
      assert.equal(task.jobs[0].adviceRetries, undefined, `${name}: not retried`);
      assert.equal(task.jobs[0].nextAdviceAt, undefined, name);
    });
  }
  // The request function itself, without the outlet around it.
  for (const provider of ['constructor', '__proto__', 'toString']) {
    await assert.rejects(() => requestFileAdvice(routeMetadata, { provider, localOnly: false, baseUrl: LOCAL_BASE, model: LOCAL_MODEL },
      async () => { throw new Error('must not be called'); }), { message: 'FILE_PROVIDER_UNAVAILABLE' }, provider);
  }
  await assert.rejects(() => requestFileAdvice(routeMetadata, { kind: 'constructor', provider: 'synthetic_fixture' }), { message: 'FILE_ADVICE_KIND_UNKNOWN' });
  // Known values and an unset variable stay silent and keep working.
  for (const known of [...KNOWN_PROVIDERS, undefined, '']) {
    await withEnv({ ...cascadeEnv, COORDINATOR_PROVIDER: known }, async ({ errors }) => {
      rig();
      assert.deepEqual(errors, [], String(known));
    });
  }
});

test('a hosted key that cannot be an HTTP header is a configuration failure that is not retried (A8)', async () => {
  const bad = { 'CRLF': TEST_KEY + '\r\nX-Injected: 1', 'non-Latin-1': TEST_KEY + '☃', 'LF': TEST_KEY + '\n' };
  for (const [label, key] of Object.entries(bad)) {
    await withEnv({ COORDINATOR_PROVIDER: 'nebius', NEBIUS_API_KEY: key, ...budgetEnv }, async ({ logs, errors }) => {
      const { adviser, calls } = rig();
      await assert.rejects(() => adviser(routeMetadata), error => error.message === 'FILE_PROVIDER_UNAVAILABLE' && error[ADVICE_NO_RETRY] === true, label);
      assert.equal(calls.hosted.length, 0, label);
      assert.ok(![...logs, ...errors].some(line => line.includes(TEST_KEY)), `${label}: the key is not logged`);
    });
    await withEnv({ ...cascadeEnv, NEBIUS_API_KEY: key }, async ({ logs, errors }) => {
      const { adviser, calls } = rig({ local: down });
      await assert.rejects(() => adviser(routeMetadata), error => error.message === 'FILE_PROVIDER_UNREACHABLE' &&
        error[ADVICE_SOURCE] === 'local_openai_compatible', label);
      assert.equal(calls.hosted.length, 0, `${label}: nothing was sent to the hosted endpoint`);
      assert.ok(![...logs, ...errors].some(line => line.includes(TEST_KEY)), `${label}: the key is not logged`);
    });
  }
  // The environment cannot carry a NUL, so that case is checked on the request function itself.
  await assert.rejects(() => requestFileAdvice(routeMetadata, { provider: 'nebius', localOnly: false, baseUrl: NEBIUS_BASE, model: NEBIUS_MODEL,
    apiKey: TEST_KEY + '\u0000' }, async () => { throw new Error('must not be called'); }), error => error.message === 'FILE_PROVIDER_UNAVAILABLE' &&
    !JSON.stringify(error).includes(TEST_KEY) && !error.message.includes(TEST_KEY));
  // A key with surrounding spaces or a Latin-1 letter is still a header value, so it is still sent.
  await withEnv({ ...cascadeEnv, NEBIUS_API_KEY: ` ${TEST_KEY}é ` }, async () => {
    const { adviser, calls } = rig({ local: down });
    await adviser(routeMetadata);
    assert.equal(calls.hosted.length, 1);
  });
});

test('the status labels say what the cascade really does, in every state (A7)', async () => {
  globalThis.location = { pathname: '/zh-TW/' };
  try {
    const zh = await import('../public/i18n.js?test=cascade-state');
    const base = { ok: true, adviserProvider: CASCADE_PROVIDER, localOnly: false, nebiusConfigured: true, nebiusBudget: { limited: true, exhausted: false } };
    assert.equal(zh.cascadeState(base), 'ready');
    assert.equal(zh.cascadeState({ ...base, nebiusBudget: { limited: true, exhausted: true } }), 'budget_spent');
    assert.equal(zh.cascadeState({ ...base, nebiusConfigured: false }), 'no_key');
    assert.equal(zh.cascadeState({ ...base, localOnly: true }), 'no_key');
    assert.equal(zh.cascadeState({ ...base, nebiusConfigured: false, nebiusBudget: { limited: false } }), 'no_key');
    for (const provider of ['nebius', 'local_openai_compatible', 'synthetic_fixture', undefined, 'constructor']) {
      assert.equal(zh.cascadeState({ ...base, adviserProvider: provider }), null, String(provider));
    }
    assert.equal(zh.cascadeState(null), null);
    // Every cascade label the two pages can show has its own zh-TW text, and none of them claims the
    // local model is not called.
    const labels = new Set();
    for (const file of ['app.js', 'audit.js']) {
      const source = await fs.readFile(new URL(`../public/${file}`, import.meta.url), 'utf8');
      for (const match of source.matchAll(/'((?:Cascade outlet|Local model first|Local model only)[^']*)'/g)) labels.add(match[1]);
    }
    assert.equal(labels.size, 6, [...labels].join('\n'));
    for (const label of labels) {
      assert.notEqual(zh.t(label), label, label);
      assert.ok(!/沒有呼叫真實模型|不呼叫模型|本機模擬/.test(zh.t(label)), zh.t(label));
    }
    assert.ok(!/No model is called|Local simulation/.test([...labels].join()));
  } finally { delete globalThis.location; }
});

test('no test in this file let a request escape to a non-loopback host', () => {
  assert.deepEqual(escaped, []);
});
