#!/usr/bin/env node
// Fills the directory's Chinese names, departments, tags and display names from a mapping table (CSV),
// without anyone typing them in one by one. It never writes the live registry: it reads the registry and
// the table, prints a report, and, only when asked and only when there are no errors, writes a NEW
// candidate registry file for the owner to review and put in place.
//
//   node scripts/import-directory-mapping.mjs --table mapping.csv --registry data/access.json [--out candidate.json]
//
// The table (UTF-8, first row is the header). Only employee_id is required; an empty cell leaves that
// field as it is:
//
//   employee_id,name_zh,name_en,aliases,title,department,region,team,role,email
//   e1001,劉文祥,Wen Liu,小劉|Wen,業務代表,sales,北區,一組,rep,
//
// aliases are separated by | (up to eight). A cell that is filled replaces that field as a whole.
//
// Rows are matched to people who are already in the registry (the registry is where tokens are issued, so
// this tool never creates a person). A row for someone who is not there is reported and skipped.
// The report prints line numbers and employee numbers, never a name. Exit codes: 0 no errors, 1 errors
// found (nothing written), 2 usage error.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { normalizeDirectory } from '../registry-schema.js';
import { validateAccess } from '../access-control.js';
import { validNameZh, validTags, validTitle, validAliases, normalizeZhName, TAG_KEYS } from '../recipient-match.js';

export const TABLE_MAX_BYTES = 5 * 1024 * 1024;
export const TABLE_MAX_ROWS = 20000;
const COLUMNS = ['employee_id', 'name_zh', 'name_en', 'aliases', 'title', 'department', 'region', 'team', 'role', 'email'];
const ID_SHAPE = /^[a-zA-Z0-9_-]{1,64}$/;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// A small CSV reader: quoted fields, doubled quotes, commas and line breaks inside quotes, CRLF, a BOM.
export function parseCsv(text) {
  const source = String(text).replace(/^﻿/, '');
  const rows = []; let row = []; let field = ''; let quoted = false; let touched = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quoted) {
      if (c === '"' && source[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === '') { quoted = true; touched = true; }
    else if (c === ',') { row.push(field); field = ''; touched = true; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && source[i + 1] === '\n') i++;
      if (touched || field !== '') { row.push(field); rows.push(row); }
      row = []; field = ''; touched = false;
    } else { field += c; touched = true; }
  }
  if (quoted) throw Object.assign(new Error('TABLE_UNTERMINATED_QUOTE'), { status: 422 });
  if (touched || field !== '') { row.push(field); rows.push(row); }
  return rows;
}

// Returns { patches, errors, warnings, info }. Every message carries a line number and, where there is
// one, an employee number, never a name.
export function planImport(csvText, registry) {
  const errors = []; const warnings = []; const patches = [];
  const rows = parseCsv(csvText);
  if (!rows.length) return { patches, errors: [{ line: 1, code: 'TABLE_EMPTY' }], warnings, info: {} };
  if (rows.length - 1 > TABLE_MAX_ROWS) return { patches, errors: [{ line: 1, code: 'TABLE_TOO_LARGE' }], warnings, info: {} };
  const header = rows[0].map(cell => cell.trim().toLowerCase());
  const unknown = header.filter(name => !COLUMNS.includes(name));
  const repeated = header.filter((name, index) => header.indexOf(name) !== index);
  if (unknown.length) errors.push({ line: 1, code: 'UNKNOWN_COLUMN', detail: unknown.join(',') });
  if (repeated.length) errors.push({ line: 1, code: 'REPEATED_COLUMN', detail: [...new Set(repeated)].join(',') });
  if (!header.includes('employee_id')) errors.push({ line: 1, code: 'MISSING_EMPLOYEE_ID_COLUMN' });
  if (errors.length) return { patches, errors, warnings, info: {} };

  const directory = normalizeDirectory(registry);
  const departments = new Set(directory.departments.map(entry => entry.id));
  const people = new Map(directory.principals.map(person => [person.id, person]));
  const seen = new Map();
  rows.slice(1).forEach((cells, index) => {
    const line = index + 2;
    const cell = name => (header.includes(name) ? (cells[header.indexOf(name)] ?? '').trim() : '');
    if (cells.length > header.length) { errors.push({ line, code: 'TOO_MANY_CELLS' }); return; }
    const id = cell('employee_id');
    if (!ID_SHAPE.test(id)) { errors.push({ line, code: 'BAD_EMPLOYEE_ID' }); return; }
    if (seen.has(id)) { errors.push({ line, id, code: 'DUPLICATE_EMPLOYEE_ID', detail: `also line ${seen.get(id)}` }); return; }
    seen.set(id, line);
    const person = people.get(id);
    if (!person) { warnings.push({ line, id, code: 'NOT_IN_REGISTRY' }); return; }
    if (person.kind !== 'recipient') { errors.push({ line, id, code: 'NOT_A_RECIPIENT' }); return; }
    const patch = { id }; let bad = false;
    const fail = code => { errors.push({ line, id, code }); bad = true; };
    if (cell('name_zh')) { if (validNameZh(cell('name_zh'))) patch.nameZh = cell('name_zh'); else fail('BAD_NAME_ZH'); }
    if (cell('name_en')) { if (cell('name_en').length <= 128 && !/[\u0000-\u001f\u007f]/.test(cell('name_en'))) patch.displayName = cell('name_en'); else fail('BAD_NAME_EN'); }
    if (cell('title')) { if (validTitle(cell('title'))) patch.title = cell('title'); else fail('BAD_TITLE'); }
    if (cell('aliases')) {
      const list = cell('aliases').split('|').map(item => item.trim()).filter(Boolean);
      if (validAliases(list)) patch.aliases = list; else fail('BAD_ALIASES');
    }
    if (cell('department')) { if (departments.has(cell('department'))) patch.department = cell('department'); else fail('UNKNOWN_DEPARTMENT'); }
    if (cell('email')) { if (cell('email').length <= 254 && EMAIL_SHAPE.test(cell('email'))) patch.email = cell('email'); else fail('BAD_EMAIL'); }
    const tags = {};
    for (const key of TAG_KEYS) if (cell(key)) tags[key] = cell(key);
    if (Object.keys(tags).length) { if (validTags(tags)) patch.tags = tags; else fail('BAD_TAG'); }
    if (!bad) patches.push(patch);
  });

  // After the import, which Chinese names would still belong to more than one person? That is not an
  // error: it is exactly the case the employee number is for. Counts only.
  const after = new Map(directory.principals.filter(person => person.kind === 'recipient').map(person => [person.id, { ...person }]));
  for (const patch of patches) Object.assign(after.get(patch.id), patch.nameZh ? { nameZh: patch.nameZh } : {});
  const groups = new Map();
  for (const person of after.values()) {
    const key = normalizeZhName(person.nameZh);
    if (key) groups.set(key, [...(groups.get(key) || []), person.id]);
  }
  const shared = [...groups.values()].filter(ids => ids.length > 1);
  const withoutName = [...after.values()].filter(person => !normalizeZhName(person.nameZh)).length;
  return { patches, errors, warnings,
    info: { rows: rows.length - 1, updated: patches.length, sharedNameGroups: shared.length, peopleInSharedGroups: shared.reduce((n, ids) => n + ids.length, 0), recipientsWithoutChineseName: withoutName } };
}

