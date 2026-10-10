import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createEdgeTrust } from '../edge-trust.js';

const secret = crypto.randomBytes(32).toString('base64url');
const request = headers => ({ headers });

test('the edge address is believed only with the right secret', () => {
  const edge = createEdgeTrust({ EDGE_SECRET: secret });
  assert.equal(edge.enabled, true);
  assert.equal(edge.address(request({ 'x-origin-auth': secret, 'x-verified-client-ip': '203.0.113.9' })), '203.0.113.9');
  assert.equal(edge.address(request({ 'x-verified-client-ip': '203.0.113.9' })), null);
  assert.equal(edge.address(request({ 'x-origin-auth': secret.slice(1), 'x-verified-client-ip': '203.0.113.9' })), null);
  assert.equal(edge.address(request({ 'x-origin-auth': secret + 'x', 'x-verified-client-ip': '203.0.113.9' })), null);
  assert.equal(edge.address(request({ 'x-origin-auth': ['a', 'b'], 'x-verified-client-ip': '203.0.113.9' })), null);
});

test('a verified request still needs a real address, and IPv6 is normalised', () => {
  const edge = createEdgeTrust({ EDGE_SECRET: secret });
  for (const bad of ['', 'not-an-ip', '203.0.113.9, 198.51.100.1', '203.0.113.256', '<script>']) {
    assert.equal(edge.address(request({ 'x-origin-auth': secret, 'x-verified-client-ip': bad })), null, bad);
  }
  assert.ok(edge.address(request({ 'x-origin-auth': secret, 'x-verified-client-ip': '2001:db8::1' })));
});

test('the feature is off without a secret, and a weak or half-set configuration is refused', () => {
  const off = createEdgeTrust({});
  assert.deepEqual([off.enabled, off.required], [false, false]);
  assert.equal(off.address(request({ 'x-origin-auth': secret, 'x-verified-client-ip': '203.0.113.9' })), null);
  assert.throws(() => createEdgeTrust({ EDGE_SECRET: 'short' }), /at least 32/);
  assert.throws(() => createEdgeTrust({ REQUIRE_EDGE: 'true' }), /needs EDGE_SECRET/);
  assert.equal(createEdgeTrust({ EDGE_SECRET: secret, REQUIRE_EDGE: 'true' }).required, true);
});

test('the redirect target is a plain https origin and only with the edge required', () => {
  const base = { EDGE_SECRET: secret, REQUIRE_EDGE: 'true' };
  assert.equal(createEdgeTrust({ ...base, EDGE_REDIRECT_TO: 'https://site.example' }).redirectTo, 'https://site.example');
  for (const bad of ['http://site.example', 'https://site.example/', 'https://site.example/path', 'https://user:pw@site.example', 'site.example', '//site.example', 'javascript:alert(1)', 'https://site.example?x=1']) {
    assert.throws(() => createEdgeTrust({ ...base, EDGE_REDIRECT_TO: bad }), /https origin/, bad);
  }
  assert.throws(() => createEdgeTrust({ EDGE_SECRET: secret, EDGE_REDIRECT_TO: 'https://site.example' }), /needs REQUIRE_EDGE/);
  assert.equal(createEdgeTrust(base).redirectTo, null);
});

const root = path.resolve(import.meta.dirname, '..');
async function start(extra) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'enclave-edge-'));
  const env = { PATH: process.env.PATH, HOME: dir, SKIP_LOCAL_ENV: 'true', LOCAL_ONLY: 'true', DATA_DIR: dir, PORT: '0',
    COORDINATOR_PROVIDER: 'synthetic_fixture', AUTH_MAX_FAILURES: '3', ...extra };
  const setup = spawn(process.execPath, ['scripts/setup-local.mjs', dir], { cwd: root, env, stdio: 'ignore' });
  assert.equal((await once(setup, 'exit'))[0], 0);
  const server = spawn(process.execPath, ['server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr.resume();
  const base = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('startup timeout')), 8000);
    server.stdout.on('data', chunk => { output += chunk; const match = output.match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timer); resolve(match[0]); } });
    server.once('exit', () => { clearTimeout(timer); reject(new Error('exited')); });
  });
  return { base, stop: async () => { server.kill(); await fs.rm(dir, { recursive: true, force: true }); } };
}
const bad = () => `Bearer ${crypto.randomBytes(32).toString('base64url')}`;

