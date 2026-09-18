import test from 'node:test';
import assert from 'node:assert/strict';
import { queueAudit, flushAuditOutbox } from '../audit-outbox.js';

test('audit write failure and acknowledgement failure retain replayable, private-free events', async () => {
  const initial = queueAudit({ state: 'APPROVED' }, [{ type: 'SNAPSHOT_TRANSITION', result: 'INFO',
    previousState: 'LOCKED', nextState: 'APPROVED', attempts: 0, snapshotVersion: 1,
    reasons: ['STATE_CHANGED'], plaintext: 'PRIVATE_CANARY', credential: 'PRIVATE_CANARY' }]);
  assert.ok(!JSON.stringify(initial).includes('PRIVATE_CANARY'));
  let stored = [initial];
  await assert.rejects(flushAuditOutbox(stored, async () => { throw new Error('disk unavailable'); }, async rows => { stored = rows; }));
  assert.equal(stored[0].auditOutbox.length, 1);
  const audit = new Map();
  const append = async event => { if (!audit.has(event.id)) audit.set(event.id, event); };
  await assert.rejects(flushAuditOutbox(stored, append, async () => { throw new Error('ack failed'); }));
  assert.equal(audit.size, 1);
  await flushAuditOutbox(structuredClone(stored), append, async rows => { stored = rows; });
  assert.equal(audit.size, 1);
  assert.equal(stored[0].auditOutbox.length, 0);
  assert.equal(stored[0].state, 'APPROVED');
});
