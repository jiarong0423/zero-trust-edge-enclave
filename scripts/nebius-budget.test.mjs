import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBudget } from '../nebius-budget.js';

const env = { NEBIUS_BUDGET_USD: '0.01', NEBIUS_PRICE_INPUT_PER_M: '1', NEBIUS_PRICE_OUTPUT_PER_M: '2' };
const reply = usage => async () => new Response(JSON.stringify({ usage, choices: [] }), { status: 200 });
const call = (budget, request, maxTokens = 100) =>
  budget.fetch('https://example.invalid/v1/chat/completions', { body: JSON.stringify({ max_tokens: maxTokens }) }, request);

test('budget is unlimited only when no ceiling is configured', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'enclave-budget-'));
  const open = createBudget({}, path.join(dir, 'spend.json'));
  assert.equal(await open.exhausted(), false);
  assert.deepEqual(await open.status(), { limited: false });
  const unpriced = createBudget({ NEBIUS_BUDGET_USD: '20' }, path.join(dir, 'spend.json'));
  assert.equal(await unpriced.exhausted(), true);
  let sent = false;
  await assert.rejects(call(unpriced, async () => { sent = true; }), /NEBIUS_BUDGET_EXHAUSTED/);
  assert.equal(sent, false);
});

test('budget settles to reported usage, persists, and refuses before crossing the ceiling', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'enclave-budget-'));
  const file = path.join(dir, 'spend.json');
  const budget = createBudget(env, file);
  await call(budget, reply({ prompt_tokens: 1000, completion_tokens: 1000 }));
  assert.equal((await budget.status()).spentUsd, 0.003);
  const restarted = createBudget(env, file);
  assert.equal((await restarted.status()).spentUsd, 0.003);
  await call(restarted, reply({ prompt_tokens: 2000, completion_tokens: 2000 }));
  assert.equal((await restarted.status()).spentUsd, 0.009);
  let sent = false;
  await assert.rejects(call(restarted, async () => { sent = true; }, 1000), /NEBIUS_BUDGET_EXHAUSTED/);
  assert.equal(sent, false);
});

test('budget keeps the worst case when usage is missing or the call breaks, and charges nothing for HTTP errors', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'enclave-budget-'));
  const budget = createBudget({ ...env, NEBIUS_BUDGET_USD: '5' }, path.join(dir, 'spend.json'));
  await call(budget, async () => new Response('{}', { status: 500 }));
  assert.equal((await budget.status()).spentUsd, 0);
  await call(budget, reply(undefined), 100);
  const body = Buffer.byteLength(JSON.stringify({ max_tokens: 100 }));
  assert.equal((await budget.status()).spentUsd, Math.round((body * 1 + 100 * 2)) / 1e6);
  await assert.rejects(call(budget, async () => { throw new Error('reset'); }, 100), /reset/);
  assert.equal((await budget.status()).spentUsd, Math.round(2 * (body * 1 + 100 * 2)) / 1e6);
});
