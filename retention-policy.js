import { receiptSummary } from './file-receipts.js';
import { downloadAccessDeadline } from './download-policy.js';

export function fileRetention(task, now = Date.now()) {
  const reasons = [];
  try {
    if (!task.file) reasons.push('KEEP_NON_FILE_RECORD');
    if (!Array.isArray(task.snapshots) || !task.snapshots.length || !Array.isArray(task.jobs)) throw Error('Invalid task');
    if (task.snapshots.some(snapshot => ['DRAFT', 'LOCKED'].includes(snapshot.status))) reasons.push('KEEP_DRAFT');
    const approved = task.snapshots.filter(snapshot => snapshot.status === 'APPROVED');
    if (!approved.length) reasons.push('KEEP_UNAPPROVED');
    if (task.jobs.some(job => !['DRY_RUN_PREPARED', 'REVOKED'].includes(job.status))) reasons.push('KEEP_UNRESOLVED_JOB');
    if (approved.some(snapshot => receiptSummary(task, snapshot.version, now).receiptState !== 'ACKNOWLEDGED')) reasons.push('KEEP_UNDELIVERED');
    if (approved.some(snapshot => !snapshot.revokedAt && downloadAccessDeadline(snapshot.content) > now)) reasons.push('KEEP_ACTIVE_ACCESS');
    if ((task.fileAccessTickets || []).some(ticket => !ticket.used && ticket.expiresAt > now)) reasons.push('KEEP_ACTIVE_CREDENTIAL');
    if (task.auditOutbox?.length) reasons.push('KEEP_PENDING_AUDIT');
  } catch { reasons.push('KEEP_UNKNOWN_STATE'); }
  return { taskId: task.id, state: reasons.length ? 'RETAIN' : 'CLEANUP_CANDIDATE', reasons,
    fileAndWrappedKey: reasons.length ? 'RETAIN' : 'REVIEW_TOGETHER', taskAndReceiptHistory: 'RETAIN', automaticDeletion: false };
}

export function retentionInventory(tasks, now = Date.now()) {
  const items = tasks.map(task => fileRetention(task, now));
  return { asOf: new Date(now).toISOString(), automaticDeletion: false, auditHistory: 'RETAIN_ARCHIVED', directoryHistory: 'RETAIN',
    retainedCount: items.filter(item => item.state === 'RETAIN').length,
    candidateCount: items.filter(item => item.state === 'CLEANUP_CANDIDATE').length, items };
}
