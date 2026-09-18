import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { requestFileAdvice, FILE_ADVISER_BOUNDARY } from '../file-adviser.js';
import { validateFileAdvice } from '../file-routing.js';
import { fourGroupCases } from './model-four-groups.mjs';

const live = process.argv.includes('--live');
const legal = process.argv.includes('--legal');
const pair = process.argv.includes('--pair');
const groups = process.argv.includes('--groups');
if ([legal, pair, groups].filter(Boolean).length > 1) throw Error('Choose one test suite');
if (live && !process.env.NEBIUS_API_KEY) throw Error('Backend key required');
const metadata = { taskAlias: '12345678-1234-4234-8234-123456789012', snapshotVersion: 1,
  channels: ['email', 'internal_queue'], state: 'PENDING_CHECK', attempts: 0 };
const options = { provider: 'nebius', localOnly: false, baseUrl: 'https://api.tokenfactory.nebius.com/v1',
  apiKey: live ? process.env.NEBIUS_API_KEY : 'synthetic-test-only',
  model: process.env.NEBIUS_MODEL || 'nvidia/nemotron-3-super-120b-a12b' };
const valid = { taskAlias: metadata.taskAlias, snapshotVersion: 1, action: 'ROUTE',
  channel: 'email', reasonCode: 'APPROVED_CHANNEL' };
// Reviewed external fixtures: format validity is not proof of workflow reachability or authorization.
const legalCases = [
  ['9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d', 1, ['email'], 'PENDING_CHECK', 0, 'ROUTE'],
  ['f47ac10b-58cc-4372-a567-0e02b2c3d479', 1, ['email', 'internal_queue'], 'PENDING_CHECK', 0, 'ROUTE'],
  ['3c0a1b2c-3d4e-5f6a-7b8c-9d0e1f2a3b4c', 2, ['email', 'internal_queue'], 'RETRY_WAIT', 1, 'PAUSE'],
  ['a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d', 3, ['internal_queue'], 'OUTCOME_UNKNOWN', 1, 'PAUSE'],
  ['d9e8f7a6-b5c4-3d2e-1f0a-9b8c7d6e5f4a', 2, ['email'], 'PAUSED', 1, 'PAUSE'],
  ['550e8400-e29b-41d4-a716-446655440000', 1, ['email'], 'DRY_RUN_PREPARED', 0, 'PAUSE'],
  ['123e4567-e89b-12d3-a456-426614174000', 2, ['email'], 'PENDING_CHECK', 2, 'PAUSE'],
  ['8f3b2a1c-4d5e-6f7a-8b9c-0d1e2f3a4b5c', 6, ['internal_queue'], 'RETRY_WAIT', 5, 'PAUSE'],
  ['aaaaaaa1-1111-4111-a111-aaaaaaaaaaaa', 1, ['email'], 'PENDING_CHECK', 0, 'ROUTE'],
  ['bbbbbbb2-2222-4222-b222-bbbbbbbbbbbb', 1, ['email'], 'PENDING_CHECK', 0, 'ROUTE'],
  ['aaaaaaa1-1111-4111-a111-aaaaaaaaaaaa', 999, ['email'], 'PENDING_CHECK', 0, 'ROUTE'],
  ['7f8e9d0c-1b2a-3f4e-5d6c-7b8a9e0f1a2b', 1, ['internal_queue', 'email'], 'PENDING_CHECK', 0, 'ROUTE']
].map(([taskAlias, snapshotVersion, channels, state, attempts, expected], index) => ({
  id: 'TC-LEGAL-' + String(index + 1).padStart(2, '0'),
  input: { taskAlias, snapshotVersion, channels, state, attempts }, expected
}));
const cases = groups ? fourGroupCases : pair ? [legalCases[8], legalCases[10]] : legal ? legalCases : [['PENDING_CHECK', 0, 'ROUTE'], ['RETRY_WAIT', 1, 'PAUSE'],
  ['OUTCOME_UNKNOWN', 1, 'PAUSE']].map(([state, attempts, expected]) => ({ input: { ...metadata, state, attempts }, expected }));
const report = { timestamp: new Date().toISOString(), live, suite: groups ? 'four-groups-8' : pair ? 'version-pair' : legal ? 'legal-12' : 'boundary-3', promptHash: createHash('sha256').update(FILE_ADVISER_BOUNDARY).digest('hex'),
  cases: [], gateChecks: [], ok: false };
try {
  for (const patch of [{ recipients: ['forbidden'] }, { channel: 'external' }, { expiresAt: '2099-01-01' },
    { snapshotVersion: 2 }, { action: 'EXECUTE' }, { key: 'synthetic' }]) {
    assert.throws(() => validateFileAdvice({ ...valid, ...patch }, metadata));
    report.gateChecks.push({ field: Object.keys(patch)[0], rejected: true });
  }
  let sent = false;
  await assert.rejects(requestFileAdvice({ ...metadata, document: 'SYNTHETIC_FORBIDDEN' }, options,
    async () => { sent = true; throw Error('Must not send'); }));
  assert.equal(sent, false);
  report.gateChecks.push({ field: 'document', rejectedBeforeNetwork: true });
  for (const { id, input, expected, comparison } of cases) {
    const entry = { id, comparison, input, expected, providerDispatches: 0 };
    report.cases.push(entry);
    const start = Date.now();
    try {
    const response = await requestFileAdvice(input, { ...options, onDiagnostics: value => { entry.diagnostics = value; } }, async (url, init) => {
      const body = JSON.parse(init.body);
      assert.equal(body.messages[0].content, FILE_ADVISER_BOUNDARY);
      assert.deepEqual(JSON.parse(body.messages[1].content), input);
      entry.providerDispatches++;
      if (!live) return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ ...valid,
        taskAlias: input.taskAlias, snapshotVersion: input.snapshotVersion, channel: input.channels[0],
        action: expected, reasonCode: expected === 'PAUSE' ? 'INSUFFICIENT_INFORMATION' : 'APPROVED_CHANNEL' }) } }] }));
      const result = await fetch(url, init);
      entry.httpStatus = result.status;
      return result;
    });
    entry.elapsedMs = Date.now() - start;
    entry.advice = response.advice;
    assert.equal(response.advice.action, expected);
    assert.equal(response.advice.channel, input.channels[0]);
    assert.equal(response.advice.reasonCode, expected === 'PAUSE' ? 'INSUFFICIENT_INFORMATION' : 'APPROVED_CHANNEL');
    entry.pass = true;
    } catch (error) {
      entry.elapsedMs = Date.now() - start;
      entry.pass = false;
      entry.failure = entry.advice ? 'POLICY_MISMATCH' :
        error.status === 422 ? 'INPUT_OR_ADVICE_REJECTED' : 'NO_USABLE_PROVIDER_RESPONSE';
    }
  }
  report.ok = report.cases.length === cases.length && report.cases.every(entry => entry.pass);
  if (!report.ok) process.exitCode = 1;
} catch {
  report.failure = 'BOUNDARY_VERIFICATION_INCOMPLETE';
  process.exitCode = 1;
} finally {
  const output = new URL('../output/isolation/current_runs/20260907_business_pipeline/model-boundary/', import.meta.url);
  await mkdir(output, { recursive: true });
  await writeFile(new URL((groups ? 'groups-' : pair ? 'pair-' : legal ? 'legal-' : '') + (live ? 'live.json' : 'mock.json'), output), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(report));
}