test('behind the edge, each visitor has their own lockout, and nobody can borrow another address', async () => {
  const { base, stop } = await start({ EDGE_SECRET: secret });
  try {
    const attempt = (headers = {}) => fetch(base + '/api/whoami', { headers: { authorization: bad(), ...headers } }).then(r => r.status);
    const as = ip => ({ 'x-origin-auth': secret, 'x-verified-client-ip': ip });
    assert.deepEqual([await attempt(as('203.0.113.1')), await attempt(as('203.0.113.1')), await attempt(as('203.0.113.1')), await attempt(as('203.0.113.1'))], [401, 401, 401, 429]);
    // Another visitor behind the same edge is not locked.
    assert.equal(await attempt(as('198.51.100.2')), 401);
    // Without the secret the claimed address is ignored: all of these share the one real socket address.
    const spoof = ip => ({ 'x-verified-client-ip': ip, 'x-forwarded-for': ip });
    assert.deepEqual([await attempt(spoof('192.0.2.1')), await attempt(spoof('192.0.2.2')), await attempt(spoof('192.0.2.3')), await attempt(spoof('192.0.2.4'))], [401, 401, 401, 429]);
  } finally { await stop(); }
});

test('with the edge required, going around it is refused and the health check stays open', async () => {
  const { base, stop } = await start({ EDGE_SECRET: secret, REQUIRE_EDGE: 'true' });
  try {
    assert.equal((await fetch(base + '/api/health')).status, 200);
    assert.equal((await fetch(base + '/decode.html')).status, 403);
    assert.equal((await fetch(base + '/api/whoami', { headers: { 'x-verified-client-ip': '203.0.113.9' } })).status, 403);
    const through = await fetch(base + '/decode.html', { headers: { 'x-origin-auth': secret, 'x-verified-client-ip': '203.0.113.9' } });
    assert.equal(through.status, 200);
  } finally { await stop(); }
});

test('REQUIRE_EDGE without a secret stops the server instead of locking everyone out', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'enclave-edge-bad-'));
  try {
    const env = { PATH: process.env.PATH, HOME: dir, SKIP_LOCAL_ENV: 'true', LOCAL_ONLY: 'true', DATA_DIR: dir, PORT: '0', REQUIRE_EDGE: 'true' };
    const setup = spawn(process.execPath, ['scripts/setup-local.mjs', dir], { cwd: root, env, stdio: 'ignore' });
    await once(setup, 'exit');
    const server = spawn(process.execPath, ['server.js'], { cwd: root, env, stdio: 'ignore' });
    const [code] = await once(server, 'exit');
    assert.notEqual(code, 0);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('a link that goes around the edge is sent to the same path on the edge address, and nothing else is', async () => {
  const { base, stop } = await start({ EDGE_SECRET: secret, REQUIRE_EDGE: 'true', EDGE_REDIRECT_TO: 'https://site.example' });
  try {
    const get = (p, init = {}) => fetch(base + p, { redirect: 'manual', ...init });
    const one = await get('/decode.html?id=abc&version=1');
    assert.equal(one.status, 307);
    assert.equal(one.headers.get('location'), 'https://site.example/decode.html?id=abc&version=1');
    assert.equal(one.headers.get('cache-control'), 'no-store');
    // A hostile path cannot move the target off the configured origin.
    for (const p of ['//evil.example/x', '/\\evil.example', '/..//evil.example']) {
      const response = await get(p);
      assert.equal(new URL(response.headers.get('location') || 'https://site.example/', 'https://site.example').origin, 'https://site.example', p);
    }
    // Writes are refused, not redirected, and the health check and the edge itself are untouched.
    assert.equal((await get('/api/judge-login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 403);
    assert.equal((await get('/api/health')).status, 200);
    assert.equal((await get('/decode.html', { headers: { 'x-origin-auth': secret, 'x-verified-client-ip': '203.0.113.9' } })).status, 200);
  } finally { await stop(); }
});
