import test from 'node:test';
import assert from 'node:assert/strict';
import { recordFileReceipt, receiptSummary, recordOverdueDeliveries } from '../file-receipts.js';

test('late acknowledgement does not grant access, complete receipt differs from download and deadlines persist', () => {
  const actor = { id: 'a', kind: 'recipient' };
  let task = { id: '12345678-1234-4234-8234-123456789012', file: {},
    snapshots: [{ version: 1, status: 'APPROVED', content: { deliveryMode: 'REQUIRED_ACK', recipients: ['a', 'b'], expiresAt: new Date(2000).toISOString(), deliveryDeadline: new Date(1000).toISOString() } }],
    fileKeyReleases: [{ subject: 'a', version: 1 }, { subject: 'b', version: 1 }] };
  assert.throws(() => recordFileReceipt(task, { ...actor, id: 'foreign' }, 1, 'FILE_VERIFIED'));
  assert.throws(() => recordFileReceipt({ ...task, fileKeyReleases: [] }, actor, 1, 'FILE_VERIFIED'));
  assert.throws(() => recordFileReceipt(task, actor, 1, 'ACKNOWLEDGED'));
  task = recordFileReceipt(task, actor, 1, 'DOWNLOAD_REQUESTED', 900).task;
  assert.equal(receiptSummary(task, 1, 999).deliveryState, 'AWAITING_ACKNOWLEDGEMENT');
  assert.equal(receiptSummary(task, 1, 1000).deliveryState, 'ESCALATION_REQUIRED');
  task = recordOverdueDeliveries(task, 1000);
  assert.equal(task.deliveryEscalations.length, 1);
  assert.equal(recordOverdueDeliveries(task, 1500), task);
  task = recordFileReceipt(task, actor, 1, 'FILE_VERIFIED', 3000).task;
  task = recordFileReceipt(task, actor, 1, 'ACKNOWLEDGED', 3000).task;
  assert.equal(recordFileReceipt(task, actor, 1, 'ACKNOWLEDGED', 4000).task, task);
  assert.equal(receiptSummary(task, 1, 4000).deliveryState, 'ESCALATION_REQUIRED');
  task = recordFileReceipt(task, { ...actor, id: 'b' }, 1, 'FILE_VERIFIED', 4000).task;
  task = recordFileReceipt(task, { ...actor, id: 'b' }, 1, 'ACKNOWLEDGED', 4000).task;
  const summary = receiptSummary(task, 1, 4000);
  assert.equal(summary.deliveryState, 'ACKNOWLEDGED');
  assert.equal(summary.acknowledgedCount, 2);
  assert.equal(summary.provesReading, false);
  assert.equal(task.snapshots[0].content.expiresAt, new Date(2000).toISOString());
  assert.equal(task.fileKeyReleases.length, 2);
});

test('timed cutoff and acknowledgement remain independent, without mission-delivery escalation', () => {
  const task = { id: '12345678-1234-4234-8234-123456789012', file: {}, snapshots: [{ version: 1, status: 'APPROVED',
    content: { recipients: ['a'], deliveryMode: 'TIME_LIMITED', downloadUntil: new Date(1000).toISOString(),
      deliveryDeadline: new Date(500).toISOString(), expiresAt: new Date(2000).toISOString() } }],
    fileKeyReleases: [{ subject: 'a', version: 1 }], fileReceipts: [] };
  assert.equal(receiptSummary(task, 1, 999).downloadWindowState, 'WINDOW_OPEN');
  const expired = receiptSummary(task, 1, 1000);
  assert.equal(expired.downloadWindowState, 'WINDOW_CLOSED');
  assert.equal(expired.receiptState, 'AWAITING_ACKNOWLEDGEMENT');
  assert.equal(expired.deliveryState, 'WINDOW_CLOSED');
  assert.equal(recordOverdueDeliveries(task, 1000), task);
  const person = { id: 'a', kind: 'recipient' };
  const verified = recordFileReceipt(task, person, 1, 'FILE_VERIFIED', 1100).task;
  const received = recordFileReceipt(verified, person, 1, 'ACKNOWLEDGED', 1100).task;
  const final = receiptSummary(received, 1, 1100);
  assert.equal(final.receiptState, 'ACKNOWLEDGED');
  assert.equal(final.downloadWindowState, 'WINDOW_CLOSED');
  assert.equal(final.deliveryState, 'ACKNOWLEDGED');
});

