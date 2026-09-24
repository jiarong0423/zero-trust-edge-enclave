import { dispatchSnapshot } from './snapshot-lifecycle.js';
import { advanceDelivery, activeGrant } from './access-control.js';
import { downloadAccessDeadline } from './download-policy.js';
import { resolvePrivateRoute } from './private-mapping.js';
import { packetCommitment } from './public/file-envelope.js';
import { queueAudit } from './audit-outbox.js';
import { fileRoutingMetadata, syntheticFileAdvice, validateFileAdvice } from './file-routing.js';
import { followupMetadata, syntheticFollowupAdvice, validateFollowupAdvice } from './delivery-followup.js';
import { receiptSummary } from './file-receipts.js';
import { normalizeDownloadPolicy } from './download-policy.js';
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
      let suggestion;
      try {
        suggestion = await advise(structuredClone(metadata));
      } catch (error) {
        // An adviser that answered with something the validator refused is invalid advice, not an
        // unavailable adviser; the audit reason should say which one happened.
        if (error?.adviceRejected) rejection = 'ADVICE_INVALID';
        throw error;
      }
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

/**
 * The second half of the loop. advanceFileJobs stops at DRY_RUN_PREPARED, which is correct for a
 * TIME_LIMITED delivery -- the window shuts and there is nothing left to do -- and wrong for a
 * REQUIRED_ACK one, where the notice is out, nobody has collected, and the deadline is still days
 * away. This pass reconsiders exactly those jobs.
 *
 * It runs at most once per window bucket, so a task is reconsidered a bounded number of times no
 * matter how often the worker ticks, and it stops at the deadline, where recordOverdueDeliveries
 * already has the answer.
 *
 * Nothing is sent here. A reminder is a prepared notice, the same dry run the first pass produces.
 */
