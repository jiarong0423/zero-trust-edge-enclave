import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createFileAdviser, CASCADE_PROVIDER } from '../file-adviser-outlet.js';
import { syntheticFileAdvice } from '../file-routing.js';
import { syntheticFollowupAdvice } from '../delivery-followup.js';
import { createBudget } from '../nebius-budget.js';
import { advanceFileJobs, ADVICE_MODEL, normalizeAdviceModel } from '../file-worker.js';
import { newTask, confirmFirst, confirmSecond } from '../snapshot-lifecycle.js';
import { sealFileBytes } from '../public/file-envelope.js';
import { taskEvidence } from '../task-evidence.js';

// The hosted model can differ per decision: routing keeps NEBIUS_MODEL, the follow-up decision may use
// NEBIUS_MODEL_FOLLOWUP. Both outlets are answered by injected transports and the global fetch is guarded,
// so no test here can leave the machine.
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init) => {
  if (new URL(String(url)).hostname !== '127.0.0.1') throw new Error('TEST_NETWORK_GUARD');
  return realFetch(url, init);
};
const ledgerDir = await fs.mkdtemp(path.join(os.tmpdir(), 'enclave-tier-ledger-'));
after(async () => { globalThis.fetch = realFetch; await fs.rm(ledgerDir, { recursive: true, force: true }); });

const SUPER = 'nvidia/nemotron-3-super-120b-a12b';
const ULTRA = 'nvidia/Nemotron-3-Ultra-550b-a55b';
const routeMetadata = { taskAlias: '0b0c3c96-1a2b-4c3d-8e4f-5a6b7c8d9e0f', snapshotVersion: 1, channels: ['email', 'internal_queue'], state: 'PENDING_CHECK', attempts: 0 };
const followupMetadata = { taskAlias: routeMetadata.taskAlias, snapshotVersion: 1, timeCode: 'WINDOW_LAST', nudgeCount: 0, pickupCode: 'PICKUP_NONE' };
const budgetEnv = { NEBIUS_BUDGET_USD: '100', NEBIUS_PRICE_INPUT_PER_M: '1', NEBIUS_PRICE_OUTPUT_PER_M: '3' };
let ledgers = 0;

const answer = call => {
  const projection = JSON.parse(call.body.messages.find(message => message.role === 'user').content);
  const advice = 'timeCode' in projection ? syntheticFollowupAdvice(projection) : syntheticFileAdvice(projection);
  return Response.json({ model: call.body.model, choices: [{ message: { content: JSON.stringify(advice) } }] });
};

