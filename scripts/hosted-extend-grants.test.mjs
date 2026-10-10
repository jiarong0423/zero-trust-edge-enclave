import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extendGrants, planExtension, parseArguments, main, DEFAULT_UNTIL } from './hosted-extend-grants.mjs';

const UNTIL = '2026-12-31T15:59:00.000Z';
const ADMIN = 'a'.repeat(43);
const PASSWORD = 'correct horse battery';
const grant = (id, expiresAt, extra = {}) => ({ id, version: 1, operatorId: 'manager-sender', coordinatorId: 'coordinator', recipients: ['sales-a'], channels: ['email'],
  expiresAt, maxAttempts: 3, maxOpens: 2, revoked: false, ...extra });

// A stand-in for the hosted instance: the gate, the admin token and the directory with its revision and versions.
function fakeServer({ grants, gate = true, failUpdateAt = null } = {}) {
  const state = { revision: 5, grants: structuredClone(grants), posts: [], logins: 0 };
  const fetchImpl = async (url, init = {}) => {
    const pathname = new URL(url).pathname;
    const respond = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
    if (pathname === '/api/health') return respond(200, { ok: true });
    if (pathname === '/api/judge-login') { state.logins += 1; return JSON.parse(init.body).password === PASSWORD ? respond(200, { ok: true }, { 'set-cookie': 'enclave_gate=SECRETCOOKIE; Path=/; HttpOnly' }) : respond(401, { ok: false }); }
    if (gate && !String(init.headers?.cookie || '').includes('enclave_gate=SECRETCOOKIE')) return respond(401, { error: 'Demo sign-in required' });
    if (init.headers?.authorization !== `Bearer ${ADMIN}`) return respond(401, { error: 'Authentication failed' });
    if (pathname !== '/api/admin/directory') return respond(404, {});
    if (init.method === 'GET') return respond(200, { revision: state.revision, grants: state.grants });
    const request = JSON.parse(init.body);
    state.posts.push(request);
    if (failUpdateAt === state.posts.length) return respond(409, { error: 'DIRECTORY_REVISION_CONFLICT' });
    if (request.expectedRevision !== state.revision) return respond(409, { error: 'DIRECTORY_REVISION_CONFLICT' });
    const target = state.grants.find(item => item.id === request.value.id);
    Object.assign(target, request.value, { version: target.version + 1 });
    state.revision += 1;
    return respond(200, { revision: state.revision, grants: state.grants });
  };
  return { state, fetchImpl };
}
const run = async (server, extra = {}) => { const lines = []; const code = await extendGrants({ origin: 'https://site.example', gate: { user: 'judge', password: PASSWORD }, adminToken: ADMIN, untilIso: UNTIL,
  apply: false, fetchImpl: server.fetchImpl, write: line => lines.push(line), ...extra }); return { code, lines, text: lines.join('\n') }; };

test('only an authorization that ends earlier and is not revoked is planned', () => {
  const grants = [grant('a', '2026-12-16T15:59:00.000Z'), grant('b', '2027-02-01T00:00:00.000Z'), grant('c', '2026-11-01T00:00:00.000Z', { revoked: true })];
  assert.deepEqual(planExtension(grants, UNTIL).map(item => item.id), ['a']);
});

test('a dry run shows the change and writes nothing', async () => {
  const server = fakeServer({ grants: [grant('procurement', '2026-12-16T15:59:00.000Z'), grant('audit', '2026-12-16T15:59:00.000Z')] });
  const result = await run(server);
  assert.equal(result.code, 0);
  assert.equal(server.state.posts.length, 0);
  assert.match(result.text, /DRY RUN: 2 authorization\(s\) would move/);
  assert.equal(server.state.grants[0].expiresAt, '2026-12-16T15:59:00.000Z');
});

