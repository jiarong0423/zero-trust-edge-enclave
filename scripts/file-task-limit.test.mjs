import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { sealFileBytes } from '../public/file-envelope.js';
import { checkCapacity, main as capacityMain, LOW_ROOM } from './hosted-capacity.mjs';

// The staged-delivery ceiling is configurable, published, and enforced; and the owner's capacity check reads it.
const root = path.resolve(import.meta.dirname, '..');
async function start(extra) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'enclave-limit-'));
  const env = { PATH: process.env.PATH, HOME: dir, SKIP_LOCAL_ENV: 'true', LOCAL_ONLY: 'true', DATA_DIR: dir, PORT: '0', COORDINATOR_PROVIDER: 'synthetic_fixture', ...extra };
  const setup = spawn(process.execPath, ['scripts/setup-local.mjs', dir], { cwd: root, env, stdio: 'ignore' });
  assert.equal((await once(setup, 'exit'))[0], 0);
  const server = spawn(process.execPath, ['server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr.resume();
  const base = await new Promise((resolve, reject) => {
    let output = ''; const timer = setTimeout(() => reject(new Error('startup timeout')), 8000);
    server.stdout.on('data', chunk => { output += chunk; const match = output.match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timer); resolve(match[0]); } });
    server.once('exit', code => { clearTimeout(timer); reject(new Error('exited ' + code)); });
  });
  const token = id => fs.readFile(path.join(dir, id + '.token'), 'utf8').then(text => text.trim());
  return { base, dir, token, stop: async () => { server.kill(); await fs.rm(dir, { recursive: true, force: true }); } };
}
async function intake(base, token, label) {
  const sealed = await sealFileBytes(new TextEncoder().encode('MOCK,' + label + '\n'), `limit-${label}.csv`);
  const response = await fetch(base + '/api/file-tasks', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: JSON.stringify({ authorizationId: 'local-review', recipients: ['recipient-a'], channels: ['email'], expiresAt: new Date(Date.now() + 600000).toISOString(),
      packet: sealed.packet, documentKey: Buffer.from(sealed.key).toString('hex') }) });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

test('the ceiling is the configured number, the next intake is refused with 507, and the health check publishes it', async () => {
  const { base, token, stop } = await start({ FILE_TASK_LIMIT: '3' });
  try {
    assert.equal((await (await fetch(base + '/api/health')).json()).fileTaskLimit, 3);
    const operator = await token('operator');
    const statuses = []; for (let i = 0; i < 5; i += 1) statuses.push((await intake(base, operator, i)).status);
    assert.deepEqual(statuses, [201, 201, 201, 507, 507]);
  } finally { await stop(); }
});

test('without the setting the ceiling stays 50, and a bad value stops the server', async () => {
  const { base, stop } = await start({});
  try { assert.equal((await (await fetch(base + '/api/health')).json()).fileTaskLimit, 50); } finally { await stop(); }
  for (const bad of ['0', '-1', '1001', '2.5', 'many']) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'enclave-limit-bad-'));
    try {
      const env = { PATH: process.env.PATH, HOME: dir, SKIP_LOCAL_ENV: 'true', LOCAL_ONLY: 'true', DATA_DIR: dir, PORT: '0', FILE_TASK_LIMIT: bad };
      await once(spawn(process.execPath, ['scripts/setup-local.mjs', dir], { cwd: root, env, stdio: 'ignore' }), 'exit');
      const [code] = await once(spawn(process.execPath, ['server.js'], { cwd: root, env, stdio: 'ignore' }), 'exit');
      assert.notEqual(code, 0, bad);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  }
});

// ---- the owner's capacity check, against a stand-in for the hosted instance
const ADMIN = 'a'.repeat(43);
const fakeHosted = ({ items, limit, gate = true, password = 'pw' }) => async (url, init = {}) => {
  const pathname = new URL(url).pathname;
  const reply = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  if (pathname === '/api/health') return reply(200, { ok: true, ...(limit !== undefined ? { fileTaskLimit: limit } : {}) });
  if (pathname === '/api/judge-login') return JSON.parse(init.body).password === password ? reply(200, { ok: true }, { 'set-cookie': 'enclave_gate=COOKIEVALUE; Path=/' }) : reply(401, {});
  if (gate && !String(init.headers?.cookie || '').includes('COOKIEVALUE')) return reply(401, { error: 'Demo sign-in required' });
  if (init.headers?.authorization !== `Bearer ${ADMIN}`) return reply(401, {});
  if (pathname === '/api/admin/retention') return reply(200, { automaticDeletion: false, retainedCount: items, candidateCount: 0, items: Array.from({ length: items }, (_, i) => ({ taskId: String(i) })) });
  return reply(404, {});
};
const check = async (hosted, extra = {}) => { const lines = []; const code = await checkCapacity({ origin: 'https://site.example', gate: { user: 'judge', password: 'pw' }, adminToken: ADMIN, fetchImpl: fakeHosted(hosted), write: line => lines.push(line), ...extra }); return { code, text: lines.join('\n') }; };

test('the capacity check reports room, low room, full, and an older server without a published ceiling', async () => {
  const plenty = await check({ items: 12, limit: 300 });
  assert.deepEqual([plenty.code, /room left: 288/.test(plenty.text), /SUMMARY OK/.test(plenty.text)], [0, true, true]);
  const low = await check({ items: 285, limit: 300 });
  assert.deepEqual([low.code, /SUMMARY LOW/.test(low.text)], [1, true]);
  assert.ok(15 < LOW_ROOM);
  const full = await check({ items: 50, limit: 50 });
  assert.deepEqual([full.code, /SUMMARY FULL/.test(full.text)], [1, true]);
  const older = await check({ items: 49 });
  assert.deepEqual([older.code, /does not publish it/.test(older.text), /room left: 1/.test(older.text)], [1, true, true]);
});

test('the capacity check fails clearly on a wrong sign-in or token, and prints no secret', async () => {
  assert.equal((await check({ items: 1, limit: 300 }, { gate: { user: 'judge', password: 'wrong' } })).code, 1);
  assert.equal((await check({ items: 1, limit: 300 }, { adminToken: 'b'.repeat(43) })).code, 1);
  const { text } = await check({ items: 1, limit: 300 });
  for (const secret of [ADMIN, 'pw', 'COOKIEVALUE']) assert.ok(!text.includes(secret), secret);
});

test('main refuses a missing or malformed administrator token and a non-https target', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'capacity-'));
  try {
    const env = { SMOKE_BASE_URL: 'https://site.example', SMOKE_TOKEN_DIR: dir, SMOKE_GATE_USER: 'judge', SMOKE_GATE_PASSWORD: 'pw' };
    const lines = []; const options = { write: line => lines.push(line), prompts: { interactive: false } };
    assert.equal(await capacityMain(env, options), 2);
    await fs.writeFile(path.join(dir, 'admin.token'), 'short');
    assert.equal(await capacityMain(env, options), 2);
    await fs.writeFile(path.join(dir, 'admin.token'), ADMIN + '\n');
    assert.equal(await capacityMain(env, { ...options, fetchImpl: fakeHosted({ items: 3, limit: 300 }) }), 0);
    assert.equal(await capacityMain({ ...env, SMOKE_BASE_URL: 'http://site.example' }, options), 2);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
