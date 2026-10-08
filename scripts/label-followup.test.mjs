import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ACTION_ORDER, ALL_INPUTS, EXCLUDED, EXCLUSION_NOTE, PICKUP_CODES, REACHABLE, SCHEMA, SHEET_COLUMNS, TIME_CODES,
  checkLabels, inputKey, kindOfPath, main, normalizeEntry, parseActionSet, parseArgs, parseCsv, parseLabelsText,
  readLabelsFile, renderLabelsDocument, renderSheet, replaceAtomically, runInteractive, writeNew, Refusal,
} from './label-followup.mjs';
import { ADVICE_KINDS } from '../file-adviser.js';
import { MAX_NUDGES, validateFollowupAdvice } from '../delivery-followup.js';

const SCRIPT = fileURLToPath(new URL('./label-followup.mjs', import.meta.url));
const POLICY = 'Synthetic test policy: compliance first, a person must see anything overdue.';

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'label-followup-'));
}

function sinks() {
  const lines = { out: [], err: [] };
  return { lines, stdout: { write: text => lines.out.push(text) }, stderr: { write: text => lines.err.push(text) } };
}

function ttyInput(lines = []) {
  const input = Object.assign(new PassThrough(), { isTTY: true });
  for (const line of lines) input.write(`${line}\n`);
  return input;
}

async function exists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}

// Fill a blank sheet the way a person would: `answers(key)` returns [acceptable, preferred, note] or null.
function fillMarkdown(text, answers, policy = POLICY) {
  return text.split('\n').map(line => {
    if (/^POLICY:/.test(line)) return `POLICY: ${policy}`;
    if (!line.startsWith('| 12345678')) return line;
    const cells = line.replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map(cell => cell.trim());
    const [, , timeCode, pickupCode, nudgeCount] = cells;
    const answer = answers(`${timeCode}/${pickupCode}/${nudgeCount}`);
    return `| ${[...cells.slice(0, 5), ...(answer ?? ['', '', ''])].join(' | ')} |`;
  }).join('\n');
}

