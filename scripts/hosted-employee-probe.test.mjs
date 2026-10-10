import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { runProbe, main, resolveOrigin, DEFAULT_BASE_URL, EMPLOYEE_ASSETS } from '../scripts/hosted-employee-probe.mjs';

const ORIGIN = 'https://hosted.test';
const GATE = '{"error":"Demo sign-in required"}';
const TOKEN = '{"error":"Authentication required"}';
const reply = (status, body = '', headers = {}) => new Response(body, { status, headers });
const redirectToLogin = route => reply(302, '', { location: `/judge-login.html?next=${encodeURIComponent(route)}` });

// A correct hosted instance. `override(route, method)` returns a Response to replace one answer.
function fakeFetch(override = () => undefined, seen = []) {
  return async (url, init = {}) => {
    const method = init.method || 'GET';
    const route = url.slice(ORIGIN.length);
    seen.push({ route, method, init });
    const replaced = override(route, method);
    if (replaced) return replaced;
    const pathOnly = route.split('?')[0];
    if (route === '/api/health') return reply(200, '{"ok":true}', { 'content-type': 'application/json' });
    if (route === '/decode.html') return reply(200, '<h1>Recipient Decode Gate</h1>', { 'content-type': 'text/html' });
    if (EMPLOYEE_ASSETS.includes(route)) return reply(200, 'x', { 'content-type': route.endsWith('.css') ? 'text/css' : 'text/javascript; charset=utf-8' });
    if (route === '/api/whoami' || route === '/api/inbox' || (method === 'POST' && route.endsWith('/key'))) return reply(401, TOKEN, { 'content-type': 'application/json' });
    if (route === '/api/tasks') return reply(401, GATE, { 'content-type': 'application/json' });
    if (['/', '/audit.html', '/admin.html'].includes(pathOnly)) return redirectToLogin(route);
    if (pathOnly === '/judge-login.html') return reply(200, '<h1>Sign in</h1>', { 'content-type': 'text/html' });
    return reply(404);
  };
}

async function run(override, seen) {
  const lines = [];
  const code = await runProbe(ORIGIN, { fetchImpl: fakeFetch(override, seen), write: line => lines.push(line) });
  return { code, lines, text: lines.join('\n') };
}

const NAMES = ['health', 'employee-page-open', 'employee-assets-open', 'employee-api-needs-token-not-signin', 'sender-pages-gated', 'login-page-open', 'next-param-kept', 'no-open-redirect'];

test('a correct hosted instance passes all eight checks, with no cookie, no authorization header and tiny bodies', async () => {
  const seen = [];
  const { code, lines, text } = await run(undefined, seen);
  assert.equal(code, 0, text);
  for (const name of NAMES) assert.ok(lines.some(line => line.startsWith(`PASS ${name}`)), `${name}\n${text}`);
  assert.equal(lines.at(-1), 'SUMMARY PASS checks=8 passed=8 failed=0');
  assert.equal(lines.some(line => line.startsWith('FAIL')), false);
  for (const { init } of seen) {
    assert.equal(init.redirect, 'manual');
    assert.ok(init.signal);
    const names = Object.keys(init.headers || {}).map(name => name.toLowerCase());
    assert.equal(names.includes('cookie') || names.includes('authorization'), false);
    assert.ok(!init.body || init.body.length <= 8);
  }
  assert.deepEqual(seen.filter(entry => entry.method === 'POST').map(entry => entry.route), ['/api/file-access/00000000-0000-0000-0000-000000000000/key']);
});

