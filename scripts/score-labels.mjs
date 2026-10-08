// Score saved follow-up adviser results against HUMAN labels.
//
//   node scripts/score-labels.mjs --labels <labels> --results <file>... [--out <report.md>]
//
// <labels> is the JSON file written by `label-followup.mjs --interactive`, or a filled-in sheet
// from `label-followup.mjs --sheet` (.md or .csv). Result files are the saved JSON written by the
// experiments and by scripts/bench-adviser.mjs. Nothing is scored unless all reachable inputs carry
// a complete human label and the owner's policy statement is present. The deterministic fixture is
// scored as one more source. No model is called and nothing touches the network.
//
// Exit codes: 0 done, 2 refused (incomplete labels, unreadable input, existing --out file).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { MAX_NUDGES, syntheticFollowupAdvice } from '../delivery-followup.js';
import {
  ACTION_ORDER, ACTION_RANK, ALL_INPUTS, EXCLUDED, EXCLUSION_NOTE, REACHABLE, Refusal, UNREACHABLE_PICKUP,
  checkLabels, inputKey, readLabelsFile, safeText, writeNew,
} from './label-followup.mjs';

const KEYS = new Set(ALL_INPUTS.map(inputKey));
const FLAT_COLUMNS = ['model', 'local4b', 'cloud120b'];
const ACCEPTED_FLAG_COLUMNS = ['model', 'cloud120b'];

/**
 * How an action compares with a set of acceptable actions, in the order WAIT < REMIND < ESCALATE.
 * `acceptable`: inside the set. `over`: stronger than every acceptable action. `under`: weaker than
 * every acceptable action. `between`: not in the set but neither stronger than all nor weaker than
 * all of it (for example REMIND against {WAIT, ESCALATE}).
 */
export function classify(action, acceptable) {
  if (acceptable.includes(action)) return 'acceptable';
  const ranks = acceptable.map(item => ACTION_RANK[item]);
  if (ACTION_RANK[action] > Math.max(...ranks)) return 'over';
  if (ACTION_RANK[action] < Math.min(...ranks)) return 'under';
  return 'between';
}

// --- Result files -------------------------------------------------------------------------------

const markdown = value => safeText(value, 'markdown');

function actionOfValue(value, where) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new Refusal(`${where}: expected an "ACTION/REASON" string or null`);
  // ASCII letters only, checked before upper-casing: toUpperCase would turn a dotless i or a long s into
  // a plain ASCII letter and accept a lookalike as an action.
  const word = value.split('/')[0].replace(/^[ \t]+|[ \t]+$/g, '');
  const action = /^[A-Za-z]+$/.test(word) ? word.toUpperCase() : null;
  if (action === null || !ACTION_ORDER.includes(action)) {
    throw new Refusal(`${where}: unrecognised action in ${safeText(value.slice(0, 40), 'ascii')}`);
  }
  return action;
}

function modelNameFor(doc, column, outlet) {
  const named = value => (typeof value === 'string' && value ? value : null);
  if (outlet) return named(doc.outlets?.[outlet]?.model);
  if (column === 'model') return named(doc.model) ?? named(doc.summary?.model);
  if (column === 'cloud120b') return named(doc.model);
  return null;
}

/**
 * Turn one parsed result file into scoreable sources. Supported shapes (extra fields are ignored):
 *   rows[] with `model`, `local4b` or `cloud120b` = "ACTION/REASON" | null  (compare, compare-cloud);
 *     a row with accepted:false has no usable `model` or `cloud120b` answer
 *   rows[] with `variant` plus `model`                                       (prompt-variants)
 *   rows[] with `outlets.<name>` = { accepted, advice }                      (bench-adviser/1)
 * The `fixture` column is not a source here; it is only cross-checked. Returns
 * { sources, ignoredUnreachable, fixtureMismatches }.
 */
