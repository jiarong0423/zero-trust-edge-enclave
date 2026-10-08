import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { clientAddress, createNetworkPolicy, normalizeAddress, parseCidrList } from '../network-policy.js';

test('unset means no restriction, so existing deployments are unchanged', () => {
  for (const value of [undefined, '']) {
    const policy = createNetworkPolicy(value);
    assert.equal(policy.enabled, false);
    assert.equal(policy.allows('203.0.113.7'), true);
    assert.equal(policy.allows(undefined), true);
  }
});

test('addresses are matched against IPv4 and IPv6 networks, including IPv4-mapped IPv6', () => {
  const policy = createNetworkPolicy('10.0.0.0/8, 192.168.1.0/24, fd00::/8');
  assert.equal(policy.enabled, true);
  for (const inside of ['10.1.2.3', '192.168.1.200', 'fd12:3456::1', '::ffff:10.9.9.9', '[fd00::5]']) assert.equal(policy.allows(inside), true, inside);
  for (const outside of ['11.0.0.1', '192.168.2.1', '2001:db8::1', '127.0.0.1', '::1', 'unknown', '', null, undefined]) assert.equal(policy.allows(outside), false, String(outside));
});

test('a value that is set but lists nothing is a configuration error, not "off"', () => {
  for (const value of [' ', ',', ' , ,']) assert.throws(() => createNetworkPolicy(value), error => error.status === 503, JSON.stringify(value));
});

test('loopback is never implicit', () => {
  const policy = createNetworkPolicy('10.0.0.0/8');
  assert.equal(policy.allows('127.0.0.1'), false);
  assert.equal(createNetworkPolicy('127.0.0.1/32, ::1/128').allows('::1'), true);
});

test('the allowlist is applied to the client ADDRESS, so IPv6 entries really match (not to a throttle bucket)', () => {
  const policy = createNetworkPolicy('127.0.0.1/32, ::1/128, 2001:db8::/32, fe80::/10');
  const from = (remoteAddress, forwarded) => ({ headers: forwarded ? { 'x-forwarded-for': forwarded } : {}, socket: { remoteAddress } });
  for (const inside of ['::1', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1', '2001:db8::5', 'fe80::1%en0']) {
    assert.equal(policy.allowsRequest(from(inside)), true, inside);
  }
  for (const outside of ['2001:db9::1', '2600::1', '10.0.0.1']) assert.equal(policy.allowsRequest(from(outside)), false, outside);
  // Behind a trusted proxy the forwarded address decides; an untrusted one is ignored.
  assert.equal(policy.allowsRequest(from('10.0.0.1', '2001:db8::7'), true), true);
  assert.equal(policy.allowsRequest(from('10.0.0.1', '2001:db8::7'), false), false);
  assert.equal(policy.allowsRequest(from('::1', 'garbage, 8.8.8.8'), true), true, 'a malformed forwarded value falls back to the socket address');
  assert.equal(clientAddress(from('::FFFF:10.1.2.3')), '10.1.2.3');
  assert.equal(clientAddress({ headers: {}, socket: {} }), null);
  assert.equal(createNetworkPolicy(undefined).allowsRequest(from(undefined)), true);
});

test('malformed entries stop startup instead of silently widening or narrowing access', () => {
  for (const bad of ['10.0.0.0', '10.0.0.0/33', 'banana/8', '10.0.0.0/8/8', '::1/129', '10.0.0.0/x']) {
    assert.throws(() => parseCidrList(bad), error => error.status === 503, bad);
  }
});

test('address normalisation rejects non-addresses', () => {
  assert.equal(normalizeAddress('::ffff:1.2.3.4'), '1.2.3.4');
  assert.equal(normalizeAddress('fe80::1%en0'), 'fe80::1');
  assert.equal(normalizeAddress('example.com'), null);
  assert.equal(normalizeAddress(42), null);
});

async function startWith(cidrs, t) {
  const root = path.resolve(import.meta.dirname, '..');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'enclave-network-test-'));
  const env = { PATH: process.env.PATH, HOME: dir, SKIP_LOCAL_ENV: 'true', LOCAL_ONLY: 'true', DATA_DIR: dir, PORT: '0',
    COORDINATOR_PROVIDER: 'synthetic_fixture', ALLOWED_CLIENT_CIDRS: cidrs };
  const setup = spawn(process.execPath, ['scripts/setup-local.mjs', dir], { cwd: root, env, stdio: 'ignore' });
  assert.equal((await once(setup, 'exit'))[0], 0);
  const server = spawn(process.execPath, ['server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { if (server.exitCode === null) { server.kill(); await once(server, 'exit'); } await fs.rm(dir, { recursive: true, force: true }); });
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Server startup timeout')), 5000);
    server.stdout.on('data', chunk => { output += chunk; const match = output.match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timer); resolve(match[0]); } });
    server.once('exit', () => { clearTimeout(timer); reject(new Error('Server exited')); });
  });
}

test('the server refuses clients outside the allowlist before any route runs, and serves clients inside it', async t => {
  const outside = await startWith('10.0.0.0/8', t);
  for (const route of ['/api/health', '/', '/api/whoami']) {
    const response = await fetch(outside + route);
    assert.equal(response.status, 403, route);
    assert.equal((await response.json()).error, 'Client network not allowed');
  }
  // A malformed Host header must not turn the refusal into a different status.
  const url = new URL(outside);
  const raw = await new Promise((resolve, reject) => {
    const socket = net.connect(Number(url.port), url.hostname, () => socket.write('GET /api/health HTTP/1.1\r\nHost: a b\r\nConnection: close\r\n\r\n'));
    let data = '';
    socket.on('data', chunk => { data += chunk; });
    socket.on('close', () => resolve(data));
    socket.on('error', reject);
  });
  assert.match(raw.split('\r\n')[0], /403/);
  const inside = await startWith('127.0.0.1/32, ::1/128', t);
  assert.equal((await fetch(inside + '/api/health')).status, 200);
});

test('an invalid list stops the server from starting', async () => {
  const root = path.resolve(import.meta.dirname, '..');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'enclave-network-bad-'));
  try {
    const env = { PATH: process.env.PATH, HOME: dir, SKIP_LOCAL_ENV: 'true', LOCAL_ONLY: 'true', DATA_DIR: dir, PORT: '0', ALLOWED_CLIENT_CIDRS: '10.0.0.0/99' };
    const server = spawn(process.execPath, ['server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const [code] = await once(server, 'exit');
    assert.notEqual(code, 0);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