test('apply updates each authorization in turn with the revision the server gave back, then verifies', async () => {
  const server = fakeServer({ grants: [grant('procurement', '2026-12-16T15:59:00.000Z'), grant('audit', '2026-12-16T15:59:00.000Z')] });
  const result = await run(server, { apply: true });
  assert.equal(result.code, 0, result.text);
  assert.deepEqual(server.state.posts.map(post => [post.operation, post.value.id, post.expectedRevision]), [['grant.update', 'procurement', 5], ['grant.update', 'audit', 6]]);
  assert.deepEqual(Object.keys(server.state.posts[0].value).sort(), ['channels', 'coordinatorId', 'expiresAt', 'id', 'maxAttempts', 'maxOpens', 'operatorId', 'recipients', 'revoked']);
  for (const item of server.state.grants) assert.deepEqual([item.expiresAt, item.version], [UNTIL, 2]);
  assert.match(result.text, /SUMMARY PASS grants=2/);
});

test('nothing is written for an authorization that already ends later, and a later run does nothing', async () => {
  const server = fakeServer({ grants: [grant('procurement', '2027-01-20T00:00:00.000Z')] });
  const result = await run(server, { apply: true });
  assert.equal(result.code, 0);
  assert.equal(server.state.posts.length, 0);
  assert.match(result.text, /nothing to change/);
});

test('a refused update stops the run and says which one', async () => {
  const server = fakeServer({ grants: [grant('procurement', '2026-12-16T15:59:00.000Z'), grant('audit', '2026-12-16T15:59:00.000Z')], failUpdateAt: 2 });
  const result = await run(server, { apply: true });
  assert.equal(result.code, 1);
  assert.match(result.text, /FAIL update audit: HTTP 409 DIRECTORY_REVISION_CONFLICT/);
});

test('a wrong judge password or a wrong administrator token fails before anything is read or written', async () => {
  const server = fakeServer({ grants: [grant('procurement', '2026-12-16T15:59:00.000Z')] });
  assert.equal((await run(server, { gate: { user: 'judge', password: 'wrong' }, apply: true })).code, 1);
  const wrongToken = await run(server, { adminToken: 'b'.repeat(43), apply: true });
  assert.equal(wrongToken.code, 1);
  assert.equal(server.state.posts.length, 0);
});

test('no secret reaches the output, in any outcome', async () => {
  for (const apply of [false, true]) {
    const server = fakeServer({ grants: [grant('procurement', '2026-12-16T15:59:00.000Z')] });
    const { text } = await run(server, { apply });
    for (const secret of [ADMIN, PASSWORD, 'SECRETCOOKIE']) assert.ok(!text.includes(secret), secret);
  }
});

test('arguments: the default date is far enough out, a past or absurd date and unknown flags are refused', () => {
  assert.ok(Date.parse(DEFAULT_UNTIL) > Date.parse('2026-12-16T00:00:00Z'));
  assert.equal(parseArguments([]).apply, false);
  assert.equal(parseArguments(['--apply']).apply, true);
  for (const bad of [['--until', '2020-01-01'], ['--until', 'tomorrowish'], ['--until', '2099-01-01'], ['--nope']]) assert.throws(() => parseArguments(bad), /--until|unknown argument/);
});

test('main reads the administrator token from the token directory and refuses a missing or malformed one', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'extend-'));
  try {
    const lines = []; const write = line => lines.push(line);
    const env = { SMOKE_BASE_URL: 'https://site.example', SMOKE_TOKEN_DIR: dir, SMOKE_GATE_USER: 'judge', SMOKE_GATE_PASSWORD: PASSWORD };
    assert.equal(await main(env, [], { write, prompts: { interactive: false } }), 2);
    await fs.writeFile(path.join(dir, 'admin.token'), 'short');
    assert.equal(await main(env, [], { write, prompts: { interactive: false } }), 2);
    await fs.writeFile(path.join(dir, 'admin.token'), ADMIN + '\n');
    const server = fakeServer({ grants: [grant('procurement', '2026-12-16T15:59:00.000Z')] });
    assert.equal(await main(env, [], { write, prompts: { interactive: false }, fetchImpl: server.fetchImpl }), 0);
    assert.equal(server.state.posts.length, 0);
    assert.equal(await main({ ...env, SMOKE_BASE_URL: 'http://site.example' }, [], { write, prompts: { interactive: false } }), 2);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
