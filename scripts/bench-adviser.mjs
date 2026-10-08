// Follow-up adviser comparison: deterministic fixture vs a loopback local model vs the hosted model,
// on the same 36 inputs, through the production requestFileAdvice path.
//
//   node scripts/bench-adviser.mjs                       fixture only: no network, no model
//   node scripts/bench-adviser.mjs --local               loopback runtime only (LM Studio, llama.cpp, ...)
//   node scripts/bench-adviser.mjs --cloud --yes-spend   hosted model; spends money, see docs/agent/bench-adviser.md
//   add --out <file> to write the result as JSON (refuses to overwrite an existing file)
//
// Environment (process environment only; no .env file is ever read by this script):
//   LOCAL_MODEL_BASE_URL   default http://127.0.0.1:1234/v1 (must be loopback)
//   LOCAL_MODEL_NAME       default nvidia-nemotron-3-nano-4b
//   NEBIUS_API_KEY         required for --cloud; never printed or written
//   NEBIUS_BASE_URL        default https://api.tokenfactory.nebius.com/v1
//   NEBIUS_MODEL           default nvidia/nemotron-3-super-120b-a12b
//   NEBIUS_PRICE_INPUT_PER_M / NEBIUS_PRICE_OUTPUT_PER_M   USD per million tokens, for the cost estimate
//
// Exit codes: 0 done, 2 refused or not ready (nothing was written).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ADVICE_KINDS, ADVISER_PROVIDERS, FOLLOWUP_ADVISER_BOUNDARY, requestFileAdvice } from '../file-adviser.js';
import { MAX_NUDGES, syntheticFollowupAdvice } from '../delivery-followup.js';

export const TASK_ALIAS = '12345678-1234-4234-8234-123456789012';
export const TIME_CODES = ['WINDOW_FULL', 'WINDOW_MOST', 'WINDOW_LITTLE', 'WINDOW_LAST'];
export const PICKUP_CODES = ['PICKUP_NONE', 'PICKUP_SOME', 'PICKUP_ALL'];
export const ACTIONS = [...ADVICE_KINDS.followup.schema.properties.action.enum];
export const CLOUD_CALL_CAP = 40;
export const CLOUD_SPACING_MS = 1200;
export const DEFAULT_LOCAL_BASE_URL = 'http://127.0.0.1:1234/v1';
export const DEFAULT_LOCAL_MODEL = 'nvidia-nemotron-3-nano-4b';
export const DEFAULT_CLOUD_BASE_URL = 'https://api.tokenfactory.nebius.com/v1';
export const DEFAULT_CLOUD_MODEL = 'nvidia/nemotron-3-super-120b-a12b';
export const FOOTER = 'The fixture is a blunt stand-in, not ground truth; agreement is not accuracy.';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);
const USAGE = 'usage: node scripts/bench-adviser.mjs [--local] [--cloud --yes-spend] [--out <file>]';

class Refusal extends Error {}

// --- Pure functions -------------------------------------------------------------------------------

/** The 4 x 3 x (MAX_NUDGES + 1) input grid, in a fixed order. */
export function buildGrid() {
  const grid = [];
  for (const timeCode of TIME_CODES) {
    for (const pickupCode of PICKUP_CODES) {
      for (let nudgeCount = 0; nudgeCount <= MAX_NUDGES; nudgeCount += 1) {
        grid.push({ timeCode, pickupCode, nudgeCount,
          metadata: { taskAlias: TASK_ALIAS, snapshotVersion: 1, timeCode, nudgeCount, pickupCode } });
      }
    }
  }
  return grid;
}

/** One row per grid entry with the deterministic fixture answer attached. */
export function fixtureRows(grid = buildGrid()) {
  return grid.map(({ timeCode, pickupCode, nudgeCount, metadata }) => {
    const advice = syntheticFollowupAdvice(metadata);
    return { timeCode, pickupCode, nudgeCount, fixture: `${advice.action}/${advice.reasonCode}`, outlets: {} };
  });
}

export const actionOf = value => (typeof value === 'string' ? value.split('/')[0] : null);

function distribution(values) {
  const counts = Object.fromEntries(ACTIONS.map(action => [action, 0]));
  for (const value of values) {
    const action = actionOf(value);
    if (action in counts) counts[action] += 1;
  }
  return counts;
}

/** Action counts of the fixture column. */
export function summariseFixture(rows) {
  return { cases: rows.length, distribution: distribution(rows.map(row => row.fixture)) };
}

/** Median of a number list; the mean of the two middle values when the count is even, rounded. */
export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

