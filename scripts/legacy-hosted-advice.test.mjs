import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

// A loopback stand-in for the hosted endpoint that only counts what reaches it.
async function stub(t) {
  const seen = { requests: 0, bodies: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => { seen.requests += 1; seen.bodies.push(body); res.writeHead(500, { 'content-type': 'application/json' }); res.end('{}'); });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { seen, url: `http://127.0.0.1:${server.address().port}/v1` };
}

async function run(t, extraEnv, baseUrl) {
  const root = path.resolve(import.meta.dirname, '..');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'enclave-legacy-'));
  let server;
  t.after(async () => {
    if (server && server.exitCode === null) { server.kill(); await once(server, 'exit'); }
    await fs.rm(dir, { recursive: true, force: true });
  });
  const env = { PATH: process.env.PATH, HOME: dir, SKIP_LOCAL_ENV: 'true', LOCAL_ONLY: 'false', DATA_DIR: dir, PORT: '0',
    COORDINATOR_PROVIDER: 'nebius', NEBIUS_API_KEY: 'unused-test-placeholder', NEBIUS_BASE_URL: baseUrl, ...extraEnv };
  const setup = spawn(process.execPath, ['scripts/setup-local.mjs', dir], { cwd: root, env, stdio: 'ignore' });
  assert.equal((await once(setup, 'exit'))[0], 0);
  server = spawn(process.execPath, ['server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr.resume();
  const base = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Server startup timeout')), 8000);
    server.stdout.on('data', chunk => { output += chunk; const match = output.match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timer); resolve(match[0]); } });
    server.once('exit', () => { clearTimeout(timer); reject(new Error('Server exited')); });
  });
  const token = (await fs.readFile(path.join(dir, 'operator.token'), 'utf8')).trim();
  return fetch(base + '/api/policy/recommend', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ policyMetadata: {} }) });
}

test('by default the legacy policy path calls the hosted endpoint with the six enumerated categories', async t => {
  const { seen, url } = await stub(t);
  await run(t, {}, url);
  assert.ok(seen.requests >= 1, 'the legacy path reached the hosted endpoint');
  const sent = JSON.parse(JSON.parse(seen.bodies[0]).messages.at(-1).content);
  assert.deepEqual(Object.keys(sent.policyMetadata).sort(),
    ['businessPurpose', 'confidentiality', 'dataCategory', 'devicePolicy', 'openLimit', 'requestedExpiry']);
});

test('LEGACY_HOSTED_ADVICE=off keeps the legacy policy path entirely local', async t => {
  const { seen, url } = await stub(t);
  const response = await run(t, { LEGACY_HOSTED_ADVICE: 'off' }, url);
  assert.equal(response.status, 200);
  assert.equal(seen.requests, 0, 'nothing reached the hosted endpoint');
  const body = await response.json();
  assert.equal(body.policy.provider, 'demo_fallback', 'answered from the local fixture');
});

test('only the exact value off changes behaviour', async t => {
  const { seen, url } = await stub(t);
  await run(t, { LEGACY_HOSTED_ADVICE: 'OFF ' }, url);
  assert.ok(seen.requests >= 1);
});
