import test from 'node:test';
import assert from 'node:assert/strict';
import { checkUnderstanding, reconcileWithDirectory, understandNote, createNoteReader, NOTE_BOUNDARY, NOTE_MAX } from '../note-understand.js';

const vocabulary = { departments: [{ id: 'sales', label: '業務部' }, { id: 'accounting', label: '會計部' }, { id: 'hr', label: '人事部' }],
  tags: { region: ['北區', '南區'], team: ['一組', '二組'], role: ['rep', 'lead'] } };
const raw = (extra = {}) => ({ department: 'NONE', region: 'NONE', team: 'NONE', role: 'NONE', surname: '', nameZh: '', employeeId: '', ...extra });
const check = (note, extra) => checkUnderstanding(raw(extra), note, vocabulary);

test('what the note supports is kept', () => {
  const { fields, dropped } = check('寄給業務部北區的劉文祥，編號 e2044', { department: 'sales', region: '北區', nameZh: '劉文祥', employeeId: 'e2044' });
  assert.deepEqual(fields, { department: 'sales', tags: { region: '北區' }, nameZh: '劉文祥', surname: null, employeeId: 'e2044' });
  assert.deepEqual(dropped, []);
});

test('a department, tag, name, surname or number the note does not say is dropped, never kept', () => {
  assert.deepEqual(check('給大家', { department: 'sales' }).dropped, ['department']);
  assert.deepEqual(check('寄給業務部', { department: 'mars' }).dropped, ['department']);
  assert.deepEqual(check('寄給業務部', { department: 'sales', role: 'lead' }).dropped, ['role']);
  assert.deepEqual(check('寄給業務部', { department: 'sales', region: '東區' }).dropped, ['region']);
  assert.deepEqual(check('寄給業務部的人', { department: 'sales', nameZh: '王小明' }).dropped, ['nameZh']);
  assert.deepEqual(check('寄給業務部的人', { department: 'sales', surname: '王' }).dropped, ['surname']);
  assert.deepEqual(check('寄給業務部的人', { department: 'sales', surname: '王小' }).dropped, ['surname']);
  assert.deepEqual(check('寄給業務部的人', { department: 'sales', employeeId: 'e999' }).dropped, ['employeeId']);
  assert.deepEqual(check('編號 e2044x', { employeeId: 'e2044' }).dropped, ['employeeId']);
  assert.deepEqual(check('業務', { employeeId: 'bad id!' }).dropped, ['employeeId']);
});

test('the usual words and the label without the suffix count as the note saying a department', () => {
  assert.equal(check('銷售那邊', { department: 'sales' }).fields.department, 'sales');
  assert.equal(check('給 HR 的人', { department: 'hr' }).fields.department, 'hr');
  assert.equal(check('給會計', { department: 'accounting' }).fields.department, 'accounting');
});

test('a full name already says what a surname would, and a malformed answer fills nothing', () => {
  assert.equal(check('劉文祥', { nameZh: '劉文祥', surname: '劉' }).fields.surname, null);
  for (const bad of [null, 'text', [], 42]) assert.deepEqual(checkUnderstanding(bad, '業務', vocabulary).dropped, ['SHAPE']);
  assert.equal(checkUnderstanding({}, '業務', vocabulary).fields.department, null);
});

test('reconciling with the people on the authorization: a name nobody carries is not kept as a name', () => {
  const people = [{ id: 'e2044', nameZh: '劉文祥', aliases: ['小劉'] }, { id: 'E3190', nameZh: '劉慶龍' }];
  const base = { department: 'sales', tags: { region: '北區' }, nameZh: null, surname: null, employeeId: null };
  assert.equal(reconcileWithDirectory({ ...base, nameZh: '劉文祥' }, people).nameZh, '劉文祥');
  assert.equal(reconcileWithDirectory({ ...base, nameZh: '小劉' }, people).nameZh, '小劉');
  const honorific = reconcileWithDirectory({ ...base, nameZh: '劉先生' }, people);
  assert.deepEqual([honorific.nameZh, honorific.surname], [null, '劉']);
  assert.deepEqual([reconcileWithDirectory({ ...base, nameZh: '大文' }, people).nameZh, reconcileWithDirectory({ ...base, nameZh: '大文' }, people).surname], [null, null]);
  assert.equal(reconcileWithDirectory({ ...base, employeeId: 'e3190' }, people).employeeId, 'E3190');
  assert.equal(reconcileWithDirectory({ ...base, employeeId: 'zzz' }, people).employeeId, null);
  assert.deepEqual(reconcileWithDirectory(base, people).tags, { region: '北區' });
});

