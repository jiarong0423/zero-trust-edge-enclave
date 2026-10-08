import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ACTION_ORDER, ALL_INPUTS, REACHABLE, Refusal, inputKey, renderLabelsDocument, renderSheet } from './label-followup.mjs';
import { syntheticFollowupAdvice } from '../delivery-followup.js';
import {
  classify, fixtureSource, main, parseArgs, scoreSource, sourcesFromResults,
} from './score-labels.mjs';

const SCRIPT = fileURLToPath(new URL('./score-labels.mjs', import.meta.url));
const POLICY = 'Synthetic test policy: an overdue delivery must reach a person.';
const REASON = 'WINDOW_EARLY';

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'score-labels-'));
}

function sinks() {
  const lines = { out: [], err: [] };
  return { lines, stdout: { write: text => lines.out.push(text) }, stderr: { write: text => lines.err.push(text) } };
}

async function exists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}

// Synthetic labels. WINDOW_LAST inputs accept only ESCALATE; every other input accepts WAIT or REMIND
// and prefers REMIND. These are test data, not a claim about the right answers.
const testLabel = input => (input.timeCode === 'WINDOW_LAST'
  ? { acceptable: ['ESCALATE'], preferred: 'ESCALATE' } : { acceptable: ['WAIT', 'REMIND'], preferred: 'REMIND' });

async function writeLabels(dir, { policy = POLICY, label = testLabel, skip = [], name = 'labels.json' } = {}) {
  const entries = new Map();
  for (const input of REACHABLE) {
    if (skip.includes(inputKey(input))) continue;
    entries.set(inputKey(input), { ...label(input), note: '' });
  }
  const file = path.join(dir, name);
  await fs.writeFile(file, renderLabelsDocument(policy, entries));
  return file;
}

const gridRow = (input, extra) => ({ timeCode: input.timeCode, pickupCode: input.pickupCode, nudgeCount: input.nudgeCount, ...extra });
const fixtureOf = input => {
  const advice = syntheticFollowupAdvice(input.metadata);
  return `${advice.action}/${advice.reasonCode}`;
};

// Small synthetic copies of the saved formats.
const compareLocal = answer => ({
  summary: { mode: 'local', cases: 36, model: 'synthetic-4b', accepted: 0 },
  rows: ALL_INPUTS.map(input => {
    const action = answer(input);
    return gridRow(input, action
      ? { fixture: fixtureOf(input), model: `${action}/${REASON}`, accepted: true, sameAction: false, ms: 10 }
      : { fixture: fixtureOf(input), accepted: false, model: null, error: 'FOLLOWUP_REASON_INCOHERENT', sameAction: false, ms: 10 });
  }),
});
const compareCloud = (local, cloud) => ({
  model: 'synthetic/120b',
  summary: { calls: 36 },
  rows: ALL_INPUTS.map(input => gridRow(input, {
    fixture: fixtureOf(input),
    local4b: local(input) ? `${local(input)}/${REASON}` : null,
    cloud120b: `${cloud(input)}/${REASON}`,
    accepted: true,
    ms: 5,
  })),
});
const promptVariants = variants => ({
  model: 'synthetic-4b',
  summary: {},
  rows: Object.entries(variants).flatMap(([variant, answer]) => ALL_INPUTS.map(input => gridRow(input, {
    variant, fixture: fixtureOf(input), model: `${answer(input)}/${REASON}`, accepted: true, ms: 7,
  }))),
});
const benchFile = answer => ({
  schema: 'bench-adviser/1',
  outlets: { cloud: { provider: 'nebius', model: 'synthetic/bench' } },
  rows: ALL_INPUTS.map(input => gridRow(input, {
    fixture: fixtureOf(input),
    outlets: { cloud: answer(input) ? { accepted: true, advice: `${answer(input)}/${REASON}`, ms: 3 } : { accepted: false, advice: null, error: 'X', ms: 3 } },
  })),
});

const constant = action => () => action;

test('classify: every pair of single actions', () => {
  const expected = {
    WAIT: { WAIT: 'acceptable', REMIND: 'under', ESCALATE: 'under' },
    REMIND: { WAIT: 'over', REMIND: 'acceptable', ESCALATE: 'under' },
    ESCALATE: { WAIT: 'over', REMIND: 'over', ESCALATE: 'acceptable' },
  };
  for (const answer of ACTION_ORDER) {
    for (const accepted of ACTION_ORDER) {
      assert.equal(classify(answer, [accepted]), expected[answer][accepted], `${answer} against {${accepted}}`);
    }
  }
});

