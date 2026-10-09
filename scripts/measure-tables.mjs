#!/usr/bin/env node
// One page, no model calls: the follow-up decision table (36 cells) beside the answers a 4B local model
// and the 120B hosted model gave on those same cells in the saved comparison run, and the recipient-match
// table (108 cells). It reads files that already exist and prints; it writes nothing and sends nothing.
//
//   node scripts/measure-tables.mjs [path-to-followup-compare-cloud-result.json]
//
// Agreement with the table is not accuracy: no person has labelled these cells yet, so "same as the
// table" says how often a model matches a blunt rule, not how often it is right.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { followupCells } from '../followup-table.js';
import { CANDIDATE_CODES, KEY_CODES, NARROW_CODES, REVERSE_CODES, ATTEMPT_CODES, matchTable, legalMatchActions } from '../match-confirm.js';

const root = path.resolve(import.meta.dirname, '..');
const argument = process.argv[2];
const dir = path.join(root, 'output', 'experiments');
async function newest(prefix) {
  const names = (await fs.readdir(dir).catch(() => [])).filter(name => name.startsWith(prefix) && name.endsWith('.json')).sort();
  return names.length ? path.join(dir, names.at(-1)) : null;
}
const file = argument ? path.resolve(argument) : await newest('followup-compare-cloud-');
const key = row => `${row.timeCode}|${row.pickupCode}|${row.nudgeCount}`;
const action = value => (typeof value === 'string' ? value.split('/')[0] : '-');

const cells = followupCells();
let saved = null;
if (file) {
  try { saved = JSON.parse(await fs.readFile(file, 'utf8')); } catch { console.error(`ERROR cannot read ${path.basename(file)}`); process.exitCode = 1; }
} else console.error('WARN no saved comparison file found under output/experiments; printing the tables alone');
const rows = new Map((saved?.rows || []).map(row => [key(row), row]));

const out = [];
out.push('# Decision tables', '');
out.push(`Source of model answers: ${saved ? path.basename(file) + (saved.model ? ` (${saved.model})` : '') : 'none'}`, '');
out.push('## Follow-up decision: 36 cells', '', '| time | pickup | nudges | table | legal actions | 4B | 120B |', '| --- | --- | --- | --- | --- | --- | --- |');
let open = 0; const agree = { local: 0, hosted: 0 }; const seen = { local: 0, hosted: 0 }; const openAgree = { local: 0, hosted: 0 }; const openSeen = { local: 0, hosted: 0 };
for (const cell of cells) {
  const row = rows.get(key(cell));
  const local = row ? action(row.local4b ?? row.model) : '-';
  const hosted = row ? action(row.cloud120b) : '-';
  if (cell.legalActions.length > 1) open++;
  for (const [name, value] of [['local', local], ['hosted', hosted]]) {
    if (value === '-') continue;
    seen[name]++;
    if (cell.legalActions.length > 1) openSeen[name]++;
    if (value === cell.action) { agree[name]++; if (cell.legalActions.length > 1) openAgree[name]++; }
  }
  out.push(`| ${cell.timeCode} | ${cell.pickupCode} | ${cell.nudgeCount} | ${cell.action} | ${cell.legalActions.join(' ')} | ${local} | ${hosted} |`);
}
const pct = (n, d) => (d ? `${n}/${d}` : 'n/a');
out.push('', `Cells where more than one action is legal: ${open} of ${cells.length}. Cells with exactly one legal action: ${cells.length - open}.`);
out.push(`Same action as the table: 4B ${pct(agree.local, seen.local)}, 120B ${pct(agree.hosted, seen.hosted)}.`);
out.push(`In the cells with more than one legal action: 4B ${pct(openAgree.local, openSeen.local)}, 120B ${pct(openAgree.hosted, openSeen.hosted)}.`);
out.push('Agreement is not accuracy: nobody has labelled these cells.', '');

const matches = [];
for (const c of CANDIDATE_CODES) for (const k of KEY_CODES) for (const n of NARROW_CODES) for (const r of REVERSE_CODES) for (const a of ATTEMPT_CODES) {
  matches.push({ candidateCode: c, keyCode: k, narrowCode: n, reverseCode: r, attemptCode: a, taskAlias: 'x', snapshotVersion: 1 });
}
const counts = {};
for (const m of matches) { const act = matchTable(m).action; counts[act] = (counts[act] || 0) + 1; }
const single = matches.filter(m => legalMatchActions(m).length === 1).length;
out.push(`## Recipient match: ${matches.length} cells`, '', `Table answers: ${Object.entries(counts).map(([a, n]) => `${a} ${n}`).join(', ')}.`,
  `Cells with exactly one legal action: ${single}; with more than one: ${matches.length - single}. The number of earlier failures never changes an answer.`,
  'Only the cells with one person, a passed reverse check and a name or number that was verified can answer CONFIRM.');
console.log(out.join('\n'));
