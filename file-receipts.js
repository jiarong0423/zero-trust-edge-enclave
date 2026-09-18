import { fail } from './access-control.js';
import { queueAudit } from './audit-outbox.js';
import { normalizeDownloadPolicy } from './download-policy.js';
import { compareGroupCodes } from './private-mapping.js';

const RECEIPT_CODES = ['DOWNLOAD_REQUESTED', 'FILE_VERIFIED', 'ACKNOWLEDGED'];

export function recipientReceiptStatus(task, principal, version) {
  const snapshot = task.snapshots.find(item => item.version === version);
  if (principal.kind !== 'recipient' || !snapshot || snapshot.status !== 'APPROVED' ||
      !snapshot.content.recipients.includes(principal.id)) fail('Receipt access denied');
  const released = (task.fileKeyReleases || []).some(entry => entry.version === version && entry.subject === principal.id);
  const reported = code => released && (task.fileReceipts || []).some(entry => entry.version === version &&
    entry.subject === principal.id && entry.code === code && entry.evidence === 'CLIENT_REPORTED');
  return { version, fileVerified: reported('FILE_VERIFIED'), downloadReported: reported('DOWNLOAD_REQUESTED'),
    acknowledged: reported('ACKNOWLEDGED'), evidence: 'CLIENT_REPORTED', provesReading: false };
}

export function recordOverdueDeliveries(task, now = Date.now()) {
  if (!task.file) return task;
  let result = task;
  for (const snapshot of task.snapshots) {
    if (snapshot.status !== 'APPROVED' || (result.deliveryEscalations || []).some(entry => entry.version === snapshot.version) ||
        receiptSummary(task, snapshot.version, now).deliveryState !== 'ESCALATION_REQUIRED') continue;
    result = queueAudit({ ...result, deliveryEscalations: [...(result.deliveryEscalations || []),
      { version: snapshot.version, code: 'DELIVERY_OVERDUE', at: new Date(now).toISOString() }] },
      [{ taskId: task.id, snapshotVersion: snapshot.version, type: 'DELIVERY_TRANSITION', result: 'DENY', reasons: ['DELIVERY_OVERDUE'] }]);
  }
  return result;
}

export function recordFileReceipt(task, principal, version, code, now = Date.now()) {
  const snapshot = task.snapshots.find(item => item.version === version);
  if (principal.kind !== 'recipient' || !snapshot || snapshot.status !== 'APPROVED' ||
      !snapshot.content.recipients.includes(principal.id)) fail('Receipt access denied');
  if (!RECEIPT_CODES.includes(code)) fail('Invalid receipt code', 422);
  if (!(task.fileKeyReleases || []).some(entry => entry.version === version && entry.subject === principal.id)) fail('Key release required before receipt');
  const receipts = task.fileReceipts || [];
  if (code === 'ACKNOWLEDGED' && !receipts.some(entry => entry.version === version && entry.subject === principal.id && entry.code === 'FILE_VERIFIED')) {
    fail('Verified file required before acknowledgement', 409);
  }
  const existing = receipts.find(entry => entry.version === version && entry.subject === principal.id && entry.code === code);
  if (existing) return { task, receipt: existing };
  const receipt = { subject: principal.id, version, code, reportedAt: new Date(now).toISOString(), evidence: 'CLIENT_REPORTED' };
  return { task: { ...task, fileReceipts: [...receipts, receipt] }, receipt };
}

export function receiptSummary(task, version, now = Date.now()) {
  const snapshot = task.snapshots.find(item => item.version === version);
  const recipients = new Set(snapshot?.content.recipients || []);
  const released = new Set((task.fileKeyReleases || []).filter(entry =>
    entry.version === version && recipients.has(entry.subject)).map(entry => entry.subject));
  // One predicate for every receipt question in this function. A report only counts when the
  // subject actually took a key, the evidence is a client report, and the code is one we issue;
  // keeping these three conditions in a single place is what stops the variants from drifting.
  const evidenceFor = (subject, codes = RECEIPT_CODES) => (task.fileReceipts || []).filter(entry =>
    entry.version === version && entry.evidence === 'CLIENT_REPORTED' &&
    released.has(entry.subject) && codes.includes(entry.code) &&
    (subject === null || entry.subject === subject));
  const reports = evidenceFor(null, ['DOWNLOAD_REQUESTED']);
  const dates = reports.map(entry => Date.parse(entry.reportedAt)).filter(Number.isFinite);
  const count = code => new Set(evidenceFor(null, [code]).map(entry => entry.subject)).size;
  const acknowledgedCount = count('ACKNOWLEDGED');
  const policy = normalizeDownloadPolicy(snapshot.content);
  const receiptState = recipients.size > 0 && acknowledgedCount === recipients.size ? 'ACKNOWLEDGED' : 'AWAITING_ACKNOWLEDGEMENT';
  const downloadWindowState = policy.deliveryMode === 'REQUIRED_ACK' ? 'NO_DOWNLOAD_CUTOFF'
    : now >= Date.parse(policy.downloadUntil) ? 'WINDOW_CLOSED' : 'WINDOW_OPEN';
  const deliveryDeadline = snapshot?.content.deliveryDeadline || snapshot?.content.expiresAt || null;
  const deliveryState = receiptState === 'ACKNOWLEDGED' ? 'ACKNOWLEDGED'
    : policy.deliveryMode === 'TIME_LIMITED' ? (downloadWindowState === 'WINDOW_CLOSED' ? 'WINDOW_CLOSED' : receiptState)
    : Number.isFinite(Date.parse(deliveryDeadline)) && now >= Date.parse(deliveryDeadline) ? 'ESCALATION_REQUIRED' : receiptState;
  // Per-recipient rows for the sender only. The sender approved this exact list and already sees it
  // in the snapshot, so naming them here reveals nothing new; the recipient-facing status stays in
  // recipientReceiptStatus, which reports only the caller's own row.
  const reported = (subject, code) => evidenceFor(subject, [code]).length > 0;
  const reportedAt = subject => {
    const times = evidenceFor(subject).map(entry => Date.parse(entry.reportedAt)).filter(Number.isFinite);
    return times.length ? new Date(Math.max(...times)).toISOString() : null;
  };
  const codeOf = subject => snapshot?.privateMapping?.recipients
    ?.find(entry => entry.recipientId === subject)?.groupCode ?? null;
  const perRecipient = [...recipients].map(subject => ({
    recipientId: subject, groupCode: codeOf(subject), keyReleased: released.has(subject),
    downloadReported: reported(subject, 'DOWNLOAD_REQUESTED'),
    fileVerified: reported(subject, 'FILE_VERIFIED'),
    acknowledged: reported(subject, 'ACKNOWLEDGED'),
    lastReportedAt: reportedAt(subject)
  })).sort((left, right) => compareGroupCodes(left.groupCode ?? 'Z999', right.groupCode ?? 'Z999'));

  return { recipients: perRecipient, recipientCount: recipients.size, keyRecipientCount: released.size,
    deliveryMode: policy.deliveryMode, downloadUntil: policy.downloadUntil, downloadWindowState, receiptState,
    verifiedReportCount: count('FILE_VERIFIED'), acknowledgedCount, deliveryDeadline, deliveryState,
    downloadReportCount: new Set(reports.map(entry => entry.subject)).size,
    lastReportedAt: dates.length ? new Date(Math.max(...dates)).toISOString() : null,
    evidence: 'CLIENT_REPORTED', provesReading: false };
}
