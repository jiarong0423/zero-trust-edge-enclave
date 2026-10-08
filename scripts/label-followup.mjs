// Tooling for HUMAN ground-truth labels of the follow-up adviser's reachable inputs.
//
//   node scripts/label-followup.mjs --sheet <out.md|out.csv>
//       write a blank label sheet (refuses to overwrite an existing file)
//   node scripts/label-followup.mjs --interactive --labels-out <labels.json>
//       walk the inputs in a terminal and save each answer as it is given (refuses to overwrite)
//   node scripts/label-followup.mjs --interactive --labels-out <labels.json> --resume
//       continue an interrupted session; earlier answers are kept
//
// This script never produces, suggests or derives a label. Every acceptable-action set, every
// preferred action and the policy statement come from a person, typed into the sheet or the
// terminal. It never calls a model and never touches the network. Score the result with
// scripts/score-labels.mjs.
//
// Exit codes: 0 done, 2 refused or bad usage (nothing was overwritten), 3 input ended early
// (progress so far is saved).
import { promises as fs, readFileSync } from 'node:fs';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { ADVICE_KINDS } from '../file-adviser.js';
import { MAX_NUDGES } from '../delivery-followup.js';

export class Refusal extends Error {}

export const SCHEMA = 'followup-human-labels/1';
export const TASK_ALIAS = '12345678-1234-4234-8234-123456789012';
export const SNAPSHOT_VERSION = 1;
export const UNREACHABLE_PICKUP = 'PICKUP_ALL';
// The order is the strength order used by the scorer: WAIT < REMIND < ESCALATE.
export const ACTION_ORDER = ['WAIT', 'REMIND', 'ESCALATE'];
export const ACTION_RANK = Object.fromEntries(ACTION_ORDER.map((action, rank) => [action, rank]));
export const SHEET_COLUMNS = ['taskAlias', 'snapshotVersion', 'timeCode', 'pickupCode', 'nudgeCount',
  'acceptable_actions', 'preferred_action', 'note'];

// TIME_CODES and PICKUP_CODES are module-private in delivery-followup.js. Rather than copy them, read
// the two array literals out of that file, then confirm each value against the exported gate
// (ADVICE_KINDS.followup.accepts), so a renamed or reordered constant fails here instead of silently
// changing what is labelled.
function extractCodes(source, name) {
  const match = new RegExp(`const ${name} = \\[([^\\]]*)\\];`).exec(source);
  const codes = match ? [...match[1].matchAll(/'([A-Z_]+)'/g)].map(item => item[1]) : [];
  if (!codes.length) throw new Error(`cannot read ${name} from delivery-followup.js`);
  return codes;
}

const FOLLOWUP_SOURCE = readFileSync(new URL('../delivery-followup.js', import.meta.url), 'utf8');
export const TIME_CODES = extractCodes(FOLLOWUP_SOURCE, 'TIME_CODES');
export const PICKUP_CODES = extractCodes(FOLLOWUP_SOURCE, 'PICKUP_CODES');

const schemaActions = ADVICE_KINDS.followup.schema.properties.action.enum;
if (schemaActions.length !== ACTION_ORDER.length || !ACTION_ORDER.every(action => schemaActions.includes(action))) {
  throw new Error('the follow-up action set changed; update ACTION_ORDER and the strength order');
}
if (!PICKUP_CODES.includes(UNREACHABLE_PICKUP)) throw new Error(`${UNREACHABLE_PICKUP} is no longer a pickup code`);

export const projectionOf = (timeCode, pickupCode, nudgeCount) =>
  ({ taskAlias: TASK_ALIAS, snapshotVersion: SNAPSHOT_VERSION, timeCode, nudgeCount, pickupCode });

export const inputKey = input => `${input.timeCode}/${input.pickupCode}/${input.nudgeCount}`;

function buildInputs() {
  const all = [];
  for (const timeCode of TIME_CODES) {
    for (const pickupCode of PICKUP_CODES) {
      for (let nudgeCount = 0; nudgeCount <= MAX_NUDGES; nudgeCount += 1) {
        const metadata = projectionOf(timeCode, pickupCode, nudgeCount);
        if (!ADVICE_KINDS.followup.accepts(metadata)) {
          throw new Error(`the follow-up gate rejects ${inputKey({ timeCode, pickupCode, nudgeCount })}`);
        }
        all.push({ timeCode, pickupCode, nudgeCount, metadata });
      }
    }
  }
  return all;
}