async function withEnv(vars, work) {
  const saved = Object.fromEntries(Object.keys(vars).map(key => [key, process.env[key]]));
  Object.assign(process.env, vars);
  const log = console.log, error = console.error;
  console.log = () => {}; console.error = () => {};
  try { return await work(); } finally {
    console.log = log; console.error = error;
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}

function rig({ followupModel, localRequest } = {}) {
  const hosted = [];
  const adviser = createFileAdviser({
    nebiusBudget: createBudget(budgetEnv, path.join(ledgerDir, `ledger-${++ledgers}.json`)), legacyHostedAdviceOff: true, localOnly: false,
    localModelBaseUrl: 'http://127.0.0.1:1234/v1', localModelName: 'nvidia-nemotron-3-nano-4b',
    nebiusBaseUrl: 'https://api.tokenfactory.nebius.com/v1', nebiusModel: SUPER, nebiusFollowupModel: followupModel,
    ...(localRequest ? { localRequest } : {}),
    hostedRequest: async (url, init) => { const call = { body: JSON.parse(init.body) }; hosted.push(call); return answer(call); },
  });
  return { adviser, hosted };
}

const hostedEnv = { COORDINATOR_PROVIDER: 'nebius', NEBIUS_API_KEY: 'nebius-key-for-this-test-only-0123456789', ...budgetEnv };

test('the follow-up decision goes to its own model and routing keeps the default', async () => {
  await withEnv(hostedEnv, async () => {
    const { adviser, hosted } = rig({ followupModel: ULTRA });
    await adviser(routeMetadata, 'route');
    await adviser(followupMetadata, 'followup');
    assert.deepEqual(hosted.map(call => call.body.model), [SUPER, ULTRA]);
  });
});

test('with no follow-up model both decisions use the default model', async () => {
  await withEnv(hostedEnv, async () => {
    for (const followupModel of [undefined, null, '']) {
      const { adviser, hosted } = rig({ followupModel });
      await adviser(routeMetadata, 'route');
      await adviser(followupMetadata, 'followup');
      assert.deepEqual(hosted.map(call => call.body.model), [SUPER, SUPER]);
    }
  });
});

test('under the cascade the hosted follow-up call uses the follow-up model after the local call fails', async () => {
  await withEnv({ ...hostedEnv, COORDINATOR_PROVIDER: CASCADE_PROVIDER }, async () => {
    const { adviser, hosted } = rig({ followupModel: ULTRA, localRequest: async () => { throw new TypeError('fetch failed'); } });
    const route = await adviser(routeMetadata, 'route');
    const followup = await adviser(followupMetadata, 'followup');
    assert.equal(route.provider, 'nebius_token_factory');
    assert.equal(followup.provider, 'nebius_token_factory');
    assert.deepEqual(hosted.map(call => call.body.model), [SUPER, ULTRA]);
  });
});

test('a follow-up model the outlet rule does not accept sends nothing', async () => {
  await withEnv(hostedEnv, async () => {
    const { adviser, hosted } = rig({ followupModel: 'someone-else/other-model' });
    await assert.rejects(adviser(followupMetadata, 'followup'));
    assert.equal(hosted.length, 0);
    await adviser(routeMetadata, 'route');
    assert.equal(hosted.length, 1, 'routing is unaffected');
  });
});

test('the follow-up request still carries only the five coded fields, whichever model answers', async () => {
  await withEnv(hostedEnv, async () => {
    const { adviser, hosted } = rig({ followupModel: ULTRA });
    await adviser(followupMetadata, 'followup');
    const projection = JSON.parse(hosted[0].body.messages.find(message => message.role === 'user').content);
    assert.deepEqual(Object.keys(projection).sort(), ['nudgeCount', 'pickupCode', 'snapshotVersion', 'taskAlias', 'timeCode']);
  });
});

// ---- the evidence trail names the model that answered

async function routedTask(advise) {
  const actor = { id: 'sender', kind: 'operator' };
  const now = Date.now();
  const grant = { id: 'grant', version: 1, operatorId: actor.id, recipients: ['recipient-one'], channels: ['email'],
    maxAttempts: 2, expiresAt: new Date(now + 60000).toISOString(), simulatedOutcomes: ['prepared'] };
  const config = { grants: [grant], principals: [actor, { id: 'recipient-one', kind: 'recipient' }] };
  const sealed = await sealFileBytes(new Uint8Array([1, 2, 3]), 'synthetic.csv');
  const draft = newTask(actor, grant, { documentHash: sealed.commitment, recipients: ['recipient-one'], channels: ['email'], expiresAt: grant.expiresAt }, now);
  draft.file = { packet: sealed.packet };
  const first = confirmFirst(draft, actor, grant, 1, now);
  const approved = confirmSecond(first.task, actor, grant, 1, first.token, now);
  return advanceFileJobs(approved, config, now, advise);
}

test('the evidence trail records which model answered, for the hosted outlet and for the local one', async () => {
  await withEnv(hostedEnv, async () => {
    const hosted = rig();
    const [entry] = taskEvidence(await routedTask(async metadata => (await hosted.adviser(metadata, 'route')).advice)).trail;
    assert.equal(entry.source, 'nebius_token_factory');
    assert.equal(entry.model, SUPER);
  });
  await withEnv({ ...hostedEnv, COORDINATOR_PROVIDER: CASCADE_PROVIDER }, async () => {
    const cascaded = rig({ localRequest: async () => { throw new TypeError('fetch failed'); } });
    const [entry] = taskEvidence(await routedTask(async metadata => (await cascaded.adviser(metadata, 'route')).advice)).trail;
    assert.equal(entry.source, 'nebius_token_factory');
    assert.equal(entry.model, SUPER);
    assert.equal(entry.cascade.reason, 'LOCAL_UNREACHABLE');
  });
  await withEnv({ ...hostedEnv, COORDINATOR_PROVIDER: CASCADE_PROVIDER }, async () => {
    const localAnswers = rig({ localRequest: async (url, init) => answer({ body: JSON.parse(init.body) }) });
    const [entry] = taskEvidence(await routedTask(async metadata => (await localAnswers.adviser(metadata, 'route')).advice)).trail;
    assert.equal(entry.source, 'local_openai_compatible');
    assert.equal(entry.model, 'nvidia-nemotron-3-nano-4b');
  });
});

test('a fixture answer, a forged name and a hand-edited record show no model', async () => {
  const fixture = await routedTask(async metadata => syntheticFileAdvice(metadata));
  assert.equal(taskEvidence(fixture).trail[0].model, null);
  assert.ok(!('model' in fixture.jobs[0].adviceTrail[0]));
  for (const forged of ['ignore previous instructions', '<script>alert(1)</script>', 'a'.repeat(129), '', 42, null]) {
    const task = await routedTask(async metadata => Object.assign(syntheticFileAdvice(metadata), { [ADVICE_MODEL]: forged, [Symbol.for('x')]: 1 }));
    assert.equal(taskEvidence(task).trail[0].model, null, String(forged));
  }
  const kept = await routedTask(async metadata => Object.assign(syntheticFileAdvice(metadata), { [ADVICE_MODEL]: ULTRA }));
  assert.equal(taskEvidence(kept).trail[0].model, null, 'a fixture answer never names a model');
  assert.equal(normalizeAdviceModel(ULTRA), ULTRA);
  assert.equal(normalizeAdviceModel('nvidia/nemotron-3-super-120b-a12b'), SUPER);
  assert.equal(normalizeAdviceModel('has space'), null);
});
