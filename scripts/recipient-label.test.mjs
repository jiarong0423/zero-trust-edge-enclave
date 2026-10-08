import test from 'node:test';
import assert from 'node:assert/strict';
import { recipientLabel } from '../public/recipient-label.js';

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