test('classify: every non-empty acceptable set against every action, checked with an independent oracle', () => {
  const rank = { WAIT: 0, REMIND: 1, ESCALATE: 2 };
  let sets = 0;
  for (let mask = 1; mask < 8; mask += 1) {
    const acceptable = ACTION_ORDER.filter((_, bit) => mask & (1 << bit));
    sets += 1;
    for (const answer of ACTION_ORDER) {
      let expected;
      if (acceptable.includes(answer)) expected = 'acceptable';
      else if (acceptable.every(item => rank[answer] > rank[item])) expected = 'over';
      else if (acceptable.every(item => rank[answer] < rank[item])) expected = 'under';
      else expected = 'between';
      assert.equal(classify(answer, acceptable), expected, `${answer} against {${acceptable.join(',')}}`);
    }
  }
  assert.equal(sets, 7);
  assert.equal(classify('REMIND', ['WAIT', 'ESCALATE']), 'between');
  assert.equal(classify('WAIT', ['REMIND', 'ESCALATE']), 'under');
  assert.equal(classify('ESCALATE', ['WAIT', 'REMIND']), 'over');
});

test('refuses to score when any reachable input is unlabeled, and writes nothing', async () => {
  const dir = await tempDir();
  const results = path.join(dir, 'results.json');
  await fs.writeFile(results, JSON.stringify(compareLocal(constant('WAIT'))));
  const labels = await writeLabels(dir, { skip: ['WINDOW_LAST/PICKUP_NONE/0', 'WINDOW_FULL/PICKUP_SOME/2'] });
  const out = path.join(dir, 'report.md');
  const io = sinks();
  assert.equal(await main(['--labels', labels, '--results', results, '--out', out], io), 2);
  const errors = io.lines.err.join('');
  assert.match(errors, /refusing to score/);
  assert.match(errors, /WINDOW_LAST\/PICKUP_NONE\/0: unlabeled/);
  assert.match(errors, /WINDOW_FULL\/PICKUP_SOME\/2: unlabeled/);
  assert.equal(io.lines.out.join(''), '');
  assert.equal(await exists(out), false);
});

test('refuses when the preferred action is outside the acceptable set', async () => {
  const dir = await tempDir();
  const results = path.join(dir, 'results.json');
  await fs.writeFile(results, JSON.stringify(compareLocal(constant('WAIT'))));
  const labels = await writeLabels(dir, {
    label: input => (inputKey(input) === 'WINDOW_MOST/PICKUP_NONE/1'
      ? { acceptable: ['WAIT'], preferred: 'ESCALATE' } : testLabel(input)),
  });
  const io = sinks();
  assert.equal(await main(['--labels', labels, '--results', results], io), 2);
  assert.match(io.lines.err.join(''), /WINDOW_MOST\/PICKUP_NONE\/1: preferred action ESCALATE is not inside the acceptable set/);
  assert.equal(io.lines.out.join(''), '');
});

test('refuses when the policy statement is empty, and on a blank sheet', async () => {
  const dir = await tempDir();
  const results = path.join(dir, 'results.json');
  await fs.writeFile(results, JSON.stringify(compareLocal(constant('WAIT'))));
  const noPolicy = await writeLabels(dir, { policy: '   ', name: 'nopolicy.json' });
  const io = sinks();
  assert.equal(await main(['--labels', noPolicy, '--results', results], io), 2);
  assert.match(io.lines.err.join(''), /policy statement is empty/);
  const sheet = path.join(dir, 'blank.md');
  await fs.writeFile(sheet, renderSheet('md'));
  const blank = sinks();
  assert.equal(await main(['--labels', sheet, '--results', results], blank), 2);
  assert.match(blank.lines.err.join(''), /24 reachable inputs need a human label|All 24 reachable inputs need a human label/);
  assert.equal(blank.lines.out.join(''), '');
});

