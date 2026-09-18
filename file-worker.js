import { dispatchSnapshot } from './snapshot-lifecycle.js';
import { advanceDelivery, activeGrant } from './access-control.js';
import { downloadAccessDeadline } from './download-policy.js';
import { resolvePrivateRoute } from './private-mapping.js';
import { packetCommitment } from './public/file-envelope.js';
import { queueAudit } from './audit-outbox.js';
import { fileRoutingMetadata, syntheticFileAdvice, validateFileAdvice } from './file-routing.js';
import { principalEnabled } from './registry-schema.js';

// A computed deadline that is not a finite number would mean "no cutoff" once it reaches the
// default parameter, so it is checked here rather than trusted.
function deliveryDeadlineFor(snapshot) {
  const deadline = downloadAccessDeadline(snapshot.content);
  if (!Number.isFinite(deadline)) throw new Error('DELIVERY_CONFIGURATION_INVALID');
  return deadline;
}

// No network or key access: this worker prepares simulated dispatch records only.
export async function advanceFileJobs(original, config, now = Date.now(), advise = syntheticFileAdvice, reloadConfig = async () => config) {
  const startedAt = Date.now();
  if (!original.file) return original;
  let task = structuredClone(original);
  let changed = false;
  for (const job of task.jobs) {
    if (!['PENDING_CHECK', 'RETRY_WAIT'].includes(job.status)) continue;
    if (job.delivery?.nextAttemptAt && Date.parse(job.delivery.nextAttemptAt) > now) continue;
    const previousState = job.status;
    let rejection = 'AUTHORIZATION_INVALID';
    try {
      let grant = activeGrant(config, task.grantId);
      rejection = 'ACTOR_DISABLED';
      const operator = config.principals.find(person => person.id === task.ownerId);
      if (!principalEnabled(config, operator)) throw new Error('OPERATOR_DISABLED');
      rejection = 'SNAPSHOT_INVALID';
      const snapshot = dispatchSnapshot(task, grant, job.version, now);
      rejection = 'PACKET_CHANGED';
      if (await packetCommitment(task.file.packet) !== snapshot.content.documentHash) throw new Error('PACKET_CHANGED');
      const metadata = fileRoutingMetadata(snapshot, job);
      rejection = 'ADVISER_UNAVAILABLE';
      const suggestion = await advise(structuredClone(metadata));
      rejection = 'ADVICE_INVALID';
      const advice = validateFileAdvice(suggestion, metadata);
      rejection = 'AUTHORIZATION_INVALID';
      const currentConfig = await reloadConfig();
      grant = activeGrant(currentConfig, task.grantId);
      const executionTime = now + Math.max(0, Date.now() - startedAt);
      dispatchSnapshot(task, grant, job.version, executionTime);
      rejection = 'ACTOR_DISABLED';
      if (!currentConfig.principals.some(person => person.id === task.ownerId && principalEnabled(currentConfig, person))) throw new Error('OPERATOR_DISABLED');
      job.routeAdvice = advice;
      rejection = 'ADVICE_PAUSED';
      if (advice.action !== 'ROUTE') throw new Error('ADVICE_PAUSED');
      const channel = advice.channel;
      rejection = 'SNAPSHOT_INVALID';
      const destinations = resolvePrivateRoute(snapshot.privateMapping, snapshot.content, channel);
      rejection = 'RECIPIENT_DISABLED';
      if (destinations.some(destination => !currentConfig.principals.some(person => person.id === destination.recipientId && principalEnabled(currentConfig, person)))) {
        throw new Error('RECIPIENT_DISABLED');
      }
      rejection = 'DELIVERY_CONFIGURATION_INVALID';
      const delivery = advanceDelivery({ delivery: job.delivery }, { ...grant, channels: snapshot.content.channels },
        { requestId: `${task.id}-${job.version}-${(job.delivery?.attempts || 0) + 1}`, channel }, executionTime,
        deliveryDeadlineFor(snapshot));
      job.delivery = delivery;
      job.status = delivery.status;
      job.attempts = delivery.attempts;
      job.reasonCode = delivery.pausedBy ? delivery.pausedBy
        : delivery.status === 'PAUSED' ? 'RETRY_EXHAUSTED'
        : delivery.status === 'OUTCOME_UNKNOWN' ? 'OUTCOME_UNKNOWN' : null;
      if (job.status === 'DRY_RUN_PREPARED') {
        job.notice = { kind: 'LOCAL_DRY_RUN', subjectCode: 'SEALED_DOCUMENT_AVAILABLE',
          taskAlias: snapshot.privateMapping.taskAlias, version: job.version,
          preparedAt: new Date(now).toISOString(), sendsEmail: false };
      }
    } catch {
      job.status = 'PAUSED';
      job.reasonCode = rejection;
    }
    job.revision = (job.revision || 0) + 1;
    job.updatedAt = new Date(now).toISOString();
    // Keep the event in this same aggregate write, replayed by the existing outbox.
    const event = { taskId: task.id, snapshotVersion: job.version, type: 'DELIVERY_TRANSITION',
      result: job.status === 'PAUSED' ? 'DENY' : 'INFO', previousState, nextState: job.status,
      attempts: job.attempts, reasons: [job.reasonCode || 'DELIVERY_UPDATED'] };
    task.auditOutbox = queueAudit({ auditOutbox: task.auditOutbox }, [event]).auditOutbox;
    changed = true;
  }
  return changed ? task : original;
}
