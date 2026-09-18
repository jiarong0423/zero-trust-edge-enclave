import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateMapping } from '../private-mapping.js';
import { fileRoutingMetadata, syntheticFileAdvice, validateFileAdvice } from '../file-routing.js';

test('file routing exposes only approved codes and rejects stale or expanded advice', () => {
  const content = { recipients: ['PRIVATE_PERSON_CANARY'], channels: ['internal_queue', 'email'] };
  const snapshot = { version: 2, content,
    privateMapping: createPrivateMapping('PRIVATE_TASK_CANARY', 2, content), key: 'PRIVATE_KEY_CANARY' };
  const metadata = fileRoutingMetadata(snapshot, { status: 'RETRY_WAIT', attempts: 1, error: 'PRIVATE_ERROR_CANARY' });
  assert.ok(!JSON.stringify(metadata).includes('PRIVATE_'));
  assert.deepEqual(Object.keys(metadata).sort(), ['attempts', 'channels', 'snapshotVersion', 'state', 'taskAlias']);
  const advice = syntheticFileAdvice(metadata);
  assert.equal(advice.channel, 'email');
  assert.deepEqual(validateFileAdvice(advice, metadata), advice);
  for (const change of [{ channel: 'https://attacker.invalid' }, { recipient: 'extra' }, { snapshotVersion: 1 },
    { taskAlias: 'another-task' }, { action: 'EXECUTE' }, { credential: 'forbidden' }]) {
    assert.throws(() => validateFileAdvice({ ...advice, ...change }, metadata));
  }
});