export const ALL_INPUTS = buildInputs();
export const REACHABLE = ALL_INPUTS.filter(input => input.pickupCode !== UNREACHABLE_PICKUP);
export const EXCLUDED = ALL_INPUTS.filter(input => input.pickupCode === UNREACHABLE_PICKUP);
const KEYS = new Set(REACHABLE.map(inputKey));

export const EXCLUSION_NOTE = `The ${EXCLUDED.length} ${UNREACHABLE_PICKUP} inputs are excluded: they are unreachable, because the ` +
  `worker never asks the adviser when everything has been collected. ${REACHABLE.length} of ${ALL_INPUTS.length} inputs are reachable.`;

// --- Label semantics ----------------------------------------------------------------------------

/** Split an action list written by a person. Order and repeats do not matter; the result is a set. */
export function parseActionSet(value) {
  const tokens = (Array.isArray(value) ? value : String(value ?? '').split(/[\s,;|/]+/))
    .map(token => String(token).trim().toUpperCase()).filter(Boolean);
  return {
    actions: ACTION_ORDER.filter(action => tokens.includes(action)),
    invalid: [...new Set(tokens.filter(token => !ACTION_ORDER.includes(token)))],
  };
}

const textOf = value => (Array.isArray(value) ? value.join(', ') : String(value ?? '')).trim();

/**
 * Judge one raw entry ({ acceptable, preferred, note }). `unlabeled` means both fields are blank;
 * `invalid` means the person started the row but it is not usable; `complete` is usable.
 */
export function normalizeEntry(entry) {
  const acceptableText = textOf(entry?.acceptable);
  const preferredText = textOf(entry?.preferred);
  if (!acceptableText && !preferredText) return { state: 'unlabeled', problems: [] };
  const problems = [];
  const set = parseActionSet(entry.acceptable);
  if (set.invalid.length) problems.push(`unknown action(s) in the acceptable set: ${set.invalid.join(', ')}`);
  if (!set.actions.length && !set.invalid.length) problems.push('acceptable set is empty');
  let preferred = null;
  const preferredSet = parseActionSet(entry.preferred);
  if (!preferredText) problems.push('preferred action is missing');
  else if (preferredSet.invalid.length || preferredSet.actions.length !== 1) {
    problems.push(`preferred action must be exactly one of ${ACTION_ORDER.join(', ')}`);
  } else {
    preferred = preferredSet.actions[0];
    if (!set.actions.includes(preferred)) problems.push(`preferred action ${preferred} is not inside the acceptable set`);
  }
  if (problems.length) return { state: 'invalid', problems };
  return { state: 'complete', problems, acceptable: set.actions, preferred, note: String(entry.note ?? '').trim() };
}

/**
 * Check a parsed label document against the full reachable grid. Complete only when the policy
 * statement is written and every reachable input has a usable label.
 */
export function checkLabels(parsed) {
  const problems = [...parsed.problems];
  if (!parsed.policy.trim()) {
    problems.push('the policy statement is empty: the owner must write the policy the labels were made under');
  }
  const labels = new Map();
  for (const input of REACHABLE) {
    const key = inputKey(input);
    const result = normalizeEntry(parsed.entries.get(key));
    if (result.state === 'unlabeled') problems.push(`${key}: unlabeled`);
    else if (result.state === 'invalid') for (const problem of result.problems) problems.push(`${key}: ${problem}`);
    else labels.set(key, { acceptable: result.acceptable, preferred: result.preferred, note: result.note });
  }
  return { ok: problems.length === 0, problems, policy: parsed.policy.trim(), labels };
}

// --- Sheet and file formats ---------------------------------------------------------------------

