import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { loadConfig } from '../scripts/hosted-smoke.mjs';
import { runProbe, main } from '../scripts/hosted-wedge-probe.mjs';

// The probe against the real server on a loopback port. The fix under test is the body reader: this run
// must pass on the current code. (Run against the tree before the fix, the same probe fails; that check
// was done by hand and is recorded in logs/decisions.)
const root = path.resolve(import.meta.dirname, '..');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'enclave-probe-test-'));
const tokenDir = path.join(dir, 'tokens');
let base; let server;

before(async () => {
  const env = { PATH: process.env.PATH, HOME: dir, SKIP_LOCAL_ENV: 'true', DATA_DIR: path.join(dir, 'data'), PORT: '0', COORDINATOR_PROVIDER: 'synthetic_fixture' };
  const setup = spawn(process.execPath, ['scripts/setup-local.mjs', env.DATA_DIR], { cwd: root, env, stdio: 'ignore' });
  assert.equal((await once(setup, 'exit'))[0], 0);
  await fs.mkdir(tokenDir, { mode: 0o700 });
  for (const [from, to] of [['operator', 'manager-sender'], ['recipient-a', 'sales-a'], ['recipient-b', 'sales-b']]) {
    await fs.writeFile(path.join(tokenDir, `${to}.token`), (await fs.readFile(path.join(env.DATA_DIR, `${from}.token`), 'utf8')).trim(), { mode: 0o600 });
  }
  Object.assign(process.env, env);
  const createServer = http.createServer;
  http.createServer = (...args) => { server = createServer(...args); return server; };
  const log = console.log; console.log = () => {};
  try { await import('../server.js'); } finally { console.log = log; http.createServer = createServer; }
  if (!server.listening) await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await fs.rm(dir, { recursive: true, force: true });
});

test('the probe passes on the current code, reports the bounded cost, and prints no secret', async () => {
  const config = await loadConfig({ SMOKE_BASE_URL: base, SMOKE_TOKEN_DIR: tokenDir });
  const lines = [];
  const code = await runProbe(config, { holdMs: 1500, write: line => lines.push(line) });
  const text = lines.join('\n');
  assert.equal(code, 0, text);
  for (const name of ['health', 'baseline', 'dropped-body', 'malformed-chunked-body', 'recovers-after-stall']) {
    assert.ok(lines.some(line => line.startsWith(`PASS ${name}`)), `${name}\n${text}`);
  }
  assert.ok(lines.some(line => line.startsWith('INFO while the stalled connection was open')), text);
  assert.match(lines.at(-1), /^SUMMARY PASS checks=5 passed=5 failed=0 hold_ms=1500$/);
  for (const name of ['manager-sender', 'sales-a']) {
    const token = (await fs.readFile(path.join(tokenDir, `${name}.token`), 'utf8')).trim();
    assert.equal(text.includes(token), false);
  }
});

test('the hold time is validated before anything is sent', async () => {
  const written = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = chunk => { written.push(String(chunk)); return true; };
  try {
    for (const value of ['abc', '500', '99999', '1.5']) {
      assert.equal(await main({ SMOKE_BASE_URL: base, SMOKE_TOKEN_DIR: tokenDir, PROBE_HOLD_MS: value }, []), 2);
    }
    assert.equal(await main({}, []), 2);
  } finally { process.stderr.write = original; }
  assert.ok(written.join('').includes('PROBE_HOLD_MS must be'));
});
