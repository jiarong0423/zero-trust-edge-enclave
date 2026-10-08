import { resumableReasons } from './task-operations.js';
import { receiptSummary } from './file-receipts.js';

export function senderTask(task) {
  return { id: task.id, authorizationId: task.grantId, hasFile: Boolean(task.file), snapshots: task.snapshots.map(snapshot => ({
    taskAlias: snapshot.privateMapping?.taskAlias,
    version: snapshot.version, status: snapshot.status, content: snapshot.content,
    hash: snapshot.hash, confirmedAt: snapshot.confirmedAt, approvedAt: snapshot.approvedAt,
    revokedAt: snapshot.revokedAt
  })), jobs: task.jobs.map(job => ({ version: job.version, status: job.status, attempts: job.attempts,
    revision: job.revision || 0, reasonCode: job.reasonCode || null, updatedAt: job.updatedAt || null,
    adviceRetries: job.adviceRetries || 0,
    canRequestResume: Boolean(task.file && job.status === 'PAUSED' && resumableReasons.has(job.reasonCode)),
    ...(task.file ? { receiptSummary: receiptSummary(task, job.version) } : {}) })) };
}
