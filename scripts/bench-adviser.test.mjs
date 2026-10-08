import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  buildGrid, fixtureRows, summariseFixture, summariseOutlet, median, estimateCost, parseArgs,
  assertLoopbackBaseUrl, main, FOOTER, CLOUD_CALL_CAP, CLOUD_SPACING_MS,
} from './bench-adviser.mjs';
import { syntheticFollowupAdvice } from '../delivery-followup.js';

const SCRIPT = fileURLToPath(new URL('./bench-adviser.mjs', import.meta.url));
const FAKE_KEY = 'bench-test-key-DO-NOT-LEAK-0123456789';

function sinks() {
  const lines = { out: [], err: [] };
  return { lines, stdout: text => lines.out.push(text), stderr: text => lines.err.push(text) };
}

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'bench-adviser-'));
}

// A stub outlet: /models lists the model, chat completions echo the deterministic fixture answer.
function stubRequest(calls = []) {
  return async (url, init = {}) => {
    const target = String(url);
    calls.push({ url: target, headers: init.headers, body: init.body });
    if (target.endsWith('/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'nvidia-nemotron-3-nano-4b' }] }), { status: 200 });
    }
    const body = JSON.parse(init.body);
    const advice = syntheticFollowupAdvice(JSON.parse(body.messages[1].content));
    return new Response(JSON.stringify({ model: body.model, choices: [{ message: { content: JSON.stringify(advice) } }] }), { status: 200 });
  };
}

const failingRequest = calls => async url => { calls.push(String(url)); throw new Error(`network must not be used: ${FAKE_KEY}`); };

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

test('fixture mode yields 36 rows and the 16/8/12 distribution without touching the network', async () => {
  const calls = [];
  const { lines, stdout, stderr } = sinks();
  const code = await main([], { env: {}, request: failingRequest(calls), stdout, stderr });
  assert.equal(code, 0);
  assert.equal(calls.length, 0);
  const rows = fixtureRows(buildGrid());
  assert.equal(rows.length, 36);
  assert.deepEqual(summariseFixture(rows), { cases: 36, distribution: { WAIT: 16, REMIND: 8, ESCALATE: 12 } });
  const printed = lines.out.join('\n');
  assert.match(printed, /fixture: 36 cases; WAIT 16 \/ REMIND 8 \/ ESCALATE 12/);
  assert.ok(printed.includes(FOOTER));
  assert.equal(printed.split('\n').filter(line => /^\| WINDOW_/.test(line)).length, 36);
});

test('grid is 4 time codes x 3 pickup codes x 3 nudge counts, all distinct', () => {
  const grid = buildGrid();
  assert.equal(grid.length, 36);
  assert.equal(new Set(grid.map(entry => `${entry.timeCode}|${entry.pickupCode}|${entry.nudgeCount}`)).size, 36);
  assert.ok(grid.length <= CLOUD_CALL_CAP);
});

test('summariser maths on a hand-made row set', () => {
  const row = (fixture, result) => ({ fixture, outlets: { m: result } });
  const rows = [
    row('WAIT/WINDOW_EARLY', { accepted: true, advice: 'WAIT/WINDOW_EARLY', ms: 100 }),
    row('REMIND/NO_PICKUP_YET', { accepted: true, advice: 'ESCALATE/DEADLINE_NEAR', ms: 200 }),
    row('ESCALATE/DEADLINE_NEAR', { accepted: true, advice: 'ESCALATE/NUDGES_EXHAUSTED', ms: 300 }),
    row('WAIT/WINDOW_EARLY', { accepted: true, advice: 'REMIND/PARTIAL_PICKUP', ms: 1000 }),
    row('REMIND/PARTIAL_PICKUP', { accepted: false, advice: null, error: 'FOLLOWUP_REASON_INCOHERENT', ms: 9000 }),
    row('REMIND/PARTIAL_PICKUP', { accepted: false, advice: null, error: 'FOLLOWUP_REASON_INCOHERENT', ms: 9500 }),
  ];
  assert.deepEqual(summariseOutlet(rows, 'm'), {
    calls: 6,
    accepted: 4,
    rejected: 2,
    distribution: { WAIT: 1, REMIND: 1, ESCALATE: 2 },
    agreeWithFixture: 2,
    agreementOfAccepted: 0.5,
    latencyMs: { min: 100, median: 250, max: 1000 },
    rejections: { FOLLOWUP_REASON_INCOHERENT: 2 },
  });
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([]), null);
  const empty = summariseOutlet([row('WAIT/X', { accepted: false, advice: null, error: 'E', ms: 1 })], 'm');
  assert.equal(empty.agreementOfAccepted, null);
  assert.deepEqual(empty.latencyMs, { min: null, median: null, max: null });
});