/**
 * Per-outlet summary. Each row carries `outlets[name] = { accepted, advice: "ACTION/REASON" | null,
 * ms, error? }`. Agreement and latency are computed over accepted answers only; a refused answer
 * has no action to compare.
 */
export function summariseOutlet(rows, name) {
  const results = rows.map(row => ({ fixture: row.fixture, result: row.outlets?.[name] })).filter(item => item.result);
  const accepted = results.filter(item => item.result.accepted);
  const times = accepted.map(item => item.result.ms).filter(Number.isFinite);
  const rejections = {};
  for (const item of results) {
    if (item.result.accepted) continue;
    const code = item.result.error || 'ERROR';
    rejections[code] = (rejections[code] ?? 0) + 1;
  }
  const agree = accepted.filter(item => actionOf(item.result.advice) === actionOf(item.fixture)).length;
  return {
    calls: results.length,
    accepted: accepted.length,
    rejected: results.length - accepted.length,
    distribution: distribution(accepted.map(item => item.result.advice)),
    agreeWithFixture: agree,
    agreementOfAccepted: accepted.length ? Math.round((agree / accepted.length) * 1000) / 1000 : null,
    latencyMs: { min: times.length ? Math.min(...times) : null, median: median(times), max: times.length ? Math.max(...times) : null },
    rejections,
  };
}

/** Parse the command line. Throws Refusal on anything unknown. */
export function parseArgs(argv) {
  const options = { local: false, cloud: false, yesSpend: false, out: null, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--local') options.local = true;
    else if (arg === '--cloud') options.cloud = true;
    else if (arg === '--yes-spend') options.yesSpend = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--out') {
      index += 1;
      if (!argv[index] || argv[index].startsWith('--')) throw new Refusal('--out needs a file path');
      options.out = argv[index];
    } else if (arg.startsWith('--out=') && arg.length > 6) options.out = arg.slice(6);
    else throw new Refusal(`unknown argument ${JSON.stringify(arg.slice(0, 40))}`);
  }
  return options;
}

/** Throws unless the URL is a plain loopback /v1 endpoint, the only shape the production outlet accepts. */
export function assertLoopbackBaseUrl(baseUrl) {
  let endpoint;
  try { endpoint = new URL(baseUrl); } catch { throw new Refusal('LOCAL_MODEL_BASE_URL is not a URL'); }
  if (!LOOPBACK_HOSTS.has(endpoint.hostname)) {
    throw new Refusal('LOCAL_MODEL_BASE_URL must be loopback (127.0.0.1, ::1 or localhost); a remote host is not a local outlet');
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname.replace(/\/$/, '') !== '/v1') {
    throw new Refusal('LOCAL_MODEL_BASE_URL must look like http://127.0.0.1:1234/v1');
  }
  return endpoint;
}

/**
 * Upper-bound cost estimate for the hosted run: about 4 characters per input token, every output at
 * the provider's max_tokens. Returns null when either price is missing or unusable.
 */
export function estimateCost(calls, env = {}) {
  const price = value => (value === undefined || String(value).trim() === '' ? NaN : Number(value));
  const inPrice = price(env.NEBIUS_PRICE_INPUT_PER_M);
  const outPrice = price(env.NEBIUS_PRICE_OUTPUT_PER_M);
  if (![inPrice, outPrice].every(value => Number.isFinite(value) && value >= 0)) return null;
  const inputTokens = Math.ceil((FOLLOWUP_ADVISER_BOUNDARY.length + 200) / 4);
  const outputTokens = ADVISER_PROVIDERS.nebius.maxTokens;
  return { inputTokensPerCall: inputTokens, outputTokensPerCall: outputTokens,
    usdUpperBound: (calls * (inputTokens * inPrice + outputTokens * outPrice)) / 1e6 };
}

/** Replace every non-empty secret in text. */
export function redact(text, secrets) {
  let out = String(text);
  for (const secret of secrets) if (secret) out = out.split(secret).join('[redacted]');
  return out;
}

/** Render the comparison as a markdown table. `names` are the outlet columns, in order. */
export function renderTable(rows, names) {
  const header = ['time', 'pickup', 'nudges', 'fixture', ...names.map(name => `${name} (ms)`)];
  const lines = [`| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`];
  for (const row of rows) {
    const cells = names.map(name => {
      const result = row.outlets[name];
      if (!result) return '-';
      return result.accepted ? `${result.advice} (${result.ms})` : `REFUSED ${result.error} (${result.ms})`;
    });
    lines.push(`| ${[row.timeCode, row.pickupCode, row.nudgeCount, row.fixture, ...cells].join(' | ')} |`);
  }
  return lines.join('\n');
}

