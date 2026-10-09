import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { readBody } from '../http-helpers.js';

// A tiny serial queue like the real one: the next request is not handled until the previous settles.
async function startServer(timeoutMs, idleMs) {
  let tail = Promise.resolve();
  const outcomes = [];
  const server = http.createServer((req, res) => {
    const run = tail.then(async () => {
      if (req.url === '/health') { res.end('ok'); return; }
      try {
        const body = await readBody(req, 1000, timeoutMs, idleMs);
        outcomes.push({ ok: true, body });
        res.end('read');
      } catch (error) {
        outcomes.push({ ok: false, status: error.status });
        if (!res.writableEnded && !res.destroyed) { res.statusCode = error.status || 500; res.end('error'); }
      }
    });
    tail = run.catch(() => {});
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port, outcomes };
}

function raw(port, text, { keepOpen = false } = {}) {
  return new Promise(resolve => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(text));
    let data = '';
    socket.on('data', chunk => { data += chunk; });
    socket.on('close', () => resolve(data));
    socket.on('error', () => resolve(data));
    if (!keepOpen) setTimeout(() => socket.destroy(), 1500);
  });
}

async function healthy(port) {
  const answer = await Promise.race([
    raw(port, 'GET /health HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'),
    new Promise(resolve => setTimeout(() => resolve('TIMEOUT'), 4000))
  ]);
  return answer.includes('200 OK');
}

test('a malformed chunked body settles the read and does not wedge the queue', async t => {
  const { server, port, outcomes } = await startServer(30_000);
  t.after(() => server.close());
  await raw(port, 'POST /x HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\nContent-Type: application/json\r\n\r\nZZZ\r\nnot a chunk\r\n');
  assert.equal(await healthy(port), true);
  assert.equal(outcomes.at(-1)?.ok, false);
});

test('a connection dropped before the declared length is settled', async t => {
  const { server, port, outcomes } = await startServer(30_000);
  t.after(() => server.close());
  const socket = net.connect(port, '127.0.0.1', () => socket.write('POST /x HTTP/1.1\r\nHost: x\r\nContent-Length: 500\r\n\r\n{"a":'));
  await new Promise(resolve => setTimeout(resolve, 150));
  socket.destroy();
  assert.equal(await healthy(port), true);
  assert.equal(outcomes.at(-1)?.ok, false);
});

test('a body that stalls is cut off by the deadline and the queue moves on', async t => {
  const { server, port, outcomes } = await startServer(300);
  t.after(() => server.close());
  const stalled = raw(port, 'POST /x HTTP/1.1\r\nHost: x\r\nContent-Length: 500\r\n\r\n{"a":', { keepOpen: true });
  assert.equal(await healthy(port), true);
  assert.equal(outcomes.at(-1)?.status, 408);
  await stalled;
});

test('a normal body, an empty body, an oversize body and bad JSON behave as before', async t => {
  const { server, port, outcomes } = await startServer(30_000);
  t.after(() => server.close());
  const post = body => raw(port, `POST /x HTTP/1.1\r\nHost: x\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`, { keepOpen: true });
  await post('{"a":1}');
  assert.deepEqual(outcomes.at(-1), { ok: true, body: { a: 1 } });
  await post('');
  assert.deepEqual(outcomes.at(-1), { ok: true, body: {} });
  await post('x'.repeat(1500));
  assert.equal(outcomes.at(-1)?.status, 413);
  await post('{bad');
  assert.equal(outcomes.at(-1)?.status, 422);
});

// The real server reads a body only after the request has waited its turn on the queue, so the client may
// already be gone, and its close event already emitted, by the time readBody is called.
async function startLateServer(waitMs) {
  let tail = Promise.resolve();
  const outcomes = [];
  const server = http.createServer((req, res) => {
    const run = tail.then(async () => {
      if (req.url === '/health') { res.end('ok'); return; }
      await new Promise(resolve => setTimeout(resolve, waitMs));
      try {
        const body = await readBody(req, 1000, 30_000);
        outcomes.push({ ok: true, body });
        res.end('read');
      } catch (error) {
        outcomes.push({ ok: false, status: error.status });
        if (!res.writableEnded && !res.destroyed) { res.statusCode = error.status || 500; res.end('error'); }
      }
    });
    tail = run.catch(() => {});
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port, outcomes };
}

test('a connection that is already gone when the body is finally read settles at once', async t => {
  const { server, port, outcomes } = await startLateServer(400);
  t.after(() => server.close());
  const socket = net.connect(port, '127.0.0.1', () => socket.write('POST /x HTTP/1.1\r\nHost: x\r\nContent-Length: 500\r\n\r\n{"a":'));
  await new Promise(resolve => setTimeout(resolve, 100));
  socket.destroy();
  assert.equal(await healthy(port), true);
  assert.equal(outcomes.at(-1)?.status, 400);
});

test('a malformed chunked body that the server already rejected settles at once, even when read late', async t => {
  const { server, port, outcomes } = await startLateServer(400);
  t.after(() => server.close());
  await raw(port, 'POST /x HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\nContent-Type: application/json\r\n\r\nZZZ\r\nnot a chunk\r\n');
  assert.equal(await healthy(port), true);
  assert.equal(outcomes.at(-1)?.ok, false);
});

test('a body that stops arriving is cut off by the idle deadline long before the overall one', async t => {
  const { server, port, outcomes } = await startServer(30_000, 300);
  t.after(() => server.close());
  const started = Date.now();
  const stalled = raw(port, 'POST /x HTTP/1.1\r\nHost: x\r\nContent-Length: 500\r\n\r\n{"a":', { keepOpen: true });
  assert.equal(await healthy(port), true);
  assert.equal(outcomes.at(-1)?.status, 408);
  assert.ok(Date.now() - started < 5000);
  await stalled;
});

test('a slow but steady body is not cut off by the idle deadline', async t => {
  const { server, port, outcomes } = await startServer(30_000, 400);
  t.after(() => server.close());
  const socket = net.connect(port, '127.0.0.1');
  socket.on('error', () => {});
  await new Promise(resolve => socket.once('connect', resolve));
  socket.write('POST /x HTTP/1.1\r\nHost: x\r\nConnection: close\r\nContent-Length: 13\r\n\r\n');
  for (const part of ['{"a"', ':', '1', ',"b"', ':2}']) { socket.write(part); await new Promise(resolve => setTimeout(resolve, 250)); }
  await new Promise(resolve => setTimeout(resolve, 300));
  socket.destroy();
  assert.deepEqual(outcomes.at(-1), { ok: true, body: { a: 1, b: 2 } });
});

test('a client that dribbles a byte at a time still hits the overall deadline', async t => {
  const { server, port, outcomes } = await startServer(900, 400);
  t.after(() => server.close());
  const socket = net.connect(port, '127.0.0.1');
  socket.on('error', () => {});
  await new Promise(resolve => socket.once('connect', resolve));
  socket.write('POST /x HTTP/1.1\r\nHost: x\r\nContent-Length: 500\r\n\r\n');
  const drip = setInterval(() => socket.write('x'), 200);
  assert.equal(await healthy(port), true);
  clearInterval(drip); socket.destroy();
  assert.equal(outcomes.at(-1)?.status, 408);
});
