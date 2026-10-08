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
import { promises as fs, rmSync } from 'node:fs';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { ADVICE_KINDS } from '../file-adviser.js';
import { MAX_NUDGES, PICKUP_CODES, TIME_CODES } from '../delivery-followup.js';

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

// The code lists come from delivery-followup.js itself (exported there), so they cannot drift from
// what the adviser is asked about. The shape check below is a guard against someone changing what
// the constants hold; the gate in buildInputs() then confirms every combination against
// ADVICE_KINDS.followup.accepts.
export { TIME_CODES, PICKUP_CODES };
for (const [name, codes] of [['TIME_CODES', TIME_CODES], ['PICKUP_CODES', PICKUP_CODES]]) {
  if (!Array.isArray(codes) || !codes.length || !codes.every(code => typeof code === 'string' && /^[A-Z_]+$/.test(code))) {
    throw new Error(`${name} in delivery-followup.js is not a non-empty array of upper-case codes`);
  }
}

const schemaActions = ADVICE_KINDS.followup.schema.properties.action.enum;
if (schemaActions.length !== ACTION_ORDER.length || !ACTION_ORDER.every(action => schemaActions.includes(action))) {
  throw new Error('the follow-up action set changed; update ACTION_ORDER and the strength order');
}
if (!PICKUP_CODES.includes(UNREACHABLE_PICKUP)) throw new Error(`${UNREACHABLE_PICKUP} is no longer a pickup code`);

export const projectionOf = (timeCode, pickupCode, nudgeCount) =>
  ({ taskAlias: TASK_ALIAS, snapshotVersion: SNAPSHOT_VERSION, timeCode, nudgeCount, pickupCode });

/**
 * The one sanitiser for any string that is echoed to a terminal, a report or an error message: C0 and C1
 * controls (ANSI and OSC escapes included), DEL, U+2028/U+2029/U+0085 and the invisible and bidirectional
 * format characters are removed (line-break-like ones become a space). Modes: `text` (terminal, errors),
 * `ascii` (every character outside printable ASCII is shown as \u{hex}, to show exactly what was typed),
 * `markdown` (also escapes Markdown specials, for report text and table cells), `code` (for a code span:
 * backticks become apostrophes) and `lines` (a multi-line message: each line cleaned, line breaks kept).
 */