test('--cloud without --yes-spend exits 2 and makes no network call', async () => {
  const calls = [];
  const { lines, stdout, stderr } = sinks();
  const code = await main(['--cloud'], { env: { NEBIUS_API_KEY: FAKE_KEY }, request: failingRequest(calls), stdout, stderr });
  assert.equal(code, 2);
  assert.equal(calls.length, 0);
  assert.match(lines.err[0], /^ERROR .*--yes-spend/);
  assert.ok(!lines.out.concat(lines.err).join('\n').includes(FAKE_KEY));

  const spawned = spawnSync(process.execPath, [SCRIPT, '--cloud'], {
    env: { PATH: process.env.PATH, NEBIUS_API_KEY: FAKE_KEY }, encoding: 'utf8', timeout: 20000,
  });
  assert.equal(spawned.status, 2);
  assert.match(spawned.stderr, /^ERROR /);
  assert.ok(!(spawned.stdout + spawned.stderr).includes(FAKE_KEY));
});

test('--cloud --yes-spend without NEBIUS_API_KEY exits 2 and makes no network call', async () => {
  const calls = [];
  const { lines, stdout, stderr } = sinks();
  const code = await main(['--cloud', '--yes-spend'], { env: {}, request: failingRequest(calls), stdout, stderr });
  assert.equal(code, 2);
  assert.equal(calls.length, 0);
  assert.match(lines.err[0], /^ERROR .*NEBIUS_API_KEY/);

  const spawned = spawnSync(process.execPath, [SCRIPT, '--cloud', '--yes-spend'], {
    env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: 20000,
  });
  assert.equal(spawned.status, 2);
  assert.match(spawned.stderr, /NEBIUS_API_KEY/);
});

test('--cloud refuses an endpoint the production rule would not accept, before any call', async () => {
  const calls = [];
  const { lines, stdout, stderr } = sinks();
  const code = await main(['--cloud', '--yes-spend'], {
    env: { NEBIUS_API_KEY: FAKE_KEY, NEBIUS_BASE_URL: 'https://example.invalid/v1' }, request: failingRequest(calls), stdout, stderr,
  });
  assert.equal(code, 2);
  assert.equal(calls.length, 0);
  assert.match(lines.err[0], /^ERROR /);
});

