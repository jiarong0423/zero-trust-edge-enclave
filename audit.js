import crypto from 'node:crypto';
import { auditProjection } from './audit-boundary.js';
import { flushAuditOutbox } from './audit-outbox.js';
import { findArchivedAudit, retainAuditWindow } from './audit-retention.js';
import { hashJson } from './value-helpers.js';
import { currentRequest } from './request-context.js';

// Audit ordering contract (see docs/agent/server-split-plan.md, risks 2 and 3):
//   appendAudit reads the chain, links previousHash, then writes through retainAuditWindow;
//   recoverAudit flushes a record's outbox AFTER the caller has written that record;
//   auditRejection records at most one REQUEST_REJECTED per request (rejectionRecorded).
// `readJson` and `writeJson` are the server's existing store wrappers, passed in unchanged.
export function createAudit({ auditsPath, readJson, writeJson }) {
  async function appendAudit(event) {
    const audits = await readJson(auditsPath, []);
    const prior = event.id && (audits.find(item => item.id === event.id) || await findArchivedAudit(auditsPath, event.id));
    if (prior) return prior;
    const previousHash = audits.at(-1)?.eventHash || null;
    const entry = {
      ...auditProjection({ ...currentRequest()?.auditTarget, ...event }),
      id: event.id || crypto.randomUUID(),
      createdAt: event.createdAt || new Date().toISOString(),
      previousHash
    };
    entry.eventHash = hashJson(entry);
    audits.push(entry);
    await retainAuditWindow(auditsPath, audits);
    return entry;
  }

  async function recoverAudit(file) {
    const records = await readJson(file, []);
    await flushAuditOutbox(records, appendAudit, next => writeJson(file, next));
  }

  async function auditRejection(error) {
    const target = currentRequest()?.auditTarget || {};
    if (!currentRequest()?.principal || currentRequest().rejectionRecorded) return;
    currentRequest().rejectionRecorded = true;
    const reason = error.status === 409 ? 'STATE_CONFLICT' : error.status === 422 ? 'INVALID_REQUEST'
      : error.status >= 500 ? 'SERVICE_UNAVAILABLE' : 'ACCESS_DENIED';
    await appendAudit({ type: 'REQUEST_REJECTED', result: 'DENY', reasons: [reason], nextState: target.previousState });
  }

  return { appendAudit, recoverAudit, auditRejection };
}