test('refuses unreadable or non-grid result files before writing a report', async () => {
  const dir = await tempDir();
  const labels = await writeLabels(dir);
  const out = path.join(dir, 'report.md');
  const missing = sinks();
  assert.equal(await main(['--labels', labels, '--results', path.join(dir, 'nope.json'), '--out', out], missing), 2);
  assert.match(missing.lines.err.join(''), /cannot read/);
  const broken = path.join(dir, 'broken.json');
  await fs.writeFile(broken, '{ nope');
  assert.equal(await main(['--labels', labels, '--results', broken, '--out', out], sinks()), 2);
  const reasoning = path.join(dir, 'reasoning.json');
  await fs.writeFile(reasoning, JSON.stringify({ model: 'm', bySetting: {}, rows: [{ setting: 'none', case: '1 just approved', fixture: 'WAIT/WINDOW_EARLY', model: 'WAIT/NO_PICKUP_YET' }] }));
  const io = sinks();
  assert.equal(await main(['--labels', labels, '--results', reasoning, '--out', out], io), 2);
  assert.match(io.lines.err.join(''), /lacks timeCode, pickupCode or nudgeCount/);
  assert.equal(await exists(out), false);
});

test('scores WAIT-everywhere and ESCALATE-everywhere with hand-computed counts', () => {
  const labels = new Map(REACHABLE.map(input => [inputKey(input), testLabel(input)]));
  const answers = action => new Map(REACHABLE.map(input => [inputKey(input), action]));
  // 6 WINDOW_LAST inputs accept only ESCALATE; the other 18 accept WAIT or REMIND and prefer REMIND.
  const wait = scoreSource(labels, { name: 'wait', answers: answers('WAIT') });
  assert.deepEqual(wait.totals, { inputs: 24, answered: 24, acceptable: 18, preferred: 0, over: 0, under: 6, between: 0, none: 0 });
  const escalate = scoreSource(labels, { name: 'escalate', answers: answers('ESCALATE') });
  assert.deepEqual(escalate.totals, { inputs: 24, answered: 24, acceptable: 6, preferred: 6, over: 18, under: 0, between: 0, none: 0 });
  const remind = scoreSource(labels, { name: 'remind', answers: answers('REMIND') });
  assert.deepEqual(remind.totals, { inputs: 24, answered: 24, acceptable: 18, preferred: 18, over: 0, under: 6, between: 0, none: 0 });
  assert.equal(wait.rows.filter(row => row.category === 'under').every(row => row.key.startsWith('WINDOW_LAST/')), true);
});

test('set semantics: any member of the set is acceptable, only the preferred one is preferred, a gap is neither over nor under', () => {
  const labels = new Map(REACHABLE.map(input => [inputKey(input), { acceptable: ['WAIT', 'ESCALATE'], preferred: 'ESCALATE' }]));
  const score = action => scoreSource(labels, { name: action, answers: new Map(REACHABLE.map(input => [inputKey(input), action])) }).totals;
  assert.deepEqual(score('WAIT'), { inputs: 24, answered: 24, acceptable: 24, preferred: 0, over: 0, under: 0, between: 0, none: 0 });
  assert.deepEqual(score('ESCALATE'), { inputs: 24, answered: 24, acceptable: 24, preferred: 24, over: 0, under: 0, between: 0, none: 0 });
  assert.deepEqual(score('REMIND'), { inputs: 24, answered: 24, acceptable: 0, preferred: 0, over: 0, under: 0, between: 24, none: 0 });
});

test('a missing, null or refused answer is "no answer": not acceptable, not over, not under', () => {
  const labels = new Map(REACHABLE.map(input => [inputKey(input), testLabel(input)]));
  const answers = new Map(REACHABLE.map(input => [inputKey(input), 'REMIND']));
  answers.set(inputKey(REACHABLE[0]), null);
  answers.delete(inputKey(REACHABLE[1]));
  const scored = scoreSource(labels, { name: 'partial', answers });
  assert.equal(scored.totals.none, 2);
  assert.equal(scored.totals.answered, 22);
  assert.equal(scored.rows[0].action, null);
  assert.equal(scored.rows[1].category, 'none');
});

test('the fixture source is the live syntheticFollowupAdvice over the 24 reachable inputs', () => {
  const source = fixtureSource();
  assert.equal(source.answers.size, 24);
  for (const input of REACHABLE) assert.equal(source.answers.get(inputKey(input)), syntheticFollowupAdvice(input.metadata).action);
  const labels = new Map(REACHABLE.map(input => [inputKey(input), testLabel(input)]));
  // WINDOW_LAST (6): ESCALATE, acceptable and preferred. nudgeCount 2 outside WINDOW_LAST (6): ESCALATE,
  // over. WINDOW_FULL with fewer than 2 reminders (4): WAIT, acceptable. WINDOW_MOST and WINDOW_LITTLE
  // with fewer than 2 reminders (8): REMIND, acceptable and preferred.
  assert.deepEqual(scoreSource(labels, source).totals,
    { inputs: 24, answered: 24, acceptable: 18, preferred: 14, over: 6, under: 0, between: 0, none: 0 });
});