export function sourcesFromResults(doc, fileName) {
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.rows)) {
    throw new Refusal(`${fileName}: no rows array; this is not a saved follow-up result file`);
  }
  const groups = new Map();
  let ignoredUnreachable = 0;
  let fixtureMismatches = 0;
  let malformedFlags = 0;
  doc.rows.forEach((row, index) => {
    const where = `${fileName} row ${index + 1}`;
    if (!row || typeof row.timeCode !== 'string' || typeof row.pickupCode !== 'string' || !Number.isInteger(row.nudgeCount)) {
      throw new Refusal(`${where}: lacks timeCode, pickupCode or nudgeCount; only grid result files are supported`);
    }
    const key = inputKey(row);
    if (!KEYS.has(key)) throw new Refusal(`${where}: ${JSON.stringify(key)} is not one of the follow-up inputs`);
    if (row.pickupCode === UNREACHABLE_PICKUP) { ignoredUnreachable += 1; return; }
    if (typeof row.fixture === 'string') {
      const expected = syntheticFollowupAdvice({ taskAlias: 'x', snapshotVersion: 1, timeCode: row.timeCode,
        pickupCode: row.pickupCode, nudgeCount: row.nudgeCount });
      if (row.fixture !== `${expected.action}/${expected.reasonCode}`) fixtureMismatches += 1;
    }
    const variant = typeof row.variant === 'string' ? row.variant : null;
    const add = (column, outlet, value, rowWhere) => {
      // A structured key: names are free text and may contain any separator.
      const id = JSON.stringify([column, outlet, variant]);
      if (!groups.has(id)) {
        const model = modelNameFor(doc, column, outlet);
        const label = `${fileName}: ${outlet ? `outlets.${outlet}` : column}${variant ? ` [variant ${variant}]` : ''}${model ? ` (${model})` : ''}`;
        groups.set(id, { name: safeText(label), answers: new Map() });
      }
      const group = groups.get(id);
      if (group.answers.has(key)) throw new Refusal(`${rowWhere}: ${JSON.stringify(key)} appears twice for ${group.name}`);
      group.answers.set(key, value);
    };
    // A row carries the flag or it does not. When it does, only the boolean true is an answer: false
    // is a refusal, and any other value (0, "false", null, ...) is not trusted and is counted.
    const flagPresent = Object.hasOwn(row, 'accepted');
    const flagMalformed = flagPresent && typeof row.accepted !== 'boolean';
    let flagCounted = false;
    for (const column of FLAT_COLUMNS) {
      if (!(column in row)) continue;
      // The prompt-variants file keeps the refused answer's text in `model` and marks the row
      // accepted:false; the compare-cloud file's `accepted` describes only cloud120b. local4b carries
      // null when its answer was refused, so it needs no flag. A format that never carries the flag
      // (no `accepted` key at all) keeps its answers.
      const gated = flagPresent && ACCEPTED_FLAG_COLUMNS.includes(column);
      const refused = gated && row.accepted !== true;
      if (gated && flagMalformed) flagCounted = true;
      add(column, null, refused ? null : actionOfValue(row[column], `${where} ${column}`), where);
    }
    if (row.outlets && typeof row.outlets === 'object') {
      for (const [outlet, result] of Object.entries(row.outlets)) {
        // The bench-adviser format always writes `accepted`; anything but the boolean true is no answer.
        const flag = result && typeof result === 'object' ? result.accepted : undefined;
        if (typeof flag !== 'boolean') malformedFlags += 1;
        const refused = flag !== true;
        add(null, outlet, refused ? null : actionOfValue(result.advice, `${where} outlets.${outlet}.advice`), where);
      }
    }
    if (flagCounted) malformedFlags += 1;
  });
  if (!groups.size) throw new Refusal(`${fileName}: no model, local4b, cloud120b or outlets column found; nothing to score`);
  return { sources: [...groups.values()], ignoredUnreachable, fixtureMismatches, malformedFlags };
}

/** The deterministic fixture as a source, computed from the live `syntheticFollowupAdvice`. */
export function fixtureSource() {
  const answers = new Map();
  for (const input of REACHABLE) answers.set(inputKey(input), syntheticFollowupAdvice(input.metadata).action);
  return { name: 'fixture (syntheticFollowupAdvice, computed now; a blunt stand-in, not ground truth)', answers };
}

// --- Scoring ------------------------------------------------------------------------------------

