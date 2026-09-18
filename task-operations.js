import { activeGrant, fail } from './access-control.js';
import { dispatchSnapshot } from './snapshot-lifecycle.js';
import { principalEnabled } from './registry-schema.js';
import { packetCommitment } from './public/file-envelope.js';
import { queueAudit } from './audit-outbox.js';

export const resumableReasons = new Set(['ADVISER_UNAVAILABLE', 'ADVICE_INVALID', 'ADVICE_PAUSED', 'RECIPIENT_DISABLED', 'ACTOR_DISABLED']);

export async function resumeFileTask(original, actor, config, version, expectedRevision, now = Date.now()) {
  if (actor.kind !== 'operator' || original.ownerId !== actor.id || !principalEnabled(config, actor)) fail('Task unavailable', 404);
  if (!original.file) fail('File task required', 409);
  const task = structuredClone(original);
  const job = task.jobs.find(item => item.version === version);
  if (!job || !Number.isSafeInteger(expectedRevision) || expectedRevision !== (job.revision || 0)) fail('JOB_REVISION_CONFLICT', 409);
  if (job.status !== 'PAUSED' || !resumableReasons.has(job.reasonCode)) fail('JOB_NOT_RESUMABLE', 409);
  const grant = activeGrant(config, task.grantId);
  const snapshot = dispatchSnapshot(task, grant, version, now);
  if ((job.delivery?.attempts || job.attempts || 0) >= grant.maxAttempts ||
      ['DRY_RUN_PREPARED', 'OUTCOME_UNKNOWN', 'PAUSED'].includes(job.delivery?.status)) fail('JOB_NOT_RESUMABLE', 409);
  if (snapshot.content.recipients.some(id => !config.principals.some(person => person.id === id &&
      person.kind === 'recipient' && principalEnabled(config, person)))) fail('RECIPIENT_DISABLED');
  if (await packetCommitment(task.file.packet) !== snapshot.content.documentHash) fail('PACKET_CHANGED', 409);
  job.status = job.delivery ? 'RETRY_WAIT' : 'PENDING_CHECK';
  job.reasonCode = null;
  job.revision = expectedRevision + 1;
  job.updatedAt = new Date(now).toISOString();
  return queueAudit(task, [{ taskId: task.id, snapshotVersion: version, type: 'DELIVERY_TRANSITION',
    previousState: 'PAUSED', nextState: job.status, attempts: job.attempts, result: 'INFO', reasons: ['RESUME_VALIDATED'] }]);
}