test('parses the local compare format: null model is no answer, PICKUP_ALL rows are ignored', () => {
  const doc = compareLocal(input => (inputKey(input) === 'WINDOW_FULL/PICKUP_SOME/0' ? null : 'WAIT'));
  doc.rows[0].somethingExtra = { nested: true };
  const parsed = sourcesFromResults(doc, 'followup-compare.json');
  assert.equal(parsed.sources.length, 1);
  assert.equal(parsed.ignoredUnreachable, 12);
  assert.equal(parsed.fixtureMismatches, 0);
  const [source] = parsed.sources;
  assert.match(source.name, /followup-compare\.json: model \(synthetic-4b\)/);
  assert.equal(source.answers.size, 24);
  assert.equal(source.answers.get('WINDOW_FULL/PICKUP_SOME/0'), null);
  assert.equal(source.answers.get('WINDOW_LAST/PICKUP_NONE/2'), 'WAIT');
});

test('parses the compare-cloud format into two sources', () => {
  const parsed = sourcesFromResults(compareCloud(input => (input.nudgeCount === 0 ? null : 'WAIT'), constant('REMIND')), 'cloud.json');
  assert.deepEqual(parsed.sources.map(source => source.name.replace('cloud.json: ', '')), ['local4b', 'cloud120b (synthetic/120b)']);
  assert.equal(parsed.sources[0].answers.get('WINDOW_MOST/PICKUP_NONE/0'), null);
  assert.equal(parsed.sources[0].answers.get('WINDOW_MOST/PICKUP_NONE/1'), 'WAIT');
  assert.equal(parsed.sources[1].answers.get('WINDOW_LAST/PICKUP_SOME/2'), 'REMIND');
});

test('parses the prompt-variants format into one source per variant', () => {
  const parsed = sourcesFromResults(promptVariants({ current: constant('WAIT'), table: constant('ESCALATE') }), 'variants.json');
  assert.equal(parsed.sources.length, 2);
  assert.match(parsed.sources[0].name, /model \[variant current\]/);
  assert.match(parsed.sources[1].name, /model \[variant table\]/);
  assert.equal(parsed.sources[0].answers.size, 24);
  assert.equal(parsed.sources[1].answers.get('WINDOW_FULL/PICKUP_NONE/0'), 'ESCALATE');
});

test('parses the bench-adviser format: outlets, with accepted:false as no answer', () => {
  const parsed = sourcesFromResults(benchFile(input => (input.timeCode === 'WINDOW_LAST' ? null : 'REMIND')), 'bench.json');
  assert.equal(parsed.sources.length, 1);
  assert.match(parsed.sources[0].name, /bench\.json: outlets\.cloud \(synthetic\/bench\)/);
  assert.equal(parsed.sources[0].answers.get('WINDOW_LAST/PICKUP_NONE/0'), null);
  assert.equal(parsed.sources[0].answers.get('WINDOW_MOST/PICKUP_NONE/0'), 'REMIND');
});

test('a row marked accepted:false has no usable model answer even when the refused text is kept', () => {
  const doc = promptVariants({ current: constant('WAIT') });
  const target = doc.rows.find(row => row.timeCode === 'WINDOW_FULL' && row.pickupCode === 'PICKUP_SOME' && row.nudgeCount === 0);
  Object.assign(target, { accepted: false, error: 'FOLLOWUP_REASON_INCOHERENT', model: 'WAIT/NO_PICKUP_YET' });
  const [source] = sourcesFromResults(doc, 'variants.json').sources;
  assert.equal(source.answers.get('WINDOW_FULL/PICKUP_SOME/0'), null);
  assert.equal(source.answers.get('WINDOW_FULL/PICKUP_SOME/1'), 'WAIT');
  const cloud = compareCloud(constant('WAIT'), constant('WAIT'));
  const row = cloud.rows.find(item => item.timeCode === 'WINDOW_FULL' && item.pickupCode === 'PICKUP_SOME' && item.nudgeCount === 0);
  Object.assign(row, { accepted: false });
  const [local, hosted] = sourcesFromResults(cloud, 'cloud.json').sources;
  assert.equal(local.answers.get('WINDOW_FULL/PICKUP_SOME/0'), 'WAIT', 'accepted describes cloud120b only');
  assert.equal(hosted.answers.get('WINDOW_FULL/PICKUP_SOME/0'), null);
});