function fillCsv(text, answers, policy = POLICY) {
  return text.split('\n').map(line => {
    if (/^# POLICY:/.test(line)) return `# POLICY: ${policy}`;
    if (!line.startsWith('12345678')) return line;
    const cells = line.split(',');
    const answer = answers(`${cells[2]}/${cells[3]}/${cells[4]}`);
    const filled = answer ?? ['', '', ''];
    return [...cells.slice(0, 5), ...filled.map(cell => (/[",]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell))].join(',');
  }).join('\n');
}

const allWait = () => ['WAIT', 'WAIT', ''];

test('the 24 reachable inputs are derived from the follow-up constants, not typed in', () => {
  assert.deepEqual(TIME_CODES, ['WINDOW_FULL', 'WINDOW_MOST', 'WINDOW_LITTLE', 'WINDOW_LAST']);
  assert.deepEqual(PICKUP_CODES, ['PICKUP_NONE', 'PICKUP_SOME', 'PICKUP_ALL']);
  assert.equal(ALL_INPUTS.length, TIME_CODES.length * PICKUP_CODES.length * (MAX_NUDGES + 1));
  assert.equal(REACHABLE.length, 24);
  assert.equal(EXCLUDED.length, 12);
  assert.ok(REACHABLE.every(input => input.pickupCode !== 'PICKUP_ALL'));
  assert.ok(EXCLUDED.every(input => input.pickupCode === 'PICKUP_ALL'));
  assert.equal(new Set(REACHABLE.map(inputKey)).size, 24);
  assert.ok(REACHABLE.every(input => ADVICE_KINDS.followup.accepts(input.metadata)));
  assert.deepEqual(Object.keys(REACHABLE[0].metadata), ['taskAlias', 'snapshotVersion', 'timeCode', 'nudgeCount', 'pickupCode']);
  assert.match(EXCLUSION_NOTE, /12 PICKUP_ALL inputs are excluded/);
  assert.match(EXCLUSION_NOTE, /unreachable/);
});

test('PICKUP_ALL is unreachable for the product: fixed code accepts only WAIT there', () => {
  const metadata = { taskAlias: 'a', snapshotVersion: 1, timeCode: 'WINDOW_LAST', nudgeCount: 0, pickupCode: 'PICKUP_ALL' };
  assert.throws(() => validateFollowupAdvice({ taskAlias: 'a', snapshotVersion: 1, action: 'ESCALATE', reasonCode: 'DEADLINE_NEAR' }, metadata));
  assert.deepEqual(ACTION_ORDER, ['WAIT', 'REMIND', 'ESCALATE']);
});

test('parseActionSet is a set: order, repeats, case and separators do not matter; unknown words are reported', () => {
  assert.deepEqual(parseActionSet('escalate, wait'), { actions: ['WAIT', 'ESCALATE'], invalid: [] });
  assert.deepEqual(parseActionSet('WAIT WAIT/remind;wait|ESCALATE'), { actions: ['WAIT', 'REMIND', 'ESCALATE'], invalid: [] });
  assert.deepEqual(parseActionSet(['REMIND', 'remind']), { actions: ['REMIND'], invalid: [] });
  assert.deepEqual(parseActionSet('WAIT, PANIC, panic'), { actions: ['WAIT'], invalid: ['PANIC'] });
  assert.deepEqual(parseActionSet(''), { actions: [], invalid: [] });
  assert.deepEqual(parseActionSet(null), { actions: [], invalid: [] });
});

test('normalizeEntry: unlabeled, invalid and complete', () => {
  assert.equal(normalizeEntry(undefined).state, 'unlabeled');
  assert.equal(normalizeEntry({ acceptable: '', preferred: ' ' }).state, 'unlabeled');
  assert.equal(normalizeEntry({ acceptable: [], preferred: '' }).state, 'unlabeled');
  assert.equal(normalizeEntry({ acceptable: 'WAIT', preferred: '' }).state, 'invalid');
  assert.equal(normalizeEntry({ acceptable: '', preferred: 'WAIT' }).state, 'invalid');
  assert.equal(normalizeEntry({ acceptable: 'WAIT', preferred: 'REMIND' }).state, 'invalid');
  assert.equal(normalizeEntry({ acceptable: 'WAIT, REMIND', preferred: 'WAIT, REMIND' }).state, 'invalid');
  assert.equal(normalizeEntry({ acceptable: 'WAIT, NOPE', preferred: 'WAIT' }).state, 'invalid');
  assert.equal(normalizeEntry({ acceptable: 'WAIT', preferred: 'NOPE' }).state, 'invalid');
  const done = normalizeEntry({ acceptable: 'escalate, remind', preferred: 'remind', note: '  because  ' });
  assert.deepEqual(done, { state: 'complete', problems: [], acceptable: ['REMIND', 'ESCALATE'], preferred: 'REMIND', note: 'because' });
});

test('--sheet writes a blank Markdown sheet: 24 rows, five-field projection, no answers, owner policy line', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'sheet.md');
  const io = sinks();
  assert.equal(await main(['--sheet', file], io), 0);
  const text = await fs.readFile(file, 'utf8');
  assert.match(text, /owner's judgement under the owner's own policy, compliance-first or not/);
  assert.match(text, /^POLICY: $/m);
  assert.match(text, /12 PICKUP_ALL inputs are excluded/);
  const rows = text.split('\n').filter(line => line.startsWith('| 12345678'));
  assert.equal(rows.length, 24);
  assert.ok(!text.includes('PICKUP_ALL |'), 'no PICKUP_ALL row on the sheet');
  for (const row of rows) {
    const cells = row.replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map(cell => cell.trim());
    assert.equal(cells.length, SHEET_COLUMNS.length);
    assert.deepEqual(cells.slice(5), ['', '', ''], 'acceptable, preferred and note start blank');
    assert.equal(cells[1], '1');
  }
  assert.match(text, /\| taskAlias \| snapshotVersion \| timeCode \| pickupCode \| nudgeCount \| acceptable_actions \| preferred_action \| note \|/);
  // The blank sheet is unusable until a person fills it.
  const parsed = parseLabelsText(text, 'md');
  const checked = checkLabels(parsed);
  assert.equal(checked.ok, false);
  assert.equal(checked.problems.filter(problem => problem.endsWith(': unlabeled')).length, 24);
  assert.ok(checked.problems.some(problem => problem.includes('policy statement is empty')));
});

test('--sheet never overwrites an existing file', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'sheet.md');
  await fs.writeFile(file, 'precious human work\n');
  const io = sinks();
  assert.equal(await main(['--sheet', file], io), 2);
  assert.match(io.lines.err.join(''), /already exists; refusing to overwrite/);
  assert.equal(await fs.readFile(file, 'utf8'), 'precious human work\n');
  await assert.rejects(writeNew(file, 'x'), Refusal);
  assert.equal(await fs.readFile(file, 'utf8'), 'precious human work\n');
});

test('a filled Markdown sheet round-trips; a note may contain a pipe', async () => {
  const blank = renderSheet('md');
  const filled = fillMarkdown(blank, key => (key === 'WINDOW_LAST/PICKUP_NONE/0'
    ? ['ESCALATE, REMIND', 'remind', 'a | b'] : ['wait', 'WAIT', '']));
  const checked = checkLabels(parseLabelsText(filled, 'md'));
  assert.deepEqual(checked.problems, []);
  assert.equal(checked.policy, POLICY);
  assert.deepEqual(checked.labels.get('WINDOW_LAST/PICKUP_NONE/0'), { acceptable: ['REMIND', 'ESCALATE'], preferred: 'REMIND', note: 'a | b' });
  assert.deepEqual(checked.labels.get('WINDOW_FULL/PICKUP_NONE/0'), { acceptable: ['WAIT'], preferred: 'WAIT', note: '' });
});

test('the CSV sheet round-trips: comments, policy line, quoted cells', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'sheet.csv');
  assert.equal(kindOfPath(file), 'csv');
  assert.equal(await main(['--sheet', file], sinks()), 0);
  const blank = await fs.readFile(file, 'utf8');
  assert.match(blank, /^# POLICY: $/m);
  assert.equal(blank.split('\n').filter(line => line.startsWith('12345678')).length, 24);
  const filled = fillCsv(blank, key => (key === 'WINDOW_MOST/PICKUP_SOME/1'
    ? ['WAIT', 'WAIT', 'said "no", twice'] : ['WAIT, REMIND', 'REMIND', '']), 'policy, with a comma and "quotes"');
  const parsed = parseLabelsText(filled, 'csv');
  assert.equal(parsed.policy, 'policy, with a comma and "quotes"');
  const checked = checkLabels(parsed);
  assert.deepEqual(checked.problems, []);
  assert.deepEqual(checked.labels.get('WINDOW_MOST/PICKUP_SOME/1'), { acceptable: ['WAIT'], preferred: 'WAIT', note: 'said "no", twice' });
  assert.deepEqual(checked.labels.get('WINDOW_LAST/PICKUP_NONE/2'), { acceptable: ['WAIT', 'REMIND'], preferred: 'REMIND', note: '' });
});