function renderSummary(name, summary) {
  const dist = ACTIONS.map(action => `${action} ${summary.distribution[action]}`).join(' / ');
  const lat = summary.latencyMs;
  const agreement = summary.agreementOfAccepted === null ? 'n/a' : `${summary.agreeWithFixture}/${summary.accepted}`;
  const rejected = Object.keys(summary.rejections).length ? ` ${JSON.stringify(summary.rejections)}` : '';
  return `${name}: accepted ${summary.accepted}/${summary.calls}, rejected ${summary.rejected}${rejected}; actions ${dist}; ` +
    `same action as fixture ${agreement}; latency ms min ${lat.min ?? 'n/a'} / median ${lat.median ?? 'n/a'} / max ${lat.max ?? 'n/a'} (accepted only)`;
}

// --- Runner ---------------------------------------------------------------------------------------

/**
 * Run the grid through one outlet. `call(metadata)` returns the validated advice or throws. The call
 * count is capped here as well as by the caller, so a larger grid cannot spend past `maxCalls`.
 */
export async function runOutlet({ name, grid, rows, call, spacingMs = 0, maxCalls = Infinity, sleep, now, secrets = [], log = () => {} }) {
  if (grid.length > maxCalls) throw new Refusal(`${grid.length} calls exceeds the cap of ${maxCalls}`);
  let calls = 0;
  for (let index = 0; index < grid.length; index += 1) {
    if (calls >= maxCalls) throw new Refusal('call cap reached');
    if (index > 0 && spacingMs > 0) await sleep(spacingMs);
    calls += 1;
    const started = now();
    let result;
    try {
      const advice = await call(grid[index].metadata);
      result = { accepted: true, advice: `${advice.action}/${advice.reasonCode}` };
    } catch (error) {
      const code = redact(error?.code || error?.message || error?.status || 'ERROR', secrets).slice(0, 80);
      result = { accepted: false, advice: null, error: code };
    }
    result.ms = Math.round(now() - started);
    rows[index].outlets[name] = result;
    log(`${name} ${index + 1}/${grid.length} ${result.accepted ? result.advice : `REFUSED ${result.error}`} ${result.ms}ms`);
  }
  return calls;
}