test('--cloud with the flag and a key makes 36 spaced calls, prints the estimate first, and leaks no key', async () => {
  const calls = [];
  const sleeps = [];
  const dir = await tempDir();
  const file = path.join(dir, 'cloud.json');
  const { lines, stdout, stderr } = sinks();
  try {
    const code = await main(['--cloud', '--yes-spend', '--out', file], {
      env: { NEBIUS_API_KEY: FAKE_KEY, NEBIUS_PRICE_INPUT_PER_M: '0.30', NEBIUS_PRICE_OUTPUT_PER_M: '0.90' },
      request: stubRequest(calls), sleep: async ms => { sleeps.push(ms); }, stdout, stderr,
    });
    assert.equal(code, 0);
    assert.equal(calls.length, 36);
    assert.ok(calls.every(call => call.url.startsWith('https://api.tokenfactory.nebius.com/v1/chat/completions')));
    assert.equal(sleeps.length, 35);
    assert.ok(sleeps.every(ms => ms === CLOUD_SPACING_MS));
    assert.match(lines.out[0], /^cloud: 36 calls \(hard cap 40\)/);
    assert.match(lines.out[1], /^cloud: estimated cost up to USD [0-9.]+/);
    const written = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(written);
    assert.equal(parsed.outlets.cloud.summary.accepted, 36);
    assert.equal(parsed.outlets.cloud.summary.agreeWithFixture, 36);
    assert.equal(parsed.rows.length, 36);
    assert.ok(!(written + lines.out.join('\n') + lines.err.join('\n')).includes(FAKE_KEY));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('cloud prices missing means "unpriced", and an error that echoes the key is redacted', async () => {
  assert.equal(estimateCost(36, {}), null);
  assert.equal(estimateCost(36, { NEBIUS_PRICE_INPUT_PER_M: '0.3' }), null);
  assert.equal(estimateCost(36, { NEBIUS_PRICE_INPUT_PER_M: 'x', NEBIUS_PRICE_OUTPUT_PER_M: '1' }), null);
  assert.ok(estimateCost(36, { NEBIUS_PRICE_INPUT_PER_M: '0.3', NEBIUS_PRICE_OUTPUT_PER_M: '0.9' }).usdUpperBound > 0);

  const calls = [];
  const dir = await tempDir();
  const file = path.join(dir, 'cloud.json');
  const { lines, stdout, stderr } = sinks();
  try {
    const code = await main(['--cloud', '--yes-spend', '--out', file], {
      env: { NEBIUS_API_KEY: FAKE_KEY }, request: failingRequest(calls), sleep: async () => {}, stdout, stderr,
    });
    assert.equal(code, 0);
    assert.equal(calls.length, 36);
    assert.match(lines.out[1], /unpriced/);
    const written = await fs.readFile(file, 'utf8');
    assert.equal(JSON.parse(written).outlets.cloud.summary.accepted, 0);
    assert.ok(!(written + lines.out.join('\n') + lines.err.join('\n')).includes(FAKE_KEY));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('--local against an unused loopback port exits 2 with the ERROR line and creates no file', async () => {
  const port = await freePort();
  const dir = await tempDir();
  const file = path.join(dir, 'local.json');
  const { lines, stdout, stderr } = sinks();
  try {
    const code = await main(['--local', '--out', file], {
      env: { LOCAL_MODEL_BASE_URL: `http://127.0.0.1:${port}/v1` }, stdout, stderr,
    });
    assert.equal(code, 2);
    assert.match(lines.err[0], /^ERROR local model not ready/);
    assert.equal(await fs.stat(file).then(() => true, () => false), false);
    assert.deepEqual(await fs.readdir(dir), []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('--local with a model that is not loaded exits 2 and writes nothing', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'local.json');
  const { lines, stdout, stderr } = sinks();
  try {
    const code = await main(['--local', '--out', file], {
      env: { LOCAL_MODEL_NAME: 'some-other-model' }, request: stubRequest(), stdout, stderr,
    });
    assert.equal(code, 2);
    assert.match(lines.err[0], /^ERROR local model not ready/);
    assert.deepEqual(await fs.readdir(dir), []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('--local with a non-loopback base URL is refused before any request', async () => {
  for (const baseUrl of ['http://192.168.1.20:1234/v1', 'https://api.example.com/v1', 'http://127.0.0.1.evil.example/v1', 'http://user:pw@127.0.0.1:1234/v1']) {
    const calls = [];
    const { lines, stdout, stderr } = sinks();
    const code = await main(['--local'], { env: { LOCAL_MODEL_BASE_URL: baseUrl }, request: failingRequest(calls), stdout, stderr });
    assert.equal(code, 2, baseUrl);
    assert.equal(calls.length, 0, baseUrl);
    assert.match(lines.err[0], /^ERROR /);
    assert.ok(!lines.err[0].includes('pw@'));
  }
  assert.throws(() => assertLoopbackBaseUrl('http://[::1]:1234/v1/x'));
  assert.doesNotThrow(() => assertLoopbackBaseUrl('http://localhost:1234/v1'));
  assert.doesNotThrow(() => assertLoopbackBaseUrl('http://[::1]:1234/v1'));
});

test('--local against a stub loopback runtime summarises 36 accepted answers', async () => {
  const calls = [];
  const dir = await tempDir();
  const file = path.join(dir, 'local.json');
  const { lines, stdout, stderr } = sinks();
  try {
    const code = await main(['--local', `--out=${file}`], { env: {}, request: stubRequest(calls), stdout, stderr });
    assert.equal(code, 0);
    assert.equal(calls.length, 37);
    assert.ok(calls[0].url.endsWith('/models'));
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(parsed.outlets.local.provider, 'local_openai_compatible');
    assert.equal(parsed.outlets.local.summary.accepted, 36);
    assert.deepEqual(parsed.outlets.local.summary.distribution, { WAIT: 16, REMIND: 8, ESCALATE: 12 });
    assert.ok(lines.out.join('\n').includes(FOOTER));
    // A second run must not overwrite.
    const again = sinks();
    const second = await main(['--out', file], { env: {}, stdout: again.stdout, stderr: again.stderr });
    assert.equal(second, 2);
    assert.match(again.lines.err[0], /already exists/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('argument parsing rejects unknown flags and a missing --out value', () => {
  assert.throws(() => parseArgs(['--bogus']));
  assert.throws(() => parseArgs(['--out']));
  assert.deepEqual(parseArgs(['--local', '--out', 'a.json']), { local: true, cloud: false, yesSpend: false, out: 'a.json', help: false });
});
