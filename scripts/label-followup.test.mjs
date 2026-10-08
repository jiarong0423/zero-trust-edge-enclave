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

test('parseActionSet is a set: order, case and ASCII separators do not matter; unknown words and repeats are reported', () => {
  assert.deepEqual(parseActionSet('escalate, wait'), { actions: ['WAIT', 'ESCALATE'], invalid: [], duplicates: [] });
  assert.deepEqual(parseActionSet('WAIT/remind;ESCALATE'), { actions: ['WAIT', 'REMIND', 'ESCALATE'], invalid: [], duplicates: [] });
  assert.deepEqual(parseActionSet(['REMIND', 'wait']), { actions: ['WAIT', 'REMIND'], invalid: [], duplicates: [] });
  assert.deepEqual(parseActionSet('WAIT, PANIC, panic'), { actions: ['WAIT'], invalid: ['PANIC', 'panic'], duplicates: [] });
  assert.deepEqual(parseActionSet(''), { actions: [], invalid: [], duplicates: [] });
  assert.deepEqual(parseActionSet(null), { actions: [], invalid: [], duplicates: [] });
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

test('a filled Markdown sheet round-trips; a note may contain an escaped pipe', async () => {
  const blank = renderSheet('md');
  const filled = fillMarkdown(blank, key => (key === 'WINDOW_LAST/PICKUP_NONE/0'
    ? ['ESCALATE, REMIND', 'remind', 'a \\| b'] : ['wait', 'WAIT', '']));
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
  const input = ttyInput(['', POLICY, 'bogus', 'WAIT', 'ESCALATE', 'wait', '', 'q']);
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

// --- Red-team fixes (B1-B10) -------------------------------------------------------------------------

// A complete CSV sheet (all 24 rows answered) with a chosen POLICY line, written the way a spreadsheet
// application would after a round trip when `pad` is set: every short row padded with trailing commas.
function completeCsv(policyLine, { pad = false } = {}) {
  const filled = fillCsv(renderSheet('csv'), () => ['WAIT, REMIND', 'WAIT', '']).split('\n')
    .map(line => (/^# POLICY:/.test(line) ? policyLine : line));
  return filled.map(line => (pad && line.startsWith('#') ? `${line}${','.repeat(7)}` : line)).join('\n');
}

test('B1: a blank policy stays blank after spreadsheet padding and is refused', () => {
  const padded = completeCsv('# POLICY: ', { pad: true });
  assert.match(padded, /^# POLICY: ,{7}$/m);
  const parsed = parseLabelsText(padded, 'csv');
  assert.equal(parsed.policy, '');
  const checked = checkLabels(parsed);
  assert.equal(checked.ok, false);
  assert.ok(checked.problems.some(problem => problem.includes('policy statement is empty')));
  // Padding must not change a real policy either, and a comma inside it survives.
  assert.equal(parseLabelsText(completeCsv('# POLICY: compliance first, then speed', { pad: true }), 'csv').policy,
    'compliance first, then speed');
});

test('B1: a policy with no letter or digit is no policy (punctuation, zero-width and space characters)', () => {
  for (const policy of ['-', '.', '\u200b', '\u00a0', '\ufeff', '\u3000', ',,,', '- . -', '\u2014\u2014']) {
    const checked = checkLabels(parseLabelsText(completeCsv(`# POLICY: ${policy}`), 'csv'));
    assert.equal(checked.ok, false, `policy ${JSON.stringify(policy)} must be refused`);
    assert.ok(checked.problems.some(problem => /policy statement is empty|no letter or digit/.test(problem)), JSON.stringify(policy));
  }
  const json = JSON.stringify({ schema: SCHEMA, policy: '.', labels: [] });
  assert.ok(checkLabels(parseLabelsText(json, 'json')).problems.some(problem => /no letter or digit/.test(problem)));
  for (const policy of ['A', '7', '\u5408\u898f\u512a\u5148', 'compliance-first!']) {
    assert.equal(checkLabels(parseLabelsText(completeCsv(`# POLICY: ${policy}`), 'csv')).ok, true, policy);
  }
});

test('B1: the interactive session refuses a policy without a letter or digit, and resume re-prompts a blank one', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'labels.json');
  const io = sinks();
  assert.equal(await main(['--interactive', '--labels-out', file], { ...io, stdin: ttyInput(['-', '\u200b', POLICY, 'q']) }), 0);
  assert.equal(io.lines.out.join('').match(/The policy statement cannot be empty/g).length, 2);
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).policy, POLICY);

  const blank = path.join(dir, 'blank.json');
  await fs.writeFile(blank, JSON.stringify({ schema: SCHEMA, policy: '  ', labels: [{ timeCode: 'WINDOW_FULL', pickupCode: 'PICKUP_NONE',
    nudgeCount: 0, acceptable: ['WAIT'], preferred: 'WAIT', note: 'kept' }] }));
  const second = sinks();
  assert.equal(await main(['--interactive', '--labels-out', blank, '--resume'], { ...second, stdin: ttyInput(['.', 'A new policy, written now', 'q']) }), 0);
  const output = second.lines.out.join('');
  assert.match(output, /policy on file is blank/i);
  assert.match(output, /Policy statement \(your own/);
  const doc = JSON.parse(await fs.readFile(blank, 'utf8'));
  assert.equal(doc.policy, 'A new policy, written now');
  assert.equal(doc.labels.length, 1, 'the earlier answer is kept');
  assert.equal(doc.labels[0].note, 'kept');

  // Input ending at the re-prompt leaves the file untouched.
  const untouched = path.join(dir, 'untouched.json');
  const text = JSON.stringify({ schema: SCHEMA, policy: '', labels: [] });
  await fs.writeFile(untouched, text);
  const ended = ttyInput();
  ended.end();
  assert.equal(await main(['--interactive', '--labels-out', untouched, '--resume'], { ...sinks(), stdin: ended }), 3);
  assert.equal(await fs.readFile(untouched, 'utf8'), text);
});

// A complete CSV whose row for WINDOW_FULL/PICKUP_NONE/0 carries the given raw (already quoted) note cell.
function csvWithNote(noteCell, policyLine = '# POLICY: the real policy') {
  return completeCsv(policyLine).split('\n').map(line => {
    if (!line.startsWith('12345678-1234-4234-8234-123456789012,1,WINDOW_FULL,PICKUP_NONE,0,')) return line;
    return `${line.split(',').slice(0, 5).join(',')},"WAIT, REMIND",WAIT,${noteCell}`;
  }).join('\n');
}

test('B2: lines inside a quoted note are note text, never comments or policy', () => {
  const text = csvWithNote('"first line\n# POLICY: convenience-first (injected)\n# second hash line\nlast line"');
  const parsed = parseLabelsText(text, 'csv');
  assert.equal(parsed.policy, 'the real policy');
  assert.deepEqual(parsed.problems, []);
  assert.equal(parsed.entries.get('WINDOW_FULL/PICKUP_NONE/0').note,
    'first line\n# POLICY: convenience-first (injected)\n# second hash line\nlast line');
  const checked = checkLabels(parsed);
  assert.deepEqual(checked.problems, []);
  assert.equal(checked.policy, 'the real policy');
});

test('B2: a note line that starts with # and holds the closing quote does not swallow the next row', () => {
  const text = csvWithNote('"see below\n#2 closing quote on a # line"');
  const parsed = parseLabelsText(text, 'csv');
  assert.equal(parsed.entries.size, 24);
  assert.equal(parsed.entries.get('WINDOW_FULL/PICKUP_NONE/0').note, 'see below\n#2 closing quote on a # line');
  assert.deepEqual(checkLabels(parsed).problems, []);
});

test('B2: # POLICY: is recognised only before the header row', () => {
  const lines = completeCsv('# POLICY: the real policy').split('\n');
  const afterHeader = [...lines, '# POLICY: convenience-first, appended after the table'].join('\n');
  const parsed = parseLabelsText(afterHeader, 'csv');
  assert.equal(parsed.policy, 'the real policy');
  assert.ok(parsed.problems.some(problem => problem.includes('not one of the 24 reachable inputs')),
    'a stray # line after the header is a problem, not a silently deleted line');
  assert.equal(checkLabels(parsed).ok, false);
});

test('B2: comment lines before the header are raw lines; a spreadsheet may quote them and pad them', () => {
  const quoted = ['"# a comment, with a comma",,,,,,,', '"# POLICY: speed, then safety",,,,,,,',
    ...completeCsv('# POLICY: ignored').split('\n').filter(line => !line.startsWith('#'))].join('\n');
  const parsed = parseLabelsText(quoted, 'csv');
  assert.equal(parsed.policy, 'speed, then safety');
  assert.deepEqual(checkLabels(parsed).problems, []);
  // A raw policy line may hold a comma followed by a quote; it is a line, not CSV.
  assert.equal(parseLabelsText(completeCsv('# POLICY: a, "b'), 'csv').policy, 'a, "b');
  // A leading byte order mark does not hide the comment lines.
  assert.equal(parseLabelsText(`\ufeff${completeCsv('# POLICY: with a BOM')}`, 'csv').policy, 'with a BOM');
});

test('B4: a Markdown row whose cell count differs from the header is refused, not repaired', () => {
  const ROW = '12345678-1234-4234-8234-123456789012 | 1 | WINDOW_FULL | PICKUP_NONE | 0';
  const base = fillMarkdown(renderSheet('md'), key => (key === 'WINDOW_FULL/PICKUP_NONE/0' ? null : allWait()));
  const withRow = row => `${base.trimEnd().replace(/^\| 12345678[^\n]*WINDOW_FULL \| PICKUP_NONE \| 0 \|[^\n]*$/m, row)}\n`;
  // The pipe shift: WAIT|WAIT in the acceptable cell, preferred left blank, would read as a complete label.
  const shifted = parseLabelsText(withRow(`| ${ROW} | WAIT|WAIT |  | n |`), 'md');
  assert.ok(shifted.problems.some(problem => /9 cells, the header has 8/.test(problem)), shifted.problems.join('; '));
  assert.equal(shifted.entries.has('WINDOW_FULL/PICKUP_NONE/0'), false);
  const checked = checkLabels(shifted);
  assert.equal(checked.ok, false);
  assert.equal(checked.labels.has('WINDOW_FULL/PICKUP_NONE/0'), false);
  // An unescaped pipe in the note is also a different cell count: refused with a hint.
  const note = parseLabelsText(withRow(`| ${ROW} | WAIT | WAIT | a | b |`), 'md');
  assert.ok(note.problems.some(problem => /escape a pipe in a note as \\\|/.test(problem)), note.problems.join('; '));
  // A short row is refused as well.
  const short = parseLabelsText(withRow(`| ${ROW} | WAIT | WAIT |`), 'md');
  assert.ok(short.problems.some(problem => /7 cells, the header has 8/.test(problem)), short.problems.join('; '));
  // An escaped pipe is the supported way to write one.
  const ok = parseLabelsText(withRow(`| ${ROW} | WAIT | WAIT | a \\| b |`), 'md');
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.entries.get('WINDOW_FULL/PICKUP_NONE/0').note, 'a | b');
});

test('B4: the pipe is not an action separator', () => {
  assert.deepEqual(parseActionSet('WAIT|REMIND'), { actions: [], invalid: ['WAIT|REMIND'], duplicates: [] });
  assert.equal(normalizeEntry({ acceptable: 'WAIT|WAIT', preferred: 'WAIT' }).state, 'invalid');
});

test('B5: lookalike letters, non-ASCII separators and numbers are not actions', () => {
  // Dotless i and long s upper-case into plain ASCII letters; they must be rejected before that happens.
  for (const word of ['WA\u0131T', 'rem\u0131nd', '\u017fcalate', 'E\u017fCALATE', 'W\u0410IT', '\uff37\uff21\uff29\uff34', 'WA\u200bIT', 'WAIT\u200b', 'K\u212aELVIN']) {
    const set = parseActionSet(word);
    assert.deepEqual(set.actions, [], JSON.stringify(word));
    assert.equal(set.invalid.length, 1, JSON.stringify(word));
    assert.equal(normalizeEntry({ acceptable: word, preferred: 'WAIT' }).state, 'invalid', JSON.stringify(word));
  }
  // A no-break space is not a separator: WAIT<NBSP>REMIND is one invalid word, not two actions.
  assert.deepEqual(parseActionSet('WAIT\u00a0REMIND').actions, []);
  assert.deepEqual(parseActionSet('WAIT\u2003REMIND').actions, []);
  assert.deepEqual(parseActionSet('WAIT\tREMIND\nESCALATE').actions, ['WAIT', 'REMIND', 'ESCALATE']);
  // Not strings.
  assert.deepEqual(parseActionSet(1).actions, []);
  assert.equal(parseActionSet(1).invalid.length, 1);
  assert.equal(parseActionSet([['WAIT']]).invalid.length, 1);
  assert.equal(parseActionSet({}).invalid.length, 1);
});

test('B5: a repeated action inside a set is refused, not collapsed', () => {
  assert.deepEqual(parseActionSet('WAIT, WAIT'), { actions: ['WAIT'], invalid: [], duplicates: ['WAIT'] });
  assert.deepEqual(parseActionSet(['REMIND', 'remind']).duplicates, ['REMIND']);
  const set = normalizeEntry({ acceptable: 'WAIT, WAIT', preferred: 'WAIT' });
  assert.equal(set.state, 'invalid');
  assert.match(set.problems.join(' '), /repeats WAIT/);
  const preferred = normalizeEntry({ acceptable: 'WAIT, REMIND', preferred: 'WAIT, WAIT' });
  assert.equal(preferred.state, 'invalid');
  assert.match(preferred.problems.join(' '), /preferred action/);
});

test('B5: JSON labels need a string timeCode and pickupCode and an integer nudgeCount, not coerced values', () => {
  const base = { timeCode: 'WINDOW_FULL', pickupCode: 'PICKUP_NONE', nudgeCount: 0, acceptable: 'WAIT', preferred: 'WAIT' };
  assert.equal(inputKey(base), 'WINDOW_FULL/PICKUP_NONE/0');
  for (const bad of [{ nudgeCount: '0' }, { nudgeCount: [0] }, { nudgeCount: 0.5 }, { nudgeCount: null }, { timeCode: ['WINDOW_FULL'] },
    { pickupCode: ['PICKUP_NONE'] }, { timeCode: 7 }]) {
    assert.equal(inputKey({ ...base, ...bad }), null, JSON.stringify(bad));
    const parsed = parseLabelsText(JSON.stringify({ schema: SCHEMA, policy: 'p', labels: [{ ...base, ...bad }] }), 'json');
    assert.equal(parsed.entries.size, 0, JSON.stringify(bad));
    assert.match(parsed.problems.join(' '), /label 1/, JSON.stringify(bad));
  }
  assert.equal(inputKey(null), null);
  assert.equal(inputKey('WINDOW_FULL'), null);
});

test('B5: the interactive session refuses a repeated or lookalike action', async () => {
  const dir = await tempDir();
  const io = sinks();
  const lines = [POLICY, 'WAIT, WAIT', 'WA\u0131T', 'WAIT\u00a0REMIND', 'WAIT, REMIND', 'WAIT, WAIT', 'WAIT', 'x', 'q'];
  assert.equal(await main(['--interactive', '--labels-out', path.join(dir, 'l.json')], { ...io, stdin: ttyInput(lines) }), 0);
  const output = io.lines.out.join('');
  assert.equal(output.match(/Not understood: use only/g).length, 3);
  assert.equal(output.match(/Not understood: give exactly one of/g).length, 1);
  const doc = JSON.parse(await fs.readFile(path.join(dir, 'l.json'), 'utf8'));
  assert.deepEqual(doc.labels.map(label => [label.acceptable, label.preferred]), [[['WAIT', 'REMIND'], 'WAIT']]);
});

test('B6: a policy typed with terminal escape sequences is stored and echoed without them', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'labels.json');
  const ESC = '\u001b';
  const typed = `${ESC}[2J${ESC}[1;31mCOMPLIANCE-FIRST${ESC}]0;pwned\u0007 \u009b31m end`;
  const first = sinks();
  assert.equal(await main(['--interactive', '--labels-out', file], { ...first, stdin: ttyInput([typed, 'q']) }), 0);
  assert.doesNotMatch(first.lines.out.join(''), /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
  assert.match(first.lines.out.join(''), /control characters were removed/i);
  const stored = JSON.parse(await fs.readFile(file, 'utf8')).policy;
  assert.doesNotMatch(stored, /[\u0000-\u001f\u007f-\u009f]/);
  assert.match(stored, /COMPLIANCE-FIRST/);

  // A file edited by hand to hold the raw sequences is cleaned on the way to the terminal.
  const doc = JSON.parse(await fs.readFile(file, 'utf8'));
  doc.policy = typed;
  await fs.writeFile(file, JSON.stringify(doc));
  const second = sinks();
  assert.equal(await main(['--interactive', '--labels-out', file, '--resume'], { ...second, stdin: ttyInput(['q']) }), 0);
  assert.doesNotMatch(second.lines.out.join(''), /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
  assert.match(second.lines.out.join(''), /Resuming\. Policy statement on file: .*COMPLIANCE-FIRST/);
});

test('B6: problem messages never echo raw control characters from a label file', () => {
  const doc = { schema: SCHEMA, policy: 'p', labels: [{ timeCode: 'WINDOW_FULL', pickupCode: 'PICKUP_NONE', nudgeCount: 0,
    acceptable: 'WAIT\u001b[2J\u009b', preferred: 'WAIT' }, { timeCode: 'WINDOW_FULL\u001b[2J', pickupCode: 'PICKUP_NONE', nudgeCount: 0 }] };
  const checked = checkLabels(parseLabelsText(JSON.stringify(doc), 'json'));
  assert.equal(checked.ok, false);
  assert.doesNotMatch(checked.problems.join('\n'), /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
});

const lockOf = file => `${file}.lock`;

test('B8: a second session on the same labels file is refused while the first runs, and the lock is released after', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'labels.json');
  const firstInput = ttyInput();
  const first = runInteractive({ input: firstInput, output: sinks().stdout, labelsOut: file });
  const saved = async () => { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return null; } };
  firstInput.write(`${POLICY}\n`);
  for (let attempt = 0; attempt < 400 && !(await saved()); attempt += 1) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(await exists(lockOf(file)), true, 'the lock exists while the session is open');

  const second = sinks();
  assert.equal(await main(['--interactive', '--labels-out', file, '--resume'], { ...second, stdin: ttyInput(['q']) }), 2);
  const message = second.lines.err.join('');
  assert.match(message, /another session/);
  assert.ok(message.includes(lockOf(file)));
  assert.match(message, /never deleted automatically|delete it yourself/);
  assert.equal(await exists(lockOf(file)), true, 'the refused session did not remove the first one\'s lock');
  const created = sinks();
  assert.equal(await main(['--interactive', '--labels-out', path.join(dir, 'other.json')], { ...created, stdin: ttyInput([POLICY, 'q']) }), 0,
    'a different labels file is not blocked');

  firstInput.write('WAIT\nWAIT\nfirst\nq\n');
  assert.equal((await first).code, 0);
  assert.equal(await exists(lockOf(file)), false, 'released on quit');
  assert.equal((await saved()).labels.length, 1, 'the first session\'s answer was not overwritten');
  assert.equal(await main(['--interactive', '--labels-out', file, '--resume'], { ...sinks(), stdin: ttyInput(['q']) }), 0);
  assert.equal(await exists(lockOf(file)), false);
});

test('B8: the lock is released at end of input and on errors, and a stale lock is never deleted automatically', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'labels.json');
  const ended = ttyInput([POLICY]);
  ended.end();
  assert.equal(await main(['--interactive', '--labels-out', file], { ...sinks(), stdin: ended }), 3);
  assert.equal(await exists(lockOf(file)), false, 'released at EOF');

  const damaged = path.join(dir, 'damaged.json');
  await fs.writeFile(damaged, '{ not json');
  assert.equal(await main(['--interactive', '--labels-out', damaged, '--resume'], { ...sinks(), stdin: ttyInput() }), 2);
  assert.equal(await exists(lockOf(damaged)), false, 'released after a refusal');

  const stale = path.join(dir, 'stale.json');
  await fs.writeFile(lockOf(stale), 'pid 1 from last week\n');
  const io = sinks();
  assert.equal(await main(['--interactive', '--labels-out', stale], { ...io, stdin: ttyInput([POLICY, 'q']) }), 2);
  assert.match(io.lines.err.join(''), /another session/);
  assert.equal(await fs.readFile(lockOf(stale), 'utf8'), 'pid 1 from last week\n', 'a stale lock is left for the owner to remove');
  assert.equal(await exists(stale), false, 'nothing was created behind a lock');
});

test('B9: a missing parent directory is a clean refusal, exit 2, not an uncaught exception', async () => {
  const dir = await tempDir();
  const sheet = path.join(dir, 'no-such-dir', 'sheet.md');
  const io = sinks();
  assert.equal(await main(['--sheet', sheet], io), 2);
  assert.match(io.lines.err.join(''), /ERROR cannot write .*ENOENT/);
  const labels = path.join(dir, 'no-such-dir', 'labels.json');
  const second = sinks();
  assert.equal(await main(['--interactive', '--labels-out', labels], { ...second, stdin: ttyInput([POLICY]) }), 2);
  assert.match(second.lines.err.join(''), /ERROR cannot (write|create)/);
  const run = spawnSync(process.execPath, [SCRIPT, '--sheet', sheet], { encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.doesNotMatch(run.stderr, /\n\s+at /);
});
