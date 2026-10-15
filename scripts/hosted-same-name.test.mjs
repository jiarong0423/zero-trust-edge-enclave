import test from 'node:test';
import assert from 'node:assert/strict';
import { applyNames, planNames, parseArguments, PEOPLE } from './hosted-same-name.mjs';

const ADMIN = 'a'.repeat(43);
const PASSWORD = 'correct horse battery';
const person = (id, extra = {}) => ({ id, kind: 'recipient', department: 'sales', displayName: `MOCK ${id}`, nameZh: null, tags: {}, ...extra });

// A stand-in for the hosted instance: the sign-in gate, the administrator token and a directory with a revision.
function fakeServer({ principals = [person('sales-a'), person('sales-b'), person('sales-c')], failAt = null } = {}) {
  const state = { revision: 7, principals: structuredClone(principals), posts: [] };
  const fetchImpl = async (url, init = {}) => {
    const pathname = new URL(url).pathname;
    const respond = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
    if (pathname === '/api/health') return respond(200, { ok: true });
    if (pathname === '/api/judge-login') return JSON.parse(init.body).password === PASSWORD ? respond(200, { ok: true }, { 'set-cookie': 'enclave_gate=SECRETCOOKIE; Path=/; HttpOnly' }) : respond(401, { error: 'no' });
    if (!String(init.headers?.cookie || '').includes('enclave_gate=SECRETCOOKIE')) return respond(401, { error: 'Demo sign-in required' });
    if (init.headers?.authorization !== `Bearer ${ADMIN}`) return respond(401, { error: 'Authentication failed' });
    if (init.method === 'GET') return respond(200, { revision: state.revision, principals: state.principals });
    const request = JSON.parse(init.body);
    state.posts.push(request);
    if (failAt === state.posts.length || request.expectedRevision !== state.revision) return respond(409, { error: 'DIRECTORY_REVISION_CONFLICT' });
    Object.assign(state.principals.find(item => item.id === request.value.id), request.value);
    state.revision += 1;
    return respond(200, { revision: state.revision });
  };
  return { state, fetchImpl };
}
const run = async (server, extra = {}) => { const lines = []; const code = await applyNames({ origin: 'https://site.example', gate: { user: 'judge', password: PASSWORD }, adminToken: ADMIN,
  apply: false, fetchImpl: server.fetchImpl, write: line => lines.push(line), ...extra }); return { code, text: lines.join('\n') }; };

test('the two 劉文祥 share the name and differ by region; the third person has another name', () => {
  assert.deepEqual(PEOPLE.map(([id, name]) => [id, name]), [['sales-a', '劉文祥'], ['sales-b', '劉文祥'], ['sales-c', '劉慶龍']]);
  assert.notEqual(PEOPLE[0][2].region, PEOPLE[1][2].region);
});
test('a person who already carries the name and tags is left alone', () => {
  const plan = planNames([person('sales-a', { nameZh: '劉文祥', tags: { region: 'north' } }), person('sales-b'), person('sales-c')]);
  assert.deepEqual(plan.map(item => item.current), [true, false, false]);
});
test('a dry run writes nothing and says what would change', async () => {
  const server = fakeServer();
  const { code, text } = await run(server);
  assert.equal(code, 0);
  assert.equal(server.state.posts.length, 0);
  assert.match(text, /DRY RUN: 3 person\(s\) would change/);
  assert.doesNotMatch(text, /SECRETCOOKIE|correct horse/);
});
test('apply writes only nameZh and tags, one person at a time, and verifies', async () => {
  const server = fakeServer();
  const { code, text } = await run(server, { apply: true });
  assert.equal(code, 0);
  assert.equal(server.state.posts.length, 3);
  for (const post of server.state.posts) { assert.equal(post.operation, 'person.update'); assert.deepEqual(Object.keys(post.value).sort(), ['id', 'nameZh', 'tags']); }
  assert.deepEqual(server.state.posts.map(post => post.expectedRevision), [7, 8, 9]);
  assert.match(text, /SUMMARY PASS people=3/);
});
test('running it twice changes nothing the second time', async () => {
  const server = fakeServer();
  await run(server, { apply: true });
  const second = await run(server, { apply: true });
  assert.equal(second.code, 0);
  assert.match(second.text, /nothing to change/);
  assert.equal(server.state.posts.length, 3);
});
test('a missing person stops everything before any write', async () => {
  const server = fakeServer({ principals: [person('sales-a'), person('sales-b')] });
  const { code, text } = await run(server, { apply: true });
  assert.equal(code, 1);
  assert.equal(server.state.posts.length, 0);
  assert.match(text, /person is missing/);
});
test('a failed write is reported and the run stops', async () => {
  const server = fakeServer({ failAt: 2 });
  const { code, text } = await run(server, { apply: true });
  assert.equal(code, 1);
  assert.match(text, /FAIL update sales-b/);
  assert.equal(server.state.posts.length, 2);
});
test('a wrong sign-in password stops before the directory is read', async () => {
  const server = fakeServer();
  const { code, text } = await run(server, { gate: { user: 'judge', password: 'wrong' } });
  assert.equal(code, 1);
  assert.match(text, /FAIL judge-signin/);
});
test('an unknown argument is a usage error', () => { assert.throws(() => parseArguments(['--force']), /unknown argument/); });