const broken = [
  ['health', 'health reports not ok', route => route === '/api/health' && reply(200, '{"ok":false}')],
  ['employee-page-open', '/decode.html redirects to the judge sign-in', route => route === '/decode.html' && redirectToLogin(route)],
  ['employee-page-open', '/decode.html is some other page', route => route === '/decode.html' && reply(200, '<h1>Other</h1>')],
  ['employee-assets-open', 'an asset is redirected', route => route === '/role-plan.js' && redirectToLogin(route)],
  ['employee-assets-open', 'the stylesheet is served as text/plain', route => route === '/styles.css' && reply(200, 'x', { 'content-type': 'text/plain' })],
  ['employee-api-needs-token-not-signin', '/api/inbox answers with the gate text', route => route === '/api/inbox' && reply(401, GATE)],
  ['employee-api-needs-token-not-signin', '/api/whoami is redirected', route => route === '/api/whoami' && redirectToLogin(route)],
  ['employee-api-needs-token-not-signin', 'the key route is open', (route, method) => method === 'POST' && route.endsWith('/key') && reply(200, '{}')],
  ['sender-pages-gated', '/ is served without sign-in', route => route === '/' && reply(200, '<h1>Sender</h1>')],
  ['sender-pages-gated', '/admin.html redirects somewhere else', route => route === '/admin.html' && reply(302, '', { location: '/elsewhere' })],
  ['sender-pages-gated', '/api/tasks answers from the token check', route => route === '/api/tasks' && reply(401, TOKEN)],
  ['login-page-open', 'the sign-in page is missing', route => route === '/judge-login.html' && reply(404)],
  ['next-param-kept', 'the redirect forgets the page asked for', route => route === '/audit.html?x=1' && reply(302, '', { location: '/judge-login.html' })],
  ['no-open-redirect', 'the sign-in page echoes the foreign address', route => route.startsWith('/judge-login.html?next=') && reply(200, '<a href="https://evil.example/">go</a>')],
  ['no-open-redirect', 'the sign-in page redirects away', route => route.startsWith('/judge-login.html?next=') && reply(302, '', { location: 'https://evil.example/' })],
];

for (const [name, what, override] of broken) {
  test(`${what}: only ${name} fails and the exit code is 1`, async () => {
    const { code, lines, text } = await run((route, method) => override(route, method) || undefined);
    assert.equal(code, 1, text);
    assert.deepEqual(lines.filter(line => line.startsWith('FAIL ')).map(line => line.split(/[ :]/)[1]), [name], text);
    assert.match(lines.at(-1), /^SUMMARY FAIL checks=8 passed=7 failed=1$/);
  });
}

test('an instance that does not answer fails every check without the probe crashing', async () => {
  const lines = [];
  const code = await runProbe(ORIGIN, { fetchImpl: async () => { throw new TypeError('fetch failed'); }, write: line => lines.push(line) });
  assert.equal(code, 1);
  assert.match(lines.at(-1), /^SUMMARY FAIL checks=8 passed=0 failed=8$/);
});

test('main: exit 0 on a good instance, 1 on a bad one, 2 on bad configuration, and the default target is the hosted one', async () => {
  const lines = [];
  assert.equal(await main({ SMOKE_BASE_URL: ORIGIN }, [], { fetchImpl: fakeFetch(), write: line => lines.push(line) }), 0);
  assert.equal(lines[0], `INFO target ${ORIGIN} credentials=none`);
  const badLines = [];
  assert.equal(await main({ SMOKE_BASE_URL: ORIGIN }, [], { fetchImpl: fakeFetch(route => route === '/' ? reply(200, 'x') : undefined), write: line => badLines.push(line) }), 1);
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = () => true;
  try {
    for (const env of [{ SMOKE_BASE_URL: 'not a url' }, { SMOKE_BASE_URL: 'http://example.com' }, { SMOKE_BASE_URL: 'https://x.test/path' }, { SMOKE_BASE_URL: 'https://u:p@x.test' }]) {
      assert.equal(await main(env, [], { fetchImpl: fakeFetch(), write: () => {} }), 2);
    }
    assert.equal(await main({ SMOKE_BASE_URL: ORIGIN }, ['extra'], { fetchImpl: fakeFetch(), write: () => {} }), 2);
  } finally { process.stderr.write = original; }
  assert.equal(resolveOrigin({}), DEFAULT_BASE_URL);
  assert.equal(resolveOrigin({ SMOKE_BASE_URL: 'http://127.0.0.1:8080' }), 'http://127.0.0.1:8080');
});

test('run as a script against an unreachable loopback port it exits non-zero and asks for no credential', () => {
  const script = path.resolve(import.meta.dirname, 'hosted-employee-probe.mjs');
  const result = spawnSync(process.execPath, [script], { env: { PATH: process.env.PATH, SMOKE_BASE_URL: 'http://127.0.0.1:1' }, encoding: 'utf8', timeout: 60000 });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /SUMMARY FAIL checks=8 passed=0 failed=8/);
  const bad = spawnSync(process.execPath, [script, 'x'], { env: { PATH: process.env.PATH }, encoding: 'utf8' });
  assert.equal(bad.status, 2);
});
