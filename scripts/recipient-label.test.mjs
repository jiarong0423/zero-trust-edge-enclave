import test from 'node:test';
import assert from 'node:assert/strict';
import { recipientLabel, sharesChineseName } from '../public/recipient-label.js';

test('three people with the same name get three different labels', () => {
  const people = [
    { id: 'e1001', displayName: 'Yenting Liu', department: 'ops', email: null },
    { id: 'e2044', displayName: 'Yenting Liu', department: 'finance', email: null },
    { id: 'e3190', displayName: 'Yenting Liu', department: 'finance', email: null }
  ];
  const labels = people.map(recipientLabel);
  assert.equal(new Set(labels).size, 3);
  for (const [index, person] of people.entries()) assert.ok(labels[index].includes(person.id));
});

test('the label carries the department and the e-mail when there is one, and survives missing fields', () => {
  assert.equal(recipientLabel({ id: 'sales-a', displayName: 'Sales A', department: 'sales', email: 'a@example.org' }), 'Sales A · sales · sales-a (a@example.org)');
  assert.equal(recipientLabel({ id: 'x1' }), 'x1 · unassigned · x1');
  assert.equal(recipientLabel({ id: 'x2', displayName: 42, department: 7, email: {} }), 'x2 · unassigned · x2');
});

test('the label shows the Chinese name and tags when the directory has them, and is unchanged when it does not', () => {
  assert.equal(recipientLabel({ id: 'e1001', displayName: 'Wen Liu', department: 'sales', nameZh: '劉文祥', tags: { region: 'north', team: 'a' } }),
    '劉文祥 · Wen Liu · sales · e1001 [north/a]');
  assert.equal(recipientLabel({ id: 'e1', displayName: 'A', department: 'sales', tags: {} }), 'A · sales · e1');
  assert.equal(recipientLabel({ id: 'e2', nameZh: 7, tags: 'x' }), 'e2 · unassigned · e2');
});

test('two people with the same Chinese name are flagged, whatever the spacing, and a unique name is not', () => {
  const people = [{ id: 'a', nameZh: '劉文祥' }, { id: 'b', nameZh: '劉 文祥' }, { id: 'c', nameZh: '劉慶龍' }, { id: 'd' }, { id: 'e' }];
  assert.equal(sharesChineseName(people[0], people), true);
  assert.equal(sharesChineseName(people[1], people), true);
  assert.equal(sharesChineseName(people[2], people), false);
  assert.equal(sharesChineseName(people[3], people), false);
});