test('flags a fixture column that differs from the live fixture', () => {
  const doc = compareLocal(constant('WAIT'));
  const target = doc.rows.find(row => row.timeCode === 'WINDOW_LAST' && row.pickupCode === 'PICKUP_NONE' && row.nudgeCount === 0);
  target.fixture = 'WAIT/WINDOW_EARLY';
  assert.equal(sourcesFromResults(doc, 'x.json').fixtureMismatches, 1);
});

test('result files that cannot be scored are refused with a reason', () => {
  assert.throws(() => sourcesFromResults(null, 'x.json'), Refusal);
  assert.throws(() => sourcesFromResults({ rows: 'no' }, 'x.json'), Refusal);
  assert.throws(() => sourcesFromResults({ rows: [] }, 'x.json'), /nothing to score/);
  assert.throws(() => sourcesFromResults({ rows: [{ timeCode: 'WINDOW_FULL', pickupCode: 'PICKUP_NONE', nudgeCount: 0, fixture: 'WAIT/WINDOW_EARLY' }] }, 'x.json'), /nothing to score/);
  assert.throws(() => sourcesFromResults({ rows: [{ timeCode: 'WINDOW_SOON', pickupCode: 'PICKUP_NONE', nudgeCount: 0, model: 'WAIT/X' }] }, 'x.json'), /not one of the follow-up inputs/);
  assert.throws(() => sourcesFromResults({ rows: [{ timeCode: 'WINDOW_FULL', pickupCode: 'PICKUP_NONE', nudgeCount: 0, model: 'PANIC/X' }] }, 'x.json'), /unrecognised action/);
  assert.throws(() => sourcesFromResults({ rows: [{ timeCode: 'WINDOW_FULL', pickupCode: 'PICKUP_NONE', nudgeCount: 0, model: 7 }] }, 'x.json'), /expected an "ACTION\/REASON" string/);
  const twice = { rows: [
    { timeCode: 'WINDOW_FULL', pickupCode: 'PICKUP_NONE', nudgeCount: 0, model: 'WAIT/X' },
    { timeCode: 'WINDOW_FULL', pickupCode: 'PICKUP_NONE', nudgeCount: 0, model: 'WAIT/X' },
  ] };
  assert.throws(() => sourcesFromResults(twice, 'x.json'), /appears twice/);
});

test('parseArgs: several result files, repeated flags, required options', () => {
  assert.deepEqual(parseArgs(['--labels', 'l.json', '--results', 'a.json', 'b.json', '--out', 'r.md', '--results', 'c.json']),
    { labels: 'l.json', results: ['a.json', 'b.json', 'c.json'], out: 'r.md', help: false });
  assert.throws(() => parseArgs(['--results', 'a.json']), Refusal);
  assert.throws(() => parseArgs(['--labels', 'l.json']), Refusal);
  assert.throws(() => parseArgs(['--labels', 'l.json', '--results']), Refusal);
  assert.throws(() => parseArgs(['--labels']), Refusal);
  assert.throws(() => parseArgs(['--nope']), Refusal);
});