/** Score one source against complete labels (a Map from input key to { acceptable, preferred }). */
export function scoreSource(labels, source) {
  const totals = { inputs: REACHABLE.length, answered: 0, acceptable: 0, preferred: 0, over: 0, under: 0, between: 0, none: 0 };
  const rows = [];
  for (const input of REACHABLE) {
    const key = inputKey(input);
    const label = labels.get(key);
    const action = source.answers.get(key) ?? null;
    let category = 'none';
    if (action !== null) {
      totals.answered += 1;
      category = classify(action, label.acceptable);
      if (action === label.preferred) totals.preferred += 1;
    }
    totals[category] += 1;
    rows.push({ key, action, category, acceptable: label.acceptable, preferred: label.preferred });
  }
  return { name: source.name, totals, rows };
}

const percent = (count, total) => (total ? `${count}/${total} (${(Math.round((count / total) * 1000) / 10).toFixed(1)}%)` : `${count}/${total}`);
const KIND_TEXT = { over: 'over-action', under: 'under-action', between: 'outside the set, between its actions', none: 'no usable answer' };

/** The Markdown report. `scored` is a list of scoreSource() results; `warnings` is a list of strings. */
export function renderReport({ policy, labelsFile, labels, scored, warnings = [] }) {
  const lines = [];
  lines.push('# Follow-up adviser scored against human labels', '');
  lines.push(`Labels: \`${safeText(labelsFile, 'code')}\`. The labels are the owner's judgement under the owner's own policy, written by a person; this report did not produce or alter any of them.`, '');
  lines.push('Policy statement, as written by the owner:', '');
  for (const line of policy.split(/\r\n|\n|\r/)) lines.push(`> ${markdown(line)}`);
  lines.push('');
  lines.push(`**${EXCLUSION_NOTE}** They are not scored and not counted below; every rate is out of ${REACHABLE.length} inputs.`, '');
  lines.push(`Action order for over/under: ${ACTION_ORDER.join(' < ')}. A row is *acceptable* when the source's action is inside the owner's acceptable set, *preferred* when it equals the single preferred action, *over-action* when it is stronger than every acceptable action, *under-action* when it is weaker than every acceptable action, and *between* when it is outside the set but neither stronger nor weaker than all of it. A refused, missing or unusable answer counts as *no answer*: it is not acceptable and not over or under.`, '');
  lines.push('The fixture is scored like any other source. It is a deterministic stand-in written for tests, not ground truth, and these labels are one person\'s judgement over a small synthetic grid with one run per source, so the rates are descriptive, not statistical.', '');
  if (warnings.length) {
    lines.push('## Warnings', '');
    for (const warning of warnings) lines.push(`- ${warning}`);
    lines.push('');
  }
  lines.push('## Results', '');
  lines.push('| Source | answered | acceptable | acceptable of answered | preferred | over-action | under-action | between | no answer |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const { name, totals } of scored) {
    lines.push(`| ${markdown(name)} | ${percent(totals.answered, totals.inputs)} | ${percent(totals.acceptable, totals.inputs)} | ` +
      `${percent(totals.acceptable, totals.answered)} | ${percent(totals.preferred, totals.inputs)} | ${percent(totals.over, totals.inputs)} | ` +
      `${percent(totals.under, totals.inputs)} | ${percent(totals.between, totals.inputs)} | ${percent(totals.none, totals.inputs)} |`);
  }
  lines.push('', '## Rows where a source disagrees', '',
    'Disagreement means the source\'s answer is not inside the acceptable set, or there is no usable answer.', '');
  for (const { name, rows } of scored) {
    const off = rows.filter(row => row.category !== 'acceptable');
    lines.push(`### ${markdown(name)}`, '');
    if (!off.length) { lines.push('No disagreements.', ''); continue; }
    lines.push('| input (timeCode/pickupCode/nudgeCount) | acceptable | preferred | source answered | kind |', '| --- | --- | --- | --- | --- |');
    for (const row of off) {
      lines.push(`| ${row.key} | ${row.acceptable.join(', ')} | ${row.preferred} | ${row.action ?? '(none)'} | ${KIND_TEXT[row.category]} |`);
    }
    lines.push('');
  }
  lines.push('## Labels used', '', '| input (timeCode/pickupCode/nudgeCount) | acceptable | preferred |', '| --- | --- | --- |');
  for (const input of REACHABLE) {
    const label = labels.get(inputKey(input));
    lines.push(`| ${inputKey(input)} | ${label.acceptable.join(', ')} | ${label.preferred} |`);
  }
  return `${lines.join('\n')}\n`;
}

