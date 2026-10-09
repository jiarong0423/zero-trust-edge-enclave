#!/usr/bin/env node
// Measures the note reader that uses a model (note-understand.js) against the fixed keyword reader
// (public/note-classify.js) on invented notes, using the model that is running on this machine. A
// measurement, not part of the test suite: it needs the model up. Nothing real is read or sent.
//
//   node scripts/note-eval.mjs
//
// The model's answer is checked by fixed code the way the shipped route does it: a department or tag must be
// something the note says, and a name or employee number must belong to someone on the authorization.
//
// A note counts as right only when every field is exactly what the note says, with nothing extra. The
// keyword reader does not read tags, so it can never get a note right that has one; that is a real
// difference between the two, not a quirk of the scoring.
import { understandNote, reconcileWithDirectory } from '../note-understand.js';
import { classifyNote } from '../public/note-classify.js';

const departments = [{ id: 'sales', displayName: '業務部' }, { id: 'accounting', displayName: '會計部' }, { id: 'hr', displayName: '人事部' }, { id: 'ops', displayName: '營運部' }];
const vocabulary = { departments: departments.map(d => ({ id: d.id, label: d.displayName })), tags: { region: ['北區', '中區', '南區'], team: ['一組', '二組', '三組'], role: ['rep', 'lead'] } };
const people = [['e1001', '劉文祥'], ['e2044', '劉文祥'], ['e3190', '劉慶龍'], ['a0007', '王小明'], ['h0001', '陳大文'], ['o0003', '李雅婷'], ['o0004', '張志豪']].map(([id, nameZh]) => ({ id, nameZh }));
const none = { department: null, region: null, team: null, role: null, surname: null, nameZh: null, employeeId: null };
const cases = [
  ['請把報價單寄給業務部的劉先生', { department: 'sales', surname: '劉' }],
  ['給業務那個姓劉的，上禮拜開會坐我旁邊', { department: 'sales', surname: '劉' }],
  ['會計部北區的王小姐', { department: 'accounting', region: '北區', surname: '王' }],
  ['e2044 那位', { employeeId: 'e2044' }],
  ['寄給劉文祥（業務，南區）', { department: 'sales', region: '南區', nameZh: '劉文祥' }],
  ['不是業務，是會計的李雅婷', { department: 'accounting', nameZh: '李雅婷' }],
  ['人事部陳經理，二組', { department: 'hr', team: '二組', surname: '陳' }],
  ['send it to Wang in accounting', { department: 'accounting' }],
  ['營運部的張志豪，他是 lead', { department: 'ops', role: 'lead', nameZh: '張志豪' }],
  ['我是業務的小陳，幫我寄給會計的王小明', { department: 'accounting', nameZh: '王小明' }],
  ['給大家', {}],
  ['業務跟會計都要', {}],
  ['劉慶龍，編號 e3190', { nameZh: '劉慶龍', employeeId: 'e3190' }],
  ['寄給在中區三組的那位', { region: '中區', team: '三組' }],
  ['麻煩寄給 A0007', { employeeId: 'a0007' }],
  ['給業務部的大文', { department: 'sales' }],
  ['請寄給王小明的主管', {}],
  ['寄給南區業務', { department: 'sales', region: '南區' }],
  ['HR 的陳大文', { department: 'hr', nameZh: '陳大文' }],
  ['給 sales 的 Wen Liu', { department: 'sales' }],
  ['請轉給楊先生', { surname: '楊' }],
  ['給李經理、人事部', { department: 'hr', surname: '李' }],
  ['不要給業務部，給營運部的人', { department: 'ops' }],
  ['業務部劉文祥那位，編號 e1001', { department: 'sales', nameZh: '劉文祥', employeeId: 'e1001' }]
].map(([note, expected]) => [note, { ...none, ...expected }]);

const fieldsOf = result => ({ department: result.department ?? null, region: result.tags?.region ?? null, team: result.tags?.team ?? null, role: result.tags?.role ?? null,
  surname: result.surname ?? null, nameZh: result.nameZh ?? null, employeeId: result.employeeId ? result.employeeId.toLowerCase() : null });
const wrongFields = (got, want) => Object.keys(none).filter(key => got[key] !== want[key]);

const baseUrl = process.env.LOCAL_MODEL_BASE_URL || 'http://127.0.0.1:1234/v1';
const model = process.env.LOCAL_MODEL_NAME || 'nvidia-nemotron-3-nano-4b';
const rows = []; let modelDown = null;
for (const [note, want] of cases) {
  const rules = fieldsOf(classifyNote(note, people, departments));
  let modelFields = null; let ms = null; let dropped = [];
  const started = performance.now();
  try { const out = await understandNote(note, vocabulary, { baseUrl, model, timeoutMs: 30000 }); modelFields = fieldsOf(reconcileWithDirectory(out.fields, people)); dropped = out.dropped; ms = Math.round(performance.now() - started); }
  catch (error) { modelDown = error.message; break; }
  rows.push({ note, want, rules, modelFields, ms, dropped, rulesWrong: wrongFields(rules, want), modelWrong: wrongFields(modelFields, want) });
}
if (modelDown) { console.error(`ERROR the model did not answer (${modelDown}); load ${model} in LM Studio and start its server`); process.exit(1); }
console.log(`notes: ${rows.length}; model: ${model}\n`);
console.log('| note | rules wrong | model wrong | ms |');
console.log('| --- | --- | --- | --- |');
for (const r of rows) console.log(`| ${r.note} | ${r.rulesWrong.join(',') || 'ok'} | ${r.modelWrong.join(',') || 'ok'}${r.dropped.length ? ` (dropped ${r.dropped.join(',')})` : ''} | ${r.ms} |`);
const right = key => rows.filter(r => r[key].length === 0).length;
const times = rows.map(r => r.ms).sort((a, b) => a - b);
console.log(`\nnotes exactly right: model ${right('modelWrong')} of ${rows.length}, keyword rules ${right('rulesWrong')} of ${rows.length}`);
for (const field of Object.keys(none)) {
  const wanted = rows.filter(r => r.want[field] !== null);
  console.log(`  ${field}: expected in ${wanted.length} notes; model right ${wanted.filter(r => r.modelFields[field] === r.want[field]).length}, rules right ${wanted.filter(r => r.rules[field] === r.want[field]).length}; filled when it should not be: model ${rows.filter(r => r.want[field] === null && r.modelFields[field] !== null).length}, rules ${rows.filter(r => r.want[field] === null && r.rules[field] !== null).length}`);
}
console.log(`model latency: median ${times[Math.floor(times.length / 2)]} ms, max ${times.at(-1)} ms`);
console.log('These notes are invented and few; the numbers describe this model on this set only.');