test('the request carries the note and the vocabulary, nothing about people, and only loopback is contacted', async () => {
  let sent; const calls = [];
  const request = async (url, init) => {
    calls.push(String(url)); sent = JSON.parse(init.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(raw({ department: 'sales', surname: '劉' })) } }] }), { status: 200 });
  };
  const options = { baseUrl: 'http://127.0.0.1:1234/v1', model: 'stand-in', request };
  const result = await understandNote('業務部的劉先生', vocabulary, options);
  assert.deepEqual([result.fields.department, result.fields.surname], ['sales', '劉']);
  assert.equal(sent.messages[0].content, NOTE_BOUNDARY);
  assert.deepEqual(Object.keys(JSON.parse(sent.messages[1].content)).sort(), ['departments', 'note', 'tags']);
  assert.deepEqual(sent.response_format.json_schema.schema.properties.department.enum, ['NONE', 'sales', 'accounting', 'hr']);
  assert.equal(sent.response_format.json_schema.strict, true);
  assert.deepEqual([sent.temperature, sent.reasoning_effort], [0, 'none']);
  for (const baseUrl of ['https://api.example.com/v1', 'http://10.0.0.5:1234/v1', 'http://127.0.0.1:1234/x', 'http://u:p@127.0.0.1:1234/v1']) {
    calls.length = 0;
    await assert.rejects(understandNote('業務', vocabulary, { ...options, baseUrl }), e => e.message === 'NOTE_ENDPOINT_REFUSED');
    assert.equal(calls.length, 0);
  }
  for (const note of ['', '   ', 'x'.repeat(NOTE_MAX + 1), 5]) await assert.rejects(understandNote(note, vocabulary, options), e => e.message === 'NOTE_REFUSED');
  await assert.rejects(understandNote('業務', vocabulary, { ...options, request: async () => new Response('no', { status: 500 }) }), e => e.message === 'NOTE_HTTP_ERROR');
  await assert.rejects(understandNote('業務', vocabulary, { ...options, request: async () => new Response(JSON.stringify({ choices: [{ message: { content: '' } }] }), { status: 200 }) }), e => e.message === 'NOTE_EMPTY');
  await assert.rejects(understandNote('業務', vocabulary, { ...options, request: async () => new Response('not json', { status: 200 }) }));
});

test('the reader is on only when NOTE_AI is exactly local, and a failure falls back without throwing', async () => {
  for (const value of [undefined, '', 'on', 'true', 'LOCAL', 'local ']) {
    const reader = createNoteReader({ env: { NOTE_AI: value }, request: async () => { throw new Error('must not be called'); } });
    assert.equal(reader.enabled, false);
    assert.deepEqual(await reader.read('業務', vocabulary), { method: 'off', fallback: 'NOTE_AI_OFF', fields: null });
  }
  const down = createNoteReader({ env: { NOTE_AI: 'local' }, request: async () => { throw new Error('down'); } });
  assert.equal(down.enabled, true);
  assert.deepEqual(await down.read('業務', vocabulary), { method: 'off', fallback: 'MODEL_UNAVAILABLE', fields: null });
  const up = createNoteReader({ env: { NOTE_AI: 'local' }, baseUrl: 'http://127.0.0.1:1234/v1', model: 'm',
    request: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(raw({ department: 'hr' })) } }] }), { status: 200 }) });
  const read = await up.read('給人事', vocabulary);
  assert.deepEqual([read.method, read.fields.department], ['model', 'hr']);
});