export async function advanceFollowups(original, config, now = Date.now(), advise = syntheticFollowupAdvice, reloadConfig = async () => config) {
  if (!original.file) return original;
  let task = structuredClone(original);
  let changed = false;
  for (const job of task.jobs) {
    if (job.status !== 'DRY_RUN_PREPARED') continue;
    if (job.nextFollowupAt && Date.parse(job.nextFollowupAt) > now) continue;
    // Decide whether this job is followable at all before touching authority. Past its deadline the
    // grant is usually expired too, and letting that surface as a refusal would append an audit
    // record on every tick of a delivery that has already finished, forever. Standing down is not
    // the same as being refused, and only the refusal is worth recording.
    const candidate = task.snapshots.find(item => item.version === job.version);
    if (!candidate || candidate.status !== 'APPROVED') continue;
    let followable;
    try {
      followable = normalizeDownloadPolicy(candidate.content).deliveryMode === 'REQUIRED_ACK' &&
        Date.parse(candidate.content.deliveryDeadline) > now;
    } catch { followable = false; }
    if (!followable) continue;
    let rejection = 'AUTHORIZATION_INVALID';
    let action = null;
    try {
      let grant = activeGrant(config, task.grantId);
      rejection = 'ACTOR_DISABLED';
      const operator = config.principals.find(person => person.id === task.ownerId);
      if (!principalEnabled(config, operator)) throw new Error('OPERATOR_DISABLED');
      rejection = 'SNAPSHOT_INVALID';
      const snapshot = dispatchSnapshot(task, grant, job.version, now);
      const deadline = Date.parse(snapshot.content.deliveryDeadline);
      rejection = 'FOLLOWUP_METADATA_INVALID';
      const summary = receiptSummary(task, job.version, now);
      const metadata = followupMetadata(snapshot, job, summary, now);
      rejection = 'ADVISER_UNAVAILABLE';
      let suggestion;
      try {
        suggestion = await advise(structuredClone(metadata));
      } catch (error) {
        // An adviser that answered with something the validator refused is invalid advice, not an
        // unavailable adviser; the audit reason should say which one happened.
        if (error?.adviceRejected) rejection = 'ADVICE_INVALID';
        throw error;
      }
      rejection = 'ADVICE_INVALID';
      const advice = validateFollowupAdvice(suggestion, metadata);
      // Authority is reloaded after the adviser has spoken, exactly as the routing pass does: a
      // grant revoked while the request was in flight must stop the reminder it advised.
      rejection = 'AUTHORIZATION_INVALID';
      const currentConfig = await reloadConfig();
      grant = activeGrant(currentConfig, task.grantId);
      dispatchSnapshot(task, grant, job.version, now);
      rejection = 'ACTOR_DISABLED';
      if (!currentConfig.principals.some(person => person.id === task.ownerId && principalEnabled(currentConfig, person))) throw new Error('OPERATOR_DISABLED');
      rejection = 'RECIPIENT_DISABLED';
      const destinations = resolvePrivateRoute(snapshot.privateMapping, snapshot.content, job.delivery?.channel || snapshot.content.channels[0]);
      if (destinations.some(destination => !currentConfig.principals.some(person => person.id === destination.recipientId && principalEnabled(currentConfig, person)))) {
        throw new Error('RECIPIENT_DISABLED');
      }
      action = advice.action;
      job.followupAdvice = advice;
      job.followups = [...(job.followups || []), { action: advice.action, reasonCode: advice.reasonCode, at: new Date(now).toISOString() }];
      if (advice.action === 'REMIND') {
        // The adviser said to remind; who is reminded is resolved here from receipts the adviser
        // never saw, exactly as the routing pass resolves recipients from the snapshot rather than
        // from the advice. Anyone who already collected is passed over in silence: reminding them
        // achieves nothing and spends the credibility of the next reminder on a finished errand.
        const outstanding = summary.recipients.filter(entry => !entry.downloadReported);
        if (!outstanding.length) throw new Error('FOLLOWUP_NOT_REQUIRED');
        job.notice = { kind: 'LOCAL_DRY_RUN', subjectCode: 'SEALED_DOCUMENT_REMINDER',
          taskAlias: snapshot.privateMapping.taskAlias, version: job.version,
          // Group codes, not identifiers: this notice is read by the sender, who approved the list
          // and already sees these codes on the receipt view.
          targets: outstanding.map(entry => entry.groupCode).filter(Boolean).sort(),
          preparedAt: new Date(now).toISOString(), sendsEmail: false };
      }
      if (advice.action === 'ESCALATE' && !(task.deliveryEscalations || []).some(entry => entry.version === job.version)) {
        task.deliveryEscalations = [...(task.deliveryEscalations || []),
          { version: job.version, code: 'FOLLOWUP_ESCALATED', at: new Date(now).toISOString() }];
      }
      // Reconsider at the midpoint of what is left, never closer than an eighth of the window. From
      // approval that lands the decision points at a half, three quarters and seven eighths, which
      // is the same geometry as the bands the adviser is shown, so each call reports a band the
      // previous one did not. The eighth is the floor that stops the halving from continuing
      // forever as the deadline approaches: the step after the last one reaches the deadline, where
      // this pass stands down and the overdue record takes over.
      //
      // Equal quarters were the obvious first choice and are the wrong one. They put three of four
      // decision points in the stretch where a reminder is least likely to be acted on and leave a
      // single point for the stretch where it is most likely. The cadence is measured against the
      // task's own window rather than the clock, so a two-hour delivery and a two-month one are
      // reconsidered the same number of times.
      const approvedAt = Date.parse(snapshot.approvedAt);
      const span = Number.isFinite(approvedAt) && deadline > approvedAt ? deadline - approvedAt : 0;
      const step = span > 0 ? Math.max(Math.ceil((deadline - now) / 2), Math.ceil(span / 8)) : deadline - now;
      job.nextFollowupAt = new Date(Math.min(now + Math.max(step, 1), deadline)).toISOString();
    } catch {
      action = null;
      job.followupPausedBy = rejection;
      // A refusal must not become a hot loop against a failing dependency; it waits out a bucket
      // like any other outcome.
      job.nextFollowupAt = new Date(now + 60000).toISOString();
    }
    job.revision = (job.revision || 0) + 1;
    job.updatedAt = new Date(now).toISOString();
    task.auditOutbox = queueAudit({ auditOutbox: task.auditOutbox }, [{
      taskId: task.id, snapshotVersion: job.version, type: 'DELIVERY_FOLLOWUP',
      result: action === 'ESCALATE' ? 'DENY' : 'INFO',
      reasons: [action ? `FOLLOWUP_${action}` : job.followupPausedBy]
    }]).auditOutbox;
    changed = true;
  }
  return changed ? task : original;
}
