import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { buildOriginRequest } from '../deploy/cloudflare-edge/src/worker.js';

const options = { originHost: 'origin.example', secret: 's'.repeat(40) };

test('the origin request carries the secret and the visitor address, and nothing the visitor claimed', async () => {
  const incoming = new Request('https://edge.example/decode.html?id=1&version=2', { headers: {
    'cf-connecting-ip': '203.0.113.9', 'x-origin-auth': 'guess', 'x-verified-client-ip': '192.0.2.1', 'x-forwarded-for': '192.0.2.2',
    'x-real-ip': '192.0.2.3', forwarded: 'for=192.0.2.4', 'x-forwarded-host': 'evil.example', authorization: 'Bearer t', cookie: 'a=b' } });
  const out = buildOriginRequest(incoming, options);
  assert.equal(out.url, 'https://origin.example/decode.html?id=1&version=2');
  assert.equal(out.method, 'GET');
  assert.equal(out.headers.get('x-origin-auth'), options.secret);
  assert.equal(out.headers.get('x-verified-client-ip'), '203.0.113.9');
  for (const gone of ['x-forwarded-for', 'x-real-ip', 'forwarded', 'x-forwarded-host']) assert.equal(out.headers.get(gone), null, gone);
  assert.equal(out.headers.get('authorization'), 'Bearer t');
  assert.equal(out.headers.get('cookie'), 'a=b');
  assert.equal(out.redirect, 'manual');
});

test('without a visitor address no address is claimed, and a visitor secret is still replaced', () => {
  const out = buildOriginRequest(new Request('https://edge.example/', { headers: { 'x-origin-auth': 'guess', 'x-verified-client-ip': '192.0.2.1' } }), options);
  assert.equal(out.headers.get('x-verified-client-ip'), null);
  assert.equal(out.headers.get('x-origin-auth'), options.secret);
});

test('a body is passed through and the path and query are kept exactly', async () => {
  const out = buildOriginRequest(new Request('https://edge.example/api/file-access/abc/key?x=%2F', { method: 'POST', body: JSON.stringify({ version: 1 }),
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.9' } }), options);
  assert.equal(out.method, 'POST');
  assert.equal(new URL(out.url).pathname + new URL(out.url).search, '/api/file-access/abc/key?x=%2F');
  assert.deepEqual(await out.json(), { version: 1 });
});

test('the worker refuses to run unconfigured and reports an unreachable origin', async () => {
  const request = new Request('https://edge.example/');
  assert.equal((await worker.fetch(request, {})).status, 503);
  assert.equal((await worker.fetch(request, { EDGE_SECRET: 'x'.repeat(40) })).status, 503);
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('down'); };
  try { assert.equal((await worker.fetch(request, { EDGE_SECRET: 'x'.repeat(40), ORIGIN_HOST: 'origin.example' })).status, 502); }
  finally { globalThis.fetch = original; }
});
