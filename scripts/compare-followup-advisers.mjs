#!/usr/bin/env node
// Lookup table against Nemotron on the follow-up decision, over the same 36 inputs.
//
// Columns:
//   table            `tableFollowupAdvice` in followup-table.js: the decision with no model at all. Computed here.
//   recorded runs    docs/agent/fixtures/followup-advisers-recorded.json: real calls made on the dates it names
//                    (Super 120B and Nano 4B 2026-10-08, Ultra 550B 2026-10-16), recomputed row by row here.
//   live runs        optional: `--cloud --yes-spend` with NEBIUS_API_KEY in the environment calls Token Factory
//                    through the production `requestFileAdvice` path with `enable_thinking` false and/or true.
//
// Every per-row figure is recomputed from rows; figures that exist only as a recorded summary (the 60-call
// prompt-form measurement, the 4B reasoning probe) are printed under "recorded summaries" and marked so.
//
// Without a key the script is offline and prints the table against the recorded runs. With a key, the live
// call count is `cells x thinking modes` and is refused before any call when it exceeds `--max-calls`
// (default 20, ceiling 40). The key is never printed and is redacted from any recorded error.
//
//   node scripts/compare-followup-advisers.mjs                                  # offline, no network
//   NEBIUS_API_KEY=... node scripts/compare-followup-advisers.mjs --cloud --yes-spend --thinking both   # 12 calls
//   ... --cells reachable --thinking off --max-calls 24                         # 24 calls, the inputs the product sends
//   ... --out result.json                                                       # JSON (refuses to overwrite)
//
// Thinking on: the production outlet sends `chat_template_kwargs.enable_thinking: false`, 512 max tokens and
// a 5 s deadline. The thinking-on column flips that flag on the wire, raises max_tokens to 4096 and waits up
// to 60 s, because otherwise every call would time out and nothing would be measured; everything else
// (projection, boundary, schema, validator) is the production path. That column is therefore a measurement
// of the model with reasoning, not of the shipped product.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { followupCells, tableFollowupAdvice } from '../followup-table.js';
import { validateFollowupAdvice, PICKUP_CODES } from '../delivery-followup.js';
import { ADVISER_PROVIDERS, requestFileAdvice } from '../file-adviser.js';

export const RECORDED_FILE = fileURLToPath(new URL('../docs/agent/fixtures/followup-advisers-recorded.json', import.meta.url));
export const DEFAULT_CLOUD_BASE_URL = 'https://api.tokenfactory.nebius.com/v1';
export const DEFAULT_CLOUD_MODEL = 'nvidia/nemotron-3-super-120b-a12b';
export const DEFAULT_MAX_CALLS = 20;
export const MAX_CALLS_CEILING = 40;
export const CLOUD_SPACING_MS = 1200;
export const THINKING_MAX_TOKENS = 4096;
export const THINKING_TIMEOUT_MS = 60000;
export const ACTIONS = ['WAIT', 'REMIND', 'ESCALATE'];
export const FOOTER = 'The table is the fixed floor and a blunt stand-in, not ground truth; agreement with it is not accuracy.';
const USAGE = 'usage: node scripts/compare-followup-advisers.mjs [--cloud --yes-spend] [--thinking off|on|both] ' +
  '[--cells critical|reachable|all] [--max-calls N] [--out <file>]';

class Refusal extends Error {}

export const keyOf = cell => `${cell.timeCode}/${cell.pickupCode}/${cell.nudgeCount}`;
export const actionOf = value => (typeof value === 'string' ? value.split('/')[0] : null);

/** The 36 inputs, from the table module itself, with the table's own answer and what the validator allows. */
export function inputs() {
  return followupCells().map(cell => ({ ...cell, key: keyOf(cell),
    metadata: { taskAlias: '11111111-1111-4111-8111-111111111111', snapshotVersion: 1,
      timeCode: cell.timeCode, pickupCode: cell.pickupCode, nudgeCount: cell.nudgeCount } }));
}

