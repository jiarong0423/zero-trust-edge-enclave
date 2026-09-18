import { exact, fail } from './access-control.js';
import { checkPrivateMapping } from './private-mapping.js';
import { normalizeDownloadPolicy } from './download-policy.js';

/**
 * The delivery loop as built handles a notice that could not be prepared: a transient failure
 * becomes RETRY_WAIT and is retried under a bounded backoff. It does not handle the other half,
 * which is a notice that was prepared and that nobody acted on. DRY_RUN_PREPARED is terminal in
 * the worker, so a REQUIRED_ACK task can sit untouched until its deadline passes and a single
 * overdue record is written — by which time the delivery that had to happen has not happened.
 *
 * This module closes that half. It only applies to REQUIRED_ACK, because TIME_LIMITED answers the
 * question by itself: the window shuts and there is nothing left to chase.
 *
 * Whether a deadline has passed is arithmetic and belongs in fixed code, which already does it.
 * What has no rule is the decision before the deadline: time is left, nobody has collected, two
 * reminders have gone out — nudge again, or raise it to a person? That depends on how the three
 * factors sit against each other, and the answer differs between tasks. That is the decision this
 * projection is for.
 */

// Four positions across the approved window. The adviser needs to know where in the window the
// task sits, never when the window is in wall-clock terms: the boundaries are cut from each
// task's own span, so an identical TIME_3 means a different hour on a two-day task and a
// two-month one, and no sequence of calls reveals the sender's schedule.
const TIME_CODES = ['TIME_1', 'TIME_2', 'TIME_3', 'TIME_4'];
// Ordinal, never a count. "Some" is the whole of what the adviser learns from a partial pickup;
// how many of how many stays inside the boundary, as it does for every other projection here.
const PICKUP_CODES = ['PICKUP_NONE', 'PICKUP_SOME', 'PICKUP_ALL'];
const FOLLOWUP_ACTIONS = ['WAIT', 'REMIND', 'ESCALATE'];
const FOLLOWUP_REASONS = ['WINDOW_EARLY', 'NO_PICKUP_YET', 'PARTIAL_PICKUP', 'DEADLINE_NEAR',
  'NUDGES_EXHAUSTED', 'INSUFFICIENT_INFORMATION'];
export const MAX_NUDGES = 3;

const timeCode = (approvedAt, deadline, now) => {
  const span = deadline - approvedAt;
  // A window that has no positive span carries no position to report. Treating it as the last
  // bucket is the fail-closed reading: there is no time left to wait out.
  if (!(span > 0)) return TIME_CODES[TIME_CODES.length - 1];
  const index = Math.floor((Math.min(Math.max(now, approvedAt), deadline) - approvedAt) / span * TIME_CODES.length);
  return TIME_CODES[Math.min(index, TIME_CODES.length - 1)];
};

export function followupMetadata(snapshot, job, summary, now = Date.now()) {
  checkPrivateMapping(snapshot.privateMapping, snapshot.privateMapping.taskId, snapshot.version, snapshot.content);
  if (normalizeDownloadPolicy(snapshot.content).deliveryMode !== 'REQUIRED_ACK') fail('FOLLOWUP_MODE_NOT_APPLICABLE', 409);
  const approvedAt = Date.parse(snapshot.approvedAt);
  const deadline = Date.parse(snapshot.content.deliveryDeadline);
  if (!Number.isFinite(approvedAt) || !Number.isFinite(deadline)) fail('FOLLOWUP_WINDOW_INVALID', 422);
  const nudges = (job.followups || []).filter(entry => entry.action === 'REMIND').length;
  // The summary is computed from receipts the backend already holds. Only its ordinal shape
  // crosses into the projection; the counts it was derived from do not.
  const collected = summary.downloadReportCount;
  const total = summary.recipientCount;
  return {
    taskAlias: snapshot.privateMapping.taskAlias,
    snapshotVersion: snapshot.version,
    timeCode: timeCode(approvedAt, deadline, now),
    nudges: Math.min(nudges, MAX_NUDGES),
    pickupCode: total > 0 && collected >= total ? 'PICKUP_ALL' : collected > 0 ? 'PICKUP_SOME' : 'PICKUP_NONE'
  };
}

export function validateFollowupAdvice(advice, metadata) {
  exact(advice, ['taskAlias', 'snapshotVersion', 'action', 'reasonCode']);
  if (advice.taskAlias !== metadata.taskAlias || advice.snapshotVersion !== metadata.snapshotVersion ||
      !FOLLOWUP_ACTIONS.includes(advice.action) || !FOLLOWUP_REASONS.includes(advice.reasonCode)) {
    fail('FOLLOWUP_ADVICE_REJECTED', 422);
  }
  // The nudge ceiling is the caller's, not the adviser's. An adviser that keeps proposing REMIND
  // past the budget would otherwise loop forever, so the ceiling is enforced here rather than
  // trusted to the prompt that states it.
  if (advice.action === 'REMIND' && metadata.nudges >= MAX_NUDGES) fail('FOLLOWUP_NUDGE_BUDGET_SPENT', 422);
  // Everything has been collected, so there is nothing left to chase. Accepting a nudge here would
  // let the adviser generate traffic against a finished delivery.
  if (advice.action !== 'WAIT' && metadata.pickupCode === 'PICKUP_ALL') fail('FOLLOWUP_NOT_REQUIRED', 422);
  return { taskAlias: advice.taskAlias, snapshotVersion: advice.snapshotVersion,
    action: advice.action, reasonCode: advice.reasonCode };
}

// A deterministic local stand-in, not evidence of a model inference. It is deliberately blunt:
// the point of the projection is that the good answer is not a lookup, so a lookup is all a
// fixture should be.
export function syntheticFollowupAdvice(metadata) {
  const base = { taskAlias: metadata.taskAlias, snapshotVersion: metadata.snapshotVersion };
  if (metadata.pickupCode === 'PICKUP_ALL') return { ...base, action: 'WAIT', reasonCode: 'WINDOW_EARLY' };
  if (metadata.nudges >= MAX_NUDGES) return { ...base, action: 'ESCALATE', reasonCode: 'NUDGES_EXHAUSTED' };
  if (metadata.timeCode === 'TIME_4') return { ...base, action: 'ESCALATE', reasonCode: 'DEADLINE_NEAR' };
  if (metadata.timeCode === 'TIME_1') return { ...base, action: 'WAIT', reasonCode: 'WINDOW_EARLY' };
  return { ...base, action: 'REMIND',
    reasonCode: metadata.pickupCode === 'PICKUP_SOME' ? 'PARTIAL_PICKUP' : 'NO_PICKUP_YET' };
}