// Applies the patches to a copy and validates the result as the server would. Empty cells were never put
// in a patch, so they leave the person's current value alone.
export function applyPatches(registry, patches) {
  const next = structuredClone(registry);
  for (const patch of patches) {
    const person = next.principals.find(item => item.id === patch.id);
    const { id, tags, ...rest } = patch;
    Object.assign(person, rest);
    if (tags) person.tags = { ...(person.tags || {}), ...tags };
  }
  if (patches.length) { next.schemaVersion = 2; next.revision = (Number.isSafeInteger(next.revision) ? next.revision : 1) + 1; }
  return validateAccess(next);
}

function parseArguments(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i];
    if (!['--table', '--registry', '--out'].includes(name) || argv[i + 1] === undefined || argv[i + 1].startsWith('--') || options[name.slice(2)]) return null;
    options[name.slice(2)] = argv[i + 1];
  }
  return options.table && options.registry ? options : null;
}

const describe = item => `line ${item.line}${item.id ? ` ${item.id}` : ''}: ${item.code}${item.detail ? ` (${item.detail})` : ''}`;

export async function main(argv = process.argv.slice(2), write = line => process.stdout.write(line + '\n')) {
  const options = parseArguments(argv);
  if (!options) {
    process.stderr.write('Usage: node scripts/import-directory-mapping.mjs --table mapping.csv --registry access.json [--out candidate.json]\n');
    return 2;
  }
  let text; let registry;
  try {
    const stat = await fs.stat(options.table);
    if (!stat.isFile() || stat.size > TABLE_MAX_BYTES) throw new Error('TABLE_REJECTED');
    text = await fs.readFile(options.table, 'utf8');
    registry = JSON.parse(await fs.readFile(options.registry, 'utf8'));
    normalizeDirectory(registry);
  } catch (error) {
    process.stderr.write(`ERROR cannot read the table or the registry (${error?.message === 'TABLE_REJECTED' ? 'table is not a regular file or is over 5 MiB' : 'missing, unreadable or not a valid registry'})\n`);
    return 2;
  }
  let plan;
  try { plan = planImport(text, registry); }
  catch (error) { process.stderr.write(`ERROR ${error.message}\n`); return 1; }
  write(`table rows: ${plan.info.rows ?? 0}; people that would be updated: ${plan.info.updated ?? 0}`);
  if (plan.info.rows !== undefined) {
    write(`Chinese names still shared by several people after the import: ${plan.info.sharedNameGroups} group(s), ${plan.info.peopleInSharedGroups} people (these are told apart by employee number)`);
    write(`recipients with no Chinese name after the import: ${plan.info.recipientsWithoutChineseName}`);
  }
  for (const item of plan.warnings) write(`WARN ${describe(item)}`);
  for (const item of plan.errors) write(`ERROR ${describe(item)}`);
  if (plan.errors.length) { write(`RESULT FAIL errors=${plan.errors.length} warnings=${plan.warnings.length} nothing written`); return 1; }
  if (!options.out) { write(`RESULT OK errors=0 warnings=${plan.warnings.length} dry run, nothing written (add --out candidate.json to write a candidate registry)`); return 0; }
  let candidate;
  try { candidate = applyPatches(registry, plan.patches); }
  catch { write('ERROR the registry would not validate after the import; nothing written'); return 1; }
  const target = path.resolve(options.out);
  if (target === path.resolve(options.registry)) { process.stderr.write('ERROR --out must not be the registry file itself\n'); return 2; }
  try { await fs.writeFile(target, JSON.stringify(candidate, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) { process.stderr.write(`ERROR cannot create ${path.basename(target)} (${error.code === 'EEXIST' ? 'it already exists; this tool never overwrites' : 'write failed'})\n`); return 2; }
  write(`RESULT OK errors=0 warnings=${plan.warnings.length} candidate registry written to ${path.basename(target)} (revision ${candidate.revision}); review it, then put it in place yourself`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const code = await main();
  process.stdout.write('', () => process.exit(code));
}