test('parseCsv handles quotes, doubled quotes, CRLF and embedded newlines', () => {
  assert.deepEqual(parseCsv('a,"b ""q"" c",d\r\n"x\ny",,z\n'), [['a', 'b "q" c', 'd'], ['x\ny', '', 'z']]);
  assert.throws(() => parseCsv('a,"open'), Refusal);
});

test('sheet problems are reported, not guessed: unknown rows, duplicates, bad columns', () => {
  const filled = fillMarkdown(renderSheet('md'), allWait);
  const extra = `${filled.trimEnd()}\n| 12345678-1234-4234-8234-123456789012 | 1 | WINDOW_FULL | PICKUP_ALL | 0 | WAIT | WAIT |  |\n`;
  assert.ok(checkLabels(parseLabelsText(extra, 'md')).problems.some(problem => problem.includes('not one of the 24 reachable inputs')));
  const dup = `${filled.trimEnd()}\n| 12345678-1234-4234-8234-123456789012 | 1 | WINDOW_FULL | PICKUP_NONE | 0 | WAIT | WAIT |  |\n`;
  assert.ok(checkLabels(parseLabelsText(dup, 'md')).problems.some(problem => problem.includes('appears more than once')));
  assert.throws(() => parseLabelsText('| timeCode | pickupCode |\n| --- | --- |\n', 'md'), Refusal);
  assert.throws(() => parseLabelsText('nothing here', 'md'), Refusal);
});

