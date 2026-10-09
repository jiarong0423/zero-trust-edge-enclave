import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

// The real server: authenticated connections that never finish their body must not slow anyone down, and a
// client that opens too many is refused. (Before the body was read ahead of the queue, each such connection
// made every other request wait up to 15 s, one after another.)
const root = path.resolve(import.meta.dirname, '..');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'enclave-stalled-test-'));
let base; let server; let port; let token;

before(async () => {
  const env = { PATH: process.env.PATH, HOME: dir, SKIP_LOCAL_ENV: 'true', DATA_DIR: dir, PORT: '0', COORDINATOR_PROVIDER: 'synthetic_fixture' };
  const setup = spawn(process.execPath, ['scripts/setup-local.mjs', dir], { cwd: root, env, stdio: 'ignore' });
  assert.equal((await once(setup, 'exit'))[0], 0);
  token = (await fs.readFile(path.join(dir, 'operator.token'), 'utf8')).trim();
  Object.assign(process.env, env);
  const createServer = http.createServer;
  http.createServer = (...args) => { server = createServer(...args); return server; };
  const log = console.log; console.log = () => {};
  try { await import('../server.js'); } finally { console.log = log; http.createServer = createServer; }
  if (!server.listening) await once(server, 'listening');
  port = server.address().port; base = `http://127.0.0.1:${port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await fs.rm(dir, { recursive: true, force: true });
});

const stalled = count => Array.from({ length: count }, () => {
  const socket = net.connect(port, '127.0.0.1', () => socket.write(`POST /api/directory HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${token}\r\nContent-Type: application/json\r\nContent-Length: 500\r\n\r\n{"authorizationId":`));
  socket.reply = ''; socket.on('data', chunk => { socket.reply += chunk; }); socket.on('error', () => {});
  return socket;
});
const whoami = async () => {
  const started = performance.now();
  const response = await fetch(base + '/api/whoami', { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000) });
  await response.text();
  return { status: response.status, ms: Math.round(performance.now() - started) };
};

test('six authenticated stalled connections do not slow a normal request', async () => {
  const sockets = stalled(6);
  await new Promise(resolve => setTimeout(resolve, 400));
  const answer = await whoami();
  sockets.forEach(socket => socket.destroy());
  assert.equal(answer.status, 200);
  assert.ok(answer.ms < 1000, `waited ${answer.ms} ms`);
});

test('a client that opens more stalled connections than its share is refused with 429 once the wait is over, and recovers when they close', async () => {
  const sockets = stalled(12);
  await new Promise(resolve => setTimeout(resolve, 10_800));
  const refused = sockets.filter(socket => socket.reply.startsWith('HTTP/1.1 429')).length;
  assert.equal(refused, 4);                                  // 8 per client are allowed; the rest wait 10 s, then are refused
  assert.equal((await whoami()).status, 200);                // requests without a body are never counted
  sockets.forEach(socket => socket.destroy());
  await new Promise(resolve => setTimeout(resolve, 400));
  const response = await fetch(base + '/api/directory', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{"authorizationId":"nope"}' });
  assert.notEqual(response.status, 429);                     // a normal POST goes through again
});
