import test from 'node:test';
import assert from 'node:assert/strict';
import { fileRetention, retentionInventory } from '../retention-policy.js';

const completed = () => ({ id: 'task', file: { packet: { ciphertext: 'PRIVATE_CANARY' }, wrappedKey: 'KEY_CANARY' },
  snapshots: [{ version: 1, status: 'APPROVED', content: { recipients: ['recipient'], expiresAt: new Date(1000).toISOString(),
    deliveryMode: 'REQUIRED_ACK' } }], jobs: [{ version: 1, status: 'DRY_RUN_PREPARED' }],
  fileKeyReleases: [{ version: 1, subject: 'recipient' }], fileReceipts: [{ version: 1, subject: 'recipient',
    code: 'ACKNOWLEDGED', evidence: 'CLIENT_REPORTED' }] });

test('retention candidates require completed delivery and closed access; expiry alone never purges', () => {
  const task = completed();
  const original = JSON.stringify(task);
  assert.equal(fileRetention(task, 999).state, 'RETAIN');
  const candidate = fileRetention(task, 1000);
  assert.equal(candidate.state, 'CLEANUP_CANDIDATE');
  assert.equal(candidate.taskAndReceiptHistory, 'RETAIN');
  assert.equal(candidate.automaticDeletion, false);
  for (const [change, reason] of [
    [{ fileReceipts: [] }, 'KEEP_UNDELIVERED'],
    [{ auditOutbox: [{}] }, 'KEEP_PENDING_AUDIT'],
    [{ fileAccessTickets: [{ expiresAt: 3000, used: false }] }, 'KEEP_ACTIVE_CREDENTIAL'],
    [{ jobs: [{ status: 'OUTCOME_UNKNOWN' }] }, 'KEEP_UNRESOLVED_JOB']
  ]) {
    const result = fileRetention({ ...task, ...change }, 2000);
    assert.equal(result.state, 'RETAIN');
    assert.ok(result.reasons.includes(reason));
  }
  const draft = completed(); draft.snapshots.push({ version: 2, status: 'DRAFT' });
  assert.ok(fileRetention(draft, 2000).reasons.includes('KEEP_DRAFT'));
  const unreceived = completed(); unreceived.fileReceipts = []; unreceived.snapshots[0].revokedAt = new Date(900).toISOString();
  assert.ok(fileRetention(unreceived, 5000).reasons.includes('KEEP_UNDELIVERED'));
  assert.equal(fileRetention({ id: 'unknown', file: {} }, 2000).state, 'RETAIN');
  assert.equal(JSON.stringify(task), original);
  const view = retentionInventory([task, unreceived], 2000);
  assert.equal(view.candidateCount, 1);
  assert.equal(view.retainedCount, 1);
  assert.ok(!JSON.stringify(view).includes('CANARY'));
});
