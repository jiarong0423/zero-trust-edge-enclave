import test from 'node:test';
import assert from 'node:assert/strict';
import { mappingProjection, resolvePrivateRoute, createPrivateMapping } from '../private-mapping.js';
import { newTask, confirmFirst, confirmSecond, reviseTask, dispatchSnapshot } from '../snapshot-lifecycle.js';

test('private aliases bind immutable task/version recipients and local simulated endpoints', () => {
  const now = Date.now();
  const actor = { kind: 'operator', id: 'sender' };
  const grant = { id: 'test', version: 1, operatorId: 'sender', recipients: ['sales-a', 'sales-b'],
    channels: ['email', 'internal_queue'], expiresAt: new Date(now + 60000).toISOString() };
  const content = { documentHash: 'a'.repeat(64), recipients: ['sales-a'], channels: grant.channels, expiresAt: grant.expiresAt };
  const first = confirmFirst(newTask(actor, grant, content, now), actor, grant, 1, now);
  const approved = confirmSecond(first.task, actor, grant, 1, first.token, now);
  const snapshot = dispatchSnapshot(approved, grant, 1, now);
  assert.deepEqual(resolvePrivateRoute(snapshot.privateMapping, snapshot.content, 'email'),
    [{ recipientId: 'sales-a', groupCode: 'A1', endpointId: 'dry-run:sales-a:email' }]);
  assert.ok(!JSON.stringify(mappingProjection(snapshot.privateMapping)).includes('sales-a'));
  const revised = reviseTask(approved, actor, grant, { ...content, recipients: ['sales-b'] }, now);
  assert.deepEqual(revised.snapshots[0], snapshot);
  assert.notEqual(revised.snapshots[1].privateMapping.taskAlias, snapshot.privateMapping.taskAlias);
  for (const mutate of [
    mapping => mapping.recipients[0].recipientId = 'sales-b',
    mapping => mapping.recipients[0].endpoints[0].endpointId = 'dry-run:sales-b:email',
    mapping => mapping.version = 2,
    mapping => mapping.taskAlias = '00000000-0000-4000-8000-000000000000',
    mapping => mapping.recipients[0].groupCode = 'B1',
    mapping => mapping.recipients[0].groupCode = 'A2',
    mapping => mapping.recipients[0].groupCode = 'sales-a',
    mapping => delete mapping.recipients[0].groupCode
  ]) {
    const corrupted = structuredClone(approved);
    mutate(corrupted.snapshots[0].privateMapping);
    assert.throws(() => dispatchSnapshot(corrupted, grant, 1, now));
  }
  assert.throws(() => resolvePrivateRoute(snapshot.privateMapping, snapshot.content, 'external'));
  const legacy = structuredClone(approved);
  delete legacy.snapshots[0].privateMapping;
  assert.throws(() => dispatchSnapshot(legacy, grant, 1, now));
});

test('group codes expose department shape only, with no gap where a recipient was left out', () => {
  const now = Date.now();
  const actor = { kind: 'operator', id: 'sender' };
  const everyone = ['sales-1', 'sales-2', 'sales-3', 'sec-1', 'sec-2', 'sec-3', 'fin-1', 'fin-2', 'fin-3'];
  const departments = Object.fromEntries(everyone.map(id => [id, id.split('-')[0]]));
  const grant = { id: 'test', version: 1, operatorId: 'sender', recipients: everyone,
    channels: ['email'], expiresAt: new Date(now + 60000).toISOString() };
  // fin-3 is never approved into the snapshot, so the adviser must not be able to see a hole.
  const chosen = everyone.filter(id => id !== 'fin-3');
  const content = { documentHash: 'a'.repeat(64), recipients: chosen, channels: grant.channels, expiresAt: grant.expiresAt };
  const task = newTask(actor, grant, content, now, departments);
  const mapping = task.snapshots[0].privateMapping;
  const codes = mapping.recipients.map(entry => entry.groupCode).sort();

  assert.deepEqual(codes, ['A1', 'A2', 'B1', 'B2', 'B3', 'C1', 'C2', 'C3']);
  assert.ok(!JSON.stringify(mappingProjection(mapping)).includes('fin'));
  assert.ok(!JSON.stringify(mappingProjection(mapping)).includes('sales'));

  // Letters follow the sorted department ids (fin, sales, sec), not the recipient order.
  const byCode = Object.fromEntries(mapping.recipients.map(entry => [entry.groupCode, entry.recipientId]));
  for (const [code, recipientId] of Object.entries(byCode)) {
    assert.equal(departments[recipientId], { A: 'fin', B: 'sales', C: 'sec' }[code[0]]);
  }

  // A revision re-shuffles positions, so a code cannot become a durable pseudonym.
  const positions = new Set();
  for (let round = 0; round < 40; round += 1) {
    const revised = reviseTask(task, actor, grant, content, now, departments);
    positions.add(revised.snapshots.at(-1).privateMapping.recipients
      .find(entry => entry.recipientId === 'sec-1').groupCode);
  }
  assert.ok(positions.size > 1, 'group position should not be stable across revisions');
});

test('group codes never reach the legacy coordinator projection sent to a provider', () => {
  const content = { recipients: ['fin-1', 'fin-2', 'sales-1'], channels: ['email'] };
  const mapping = createPrivateMapping('t', 1, content, { 'fin-1': 'finance', 'fin-2': 'finance', 'sales-1': 'sales' });
  const projected = JSON.stringify(mappingProjection(mapping));
  // The legacy recommend tool stringifies this straight into a provider request, so a letter plus
  // position here would disclose the department shape and the approved headcount.
  assert.ok(!projected.includes('groupCode'), 'mappingProjection must not carry group codes');
  for (const entry of mapping.recipients) assert.ok(!projected.includes('"' + entry.groupCode + '"'));
  assert.ok(!projected.includes('fin') && !projected.includes('sales'));
});

test('recipient ids that collide with Object.prototype keys do not become their own groups', () => {
  const content = { recipients: ['alice', 'bob', 'constructor', 'toString'], channels: ['email'] };
  const codes = createPrivateMapping('t', 1, content, {}).recipients.map(entry => entry.groupCode);
  // With no department map every recipient is unassigned, so all four share one letter.
  assert.deepEqual(new Set(codes.map(code => code[0])), new Set(['A']));
  assert.deepEqual([...codes].sort(), ['A1', 'A2', 'A3', 'A4']);
});

test('a group larger than the code format is refused at creation, not at confirmation', () => {
  const recipients = Array.from({ length: 1000 }, (_, index) => 'person-' + index);
  assert.throws(() => createPrivateMapping('t', 1, { recipients, channels: ['email'] }, {}),
    /PRIVATE_MAPPING_REJECTED/);
  const ok = createPrivateMapping('t', 1, { recipients: recipients.slice(0, 999), channels: ['email'] }, {});
  assert.equal(ok.recipients.length, 999);
});
