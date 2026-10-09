import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyNote } from '../public/note-classify.js';

const departments = [{ id: 'sales', displayName: '業務部' }, { id: 'accounting', displayName: '會計部' }, { id: 'hr', displayName: '人事部' }];
const people = [
  { id: 'e1001', nameZh: '劉文祥', department: 'sales' }, { id: 'e2044', nameZh: '劉文祥', department: 'sales' },
  { id: 'e3190', nameZh: '劉慶龍', department: 'sales' }, { id: 'a0007', nameZh: '王小明', department: 'accounting' },
  { id: 'e12', nameZh: '陳大文', department: 'hr' }
];

test('the owner example: a surname with an honorific and a department narrows, and selects nobody', () => {
  const result = classifyNote('請把報價單寄給業務部的劉先生', people, departments);
  assert.deepEqual([result.department, result.surname, result.nameZh, result.employeeId], ['sales', '劉', null, null]);
});

test('a department word is recognised through the display name, the id and the alias table', () => {
  assert.equal(classifyNote('給會計的同事', people, departments).department, 'accounting');
  assert.equal(classifyNote('send to HR please', people, departments).department, 'hr');
  assert.equal(classifyNote('銷售那邊', people, departments).department, 'sales');
});

test('two departments in one note is unclear, and nothing is chosen', () => {
  const result = classifyNote('業務和會計都要看', people, departments);
  assert.deepEqual([result.department, result.departmentAmbiguous], [null, true]);
});

test('a full Chinese name on the authorization is found; a name nobody carries is not', () => {
  assert.equal(classifyNote('給劉慶龍', people, departments).nameZh, '劉慶龍');
  assert.equal(classifyNote('給劉文祥', people, departments).nameZh, '劉文祥');
  assert.equal(classifyNote('給李四', people, departments).nameZh, null);
});

test('two different full names in one note is unclear', () => {
  assert.equal(classifyNote('劉慶龍和王小明', people, departments).nameZh, null);
});

test('an employee number counts only as a whole token', () => {
  assert.equal(classifyNote('業務 e2044 那位', people, departments).employeeId, 'e2044');
  assert.equal(classifyNote('編號 E3190', people, departments).employeeId, 'e3190');
  assert.equal(classifyNote('編號 e1234', people, departments).employeeId, null);
  assert.equal(classifyNote('編號 e123', people, departments).employeeId, null);
  assert.equal(classifyNote('編號 e12', people, departments).employeeId, 'e12');
});

test('empty, whitespace and non-text notes fill nothing', () => {
  for (const note of ['', '   ', null, undefined, 42]) {
    assert.deepEqual(classifyNote(note, people, departments),
      { department: null, departmentAmbiguous: false, nameZh: null, employeeId: null, surname: null });
  }
});
