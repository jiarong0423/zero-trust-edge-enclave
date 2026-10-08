/**
 * Opt-in fixed floor for the follow-up pass. A passive adviser can answer WAIT all the way to the
 * last band of the window with nothing collected, so a person is never asked to look before the
 * deadline. The floor is a fixed rule, not a second model call: when it is enabled, an accepted WAIT
 * at WINDOW_LAST with the pickup not complete becomes ESCALATE with the reason DEADLINE_NEAR, which
 * the validator's coherence rule already allows only for WINDOW_LAST.
 *
 * Pure function. The adviser's own answer is never mutated; the caller keeps it in the advice trail
 * and records the floor decision separately.
 */
export function followupFloorEnabled(env = process.env) {
  return env.FOLLOWUP_FLOOR === 'true';
}

export function applyFloor(advice, metadata, enabled) {
  if (enabled !== true || !advice || !metadata) return { advice, floored: false };
  if (advice.action !== 'WAIT' || metadata.timeCode !== 'WINDOW_LAST' || metadata.pickupCode === 'PICKUP_ALL') {
    return { advice, floored: false };
  }
  return { advice: { ...advice, action: 'ESCALATE', reasonCode: 'DEADLINE_NEAR' }, floored: true };
}
