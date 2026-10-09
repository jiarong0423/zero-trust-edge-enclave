import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseCsv, planImport, applyPatches, main } from './import-directory-mapping.mjs';
import { validateAccess } from '../access-control.js';
import { resolveRecipient } from '../recipient-match.js';

const hash = text => crypto.createHash('sha256').update(text).digest('hex');
function registry() {
  const person = (id, kind, department) => ({ id, kind, department, tokenHash: hash(id) });
  return validateAccess({ schemaVersion: 2, revision: 3,
    departments: ['ops', 'sales', 'accounting'].map(id => ({ id, displayName: id })),
    principals: [person('admin', 'administrator', 'ops'), person('sender', 'operator', 'ops'), person('coord', 'coordinator', 'ops'),
      person('e1001', 'recipient', 'sales'), person('e2044', 'recipient', 'sales'), person('e3190', 'recipient', 'sales'), person('a0007', 'recipient', 'accounting')],
    grants: [{ id: 'g', version: 1, operatorId: 'sender', coordinatorId: 'coord', recipients: ['e1001'], channels: ['email'],
      expiresAt: new Date(Date.now() + 60000).toISOString(), maxAttempts: 3, maxOpens: 2 }] });
}
const TABLE = [
  'employee_id,name_zh,name_en,aliases,title,department,region,team,role,email',
  'e1001,劉文祥,Wen Liu,小劉|Wen,業務代表,sales,北區,一組,rep,',
  'e2044,劉文祥,Wen Liu,,業務經理,sales,南區,二組,lead,',
  'e3190,劉慶龍,Q Liu,,,sales,北區,,,',
  'a0007,王小明,Ming Wang,,,accounting,,,,ming@example.com'
].join('\r\n');

test('the CSV reader handles quotes, doubled quotes, line breaks inside quotes, CRLF and a BOM', () => {
  assert.deepEqual(parseCsv('﻿a,b\r\n"x,1","he said ""hi"""\n"two\nlines",z\n'), [['a', 'b'], ['x,1', 'he said "hi"'], ['two\nlines', 'z']]);
  assert.deepEqual(parseCsv('a,,c\n,,\n'), [['a', '', 'c'], ['', '', '']]);
  assert.deepEqual(parseCsv(''), []);
  assert.throws(() => parseCsv('a,"open'), e => e.message === 'TABLE_UNTERMINATED_QUOTE');
});

test('the owner example imports: two people share a name, and the report says so without printing it', () => {
  const plan = planImport(TABLE, registry());
  assert.deepEqual(plan.errors, []);
  assert.equal(plan.patches.length, 4);
  assert.deepEqual(plan.info, { rows: 4, updated: 4, sharedNameGroups: 1, peopleInSharedGroups: 2, recipientsWithoutChineseName: 0 });
  assert.deepEqual(plan.patches[0], { id: 'e1001', nameZh: '劉文祥', displayName: 'Wen Liu', aliases: ['小劉', 'Wen'], title: '業務代表', department: 'sales', tags: { region: '北區', team: '一組', role: 'rep' } });
  assert.deepEqual(plan.patches[2], { id: 'e3190', nameZh: '劉慶龍', displayName: 'Q Liu', department: 'sales', tags: { region: '北區' } });
});

test('the imported registry validates and resolves the way the owner described', () => {
  const next = applyPatches(registry(), planImport(TABLE, registry()).patches);
  assert.equal(next.revision, 4);
  assert.equal(resolveRecipient(next, { nameZh: '劉慶龍' }).id, 'e3190');
  assert.equal(resolveRecipient(next, { nameZh: '劉文祥' }).status, 'AMBIGUOUS');
  assert.equal(resolveRecipient(next, { nameZh: '劉文祥', employeeId: 'e2044' }).id, 'e2044');
  assert.equal(resolveRecipient(next, { nameZh: '劉文祥', tags: { region: '南區' } }).narrow, 'NARROW_DECISIVE');
  assert.equal(resolveRecipient(next, { nameZh: '小劉' }).code, 'MATCH_BY_ALIAS');
});

test('empty cells leave a field alone, and a filled cell replaces it', () => {
  const base = registry();
  Object.assign(base.principals.find(p => p.id === 'e1001'), { title: '舊職稱', tags: { region: '北區', team: '舊組' }, email: 'old@example.com' });
  const next = applyPatches(base, planImport('employee_id,title,team\ne1001,,新組\n', base).patches);
  const person = next.principals.find(p => p.id === 'e1001');
  assert.deepEqual([person.title, person.tags, person.email], ['舊職稱', { region: '北區', team: '新組' }, 'old@example.com']);
});