/** Which inputs a live run sends. `critical`: WINDOW_LAST with the pickup incomplete (the table escalates in all 6). */
export function selectCells(cells, which) {
  if (which === 'all') return cells;
  if (which === 'reachable') return cells.filter(cell => cell.pickupCode !== 'PICKUP_ALL');
  if (which === 'critical') return cells.filter(cell => cell.timeCode === 'WINDOW_LAST' && cell.pickupCode !== 'PICKUP_ALL');
  throw new Refusal(`unknown --cells ${JSON.stringify(String(which).slice(0, 20))}`);
}

/** The lookup table column: every input through the table and then the production validator, timed. */
export function tableColumn(cells, now = () => performance.now()) {
  const rows = {};
  for (const cell of cells) {
    const started = now();
    let result;
    try {
      const advice = validateFollowupAdvice(tableFollowupAdvice(cell.metadata), cell.metadata);
      result = { accepted: true, action: advice.action, advice: `${advice.action}/${advice.reasonCode}` };
    } catch (error) {
      result = { accepted: false, action: null, error: error?.message || 'ERROR' };
    }
    result.ms = Math.round((now() - started) * 1000) / 1000;
    rows[cell.key] = result;
  }
  return { id: 'table', label: 'lookup table (followup-table.js), no model', model: '-', date: 'computed now', thinking: 'n/a', live: false, rows };
}

export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  if (sorted.length % 2) return sorted[middle];
  const mean = (sorted[middle - 1] + sorted[middle]) / 2;
  return sorted.every(Number.isInteger) ? Math.round(mean) : Math.round(mean * 1000) / 1000;
}

/** Nearest-rank p95. */
export function p95(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)];
}

/**
 * Summary of one column over the cells it has rows for. "Coherent" is validator acceptance: the production
 * validator refuses an answer whose reason does not fit the input, so accepted / answered is the coherence
 * rate on the production definition. Agreement is with the table (same action), on accepted rows only.
 */
export function summarise(column, cells, table) {
  const present = cells.filter(cell => column.rows[cell.key]);
  const accepted = present.filter(cell => column.rows[cell.key].accepted);
  const same = accepted.filter(cell => column.rows[cell.key].action === table.rows[cell.key].action);
  const tableEscalates = present.filter(cell => table.rows[cell.key].action === 'ESCALATE');
  const escalated = tableEscalates.filter(cell => column.rows[cell.key].action === 'ESCALATE');
  const reachable = present.filter(cell => cell.pickupCode !== 'PICKUP_ALL');
  const reachableAccepted = reachable.filter(cell => column.rows[cell.key].accepted);
  const reachableSame = reachableAccepted.filter(cell => column.rows[cell.key].action === table.rows[cell.key].action);
  const times = accepted.map(cell => column.rows[cell.key].ms).filter(Number.isFinite);
  const distribution = Object.fromEntries(ACTIONS.map(action => [action, accepted.filter(cell => column.rows[cell.key].action === action).length]));
  const rejections = {};
  for (const cell of present) {
    const row = column.rows[cell.key];
    if (!row.accepted) rejections[row.error || 'ERROR'] = (rejections[row.error || 'ERROR'] ?? 0) + 1;
  }
  const latency = times.length
    ? { min: Math.min(...times), median: median(times), p95: p95(times), max: Math.max(...times), from: 'rows' }
    : column.recordedLatencyMs ? { ...column.recordedLatencyMs, p95: null, from: 'recorded summary' } : null;
  return {
    answered: present.length, accepted: accepted.length, rejected: present.length - accepted.length, rejections,
    coherent: present.length ? Math.round((accepted.length / present.length) * 1000) / 1000 : null,
    distribution, sameAsTable: same.length,
    escalatedWhereTableDoes: { count: escalated.length, of: tableEscalates.length },
    reachable: { answered: reachable.length, accepted: reachableAccepted.length, sameAsTable: reachableSame.length },
    latencyMs: latency,
  };
}

