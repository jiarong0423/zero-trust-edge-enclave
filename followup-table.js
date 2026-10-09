import { TIME_CODES, PICKUP_CODES, MAX_NUDGES, syntheticFollowupAdvice, validateFollowupAdvice } from './delivery-followup.js';

// Every combination the follow-up decision can meet, written out. The decision is a function of three
// ordinal codes, so the whole input space is small enough to list and to test cell by cell:
// TIME_CODES x PICKUP_CODES x (0..MAX_NUDGES) = 4 x 3 x 3 = 36. For each cell this lists the answer the
// fixed fixture gives and every action the validator would accept there.
//
// The answer column is the fixture's, kept as written: it is the blunt baseline an adviser is measured
// against and the fixed floor beneath it, not a judgement about what is best. Where more than one action
// is legal the table does not claim the fixture's choice is the right one; that is for a person to decide
// and for a measurement to show.
const ACTIONS = ['WAIT', 'REMIND', 'ESCALATE'];
const REASONS = ['WINDOW_EARLY', 'NO_PICKUP_YET', 'PARTIAL_PICKUP', 'DEADLINE_NEAR', 'NUDGES_EXHAUSTED', 'INSUFFICIENT_INFORMATION'];

export function followupCells() {
  const cells = [];
  for (const timeCode of TIME_CODES) for (const pickupCode of PICKUP_CODES) for (let nudgeCount = 0; nudgeCount <= MAX_NUDGES; nudgeCount++) {
    const metadata = { taskAlias: '11111111-1111-4111-8111-111111111111', snapshotVersion: 1, timeCode, pickupCode, nudgeCount };
    const fixture = syntheticFollowupAdvice(metadata);
    const legal = new Set();
    for (const action of ACTIONS) for (const reasonCode of REASONS) {
      try { validateFollowupAdvice({ taskAlias: metadata.taskAlias, snapshotVersion: 1, action, reasonCode }, metadata); legal.add(action); } catch { /* not legal here */ }
    }
    cells.push({ timeCode, pickupCode, nudgeCount, action: fixture.action, reasonCode: fixture.reasonCode,
      legalActions: ACTIONS.filter(action => legal.has(action)) });
  }
  return cells;
}

// A lookup by the three codes. This is the follow-up decision with no adviser at all.
export function tableFollowupAdvice(metadata) {
  const row = followupCells().find(cell => cell.timeCode === metadata.timeCode &&
    cell.pickupCode === metadata.pickupCode && cell.nudgeCount === metadata.nudgeCount);
  if (!row) throw Object.assign(new Error('FOLLOWUP_CELL_UNKNOWN'), { status: 422 });
  return { taskAlias: metadata.taskAlias, snapshotVersion: metadata.snapshotVersion, action: row.action, reasonCode: row.reasonCode };
}