test('problems are reported by line and employee number, and a bad table writes nothing', () => {
  const bad = [
    'employee_id,name_zh,department,region,email,aliases,title',
    'e1001,劉文祥,nowhere,,,,',
    'e1001,劉文祥,sales,,,,',
    'e2044,,sales,x y,,,',
    'e3190,,,,not-an-email,,',
    'a0007,,,,,a|a,',
    'sender,,,,,,',
    'ghost,劉某,,,,,',
    '!!,,,,,,'
  ].join('\n');
  const plan = planImport(bad, registry());
  const codes = plan.errors.map(e => `${e.line}:${e.id || ''}:${e.code}`);
  assert.deepEqual(codes, ['2:e1001:UNKNOWN_DEPARTMENT', '3:e1001:DUPLICATE_EMPLOYEE_ID', '4:e2044:BAD_TAG', '5:e3190:BAD_EMAIL', '6:a0007:BAD_ALIASES', '7:sender:NOT_A_RECIPIENT', '9::BAD_EMPLOYEE_ID']);
  assert.deepEqual(plan.warnings.map(w => `${w.line}:${w.id}:${w.code}`), ['8:ghost:NOT_IN_REGISTRY']);
  assert.equal(JSON.stringify(plan).includes('劉'), false);
  for (const text of ['name_zh\nx', 'employee_id,employee_id\ne1,e1', 'employee_id,colour\ne1001,red', '']) {
    assert.ok(planImport(text, registry()).errors.length > 0, text);
  }
});

test('the command line: dry run writes nothing, --out writes one private new file, and never overwrites', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'import-map-'));
  const table = path.join(dir, 'mapping.csv'); const registryFile = path.join(dir, 'access.json'); const out = path.join(dir, 'candidate.json');
  await fs.writeFile(table, TABLE);
  await fs.writeFile(registryFile, JSON.stringify(registry()));
  const before = await fs.readFile(registryFile, 'utf8');
  const lines = [];
  const run = args => main(args, line => lines.push(line));
  assert.equal(await run(['--table', table, '--registry', registryFile]), 0);
  assert.match(lines.join('\n'), /RESULT OK errors=0 warnings=0 dry run, nothing written/);
  await assert.rejects(fs.stat(out));
  lines.length = 0;
  assert.equal(await run(['--table', table, '--registry', registryFile, '--out', out]), 0);
  assert.match(lines.join('\n'), /candidate registry written to candidate\.json \(revision 4\)/);
  assert.equal((await fs.stat(out)).mode & 0o077, 0);
  const candidate = JSON.parse(await fs.readFile(out, 'utf8'));
  assert.equal(candidate.principals.find(p => p.id === 'e3190').nameZh, '劉慶龍');
  assert.equal(await fs.readFile(registryFile, 'utf8'), before);
  assert.equal(lines.join('\n').includes('劉'), false);
  assert.equal(await run(['--table', table, '--registry', registryFile, '--out', out]), 2);
  assert.equal(await run(['--table', table, '--registry', registryFile, '--out', registryFile]), 2);
  assert.equal(await fs.readFile(registryFile, 'utf8'), before);
  await fs.writeFile(table, 'employee_id,department\ne1001,nowhere\n');
  lines.length = 0;
  assert.equal(await run(['--table', table, '--registry', registryFile, '--out', path.join(dir, 'never.json')]), 1);
  assert.match(lines.join('\n'), /RESULT FAIL/);
  await assert.rejects(fs.stat(path.join(dir, 'never.json')));
  await fs.rm(dir, { recursive: true, force: true });
});

test('usage errors exit 2 and a missing file does not print a path or a stack', async () => {
  const written = []; const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = chunk => { written.push(String(chunk)); return true; };
  try {
    for (const args of [[], ['--table', 'x'], ['--registry', 'y'], ['--table', 'x', '--registry', 'y', '--bogus', 'z'], ['--table', 'x', '--registry']]) assert.equal(await main(args, () => {}), 2);
    assert.equal(await main(['--table', '/no/such/file.csv', '--registry', '/no/such/registry.json'], () => {}), 2);
  } finally { process.stderr.write = original; }
  assert.equal(written.join('').includes('/no/such'), false);
});
