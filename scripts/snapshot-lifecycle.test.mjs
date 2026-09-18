import test from 'node:test';
import assert from 'node:assert/strict';
import { newTask, reviseTask, confirmFirst, confirmSecond, revokeSnapshot, dispatchSnapshot } from '../snapshot-lifecycle.js';

const now = Date.parse('2026-09-07T00:00:00Z');
const actor = { id: 'sender', kind: 'operator' };
const grant = { id: 'grant', operatorId: actor.id, version: 1, recipients: ['a', 'b'],
  channels: ['email', 'internal_queue'], expiresAt: '2026-09-08T00:00:00Z' };
const input = { documentHash: 'a'.repeat(64), recipients: ['a'], channels: ['email'], expiresAt: '2026-09-07T12:00:00Z' };

test('each material edit invalidates prior confirmations and unused token, preserves hash', () => {
  for (const change of [{ documentHash: 'b'.repeat(64) }, { recipients: ['b'] },
    { channels: ['internal_queue'] }, { expiresAt: '2026-09-07T13:00:00Z' }]) {
    const draft = newTask(actor, grant, input, now);
    assert.throws(() => confirmSecond(draft, actor, grant, 1, 'a'.repeat(43), now));
    const locked = confirmFirst(draft, actor, grant, 1, now);
    const edited = reviseTask(locked.task, actor, grant, { ...input, ...change }, now);
    assert.equal(edited.snapshots[0].status, 'INVALIDATED');
    assert.equal(edited.snapshots[0].confirmedAt, null);
    assert.equal(edited.snapshots[0].submissionHash, null);
    assert.equal(edited.snapshots[0].hash, locked.task.snapshots[0].hash);
    assert.throws(() => confirmSecond(edited, actor, grant, 1, locked.token, now));
    assert.throws(() => confirmSecond(edited, actor, grant, 2, locked.token, now));
    assert.throws(() => dispatchSnapshot(edited, grant, 1, now));
  }
});

test('approved snapshot survives a new draft, duplicate confirmation makes one job, revocation is explicit', () => {
  const locked = confirmFirst(newTask(actor, grant, input, now), actor, grant, 1, now);
  const approved = confirmSecond(locked.task, actor, grant, 1, locked.token, now);
  assert.equal(confirmSecond(approved, actor, grant, 1, locked.token, now).jobs.length, 1);
  const edited = reviseTask(approved, actor, grant, { ...input, recipients: ['b'] }, now);
  assert.deepEqual(edited.snapshots[0], approved.snapshots[0]);
  assert.equal(dispatchSnapshot(edited, grant, 1, now).status, 'APPROVED');
  assert.throws(() => dispatchSnapshot(edited, grant, 2, now));
  assert.throws(() => dispatchSnapshot(edited, { ...grant, revoked: true }, 1, now));
  assert.throws(() => dispatchSnapshot(edited, { ...grant, version: 2 }, 1, now));
  assert.throws(() => dispatchSnapshot(edited, grant, 1, now + 86400000));
  assert.throws(() => revokeSnapshot(edited, { id: 'attacker', kind: 'operator' }, 1, now));
  const revoked = revokeSnapshot(edited, actor, 1, now);
  assert.throws(() => dispatchSnapshot(revoked, grant, 1, now));
  assert.throws(() => confirmSecond(revoked, actor, grant, 1, locked.token, now));
  assert.equal(revoked.snapshots[1].status, 'DRAFT');
});

test('expired authorization renewal needs a new snapshot and both fresh confirmations', () => {
  const locked = confirmFirst(newTask(actor, grant, input, now), actor, grant, 1, now);
  const approved = confirmSecond(locked.task, actor, grant, 1, locked.token, now);
  const later = now + 2 * 86400000;
  assert.throws(() => reviseTask(approved, actor, grant, input, later));
  const renewed = { ...grant, version: 2, recipients: ['a'], expiresAt: new Date(later + 86400000).toISOString() };
  assert.throws(() => dispatchSnapshot(approved, renewed, 1, later));
  const renewedInput = { ...input, expiresAt: renewed.expiresAt, deliveryMode: 'REQUIRED_ACK' };
  assert.throws(() => reviseTask(approved, actor, renewed, { ...renewedInput, recipients: ['b'] }, later));
  const draft = reviseTask(approved, actor, renewed, renewedInput, later);
  assert.equal(draft.jobs.length, 1);
  assert.throws(() => dispatchSnapshot(draft, renewed, 2, later));
  assert.throws(() => confirmSecond(draft, actor, renewed, 2, locked.token, later));
  const fresh = confirmFirst(draft, actor, renewed, 2, later);
  assert.notEqual(fresh.token, locked.token);
  assert.throws(() => confirmSecond(fresh.task, actor, renewed, 2, locked.token, later));
  const reapproved = confirmSecond(fresh.task, actor, renewed, 2, fresh.token, later);
  assert.equal(dispatchSnapshot(reapproved, renewed, 2, later).grantVersion, 2);
  assert.throws(() => dispatchSnapshot(reapproved, renewed, 1, later));
  assert.deepEqual(reapproved.snapshots[0], approved.snapshots[0]);
});