/** Load the recorded runs and turn each into a column keyed like the table. */
export async function loadRecorded(file = RECORDED_FILE, read = fs.readFile) {
  const record = JSON.parse(await read(file, 'utf8'));
  const columns = [];
  for (const run of record.runs) {
    let rows = run.rows;
    if (run.rowsFile) {
      const bench = JSON.parse(await read(path.join(path.dirname(file), run.rowsFile), 'utf8'));
      rows = {};
      for (const row of bench.rows) {
        const result = row.outlets[run.rowsOutlet];
        rows[keyOf(row)] = { accepted: result.accepted, action: actionOf(result.advice), advice: result.advice ?? undefined,
          ms: Number.isFinite(result.ms) ? result.ms : null, ...(result.accepted ? {} : { error: result.error }) };
      }
    }
    columns.push({ id: run.id, label: run.label, model: run.model, date: run.date, thinking: run.thinking, live: false,
      source: run.source, recordedLatencyMs: run.recordedLatencyMs, rows });
  }
  return { columns, summariesOnly: record.summariesOnly ?? [] };
}

export function parseArgs(argv) {
  const options = { cloud: false, yesSpend: false, thinking: 'off', cells: 'critical', maxCalls: DEFAULT_MAX_CALLS, out: null, help: false };
  const value = (index, name) => {
    if (!argv[index] || argv[index].startsWith('--')) throw new Refusal(`${name} needs a value`);
    return argv[index];
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--cloud') options.cloud = true;
    else if (arg === '--yes-spend') options.yesSpend = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--thinking') options.thinking = value(++index, arg);
    else if (arg === '--cells') options.cells = value(++index, arg);
    else if (arg === '--max-calls') options.maxCalls = Number(value(++index, arg));
    else if (arg === '--out') options.out = value(++index, arg);
    else throw new Refusal(`unknown argument ${JSON.stringify(arg.slice(0, 40))}`);
  }
  if (!['off', 'on', 'both'].includes(options.thinking)) throw new Refusal('--thinking must be off, on or both');
  if (!Number.isInteger(options.maxCalls) || options.maxCalls < 1 || options.maxCalls > MAX_CALLS_CEILING) {
    throw new Refusal(`--max-calls must be an integer from 1 to ${MAX_CALLS_CEILING}`);
  }
  return options;
}

export function redact(text, secrets) {
  let out = String(text);
  for (const secret of secrets) if (secret) out = out.split(secret).join('[redacted]');
  return out;
}

/**
 * Wrap fetch so the production request goes out with `enable_thinking` set as asked. For thinking on, the
 * answer budget and the deadline are widened (see the header); the production `signal` is dropped for that
 * mode only, so the 5 s abort does not fire while the model reasons.
 */
export function thinkingRequest(request, enable) {
  return async (url, init = {}) => {
    const body = JSON.parse(init.body);
    body.chat_template_kwargs = { ...(body.chat_template_kwargs ?? {}), enable_thinking: enable };
    if (enable) body.max_tokens = Math.max(body.max_tokens ?? 0, THINKING_MAX_TOKENS);
    const { signal, ...rest } = init;
    return request(url, { ...rest, body: JSON.stringify(body), signal: enable ? AbortSignal.timeout(THINKING_TIMEOUT_MS) : signal });
  };
}

async function runLive({ cells, enable, cloud, apiKey, request, sleep, now, secrets, log }) {
  const rows = {};
  const send = thinkingRequest(request, enable);
  for (let index = 0; index < cells.length; index += 1) {
    if (index > 0) await sleep(CLOUD_SPACING_MS);
    const cell = cells[index];
    const started = now();
    let result;
    try {
      const { advice } = await requestFileAdvice(cell.metadata, { kind: 'followup', provider: 'nebius', localOnly: false,
        apiKey, baseUrl: cloud.baseUrl, model: cloud.model }, send);
      result = { accepted: true, action: advice.action, advice: `${advice.action}/${advice.reasonCode}` };
    } catch (error) {
      result = { accepted: false, action: null, error: redact(error?.code || error?.message || 'ERROR', secrets).slice(0, 80) };
    }
    result.ms = Math.round(now() - started);
    rows[cell.key] = result;
    log(`live thinking=${enable ? 'on' : 'off'} ${index + 1}/${cells.length} ${cell.key} ${result.accepted ? result.advice : `REFUSED ${result.error}`} ${result.ms}ms`);
  }
  return rows;
}