test('a label with a wrong preferred action is flagged by checkLabels', () => {
  const filled = fillMarkdown(renderSheet('md'), key => (key === 'WINDOW_LAST/PICKUP_NONE/0' ? ['WAIT', 'ESCALATE', ''] : allWait()));
  const checked = checkLabels(parseLabelsText(filled, 'md'));
  assert.equal(checked.ok, false);
  assert.deepEqual(checked.problems, ['WINDOW_LAST/PICKUP_NONE/0: preferred action ESCALATE is not inside the acceptable set']);
});

test('parseArgs: exactly one mode, required companions', () => {
  assert.throws(() => parseArgs([]), Refusal);
  assert.throws(() => parseArgs(['--sheet', 'a.md', '--interactive', '--labels-out', 'a.json']), Refusal);
  assert.throws(() => parseArgs(['--interactive']), Refusal);
  assert.throws(() => parseArgs(['--interactive', '--labels-out', 'a.txt']), Refusal);
  assert.throws(() => parseArgs(['--sheet', 'a.md', '--resume']), Refusal);
  assert.throws(() => parseArgs(['--sheet']), Refusal);
  assert.throws(() => parseArgs(['--bogus']), Refusal);
  assert.deepEqual(parseArgs(['--interactive', '--labels-out', 'a.json', '--resume']),
    { sheet: null, interactive: true, labelsOut: 'a.json', resume: true, help: false });
});

test('--interactive fails clearly when stdin is not a TTY, and writes nothing', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'labels.json');
  const io = sinks();
  assert.equal(await main(['--interactive', '--labels-out', file], { ...io, stdin: new PassThrough() }), 2);
  assert.match(io.lines.err.join(''), /stdin is not a TTY/);
  assert.equal(await exists(file), false);
  const run = spawnSync(process.execPath, [SCRIPT, '--interactive', '--labels-out', file], { input: 'WAIT\n', encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /ERROR .*not a TTY/);
  assert.equal(await exists(file), false);
});

// A scripted session: policy, then (acceptable, preferred, note) for each answered input.
const answerLines = (count, offset = 0) => {
  const lines = [];
  for (let index = 0; index < count; index += 1) {
    lines.push(index % 2 === 0 ? 'wait, remind' : 'escalate', index % 2 === 0 ? 'remind' : 'ESCALATE', `note ${offset + index}`);
  }
  return lines;
};