test('the sender sees which individual recipients have downloaded, not only a count', () => {
  const content = { recipients: ['sales-a', 'sales-b', 'fin-a'], channels: ['email'],
    expiresAt: new Date(9000).toISOString(), deliveryDeadline: new Date(9000).toISOString(), deliveryMode: 'REQUIRED_ACK' };
  const mapping = { recipients: [
    { recipientId: 'sales-a', groupCode: 'B1' },
    { recipientId: 'sales-b', groupCode: 'B2' },
    { recipientId: 'fin-a', groupCode: 'A1' }] };
  const task = {
    id: 't', file: {}, snapshots: [{ version: 1, status: 'APPROVED', content, privateMapping: mapping }], jobs: [],
    fileKeyReleases: [{ version: 1, subject: 'sales-a', at: new Date(100).toISOString() },
      { version: 1, subject: 'fin-a', at: new Date(120).toISOString() }],
    fileReceipts: [
      { version: 1, subject: 'sales-a', code: 'DOWNLOAD_REQUESTED', evidence: 'CLIENT_REPORTED', reportedAt: new Date(200).toISOString() },
      { version: 1, subject: 'sales-a', code: 'FILE_VERIFIED', evidence: 'CLIENT_REPORTED', reportedAt: new Date(210).toISOString() },
      { version: 1, subject: 'fin-a', code: 'DOWNLOAD_REQUESTED', evidence: 'CLIENT_REPORTED', reportedAt: new Date(300).toISOString() }]
  };
  const rows = receiptSummary(task, 1, 500).recipients;

  assert.deepEqual(rows.map(row => row.groupCode), ['A1', 'B1', 'B2']);
  const byCode = Object.fromEntries(rows.map(row => [row.groupCode, row]));
  assert.equal(byCode.B1.downloadReported, true);
  assert.equal(byCode.B1.fileVerified, true);
  assert.equal(byCode.B1.acknowledged, false);
  assert.equal(byCode.A1.downloadReported, true);
  assert.equal(byCode.A1.fileVerified, false);
  // sales-b never took a key, so it reports nothing at all rather than a stale or assumed state.
  assert.equal(byCode.B2.keyReleased, false);
  assert.equal(byCode.B2.downloadReported, false);
  assert.equal(byCode.B2.lastReportedAt, null);
  // A report without a key release is never counted as a download.
  const forged = { ...task, fileReceipts: [...task.fileReceipts,
    { version: 1, subject: 'sales-b', code: 'DOWNLOAD_REQUESTED', evidence: 'CLIENT_REPORTED', reportedAt: new Date(400).toISOString() }] };
  assert.equal(receiptSummary(forged, 1, 500).recipients.find(row => row.groupCode === 'B2').downloadReported, false);
});

test('sender receipt rows order a group of ten by position, not by text', () => {
  const ids = Array.from({ length: 12 }, (_, index) => 'sales-' + (index + 1));
  const content = { recipients: ids, channels: ['email'], expiresAt: new Date(9000).toISOString(),
    deliveryDeadline: new Date(9000).toISOString(), deliveryMode: 'REQUIRED_ACK' };
  const mapping = { recipients: ids.map((recipientId, index) => ({ recipientId, groupCode: 'A' + (index + 1) })) };
  const task = { id: 't', file: {}, jobs: [], fileKeyReleases: [], fileReceipts: [],
    snapshots: [{ version: 1, status: 'APPROVED', content, privateMapping: mapping }] };
  assert.deepEqual(receiptSummary(task, 1, 500).recipients.map(row => row.groupCode),
    ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9', 'A10', 'A11', 'A12']);
});

test('a report without a key release leaks no timestamp either', () => {
  const content = { recipients: ['a', 'b'], channels: ['email'], expiresAt: new Date(9000).toISOString(),
    deliveryDeadline: new Date(9000).toISOString(), deliveryMode: 'REQUIRED_ACK' };
  const task = { id: 't', file: {}, jobs: [], fileKeyReleases: [],
    snapshots: [{ version: 1, status: 'APPROVED', content,
      privateMapping: { recipients: [{ recipientId: 'a', groupCode: 'A1' }, { recipientId: 'b', groupCode: 'A2' }] } }],
    fileReceipts: [{ version: 1, subject: 'b', code: 'DOWNLOAD_REQUESTED', evidence: 'CLIENT_REPORTED', reportedAt: new Date(400).toISOString() }] };
  const row = receiptSummary(task, 1, 500).recipients.find(entry => entry.recipientId === 'b');
  assert.equal(row.downloadReported, false);
  assert.equal(row.lastReportedAt, null, 'every flag reads false, so the timestamp must not survive');
});