function pct(value) { return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`; }
function ms(value) { return value === null || value === undefined ? 'n/a' : Number.isInteger(value) ? String(value) : value.toFixed(3); }

export function renderRows(cells, columns) {
  const header = ['input', ...columns.map(column => column.id)];
  const lines = [`| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`];
  for (const cell of cells) {
    const values = columns.map(column => {
      const row = column.rows[cell.key];
      if (!row) return '-';
      return row.accepted ? `${row.action}${row.ms === null ? '' : ` (${ms(row.ms)})`}` : `REFUSED ${row.error}`;
    });
    lines.push(`| ${[cell.key, ...values].join(' | ')} |`);
  }
  return lines.join('\n');
}

export function renderSummary(columns, summaries) {
  const header = ['column', 'model', 'thinking', 'date', 'answered', 'coherent (validator)', 'WAIT/REMIND/ESCALATE',
    'same as table', 'ESCALATE where table does', 'on the 24 reachable: same', 'latency ms min/median/p95/max'];
  const lines = [`| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`];
  for (const column of columns) {
    const s = summaries[column.id];
    const lat = s.latencyMs ? `${ms(lat0(s.latencyMs.min))}/${ms(lat0(s.latencyMs.median))}/${ms(lat0(s.latencyMs.p95))}/${ms(lat0(s.latencyMs.max))}` +
      (s.latencyMs.from === 'recorded summary' ? ' (recorded)' : '') : 'n/a';
    lines.push(`| ${[column.id, column.model, column.thinking, column.live ? `live ${column.date}` : column.date, s.answered,
      `${s.accepted}/${s.answered} = ${pct(s.coherent)}`, ACTIONS.map(action => s.distribution[action]).join('/'),
      `${s.sameAsTable}/${s.accepted}`, `${s.escalatedWhereTableDoes.count}/${s.escalatedWhereTableDoes.of}`,
      `${s.reachable.sameAsTable}/${s.reachable.accepted}`, lat].join(' | ')} |`);
  }
  return lines.join('\n');
}
const lat0 = value => (value === undefined ? null : value);

export function renderSummariesOnly(items) {
  const lines = ['recorded summaries (no per-row data in the repository; copied, not recomputed):'];
  for (const item of items) {
    if (item.forms) {
      for (const [form, f] of Object.entries(item.forms)) {
        lines.push(`- ${item.id} [${form}]: ${item.callsPerForm} calls, schema pass ${pct(f.schemaPass)}, reason coherent ${pct(f.reasonCoherent)}, ` +
          `logic pass ${pct(f.logicPass)}, p95 ${f.p95Ms} ms (${item.model}, ${item.date}, thinking ${item.thinking}; source ${item.source})`);
      }
    } else if (item.settings) {
      for (const [setting, s] of Object.entries(item.settings)) {
        lines.push(`- ${item.id} [reasoning_effort ${setting}]: ${item.cases} inputs, ${ACTIONS.map(action => `${action} ${s[action]}`).join(' / ')}, ` +
          `same as fixture ${s.sameAsFixture}/${item.cases}, median ${s.medianMs} ms (${item.model}, ${item.date}; source ${item.source})`);
      }
    }
  }
  return lines.join('\n');
}

export function renderSources(columns) {
  return ['sources:', ...columns.map(column => `- ${column.id}: ${column.label}; ${column.live ? `live calls made now (${column.date})` : column.id === 'table' ? 'computed now' : `recorded ${column.date}`}` +
    (column.source ? `; ${column.source}` : ''))].join('\n');
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const env = deps.env ?? process.env;
  const request = deps.request ?? fetch;
  const out = deps.stdout ?? (text => process.stdout.write(`${text}\n`));
  const err = deps.stderr ?? (text => process.stderr.write(`${text}\n`));
  const sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const now = deps.now ?? (() => performance.now());
  const read = deps.readFile ?? fs.readFile;
  const apiKey = typeof env.NEBIUS_API_KEY === 'string' ? env.NEBIUS_API_KEY.trim() : '';
  const secrets = [apiKey];
  try {
    const options = parseArgs(argv);
    if (options.help) { out(USAGE); return 0; }
    const cells = inputs();
    const table = tableColumn(cells, now);
    const { columns: recorded, summariesOnly } = await loadRecorded(deps.recordedFile ?? RECORDED_FILE, read);
    const columns = [table, ...recorded];

    // Every gate before the first call.
    let cloud = null;
    let liveCells = [];
    const modes = options.thinking === 'both' ? [false, true] : [options.thinking === 'on'];
    if (options.cloud) {
      if (!options.yesSpend) throw new Refusal('--cloud spends money on the hosted model and needs --yes-spend as well; nothing was called');
      if (!apiKey) throw new Refusal('--cloud needs NEBIUS_API_KEY already set in the process environment; no .env file is read; nothing was called');
      liveCells = selectCells(cells, options.cells);
      const planned = liveCells.length * modes.length;
      if (planned > options.maxCalls) {
        throw new Refusal(`${planned} calls (${liveCells.length} inputs x ${modes.length} thinking mode${modes.length > 1 ? 's' : ''}) exceeds --max-calls ${options.maxCalls}; nothing was called`);
      }
      cloud = { baseUrl: env.NEBIUS_BASE_URL || DEFAULT_CLOUD_BASE_URL, model: env.NEBIUS_MODEL || DEFAULT_CLOUD_MODEL };
      let endpoint;
      try { endpoint = new URL(cloud.baseUrl); } catch { throw new Refusal('NEBIUS_BASE_URL is not a URL'); }
      if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname.replace(/\/$/, '') !== '/v1' ||
          !ADVISER_PROVIDERS.nebius.accepts(endpoint, { apiKey, model: cloud.model })) {
        throw new Refusal('NEBIUS_BASE_URL or NEBIUS_MODEL is not accepted by the production outlet rule; nothing was called');
      }
      out(`live: ${planned} calls to ${cloud.model} (${liveCells.length} inputs, thinking ${modes.map(m => (m ? 'on' : 'off')).join(' and ')}), ${CLOUD_SPACING_MS} ms apart, cap ${options.maxCalls}`);
    }
    let outTarget = null;
    if (options.out) {
      outTarget = path.resolve(options.out);
      if (await fs.stat(outTarget).then(() => true, () => false)) throw new Refusal(`${options.out} already exists; this script does not overwrite`);
    }

    if (cloud) {
      const date = new Date().toISOString().slice(0, 10);
      for (const enable of modes) {
        const rows = await runLive({ cells: liveCells, enable, cloud, apiKey, request, sleep, now, secrets, log: err });
        columns.push({ id: `live-thinking-${enable ? 'on' : 'off'}`, model: cloud.model, date, thinking: enable ? 'on' : 'off', live: true, rows,
          label: `${cloud.model} on Token Factory through requestFileAdvice, enable_thinking:${enable}` +
            (enable ? ` (max_tokens ${THINKING_MAX_TOKENS}, deadline ${THINKING_TIMEOUT_MS / 1000} s instead of the production 512 / 5 s)` : ' (production shape)') });
      }
    }

    const summaries = Object.fromEntries(columns.map(column => [column.id, summarise(column, cells, table)]));
    out(renderRows(cells, columns));
    out('');
    out(renderSummary(columns, summaries));
    out('');
    out(renderSummariesOnly(summariesOnly));
    out('');
    out(renderSources(columns));
    out(FOOTER);
    if (outTarget) {
      const result = { schema: 'compare-followup-advisers/1', generatedAt: new Date().toISOString(), cases: cells.length,
        columns: columns.map(column => ({ ...column, summary: summaries[column.id] })), summariesOnly, note: FOOTER };
      await fs.writeFile(outTarget, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
      out(`wrote ${options.out}`);
    }
    return 0;
  } catch (error) {
    if (error instanceof Refusal) { err(`ERROR ${redact(error.message, secrets)}`); err(USAGE); return 2; }
    err(`ERROR ${redact(error?.message || 'unexpected failure', secrets)}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