export function describeValues() {
  return [
    `timeCode: how much of the approved window is left, in words: ${TIME_CODES.join(' > ')} (most time left to least). ` +
      'The boundaries are cut at a half, three quarters and seven eighths of each task\'s own window.',
    `pickupCode: ${PICKUP_CODES.filter(code => code !== UNREACHABLE_PICKUP).join(' < ')}: nothing collected, or some but not all collected.`,
    `nudgeCount: reminders already sent, 0 to ${MAX_NUDGES}. In production, fixed code refuses a REMIND proposed when nudgeCount is ${MAX_NUDGES}.`,
    'WAIT: do nothing now and ask again later. REMIND: send the recipients another reminder. ESCALATE: ask a person to look; it does not send, cancel or extend anything.',
  ];
}

function sheetIntro() {
  return [
    'Follow-up adviser: human ground-truth labels',
    'These labels are the owner\'s judgement under the owner\'s own policy, compliance-first or not. The policy changes which actions are defensible, so the sheet does not choose it: the owner writes the policy statement on the policy line below before filling any row. A label set without a policy statement is refused by the scorer.',
    'Nothing here is prefilled. No tool, model or fixture supplied an answer and none may be added for you.',
    EXCLUSION_NOTE,
    ...describeValues(),
    `Per row: list ALL acceptable actions among ${ACTION_ORDER.join(', ')} separated by commas (several can be defensible), then name the single preferred action, which must be one of the acceptable ones. The note is free text (avoid the pipe character in the Markdown sheet).`,
  ];
}

const csvField = value => (/[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value);

/** A blank sheet. `format` is `md` or `csv`. */
export function renderSheet(format) {
  const rows = REACHABLE.map(input => [TASK_ALIAS, String(SNAPSHOT_VERSION), input.timeCode, input.pickupCode,
    String(input.nudgeCount), '', '', '']);
  const intro = sheetIntro();
  if (format === 'csv') {
    const lines = intro.map(line => `# ${line.replaceAll('"', '\'')}`);
    lines.push('# POLICY: ');
    lines.push(SHEET_COLUMNS.join(','));
    for (const row of rows) lines.push(row.map(csvField).join(','));
    return `${lines.join('\n')}\n`;
  }
  const lines = [`# ${intro[0]}`, '', ...intro.slice(1).flatMap(line => [line, '']), 'POLICY: ', '',
    `| ${SHEET_COLUMNS.join(' | ')} |`, `| ${SHEET_COLUMNS.map(() => '---').join(' | ')} |`];
  for (const row of rows) lines.push(`| ${row.join(' | ')} |`);
  return `${lines.join('\n')}\n`;
}

/** RFC 4180 style parser: quoted fields, doubled quotes, CRLF or LF. Returns an array of records. */
export function parseCsv(text) {
  const records = [];
  let record = [];
  let field = '';
  let quoted = false;
  let touched = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { field += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"' && field === '') { quoted = true; touched = true; }
    else if (char === ',') { record.push(field); field = ''; touched = true; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      if (touched || field !== '') { record.push(field); records.push(record); }
      record = []; field = ''; touched = false;
    } else { field += char; touched = true; }
  }
  if (quoted) throw new Refusal('the CSV sheet has an unterminated quoted field');
  if (touched || field !== '') { record.push(field); records.push(record); }
  return records;
}

function keyOfCells(cells, problems, where) {
  const { timeCode = '', pickupCode = '', nudgeCount = '' } = cells;
  const key = `${timeCode.trim()}/${pickupCode.trim()}/${nudgeCount.trim()}`;
  if (!/^\d+$/.test(nudgeCount.trim()) || !KEYS.has(key)) {
    problems.push(`${where}: ${JSON.stringify(key)} is not one of the ${REACHABLE.length} reachable inputs`);
    return null;
  }
  return key;
}

function collectRows(header, rows, where) {
  for (const column of SHEET_COLUMNS) {
    if (!header.includes(column)) throw new Refusal(`the sheet header has no ${column} column`);
  }
  const entries = new Map();
  const problems = [];
  rows.forEach((cells, index) => {
    const named = Object.fromEntries(header.map((name, position) => [name, cells[position] ?? '']));
    const key = keyOfCells(named, problems, `${where} row ${index + 1}`);
    if (key === null) return;
    if (entries.has(key)) { problems.push(`${key}: appears more than once`); return; }
    entries.set(key, { acceptable: named.acceptable_actions, preferred: named.preferred_action, note: named.note });
  });
  return { entries, problems };
}

function parseMarkdownSheet(text) {
  let policy = '';
  const rows = [];
  let header = null;
  for (const line of text.split(/\r?\n/)) {
    const policyMatch = /^\s*POLICY:\s*(.*)$/.exec(line);
    if (policyMatch) { policy = policyMatch[1].trim(); continue; }
    if (!line.trim().startsWith('|')) continue;
    const cells = line.trim().replace(/^\|/, '').replace(/\|\s*$/, '').split('|');
    if (cells.every(cell => /^:?-{3,}:?$/.test(cell.trim()))) continue;
    if (!header) { header = cells.map(cell => cell.trim()); continue; }
    // A pipe inside the note splits it; the note is the last column, so rejoin the surplus.
    const noteAt = header.indexOf('note');
    if (noteAt !== -1 && cells.length > header.length) {
      cells.splice(noteAt, cells.length - noteAt, cells.slice(noteAt).join('|'));
    }
    rows.push(cells.map(cell => cell.trim()));
  }
  if (!header) throw new Refusal('no sheet table found: expected a Markdown table with the sheet columns');
  return { policy, ...collectRows(header, rows, 'sheet') };
}

function parseCsvSheet(text) {
  let policy = '';
  const kept = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('#')) {
      const policyMatch = /^#\s*POLICY:\s*(.*)$/.exec(line);
      if (policyMatch) policy = policyMatch[1].trim();
    } else kept.push(line);
  }
  const records = parseCsv(kept.join('\n')).filter(record => {
    const first = (record[0] ?? '').trim();
    if (first.startsWith('#')) {
      const policyMatch = /^#\s*POLICY:\s*(.*)$/.exec(first);
      if (policyMatch) policy = policyMatch[1].trim();
      return false;
    }
    return record.some(cell => cell.trim() !== '');
  });
  if (!records.length) throw new Refusal('no sheet table found: the CSV has no header row');
  const [header, ...rows] = records.map(record => record.map(cell => cell.trim()));
  return { policy, ...collectRows(header, rows, 'sheet') };
}