test('--interactive walks all 24 inputs and saves a complete, scoreable labels file', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'labels.json');
  const input = ttyInput([POLICY, ...answerLines(24)]);
  const io = sinks();
  const code = await main(['--interactive', '--labels-out', file], { ...io, stdin: input });
  assert.equal(code, 0);
  const output = io.lines.out.join('');
  assert.match(output, /\[1\/24\]/);
  assert.match(output, /\[24\/24\]/);
  assert.match(output, /12 PICKUP_ALL inputs are excluded/);
  assert.match(output, /24 of 24 inputs are labelled/);
  const doc = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(doc.schema, SCHEMA);
  assert.equal(doc.policy, POLICY);
  assert.equal(doc.labels.length, 24);
  assert.deepEqual(doc.labels.map(label => inputKey(label)), REACHABLE.map(inputKey));
  assert.equal(doc.labels[0].preferred, 'REMIND');
  assert.deepEqual(doc.labels[0].acceptable, ['WAIT', 'REMIND']);
  assert.equal(doc.labels[1].note, 'note 1');
  const checked = checkLabels(await readLabelsFile(file));
  assert.deepEqual(checked.problems, []);
  assert.deepEqual((await fs.readdir(dir)).sort(), ['labels.json']);
});

test('--interactive refuses to overwrite and re-asks on bad answers; it never prefills a preferred action', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'labels.json');
  await fs.writeFile(file, 'keep me\n');
  const refused = sinks();
  assert.equal(await main(['--interactive', '--labels-out', file], { ...refused, stdin: ttyInput([POLICY]) }), 2);
  assert.match(refused.lines.err.join(''), /already exists; refusing to overwrite/);
  assert.equal(await fs.readFile(file, 'utf8'), 'keep me\n');

  const fresh = path.join(dir, 'fresh.json');
  const io = sinks();
  const input = ttyInput(['', POLICY, 'bogus', 'WAIT', 'ESCALATE', 'WAIT, WAIT', '', 'q']);
  assert.equal(await main(['--interactive', '--labels-out', fresh], { ...io, stdin: input }), 0);
  const output = io.lines.out.join('');
  assert.match(output, /The policy statement cannot be empty/);
  assert.match(output, /Not understood: use only WAIT, REMIND, ESCALATE/);
  assert.match(output, /Not understood: give exactly one of WAIT/);
  const doc = JSON.parse(await fs.readFile(fresh, 'utf8'));
  assert.equal(doc.labels.length, 1);
  assert.deepEqual(doc.labels[0], { timeCode: 'WINDOW_FULL', pickupCode: 'PICKUP_NONE', nudgeCount: 0,
    acceptable: ['WAIT'], preferred: 'WAIT', note: '' });
});

test('a single acceptable action still needs the person to name the preferred one', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'labels.json');
  const input = ttyInput([POLICY, 'REMIND']);
  input.end();
  const { code } = await runInteractive({ input, output: sinks().stdout, labelsOut: file });
  assert.equal(code, 3, 'input ended while the preferred action was still unanswered');
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).labels.length, 0);
});

test('resuming keeps every earlier answer, asks only the rest, and rewrites atomically', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'labels.json');
  const first = sinks();
  // Three inputs answered, the fourth skipped with Enter, the fifth answered, then quit.
  const lines = [POLICY, ...answerLines(3), '', 'wait', 'WAIT', 'five', 'q'];
  assert.equal(await main(['--interactive', '--labels-out', file], { ...first, stdin: ttyInput(lines) }), 0);
  const afterFirst = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(afterFirst.labels.map(label => inputKey(label)), [REACHABLE[0], REACHABLE[1], REACHABLE[2], REACHABLE[4]].map(inputKey));
  assert.match(first.lines.out.join(''), /4 of 24 inputs are labelled/);

  const second = sinks();
  const rest = answerLines(20, 100);
  assert.equal(await main(['--interactive', '--labels-out', file, '--resume'], { ...second, stdin: ttyInput(rest) }), 0);
  const output = second.lines.out.join('');
  assert.match(output, /Resuming\. Policy statement on file: Synthetic test policy/);
  assert.doesNotMatch(output, /Policy statement \(your own/);
  assert.match(output, /\[4\/24\]/, 'the skipped input is asked again');
  assert.doesNotMatch(output, /\[1\/24\]/, 'answered inputs are not asked again');
  assert.match(output, /24 of 24 inputs are labelled/);
  const final = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(final.labels.length, 24);
  assert.equal(final.policy, POLICY);
  for (const earlier of afterFirst.labels) {
    const kept = final.labels.find(label => inputKey(label) === inputKey(earlier));
    assert.deepEqual(kept, earlier);
  }
  assert.deepEqual((await fs.readdir(dir)).sort(), ['labels.json']);
  assert.deepEqual(checkLabels(await readLabelsFile(file)).problems, []);
});

