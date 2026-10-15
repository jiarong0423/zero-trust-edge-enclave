import test from 'node:test';
import assert from 'node:assert/strict';
import { matchGuard, parseArguments } from './hosted-match-guard.mjs';

const ADMIN = 'a'.repeat(43);
const PASSWORD = 'correct horse battery';
const entry = (operatorId, fails, quarantined) => ({ operatorId, grantId: 'procurement', fails, quarantined, since: '2026-10-15T00:00:00.000Z' });

// A stand-in for the hosted instance: the sign-in gate, the administrator token and the match guard with its list.
function fakeServer({ entries = [], failClear = false, stuck = false } = {}) {
  const state = { entries: structuredClone(entries), posts: [] };
  const fetchImpl = async (url, init = {}) => {
    const pathname = new URL(url).pathname;
    const respond = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
    if (pathname === '/api/health') return respond(200, { ok: true });
    if (pathname === '/api/judge-login') return JSON.parse(init.body).password === PASSWORD ? respond(200, { ok: true }, { 'set-cookie': 'enclave_gate=SECRETCOOKIE; Path=/; HttpOnly' }) : respond(401, { error: 'no' });
    if (!String(init.headers?.cookie || '').includes('enclave_gate=SECRETCOOKIE')) return respond(401, { error: 'Demo sign-in required' });
    if (init.headers?.authorization !== `Bearer ${ADMIN}`) return respond(401, { error: 'Authentication failed' });
    if (pathname !== '/api/admin/match-guard') return respond(404, {});
    if (init.method === 'GET') return respond(200, { limit: 3, entries: state.entries });
    const request = JSON.parse(init.body);
    state.posts.push(request);
    if (failClear) return respond(500, { error: 'boom' });
    if (!stuck) state.entries = state.entries.filter(item => !(item.operatorId === request.operatorId && item.grantId === request.authorizationId));
    return respond(200, { ok: true, unlocked: true });
  };
  return { state, fetchImpl };
}
const run = async (server, extra = {}) => { const lines = []; const code = await matchGuard({ origin: 'https://site.example', gate: { user: 'judge', password: PASSWORD }, adminToken: ADMIN,
  clear: false, fetchImpl: server.fetchImpl, write: line => lines.push(line), ...extra }); return { code, text: lines.join('\n') }; };

test('with nothing on record it says so and writes nothing', async () => {
  const server = fakeServer();
  const { code, text } = await run(server, { clear: true });
  assert.equal(code, 0);
  assert.match(text, /no sender has a failed match/);
  assert.equal(server.state.posts.length, 0);
});
test('listing shows who is locked and who only has failures, and writes nothing', async () => {
  const server = fakeServer({ entries: [entry('manager-sender', 3, true), entry('accounting-sender', 1, false)] });
  const { code, text } = await run(server);
  assert.equal(code, 0);
  assert.match(text, /manager-sender .* failures 3\/3 +LOCKED/);
  assert.match(text, /accounting-sender .* failures 1\/3 +not locked/);
  assert.match(text, /1 lock\(s\) set\. Add --clear/);
  assert.equal(server.state.posts.length, 0);
  assert.doesNotMatch(text, /SECRETCOOKIE|correct horse/);
});
test('clear removes only the locks that are set and verifies', async () => {
  const server = fakeServer({ entries: [entry('manager-sender', 3, true), entry('accounting-sender', 1, false)] });
  const { code, text } = await run(server, { clear: true });
  assert.equal(code, 0);
  assert.deepEqual(server.state.posts, [{ operatorId: 'manager-sender', authorizationId: 'procurement' }]);
  assert.match(text, /SUMMARY PASS cleared=1/);
});
test('a lock that is still there after clearing is a failure', async () => {
  const server = fakeServer({ entries: [entry('manager-sender', 3, true)], stuck: true });
  const { code, text } = await run(server, { clear: true });
  assert.equal(code, 1);
  assert.match(text, /FAIL verify/);
});
test('a failed clear is reported and stops', async () => {
  const server = fakeServer({ entries: [entry('manager-sender', 3, true)], failClear: true });
  const { code, text } = await run(server, { clear: true });
  assert.equal(code, 1);
  assert.match(text, /FAIL clear manager-sender\/procurement: HTTP 500/);
});
test('a wrong sign-in password stops before the guard is read', async () => {
  const { code, text } = await run(fakeServer(), { gate: { user: 'judge', password: 'wrong' } });
  assert.equal(code, 1);
  assert.match(text, /FAIL judge-signin/);
});
test('an unknown argument is a usage error', () => { assert.throws(() => parseArguments(['--force']), /unknown argument/); });