function parseJsonLabels(text) {
  let doc;
  try { doc = JSON.parse(text); } catch { throw new Refusal('the labels file is not valid JSON'); }
  if (!doc || doc.schema !== SCHEMA || !Array.isArray(doc.labels) || typeof doc.policy !== 'string') {
    throw new Refusal(`the labels file is not a ${SCHEMA} document`);
  }
  const entries = new Map();
  const problems = [];
  doc.labels.forEach((label, index) => {
    const key = inputKey(label ?? {});
    if (!KEYS.has(key)) { problems.push(`label ${index + 1}: ${JSON.stringify(key)} is not one of the ${REACHABLE.length} reachable inputs`); return; }
    if (entries.has(key)) { problems.push(`${key}: appears more than once`); return; }
    entries.set(key, { acceptable: label.acceptable, preferred: label.preferred, note: label.note });
  });
  return { policy: doc.policy.trim(), entries, problems };
}

/** Parse labels text. `kind` is `json`, `csv` or `md`. */
export function parseLabelsText(text, kind) {
  if (kind === 'json') return parseJsonLabels(text);
  return kind === 'csv' ? parseCsvSheet(text) : parseMarkdownSheet(text);
}

export const kindOfPath = file => (/\.json$/i.test(file) ? 'json' : /\.csv$/i.test(file) ? 'csv' : 'md');

export async function readLabelsFile(file) {
  let text;
  try { text = await fs.readFile(file, 'utf8'); } catch (error) {
    throw new Refusal(`cannot read the labels file: ${error.code ?? error.message}`);
  }
  return parseLabelsText(text, kindOfPath(file));
}

