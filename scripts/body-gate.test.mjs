import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { readBody, createBodyGate, hasBody, BODY_MAX_BYTES } from '../http-helpers.js';

// A small server shaped like server.js: the body is read by the gate before the request joins a serial queue.
async function start(gateOptions) {
  const gate = createBodyGate(gateOptions);
  let tail = Promise.resolve();
  const server = http.createServer(async (req, res) => {
    try {
      await gate(req, res, 'one-client');
      const run = tail.then(async () => {
        if (req.method === 'GET') { res.end('ok'); return; }
        const limit = req.url === '/small' ? 20 : 1_000_000;
        try { const body = await readBody(req, limit); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ got: body })); }
        catch (error) { res.statusCode = error.status || 500; res.end(error.message); }
      });
      tail = run.catch(() => {});
    } catch (error) { res.statusCode = error.status || 500; if (error.retryAfter) res.setHeader('retry-after', String(error.retryAfter)); res.end(error.message); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
}
const stalled = (port, count) => Array.from({ length: count }, () => {
  const socket = net.connect(port, '127.0.0.1', () => socket.write('POST /x HTTP/1.1\r\nHost: x\r\nContent-Length: 500\r\n\r\n{"a":'));
  socket.reply = ''; socket.on('data', chunk => { socket.reply += chunk; }); socket.on('error', () => {});
  return socket;
});
async function get(port, limit = 3000) {
  const started = performance.now();
  try { const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(limit) }); return { status: response.status, ms: Math.round(performance.now() - started) }; }
  catch { return { status: 0, ms: Math.round(performance.now() - started) }; }
}
async function post(port, body, path = '/') {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(5000) });
  return { status: response.status, text: await response.text() };
}

test('stalled bodies no longer hold the queue: other requests are answered at once however many are open', async t => {
  const { server, port } = await start({ perClient: 8, total: 24 });
  t.after(() => server.closeAllConnections() || server.close());
  const sockets = stalled(port, 6);
  t.after(() => sockets.forEach(socket => socket.destroy()));
  await new Promise(resolve => setTimeout(resolve, 300));
  const answer = await get(port);
  assert.equal(answer.status, 200);
  assert.ok(answer.ms < 1000, `waited ${answer.ms} ms`);
  assert.deepEqual(await post(port, '{"a":1}'), { status: 200, text: JSON.stringify({ got: { a: 1 } }) });
});

test('a client that opens more stalled bodies than its share is refused with 429, and slots come back when they close', async t => {
  const { server, port } = await start({ perClient: 3, total: 24, waitMs: 250 });
  t.after(() => server.closeAllConnections() || server.close());
  const sockets = stalled(port, 6);
  await new Promise(resolve => setTimeout(resolve, 900));
  const refused = sockets.filter(socket => socket.reply.startsWith('HTTP/1.1 429'));
  assert.equal(refused.length, 3);
  assert.match(refused[0].reply, /retry-after: 1/i);
  assert.equal((await get(port)).status, 200);                       // a request with no body is never counted
  assert.equal((await post(port, '{"a":1}')).status, 429);           // this client is at its limit, and nothing frees up within the wait
  sockets.forEach(socket => socket.destroy());
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal((await post(port, '{"a":1}')).status, 200);           // the slots were released
});

test('the total limit holds across clients, and a declared body over the limit is refused without being read', async t => {
  const { server, port } = await start({ perClient: 50, total: 4, waitMs: 250 });
  t.after(() => server.closeAllConnections() || server.close());
  const sockets = stalled(port, 6);
  t.after(() => sockets.forEach(socket => socket.destroy()));
  await new Promise(resolve => setTimeout(resolve, 900));
  assert.equal(sockets.filter(socket => socket.reply.startsWith('HTTP/1.1 429')).length, 2);
  const huge = net.connect(port, '127.0.0.1', () => huge.write(`POST /x HTTP/1.1\r\nHost: x\r\nContent-Length: ${BODY_MAX_BYTES + 1}\r\n\r\n`));
  let reply = ''; huge.on('data', chunk => { reply += chunk; }); huge.on('error', () => {});
  t.after(() => huge.destroy());
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.match(reply, /^HTTP\/1\.1 (413|429)/);
});

test('readBody keeps its answers when the body was read earlier: parse, empty, too big for the route, invalid', async t => {
  const { server, port } = await start({ perClient: 8, total: 24 });
  t.after(() => server.closeAllConnections() || server.close());
  assert.deepEqual(await post(port, '{"a":1}'), { status: 200, text: '{"got":{"a":1}}' });
  assert.deepEqual(await post(port, ''), { status: 200, text: '{"got":{}}' });
  assert.equal((await post(port, '{"a":')).status, 422);
  assert.equal((await post(port, '{"padding":"xxxxxxxxxxxxxxxxxxxx"}', '/small')).status, 413);
  assert.equal((await post(port, '{"a":1}', '/small')).status, 200);
});

test('which requests carry a body', () => {
  const request = (method, headers = {}) => ({ method, headers });
  assert.equal(hasBody(request('GET', { 'content-length': '5' })), false);
  assert.equal(hasBody(request('POST')), false);
  assert.equal(hasBody(request('POST', { 'content-length': '0' })), false);
  assert.equal(hasBody(request('POST', { 'content-length': '12' })), true);
  assert.equal(hasBody(request('PUT', { 'transfer-encoding': 'chunked' })), true);
});

test('a burst of honest requests is only slowed, never refused, and a waiting client that leaves frees its place', async t => {
  const { server, port } = await start({ perClient: 3, total: 24, waitMs: 5000 });
  t.after(() => server.closeAllConnections() || server.close());
  const results = await Promise.all(Array.from({ length: 40 }, (_, index) => post(port, JSON.stringify({ n: index }))));
  assert.deepEqual([...new Set(results.map(result => result.status))], [200]);
  assert.equal(results.length, 40);
  // Three stalled bodies fill this client's share; a fourth request waits, and gives up by closing.
  const holders = stalled(port, 3);
  t.after(() => holders.forEach(socket => socket.destroy()));
  await new Promise(resolve => setTimeout(resolve, 200));
  const waiter = net.connect(port, '127.0.0.1', () => waiter.write('POST /x HTTP/1.1\r\nHost: x\r\nContent-Length: 500\r\n\r\n{"a":'));
  waiter.on('error', () => {});
  await new Promise(resolve => setTimeout(resolve, 200));
  waiter.destroy();
  holders.forEach(socket => socket.destroy());
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal((await post(port, '{"a":1}')).status, 200);
});