test('an input that ends early still leaves the answers given so far, exit code 3', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'labels.json');
  const input = ttyInput([POLICY, ...answerLines(5)]);
  input.end();
  const io = sinks();
  assert.equal(await main(['--interactive', '--labels-out', file], { ...io, stdin: input }), 3);
  assert.match(io.lines.out.join(''), /Input ended; progress is saved\. 5 of 24 inputs are labelled/);
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).labels.length, 5);
});

test('every answer is on disk before the next prompt is answered', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'labels.json');
  const input = ttyInput();
  const output = sinks();
  const running = runInteractive({ input, output: output.stdout, labelsOut: file });
  const waitFor = async condition => {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (await condition()) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('timed out waiting for the session');
  };
  const savedCount = async () => {
    try { return JSON.parse(await fs.readFile(file, 'utf8')).labels.length; } catch { return -1; }
  };
  input.write(`${POLICY}\n`);
  await waitFor(async () => (await savedCount()) === 0);
  input.write('WAIT\nWAIT\nfirst\n');
  await waitFor(async () => (await savedCount()) === 1);
  input.write('REMIND, ESCALATE\nESCALATE\nsecond\n');
  await waitFor(async () => (await savedCount()) === 2);
  input.write('q\n');
  assert.equal((await running).code, 0);
  assert.equal(await savedCount(), 2);
});

test('--resume refuses a missing file, a damaged file and a sheet', async () => {
  const dir = await tempDir();
  const missing = path.join(dir, 'missing.json');
  const io = sinks();
  assert.equal(await main(['--interactive', '--labels-out', missing, '--resume'], { ...io, stdin: ttyInput() }), 2);
  assert.match(io.lines.err.join(''), /cannot read the labels file/);
  const damaged = path.join(dir, 'damaged.json');
  await fs.writeFile(damaged, '{ not json');
  assert.equal(await main(['--interactive', '--labels-out', damaged, '--resume'], { ...sinks(), stdin: ttyInput() }), 2);
  assert.equal(await fs.readFile(damaged, 'utf8'), '{ not json');
});

test('replaceAtomically replaces content and leaves no temporary file', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'x.txt');
  await fs.writeFile(file, 'old');
  await replaceAtomically(file, 'new');
  assert.equal(await fs.readFile(file, 'utf8'), 'new');
  assert.deepEqual(await fs.readdir(dir), ['x.txt']);
});

test('renderLabelsDocument keeps entries in grid order and answers exactly as given', () => {
  const entries = new Map([
    ['WINDOW_LAST/PICKUP_SOME/2', { acceptable: ['ESCALATE'], preferred: 'ESCALATE', note: 'late' }],
    ['WINDOW_FULL/PICKUP_NONE/0', { acceptable: ['WAIT'], preferred: 'WAIT' }],
  ]);
  const doc = JSON.parse(renderLabelsDocument('p', entries));
  assert.deepEqual(doc.labels.map(label => inputKey(label)), ['WINDOW_FULL/PICKUP_NONE/0', 'WINDOW_LAST/PICKUP_SOME/2']);
  assert.equal(doc.labels[0].note, '');
});

test('the label tools contain no model or network call and offer no default label', async () => {
  const source = await fs.readFile(SCRIPT, 'utf8');
  assert.doesNotMatch(source, /\bfetch\(|node:http|node:https|node:net|XMLHttpRequest|process\.env/);
  assert.doesNotMatch(source, /syntheticFollowupAdvice|requestFileAdvice/);
});
