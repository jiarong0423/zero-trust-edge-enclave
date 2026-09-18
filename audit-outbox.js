import crypto from 'node:crypto';
import { auditProjection } from './audit-boundary.js';

export function queueAudit(record, events) {
  return { ...record, auditOutbox: [...(record.auditOutbox || []), ...events.map(event => ({
    ...auditProjection({ ...event, createdAt: new Date().toISOString() }), id: crypto.randomUUID()
  }))] };
}

// Append must deduplicate event ids before acknowledging; a crash may replay this batch.
export async function flushAuditOutbox(records, append, persist) {
  if (!records.some(record => record.auditOutbox?.length)) return;
  let current = structuredClone(records);
  for (let index = 0; index < current.length; index += 1) {
    while (current[index].auditOutbox?.length) {
      await append(current[index].auditOutbox[0]);
      const next = structuredClone(current);
      next[index].auditOutbox.shift();
      await persist(next);
      current = next;
    }
  }
}