export function safeText(value, mode = 'text') {
  if (mode === 'ascii') return String(value ?? '').replace(/[^\x20-\x7e]/gu, char => `\\u{${char.codePointAt(0).toString(16)}}`);
  if (mode === 'lines') return String(value ?? '').split('\n').map(stripInvisible).join('\n');
  let text = stripInvisible(value).trim();
  if (mode === 'code') text = text.replaceAll('`', "'");
  else if (mode === 'markdown') {
    text = text.replace(/[\\`*_[\]<>|#~&]/g, '\\$&').replace(/^([-+=]|\d+(?=[.)]))/, '\\$1');
  }
  return text;
}

function stripInvisible(value) {
  return String(value ?? '')
    .replace(/[\t\n\v\f\r\u0085\u2028\u2029]+/g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, '');
}

/** A policy statement must say something: at least one letter or digit (any script, CJK included). */
export const hasLetterOrDigit = text => /[\p{L}\p{N}]/u.test(String(text ?? ''));

/**
 * The identity of an input, or null when the value is not an input: timeCode and pickupCode must be
 * strings and nudgeCount an integer. Nothing is coerced, so "0", [0] and ["WINDOW_FULL"] are not keys.
 */
export const inputKey = input => {
  const { timeCode, pickupCode, nudgeCount } = input ?? {};
  if (typeof timeCode !== 'string' || typeof pickupCode !== 'string' || !Number.isInteger(nudgeCount)) return null;
  return `${timeCode}/${pickupCode}/${nudgeCount}`;
};

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

/**
 * Split an action list written by a person into a set. Separators are ASCII only: comma, semicolon,
 * slash, space, tab and line breaks (a pipe is NOT one: in a Markdown sheet it splits the cell). Every
 * raw token must be ASCII letters before it is upper-cased, so dotless i, long s, Cyrillic or full-width
 * lookalikes and zero-width characters are reported as invalid instead of being folded into an action.
 * A repeated action is reported in `duplicates`, never collapsed silently.
 */
export function parseActionSet(value) {
  const raw = Array.isArray(value) ? value
    : typeof value === 'string' ? value.split(/[ \t\r\n,;/]+/)
      : value === null || value === undefined ? [] : [value];
  const tokens = raw.map(token => (typeof token === 'string' ? token.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '') : token))
    .filter(token => token !== '');
  const seen = new Set();
  const invalid = [];
  const duplicates = [];
  for (const token of tokens) {
    const word = typeof token === 'string' && /^[A-Za-z]+$/.test(token) ? token.toUpperCase() : null;
    if (word === null || !ACTION_ORDER.includes(word)) { if (!invalid.includes(String(token))) invalid.push(String(token)); continue; }
    if (seen.has(word)) { if (!duplicates.includes(word)) duplicates.push(word); } else seen.add(word);
  }
  return { actions: ACTION_ORDER.filter(action => seen.has(action)), invalid, duplicates };
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
  if (set.invalid.length) problems.push(`unknown action(s) in the acceptable set: ${set.invalid.map(word => safeText(word, 'ascii')).join(', ')}`);
  if (set.duplicates.length) problems.push(`the acceptable set repeats ${set.duplicates.join(', ')}: list each action once`);
  if (!set.actions.length && !set.invalid.length) problems.push('acceptable set is empty');
  let preferred = null;
  const preferredSet = parseActionSet(entry.preferred);
  if (!preferredText) problems.push('preferred action is missing');
  else if (preferredSet.invalid.length || preferredSet.duplicates.length || preferredSet.actions.length !== 1) {
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
  } else if (!hasLetterOrDigit(parsed.policy)) {
    problems.push('the policy statement has no letter or digit, so it says nothing: the owner must write the policy the labels were made under');
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
    `Per row: list ALL acceptable actions among ${ACTION_ORDER.join(', ')} separated by commas, each at most once and in plain ASCII letters (several can be defensible), then name the single preferred action, which must be one of the acceptable ones. The note is free text (in the Markdown sheet write a pipe as \\|; the pipe is never an action separator).`,
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

/**
 * Read one RFC 4180 style record from `text` starting at `start`: quoted fields, doubled quotes, CRLF,
 * LF or CR line ends, line breaks inside quotes. Returns { record, next }; `record` is null for a
 * blank line.
 */
function readCsvRecord(text, start) {
  const record = [];
  let field = '';
  let quoted = false;
  let touched = false;
  let index = start;
  for (; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { field += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"' && field === '') { quoted = true; touched = true; }
    else if (char === ',') { record.push(field); field = ''; touched = true; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      index += 1;
      break;
    } else { field += char; touched = true; }
  }
  if (quoted) throw new Refusal('the CSV sheet has an unterminated quoted field');
  if (!touched && field === '') return { record: null, next: index };
  record.push(field);
  return { record, next: index };
}

/** RFC 4180 style parser. Returns an array of records; blank lines are skipped. */
export function parseCsv(text) {
  const records = [];
  for (let position = 0; position < text.length;) {
    const { record, next } = readCsvRecord(text, position);
    if (record) records.push(record);
    position = next;
  }
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

function collectRows(header, rows, where, { exactCells = false } = {}) {
  for (const column of SHEET_COLUMNS) {
    if (!header.includes(column)) throw new Refusal(`the sheet header has no ${column} column`);
  }
  const entries = new Map();
  const problems = [];
  rows.forEach((cells, index) => {
    const label = `${where} row ${index + 1}`;
    // A pipe or comma that shifts a cell must never turn into a different, complete label. A Markdown row
    // has exactly the header's cells. A CSV row may be short (blank trailing cells) but may not carry
    // extra cells with text (padding commas from a spreadsheet are blank).
    if (exactCells ? cells.length !== header.length : cells.slice(header.length).some(cell => cell !== '')) {
      problems.push(`${label}: has ${cells.length} cells, the header has ${header.length}; the row is ignored` +
        (exactCells ? ' (a pipe inside a cell splits it; escape a pipe in a note as \\| and do not use one between actions)' : ''));
      return;
    }
    const named = Object.fromEntries(header.map((name, position) => [name, cells[position] ?? '']));
    const key = keyOfCells(named, problems, label);
    if (key === null) return;
    if (entries.has(key)) { problems.push(`${key}: appears more than once`); return; }
    entries.set(key, { acceptable: named.acceptable_actions, preferred: named.preferred_action, note: named.note });
  });
  return { entries, problems };
}

// A pipe splits a Markdown table cell. `\|` is the table syntax for a literal pipe and is the only way
// to put one in a note; every other pipe is a cell boundary.
const splitMarkdownRow = line => line.trim().replace(/^\|/, '').replace(/(?<!\\)\|\s*$/, '').split(/(?<!\\)\|/)
  .map(cell => cell.replaceAll('\\|', '|').trim());

function parseMarkdownSheet(text) {
  let policy = '';
  const rows = [];
  let header = null;
  for (const line of text.split(/\r\n|\n|\r/)) {
    const policyMatch = /^\s*POLICY:\s*(.*)$/.exec(line);
    if (policyMatch) { policy = policyMatch[1].trim(); continue; }
    if (!line.trim().startsWith('|')) continue;
    const cells = splitMarkdownRow(line);
    if (cells.every(cell => /^:?-{3,}:?$/.test(cell))) continue;
    if (!header) { header = cells; continue; }
    rows.push(cells);
  }
  if (!header) throw new Refusal('no sheet table found: expected a Markdown table with the sheet columns');
  return { policy, ...collectRows(header, rows, 'sheet', { exactCells: true }) };
}

// A spreadsheet application pads every short row with trailing commas, so `# POLICY: ` comes back as
// `# POLICY: ,,,,,,,`. The commas are padding, not policy.
const cleanCsvPolicy = value => value.replace(/[,\s]+$/, '').trim();
const COMMENT_START = /[ \t]*#/y;
const CSV_POLICY_LINE = /^[ \t]*#\s*POLICY:([^]*)$/;

/**
 * The CSV is parsed as CSV first. Comment lines (`# ...`) and the `# POLICY:` line exist only before the
 * header row, as raw lines (or, after a spreadsheet round trip, as a quoted and padded first cell).
 * After the header row nothing is a comment: a line inside a quoted note is note text, and a stray
 * `#` row is an ordinary row that fails the reachable-input check instead of vanishing.
 */
function parseCsvSheet(text) {
  let policy = '';
  let header = null;
  const rows = [];
  const noteComment = comment => {
    const policyMatch = CSV_POLICY_LINE.exec(comment);
    if (policyMatch) policy = cleanCsvPolicy(policyMatch[1]);
  };
  const body = text.startsWith('\ufeff') ? text.slice(1) : text;
  for (let position = 0; position < body.length;) {
    COMMENT_START.lastIndex = position;
    if (header === null && COMMENT_START.test(body)) {
      let end = position;
      while (end < body.length && body[end] !== '\n' && body[end] !== '\r') end += 1;
      noteComment(body.slice(position, end));
      position = end;
      if (body[position] === '\r' && body[position + 1] === '\n') position += 1;
      position += 1;
      continue;
    }
    const { record, next } = readCsvRecord(body, position);
    position = next;
    if (!record) continue;
    const cells = record.map(cell => cell.trim());
    if (cells.every(cell => cell === '')) continue;
    if (header === null) {
      if (cells[0].startsWith('#')) { noteComment(cells[0]); continue; }
      header = cells;
    } else rows.push(cells);
  }
  if (!header) throw new Refusal('no sheet table found: the CSV has no header row');
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
    const key = inputKey(label);
    if (key === null) { problems.push(`label ${index + 1}: timeCode and pickupCode must be strings and nudgeCount an integer; nothing is converted`); return; }
    if (!KEYS.has(key)) { problems.push(`label ${index + 1}: ${safeText(JSON.stringify(key))} is not one of the ${REACHABLE.length} reachable inputs`); return; }
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
    throw new Refusal(`cannot read the labels file: ${safeText(error.code ?? error.message)}`);
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
    if (error.code === 'EEXIST') throw new Refusal(`${safeText(file)} already exists; refusing to overwrite it`);
    if (typeof error.code === 'string' && /^E[A-Z]+$/.test(error.code)) throw new Refusal(`cannot write ${safeText(file)}: ${error.code}`);
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
    if (typeof error.code === 'string' && /^E[A-Z]+$/.test(error.code)) throw new Refusal(`cannot save ${safeText(file)}: ${error.code}`);
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

export const lockPathOf = labelsOut => `${labelsOut}.lock`;

/**
 * Take the exclusive session lock next to the labels file (created with `wx`). Two sessions on one
 * file would each rewrite it from their own memory and silently lose the other's answers. A lock left
 * behind by a crashed session is never removed automatically: the person decides. Returns the release.
 */
async function acquireLock(labelsOut) {
  const lock = lockPathOf(labelsOut);
  let handle;
  try { handle = await fs.open(lock, 'wx'); } catch (error) {
    if (error.code === 'EEXIST') {
      throw new Refusal(`another session is using ${safeText(labelsOut)}, or one that crashed left its lock file ${safeText(lock)} behind. ` +
        'Only one session may write a labels file. If you are sure no other session is running, delete the lock file yourself; ' +
        'it is never deleted automatically.');
    }
    throw new Refusal(`cannot create the lock file ${safeText(lock)}: ${safeText(error.code ?? error.message)}`);
  }
  try { await handle.writeFile(`pid ${process.pid}\nstarted ${new Date().toISOString()}\n`); } finally { await handle.close(); }
  let released = false;
  // A natural exit that skips the finally block (readline paused by Ctrl-C leaves nothing to wait for)
  // still removes the lock this session created, synchronously. Nothing else is ever removed.
  const onExit = () => { if (!released) { released = true; try { rmSync(lock, { force: true }); } catch { /* the lock stays; the person removes it */ } } };
  process.once('exit', onExit);
  return async () => {
    process.removeListener('exit', onExit);
    if (released) return;
    released = true;
    await fs.rm(lock, { force: true });
  };
}

/**
 * Walk the reachable inputs, asking a person for each label. Every completed answer is saved before
 * the next prompt. Only one session at a time may use a labels file (see acquireLock). Returns
 * { code, labeled, skipped }.
 */
export async function runInteractive(options) {
  if (options.resume && kindOfPath(options.labelsOut) !== 'json') throw new Refusal('--resume works on the JSON labels file written by --interactive');
  const release = await acquireLock(options.labelsOut);
  try { return await interactiveSession(options); } finally { await release(); }
}

async function interactiveSession({ input, output, labelsOut, resume = false }) {
  const say = text => output.write(`${text}\n`);
  let policy;
  let entries = new Map();
  if (resume) {
    const existing = await readLabelsFile(labelsOut);
    if (existing.problems.length) throw new Refusal(`the labels file cannot be resumed: ${safeText(existing.problems[0])}`);
    ({ policy, entries } = existing);
  } else {
    try { await fs.access(labelsOut); throw new Refusal(`${safeText(labelsOut)} already exists; refusing to overwrite it (use --resume to continue it)`); }
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
  const labeledCount = () => REACHABLE.filter(item => normalizeEntry(entries.get(inputKey(item))).state === 'complete').length;
  const finish = (code, message) => {
    const labeled = labeledCount();
    say(`${message} ${labeled} of ${REACHABLE.length} inputs are labelled.`);
    reader.close();
    return { code, labeled, skipped: REACHABLE.length - labeled };
  };

  try {
    say('Follow-up adviser: human ground-truth labels. These are your judgement under your own policy; nothing is prefilled.');
    say(EXCLUSION_NOTE);
    for (const line of describeValues()) say(line);
    // Returns the policy text, or null when the session ended or was quit (the message is already said).
    const askPolicy = async untouched => {
      for (;;) {
        const answer = await ask('Policy statement (your own, one line, required; q to quit): ');
        if (answer === null || QUIT.test(answer.trim())) {
          say(`${answer === null ? 'Input ended' : 'Quit'} before a policy statement was given; ${untouched}.`);
          return { code: answer === null ? 3 : 0 };
        }
        const cleaned = safeText(answer);
        if (cleaned && hasLetterOrDigit(cleaned)) {
          if (cleaned !== answer.trim()) say('Control characters were removed from the policy statement.');
          return { policy: cleaned };
        }
        say('The policy statement cannot be empty and needs at least one letter or digit.');
      }
    };
    if (!resume || !hasLetterOrDigit(policy)) {
      if (resume) say('The policy on file is blank (or has no letter or digit). Labels need the policy they were made under, so write it now.');
      const asked = await askPolicy(resume ? 'the file was left as it was' : 'nothing was saved');
      if (asked.policy === undefined) { reader.close(); return { code: asked.code, labeled: labeledCount(), skipped: REACHABLE.length - labeledCount() }; }
      policy = asked.policy;
      await save();
    } else say(`Resuming. Policy statement on file: ${safeText(policy)}`);

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
        if (set.invalid.length || set.duplicates.length || !set.actions.length) { say(`Not understood: use only ${ACTION_ORDER.join(', ')}, each at most once, in plain ASCII letters.`); continue; }
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
        if (set.invalid.length || set.duplicates.length || set.actions.length !== 1 || !acceptable.includes(set.actions[0])) {
          say(`Not understood: give exactly one of ${acceptable.join(', ')}.`);
          continue;
        }
        preferred = set.actions[0];
        break;
      }
      const note = await ask('Note (optional free text; Enter for none): ');
      entries.set(inputKey(item), { acceptable, preferred, note: safeText(note ?? '') });
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
    else throw new Refusal(`unknown argument ${safeText(JSON.stringify(arg.slice(0, 40)))}`);
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
      stdout.write(`wrote a blank sheet with ${REACHABLE.length} rows to ${safeText(options.sheet)}. ${EXCLUSION_NOTE}\n`);
      return 0;
    }
    if (!stdin.isTTY) {
      throw new Refusal('--interactive needs a terminal: stdin is not a TTY. Run it in a terminal, or use --sheet to write a sheet to fill in.');
    }
    const result = await runInteractive({ input: stdin, output: stdout, labelsOut: options.labelsOut, resume: options.resume });
    return result.code;
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    stderr.write(`ERROR ${safeText(error.message, 'lines')}\n${USAGE}\n`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