/** The labels document for the interactive file: entries in grid order, answers exactly as given. */
export function renderLabelsDocument(policy, entries) {
  const labels = [];
  for (const input of REACHABLE) {
    const entry = entries.get(inputKey(input));
    if (!entry) continue;
    labels.push({ timeCode: input.timeCode, pickupCode: input.pickupCode, nudgeCount: input.nudgeCount,
      acceptable: entry.acceptable, preferred: entry.preferred, note: entry.note ?? '' });
  }
  return `${JSON.stringify({ schema: SCHEMA, policy, labels }, null, 2)}\n`;
}

// --- Writing ------------------------------------------------------------------------------------

/** Create a new file; an existing file is never overwritten. */
export async function writeNew(file, text) {
  try { await fs.writeFile(file, text, { flag: 'wx' }); } catch (error) {
    if (error.code === 'EEXIST') throw new Refusal(`${file} already exists; refusing to overwrite it`);
    throw error;
  }
}

let tempCounter = 0;
/** Replace an existing file atomically: write a sibling temporary file, then rename it over the target. */
export async function replaceAtomically(file, text) {
  tempCounter += 1;
  const temporary = `${file}.${process.pid}.${tempCounter}.tmp`;
  try {
    await fs.writeFile(temporary, text, { flag: 'wx' });
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

// --- Interactive session ------------------------------------------------------------------------

function lineReader(input) {
  const reader = readline.createInterface({ input, crlfDelay: Infinity });
  const iterator = reader[Symbol.asyncIterator]();
  return {
    async next() {
      const { value, done } = await iterator.next();
      return done ? null : value;
    },
    close: () => reader.close(),
  };
}

const QUIT = /^(q|quit)$/i;

/**
 * Walk the reachable inputs, asking a person for each label. Every completed answer is saved before
 * the next prompt. Returns { code, labeled, skipped }.
 */
export async function runInteractive({ input, output, labelsOut, resume = false }) {
  const say = text => output.write(`${text}\n`);
  let policy;
  let entries = new Map();
  if (resume) {
    if (kindOfPath(labelsOut) !== 'json') throw new Refusal('--resume works on the JSON labels file written by --interactive');
    const existing = await readLabelsFile(labelsOut);
    if (existing.problems.length) throw new Refusal(`the labels file cannot be resumed: ${existing.problems[0]}`);
    ({ policy, entries } = existing);
  } else {
    try { await fs.access(labelsOut); throw new Refusal(`${labelsOut} already exists; refusing to overwrite it (use --resume to continue it)`); }
    catch (error) { if (error instanceof Refusal) throw error; }
  }

  const reader = lineReader(input);
  const ask = async prompt => { output.write(prompt); return reader.next(); };
  let created = resume;
  const save = async () => {
    const text = renderLabelsDocument(policy, entries);
    if (created) await replaceAtomically(labelsOut, text);
    else { await writeNew(labelsOut, text); created = true; }
  };
  const finish = (code, message) => {
    const labeled = REACHABLE.filter(item => normalizeEntry(entries.get(inputKey(item))).state === 'complete').length;
    say(`${message} ${labeled} of ${REACHABLE.length} inputs are labelled.`);
    reader.close();
    return { code, labeled, skipped: REACHABLE.length - labeled };
  };

  try {
    say('Follow-up adviser: human ground-truth labels. These are your judgement under your own policy; nothing is prefilled.');
    say(EXCLUSION_NOTE);
    for (const line of describeValues()) say(line);
    if (!resume) {
      for (;;) {
        const answer = await ask('Policy statement (your own, one line, required; q to quit): ');
        if (answer === null) { say('Input ended before a policy statement was given; nothing was saved.'); reader.close(); return { code: 3, labeled: 0, skipped: REACHABLE.length }; }
        if (QUIT.test(answer.trim())) { say('Quit before a policy statement was given; nothing was saved.'); reader.close(); return { code: 0, labeled: 0, skipped: REACHABLE.length }; }
        if (answer.trim()) { policy = answer.trim(); break; }
        say('The policy statement cannot be empty.');
      }
      await save();
    } else say(`Resuming. Policy statement on file: ${policy}`);

    const pending = REACHABLE.filter(item => normalizeEntry(entries.get(inputKey(item))).state !== 'complete');
    for (const item of pending) {
      const position = REACHABLE.indexOf(item) + 1;
      say(`\n[${position}/${REACHABLE.length}] ${JSON.stringify(item.metadata)}`);
      let acceptable = null;
      for (;;) {
        const answer = await ask(`Acceptable actions, any of ${ACTION_ORDER.join(', ')} (comma separated; Enter skips this input; q saves and quits): `);
        if (answer === null) return finish(3, 'Input ended; progress is saved.');
        if (QUIT.test(answer.trim())) return finish(0, 'Stopped; progress is saved.');
        if (!answer.trim()) break;
        const set = parseActionSet(answer);
        if (set.invalid.length || !set.actions.length) { say(`Not understood: use only ${ACTION_ORDER.join(', ')}.`); continue; }
        acceptable = set.actions;
        break;
      }
      if (acceptable === null) { say('Skipped; it stays unlabelled.'); continue; }
      let preferred = null;
      for (;;) {
        const answer = await ask(`Preferred action, exactly one of the acceptable set (${acceptable.join(', ')}); q saves and quits: `);
        if (answer === null) return finish(3, 'Input ended; progress is saved.');
        if (QUIT.test(answer.trim())) return finish(0, 'Stopped; progress is saved.');
        const set = parseActionSet(answer);
        if (set.invalid.length || set.actions.length !== 1 || !acceptable.includes(set.actions[0])) {
          say(`Not understood: give exactly one of ${acceptable.join(', ')}.`);
          continue;
        }
        preferred = set.actions[0];
        break;
      }
      const note = await ask('Note (optional free text; Enter for none): ');
      entries.set(inputKey(item), { acceptable, preferred, note: (note ?? '').trim() });
      await save();
      if (note === null) return finish(3, 'Input ended; progress is saved.');
    }
    return finish(0, 'Done.');
  } catch (error) {
    reader.close();
    throw error;
  }
}

// --- Command line -------------------------------------------------------------------------------

export const USAGE = 'usage: node scripts/label-followup.mjs --sheet <out.md|out.csv>\n' +
  '       node scripts/label-followup.mjs --interactive --labels-out <labels.json> [--resume]';

export function parseArgs(argv) {
  const options = { sheet: null, interactive: false, labelsOut: null, resume: false, help: false };
  const value = (index, flag) => {
    if (!argv[index] || argv[index].startsWith('--')) throw new Refusal(`${flag} needs a file path`);
    return argv[index];
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--sheet') { index += 1; options.sheet = value(index, '--sheet'); }
    else if (arg === '--labels-out') { index += 1; options.labelsOut = value(index, '--labels-out'); }
    else if (arg === '--interactive') options.interactive = true;
    else if (arg === '--resume') options.resume = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Refusal(`unknown argument ${JSON.stringify(arg.slice(0, 40))}`);
  }
  if (options.help) return options;
  if (Boolean(options.sheet) === options.interactive) throw new Refusal('give exactly one of --sheet and --interactive');
  if (options.interactive && !options.labelsOut) throw new Refusal('--interactive needs --labels-out <file>');
  if (options.labelsOut && !/\.json$/i.test(options.labelsOut)) throw new Refusal('--labels-out must be a .json file');
  if (!options.interactive && (options.labelsOut || options.resume)) throw new Refusal('--labels-out and --resume belong to --interactive');
  return options;
}

export async function main(argv, io = {}) {
  const stdin = io.stdin ?? process.stdin;
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  try {
    const options = parseArgs(argv);
    if (options.help) { stdout.write(`${USAGE}\n`); return 0; }
    if (options.sheet) {
      await writeNew(options.sheet, renderSheet(kindOfPath(options.sheet) === 'csv' ? 'csv' : 'md'));
      stdout.write(`wrote a blank sheet with ${REACHABLE.length} rows to ${options.sheet}. ${EXCLUSION_NOTE}\n`);
      return 0;
    }
    if (!stdin.isTTY) {
      throw new Refusal('--interactive needs a terminal: stdin is not a TTY. Run it in a terminal, or use --sheet to write a sheet to fill in.');
    }
    const result = await runInteractive({ input: stdin, output: stdout, labelsOut: options.labelsOut, resume: options.resume });
    return result.code;
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    stderr.write(`ERROR ${error.message}\n${USAGE}\n`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