test('end to end: report to stdout, then --out once and never twice', async () => {
  const dir = await tempDir();
  const labels = await writeLabels(dir);
  const one = path.join(dir, 'one.json');
  const two = path.join(dir, 'two.json');
  await fs.writeFile(one, JSON.stringify(compareLocal(constant('WAIT'))));
  await fs.writeFile(two, JSON.stringify(compareCloud(constant('WAIT'), constant('ESCALATE'))));

  const io = sinks();
  assert.equal(await main(['--labels', labels, '--results', one, two], io), 0);
  const report = io.lines.out.join('');
  assert.match(report, /12 PICKUP_ALL inputs are excluded/);
  assert.match(report, /unreachable/);
  assert.match(report, /every rate is out of 24 inputs/);
  assert.match(report, new RegExp(`> ${POLICY}`));
  assert.match(report, /\| fixture \(syntheticFollowupAdvice/);
  assert.match(report, /one\.json: model \(synthetic-4b\) \| 24\/24 \(100\.0%\) \| 18\/24 \(75\.0%\) \| 18\/24 \(75\.0%\) \| 0\/24 \(0\.0%\) \| 0\/24 \(0\.0%\) \| 6\/24 \(25\.0%\)/);
  assert.match(report, /two\.json: cloud120b \(synthetic\/120b\) \| 24\/24 \(100\.0%\) \| 6\/24 \(25\.0%\) \| 6\/24 \(25\.0%\) \| 6\/24 \(25\.0%\) \| 18\/24 \(75\.0%\)/);
  assert.match(report, /\| fixture \(syntheticFollowupAdvice[^|]*\| 24\/24 \(100\.0%\) \| 18\/24 \(75\.0%\) \| 18\/24 \(75\.0%\) \| 14\/24 \(58\.3%\) \| 6\/24 \(25\.0%\)/);
  assert.match(report, /### two\.json: cloud120b/);
  assert.match(report, /\| WINDOW_FULL\/PICKUP_NONE\/0 \| WAIT, REMIND \| REMIND \| ESCALATE \| over-action \|/);
  assert.match(report, /\| WINDOW_LAST\/PICKUP_NONE\/0 \| ESCALATE \| ESCALATE \| WAIT \| under-action \|/);
  assert.ok(!report.includes('| WINDOW_FULL/PICKUP_ALL'), 'no PICKUP_ALL row is scored or listed');

  const out = path.join(dir, 'report.md');
  const written = sinks();
  assert.equal(await main(['--labels', labels, '--results', one, '--out', out], written), 0);
  assert.equal(written.lines.out.join('').trim(), `wrote the report to ${out}`);
  const saved = await fs.readFile(out, 'utf8');
  assert.match(saved, /# Follow-up adviser scored against human labels/);
  const again = sinks();
  assert.equal(await main(['--labels', labels, '--results', two, '--out', out], again), 2);
  assert.match(again.lines.err.join(''), /already exists; refusing to overwrite/);
  assert.equal(await fs.readFile(out, 'utf8'), saved);
});

test('reads labels from a filled Markdown sheet and warns about REMIND where fixed code refuses it', async () => {
  const dir = await tempDir();
  const filled = renderSheet('md').split('\n').map(line => {
    if (/^POLICY:/.test(line)) return `POLICY: ${POLICY}`;
    if (!line.startsWith('| 12345678')) return line;
    const cells = line.replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map(cell => cell.trim());
    const nudge = Number(cells[4]);
    return `| ${[...cells.slice(0, 5), nudge === 2 ? 'REMIND, ESCALATE' : 'WAIT', nudge === 2 ? 'ESCALATE' : 'WAIT', ''].join(' | ')} |`;
  }).join('\n');
  const sheet = path.join(dir, 'filled.md');
  await fs.writeFile(sheet, filled);
  const results = path.join(dir, 'r.json');
  await fs.writeFile(results, JSON.stringify(benchFile(constant('WAIT'))));
  const io = sinks();
  assert.equal(await main(['--labels', sheet, '--results', results], io), 0);
  const report = io.lines.out.join('');
  assert.match(report, /## Warnings/);
  assert.match(report, /WINDOW_FULL\/PICKUP_NONE\/2: REMIND is in the acceptable set, but production fixed code refuses REMIND at nudgeCount 2/);
  assert.match(report, /r\.json: 12 PICKUP_ALL row\(s\) ignored/);
  assert.match(report, /r\.json: outlets\.cloud \(synthetic\/bench\) \| 24\/24 \(100\.0%\) \| 16\/24 \(66\.7%\) \| 16\/24 \(66\.7%\) \| 16\/24 \(66\.7%\) \| 0\/24 \(0\.0%\) \| 8\/24 \(33\.3%\)/);
});

test('the command line entry point scores and exits 0, and exits 2 on incomplete labels', async () => {
  const dir = await tempDir();
  const labels = await writeLabels(dir);
  const partial = await writeLabels(dir, { skip: ['WINDOW_LAST/PICKUP_SOME/1'], name: 'partial.json' });
  const results = path.join(dir, 'r.json');
  await fs.writeFile(results, JSON.stringify(compareLocal(constant('REMIND'))));
  const ok = spawnSync(process.execPath, [SCRIPT, '--labels', labels, '--results', results], { encoding: 'utf8' });
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /Follow-up adviser scored against human labels/);
  const refused = spawnSync(process.execPath, [SCRIPT, '--labels', partial, '--results', results], { encoding: 'utf8' });
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /ERROR refusing to score/);
  assert.equal(refused.stdout, '');
});

test('the scorer contains no model or network call', async () => {
  const source = await fs.readFile(SCRIPT, 'utf8');
  assert.doesNotMatch(source, /\bfetch\(|node:http|node:https|node:net|XMLHttpRequest|process\.env|requestFileAdvice/);
});
