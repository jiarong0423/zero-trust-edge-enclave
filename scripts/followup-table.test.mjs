import test from 'node:test';
import assert from 'node:assert/strict';
import { followupCells, tableFollowupAdvice } from '../followup-table.js';
import { validateFollowupAdvice, syntheticFollowupAdvice } from '../delivery-followup.js';

test('the table has all 36 cells and every answer is one the validator accepts', () => {
  const cells = followupCells();
  assert.equal(cells.length, 36);
  assert.equal(new Set(cells.map(c => `${c.timeCode}|${c.pickupCode}|${c.nudgeCount}`)).size, 36);
  for (const cell of cells) {
    const metadata = { taskAlias: '11111111-1111-4111-8111-111111111111', snapshotVersion: 1, ...cell };
    assert.ok(cell.legalActions.includes(cell.action), JSON.stringify(cell));
    assert.equal(validateFollowupAdvice(tableFollowupAdvice(metadata), metadata).action, cell.action);
    assert.deepEqual(tableFollowupAdvice(metadata).action, syntheticFollowupAdvice(metadata).action);
  }
});

test('the table is pinned: any change to an answer is a decision and shows up here', () => {
  const summary = followupCells().reduce((counts, c) => { counts[c.action] = (counts[c.action] || 0) + 1; return counts; }, {});
  assert.deepEqual(summary, { WAIT: 16, ESCALATE: 12, REMIND: 8 });
  const open = followupCells().filter(c => c.legalActions.length > 1).length;
  assert.equal(open, 24);
  const fixed = followupCells().filter(c => c.legalActions.length === 1).length;
  assert.equal(fixed, 12);
});

test('a cell outside the table is refused', () => {
  assert.throws(() => tableFollowupAdvice({ taskAlias: 'a', snapshotVersion: 1, timeCode: 'WINDOW_NEVER', pickupCode: 'PICKUP_ALL', nudgeCount: 0 }), e => e.message === 'FOLLOWUP_CELL_UNKNOWN');
});
