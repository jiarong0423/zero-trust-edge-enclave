import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

test('failed sign-ins lock the client out with 429 and Retry-After; a half-typed token never counts', async t => {
  const root = path.resolve(import.meta.dirname, '..');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'enclave-throttle-test-'));
  let server;
  t.after(async () => {
    if (server && server.exitCode === null) { server.kill(); await once(server, 'exit'); }
    await fs.rm(dir, { recursive: true, force: true });
  });
  const env = { PATH: process.env.PATH, HOME: dir, SKIP_LOCAL_ENV: 'true', LOCAL_ONLY: 'true', DATA_DIR: dir, PORT: '0',
    COORDINATOR_PROVIDER: 'synthetic_fixture', AUTH_MAX_FAILURES: '3', AUTH_WINDOW_SECONDS: '60', AUTH_LOCK_SECONDS: '30' };
  const setup = spawn(process.execPath, ['scripts/setup-local.mjs', dir], { cwd: root, env, stdio: 'ignore' });
  assert.equal((await once(setup, 'exit'))[0], 0);
  server = spawn(process.execPath, ['server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr.resume();
  const base = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Server startup timeout')), 5000);
    server.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
    server.once('exit', () => { clearTimeout(timer); reject(new Error('Server exited')); });
  });
  const whoami = token => fetch(base + '/api/whoami', { headers: token ? { authorization: `Bearer ${token}` } : {} });
  const valid = (await fs.readFile(path.join(dir, 'operator.token'), 'utf8')).trim();
  const wrong = () => crypto.randomBytes(32).toString('base64url');

  // Malformed or missing credentials are 401 and never counted, however many there are.
  for (let i = 0; i < 8; i += 1) assert.equal((await whoami('short')).status, 401);
  assert.equal((await whoami()).status, 401);
  // Typing one's own valid token sends every prefix of it (the pages check as you type). None of
  // that may lock the person out, and the full token must still sign in afterwards.
  for (let length = 1; length < valid.length; length += 1) assert.equal((await whoami(valid.slice(0, length))).status, 401, `prefix ${length}`);
  assert.equal((await whoami(valid)).status, 200);

  // Three well-formed wrong tokens lock the client; the fourth request is refused before any check.
  for (let i = 0; i < 3; i += 1) assert.equal((await whoami(wrong())).status, 401);
  const locked = await whoami(wrong());
  assert.equal(locked.status, 429);
  const retryAfter = Number(locked.headers.get('retry-after'));
  assert.ok(Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 30);
  assert.equal((await locked.json()).ok, false);
  // The lock refuses requests that fail to authenticate. A valid token is not held back by an address's earlier failures:
  // otherwise anyone sending bad tokens from a shared address could lock every legitimate user out. Tokens are 256-bit
  // random values, so the lock limits noise rather than being what stops guessing.
  assert.equal((await whoami(valid)).status, 200);
  assert.equal((await whoami(wrong())).status, 429);
  assert.equal((await whoami(undefined)).status, 429);
  assert.equal((await fetch(base + '/api/health')).status, 200);
});

test('with TRUST_PROXY, spelling one address differently does not buy extra guesses', async t => {
  const root = path.resolve(import.meta.dirname, '..');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'enclave-throttle-proxy-'));
  let server;
  t.after(async () => {
    if (server && server.exitCode === null) { server.kill(); await once(server, 'exit'); }
    await fs.rm(dir, { recursive: true, force: true });
  });
  const env = { PATH: process.env.PATH, HOME: dir, SKIP_LOCAL_ENV: 'true', LOCAL_ONLY: 'true', DATA_DIR: dir, PORT: '0',
    COORDINATOR_PROVIDER: 'synthetic_fixture', AUTH_MAX_FAILURES: '3', TRUST_PROXY: 'true' };
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
  const attempt = forwarded => fetch(base + '/api/whoami', { headers: { authorization: `Bearer ${crypto.randomBytes(32).toString('base64url')}`, 'x-forwarded-for': forwarded } });
  const spellings = ['::1', '0:0:0:0:0:0:0:1', '::0001', '0000::1', '::1', '0:0::1'];
  const statuses = [];
  for (const spelling of spellings) statuses.push((await attempt(spelling)).status);
  assert.deepEqual(statuses, [401, 401, 401, 429, 429, 429]);
  // A different client is unaffected.
  assert.equal((await attempt('198.51.100.7')).status, 401);
});
