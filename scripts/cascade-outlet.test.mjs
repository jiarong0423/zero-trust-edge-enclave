import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createFileAdviser, cascadeReason, cascadeStartupProblem, CASCADE_PROVIDER } from '../file-adviser-outlet.js';
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
after(() => { globalThis.fetch = realFetch; });

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

function rig({ local = validAnswer, hosted = validAnswer, localOnly = false, budget, realLocal = false, localBaseUrl = LOCAL_BASE } = {}) {
  const calls = { local: [], hosted: [] };
  const record = (list, responder) => async (url, init) => {
    const call = { url: String(url), headers: init.headers, body: JSON.parse(init.body) };
    list.push(call);
    return responder(call);
  };
  const adviser = createFileAdviser({
    nebiusBudget: budget || createBudget({}, path.join(os.tmpdir(), 'cascade-test-unused-ledger.json')),
    localOnly, localModelBaseUrl: localBaseUrl, localModelName: LOCAL_MODEL, nebiusBaseUrl: NEBIUS_BASE, nebiusModel: NEBIUS_MODEL,
    ...(realLocal ? {} : { localRequest: record(calls.local, local) }),
    hostedRequest: record(calls.hosted, hosted),
  });
  return { adviser, calls };
}

const cascadeEnv = { COORDINATOR_PROVIDER: CASCADE_PROVIDER, NEBIUS_API_KEY: TEST_KEY };
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
  await withEnv({ COORDINATOR_PROVIDER: CASCADE_PROVIDER, NEBIUS_API_KEY: undefined }, async ({ errors }) => {
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
  assert.equal(cascadeStartupProblem(CASCADE_PROVIDER, false), null);
  assert.equal(cascadeStartupProblem('nebius', true), null, 'other providers keep their existing behaviour');
  // Defence in depth: if the environment is switched after start-up, the request path still refuses.
  const calls = { local: 0, hosted: 0 };
  let adviser;
  await withEnv({ COORDINATOR_PROVIDER: 'local_openai_compatible', NEBIUS_API_KEY: TEST_KEY }, async () => {
    adviser = createFileAdviser({ nebiusBudget: createBudget({}, 'unused'), localOnly: true, localModelBaseUrl: LOCAL_BASE,
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

test('no test in this file let a request escape to a non-loopback host', () => {
  assert.deepEqual(escaped, []);
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