async function probeLocal(baseUrl, model, request) {
  const response = await request(`${baseUrl.replace(/\/$/, '')}/models`, { signal: AbortSignal.timeout(4000), redirect: 'error' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const names = (await response.json()).data?.map(entry => entry.id) ?? [];
  if (!names.includes(model)) throw new Error(`model "${model}" is not loaded; loaded: ${names.join(', ') || 'none'}`);
}

async function assertOutWritable(file) {
  const target = path.resolve(file);
  const exists = await fs.stat(target).then(() => true, () => false);
  if (exists) throw new Refusal(`${file} already exists; this script does not overwrite`);
  const parent = await fs.stat(path.dirname(target)).catch(() => null);
  if (!parent?.isDirectory()) throw new Refusal(`directory of ${file} does not exist`);
  return target;
}

/**
 * Entry point. Returns the exit code instead of exiting so tests can drive it. `deps` lets tests
 * inject env, fetch, output sinks, sleep and the clock.
 */
export async function main(argv = process.argv.slice(2), deps = {}) {
  const env = deps.env ?? process.env;
  const request = deps.request ?? fetch;
  const out = deps.stdout ?? (text => process.stdout.write(`${text}\n`));
  const err = deps.stderr ?? (text => process.stderr.write(`${text}\n`));
  const sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const now = deps.now ?? (() => performance.now());
  const apiKey = typeof env.NEBIUS_API_KEY === 'string' ? env.NEBIUS_API_KEY.trim() : '';
  const secrets = [apiKey];

  try {
    const options = parseArgs(argv);
    if (options.help) { out(USAGE); return 0; }
    const grid = buildGrid();
    const rows = fixtureRows(grid);
    const outlets = [];
    let outTarget = null;

    // Every gate runs before the first model call, so a refusal never leaves a half-spent run behind.
    let cloud = null;
    if (options.cloud) {
      if (!options.yesSpend) throw new Refusal('--cloud spends money on the hosted model and needs --yes-spend as well; nothing was called');
      if (!apiKey) throw new Refusal('--cloud needs NEBIUS_API_KEY already set in the process environment; no .env file is read; nothing was called');
      if (grid.length > CLOUD_CALL_CAP) throw new Refusal(`${grid.length} calls exceeds the hard cap of ${CLOUD_CALL_CAP}`);
      cloud = { baseUrl: env.NEBIUS_BASE_URL || DEFAULT_CLOUD_BASE_URL, model: env.NEBIUS_MODEL || DEFAULT_CLOUD_MODEL };
      let endpoint;
      try { endpoint = new URL(cloud.baseUrl); } catch { throw new Refusal('NEBIUS_BASE_URL is not a URL'); }
      if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname.replace(/\/$/, '') !== '/v1' ||
          !ADVISER_PROVIDERS.nebius.accepts(endpoint, { apiKey, model: cloud.model })) {
        throw new Refusal('NEBIUS_BASE_URL or NEBIUS_MODEL is not accepted by the production outlet rule; nothing was called');
      }
    }
    let local = null;
    if (options.local) {
      local = { baseUrl: env.LOCAL_MODEL_BASE_URL || DEFAULT_LOCAL_BASE_URL, model: env.LOCAL_MODEL_NAME || DEFAULT_LOCAL_MODEL };
      const endpoint = assertLoopbackBaseUrl(local.baseUrl);
      if (!ADVISER_PROVIDERS.local_openai_compatible.accepts(endpoint, local)) throw new Refusal('LOCAL_MODEL_NAME is not accepted by the production outlet rule');
    }
    if (options.out) outTarget = await assertOutWritable(options.out);

    if (local) {
      try {
        await probeLocal(local.baseUrl, local.model, request);
      } catch (error) {
        err(`ERROR local model not ready at ${local.baseUrl}: ${redact(error?.cause?.code || error?.message || 'unreachable', secrets)}`);
        return 2;
      }
    }

    if (local) {
      outlets.push('local');
      await runOutlet({ name: 'local', grid, rows, sleep, now, secrets, log: err,
        call: async metadata => (await requestFileAdvice(metadata, { kind: 'followup', provider: 'local_openai_compatible',
          localOnly: true, baseUrl: local.baseUrl, model: local.model }, request)).advice });
    }
    if (cloud) {
      outlets.push('cloud');
      const estimate = estimateCost(grid.length, env);
      out(`cloud: ${grid.length} calls (hard cap ${CLOUD_CALL_CAP}), ${CLOUD_SPACING_MS} ms apart, model ${cloud.model}`);
      out(estimate
        ? `cloud: estimated cost up to USD ${estimate.usdUpperBound.toFixed(4)} (upper bound: ~${estimate.inputTokensPerCall} input and ${estimate.outputTokensPerCall} output tokens per call at the configured prices)`
        : 'cloud: estimated cost unpriced (set NEBIUS_PRICE_INPUT_PER_M and NEBIUS_PRICE_OUTPUT_PER_M for an estimate)');
      await runOutlet({ name: 'cloud', grid, rows, sleep, now, secrets, log: err, spacingMs: CLOUD_SPACING_MS, maxCalls: CLOUD_CALL_CAP,
        call: async metadata => (await requestFileAdvice(metadata, { kind: 'followup', provider: 'nebius', localOnly: false,
          apiKey, baseUrl: cloud.baseUrl, model: cloud.model }, request)).advice });
    }

    const fixture = summariseFixture(rows);
    const summaries = Object.fromEntries(outlets.map(name => [name, summariseOutlet(rows, name)]));
    out(renderTable(rows, outlets));
    out('');
    out(`fixture: ${fixture.cases} cases; ${ACTIONS.map(action => `${action} ${fixture.distribution[action]}`).join(' / ')}`);
    for (const name of outlets) out(renderSummary(name, summaries[name]));
    out(FOOTER);

    if (outTarget) {
      const result = {
        schema: 'bench-adviser/1',
        generatedAt: new Date().toISOString(),
        modes: ['fixture', ...outlets],
        cases: rows.length,
        fixture,
        outlets: {
          ...(local ? { local: { provider: 'local_openai_compatible', baseUrl: local.baseUrl, model: local.model, summary: summaries.local } } : {}),
          ...(cloud ? { cloud: { provider: 'nebius', baseUrl: cloud.baseUrl, model: cloud.model, summary: summaries.cloud } } : {}),
        },
        rows,
        note: FOOTER,
      };
      await fs.writeFile(outTarget, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
      out(`wrote ${options.out}`);
    }
    return 0;
  } catch (error) {
    if (error instanceof Refusal) {
      err(`ERROR ${redact(error.message, secrets)}`);
      err(USAGE);
      return 2;
    }
    err(`ERROR ${redact(error?.message || 'unexpected failure', secrets)}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