// --- Command line -------------------------------------------------------------------------------

export const USAGE = 'usage: node scripts/score-labels.mjs --labels <labels.json|sheet.md|sheet.csv> --results <result.json>... [--out <report.md>]';

export function parseArgs(argv) {
  const options = { labels: null, results: [], out: null, help: false };
  const value = (index, flag) => {
    if (!argv[index] || argv[index].startsWith('--')) throw new Refusal(`${flag} needs a file path`);
    return argv[index];
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--labels') { index += 1; options.labels = value(index, '--labels'); }
    else if (arg === '--out') { index += 1; options.out = value(index, '--out'); }
    else if (arg === '--results') {
      let taken = 0;
      while (argv[index + 1] && !argv[index + 1].startsWith('--')) { index += 1; taken += 1; options.results.push(argv[index]); }
      if (!taken) throw new Refusal('--results needs at least one file path');
    } else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Refusal(`unknown argument ${safeText(JSON.stringify(arg.slice(0, 40)))}`);
  }
  if (options.help) return options;
  if (!options.labels) throw new Refusal('--labels <file> is required');
  if (!options.results.length) throw new Refusal('--results <file>... is required');
  return options;
}

async function loadResults(file) {
  let text;
  try { text = await fs.readFile(file, 'utf8'); } catch (error) {
    throw new Refusal(`cannot read ${safeText(file)}: ${safeText(error.code ?? error.message)}`);
  }
  let doc;
  try { doc = JSON.parse(text); } catch { throw new Refusal(`${safeText(file)} is not valid JSON`); }
  return doc;
}

export async function main(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  try {
    const options = parseArgs(argv);
    if (options.help) { stdout.write(`${USAGE}\n`); return 0; }
    const checked = checkLabels(await readLabelsFile(options.labels));
    if (!checked.ok) {
      throw new Refusal(`refusing to score: the labels are not complete (${checked.problems.length} problem(s)). ` +
        `All ${REACHABLE.length} reachable inputs need a human label and the policy statement must be written.\n` +
        checked.problems.map(problem => `  - ${problem}`).join('\n'));
    }
    const warnings = [];
    for (const input of REACHABLE) {
      const label = checked.labels.get(inputKey(input));
      if (input.nudgeCount >= MAX_NUDGES && label.acceptable.includes('REMIND')) {
        warnings.push(`${inputKey(input)}: REMIND is in the acceptable set, but production fixed code refuses REMIND at nudgeCount ${MAX_NUDGES}, so a source cannot take effect with it there.`);
      }
    }
    const sources = [fixtureSource()];
    const seen = new Map();
    for (const file of options.results) {
      const base = safeText(path.basename(file));
      const count = (seen.get(base) ?? 0) + 1;
      seen.set(base, count);
      const parsed = sourcesFromResults(await loadResults(file), count > 1 ? `${base} (#${count})` : base);
      sources.push(...parsed.sources);
      if (parsed.ignoredUnreachable) {
        warnings.push(`${markdown(base)}: ${parsed.ignoredUnreachable} ${UNREACHABLE_PICKUP} row(s) ignored (unreachable, excluded).`);
      }
      if (parsed.malformedFlags) {
        warnings.push(`${markdown(base)}: ${parsed.malformedFlags} row(s) carry an "accepted" flag that is not a boolean (or an outlets entry has none); those answers were counted as no answer, because only accepted: true is trusted.`);
      }
      if (parsed.fixtureMismatches) {
        warnings.push(`${markdown(base)}: the fixture column of ${parsed.fixtureMismatches} row(s) differs from the current syntheticFollowupAdvice; the fixture source here is computed from the current code.`);
      }
    }
    const report = renderReport({ policy: checked.policy, labelsFile: options.labels, labels: checked.labels,
      scored: sources.map(source => scoreSource(checked.labels, source)), warnings });
    if (options.out) {
      await writeNew(options.out, report);
      stdout.write(`wrote the report to ${safeText(options.out)}\n`);
    } else stdout.write(report);
    return 0;
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    stderr.write(`ERROR ${safeText(error.message, 'lines')}\n${USAGE}\n`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
