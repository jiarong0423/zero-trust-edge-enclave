#!/usr/bin/env node
// Checks the hosted demo from an employee's point of view: WITHOUT the shared judge sign-in and WITHOUT any
// token. It sends no cookie and no authorization header, so it needs no credential at all and can be run
// by anyone.
//
//   node scripts/hosted-employee-probe.mjs
//
// The target defaults to the hosted instance; override it with SMOKE_BASE_URL (an https origin, or
// http://127.0.0.1:<port>), the same variable as hosted-smoke.mjs and hosted-wedge-probe.mjs.
//
// What it asks: GET (and one POST with the body {}) requests, never following a redirect, each with a 5 s
// timeout. It creates nothing and changes nothing. It checks that
//   - the recipient ("employee") page and its scripts are served without the judge sign-in,
//   - the employee API answers from its own token check (401) and not from the judge sign-in gate,
//   - the sender pages and the sender API stay behind the judge sign-in,
//   - the sign-in page is open, keeps the page the person asked for, and cannot be turned into an open redirect.
//
// Exit codes: 0 every check passed, 1 a check failed, 2 configuration or usage error.
import { pathToFileURL } from 'node:url';

export const DEFAULT_BASE_URL = 'https://enclave.jace0423.com';
export const TIMEOUT_MS = 5000;
export const GATE_TEXT = 'Demo sign-in required';
export const EMPLOYEE_ASSETS = ['/decode.js', '/inbox.js', '/auth.js', '/i18n.js', '/file-envelope.js', '/crypto-utils.js', '/role-nav.js', '/role-plan.js', '/styles.css'];
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

const out = line => process.stdout.write(line + '\n');

export function resolveOrigin(env = {}) {
  const raw = env.SMOKE_BASE_URL || DEFAULT_BASE_URL;
  let url;
  try { url = new URL(raw); } catch { throw new Error('SMOKE_BASE_URL is not a valid URL'); }
  const loopback = url.protocol === 'http:' && url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !loopback) throw new Error('SMOKE_BASE_URL must be https://<host> or http://127.0.0.1:<port>');
  if (url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== '/')) throw new Error('SMOKE_BASE_URL must be an origin only (no credentials, path, query or fragment)');
  return url.origin;
}

// One request with no cookie and no authorization header. A redirect is never followed; a failure to answer
// becomes status 0 so the check that needed it fails instead of the probe crashing.
async function ask(fetchImpl, origin, route, { method = 'GET', body } = {}) {
  try {
    const response = await fetchImpl(origin + route, {
      method, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS),
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body }),
    });
    const text = await response.text().catch(() => '');
    return { status: response.status, type: response.headers.get('content-type') || '', location: response.headers.get('location') || '', text };
  } catch (error) {
    return { status: 0, type: '', location: '', text: '', failed: error?.name === 'TimeoutError' ? 'timed out' : 'no answer' };
  }
}

const describe = r => r.status ? `HTTP ${r.status}` : r.failed;
const jsonOf = text => { try { return JSON.parse(text); } catch { return null; } };
const sayingGate = r => String(jsonOf(r.text)?.error ?? r.text).includes(GATE_TEXT);

export async function runProbe(origin, { fetchImpl = globalThis.fetch, write = out } = {}) {
  const results = [];
  const record = (name, ok, detail) => { write(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); results.push(ok); };
  const get = (route, options) => ask(fetchImpl, origin, route, options);

  // 1. health
  const health = await get('/api/health');
  record('health', health.status === 200 && jsonOf(health.text)?.ok === true, health.status === 200 ? `HTTP 200, ok=${jsonOf(health.text)?.ok}` : describe(health));

  // 2. the employee page is open (a 302 to the judge sign-in must fail)
  const page = await get('/decode.html');
  record('employee-page-open', page.status === 200 && page.text.includes('Recipient Decode Gate'),
    page.status === 200 ? (page.text.includes('Recipient Decode Gate') ? 'HTTP 200, page served' : 'HTTP 200 but not the recipient page') : `${describe(page)}${page.location ? ` -> ${page.location.slice(0, 80)}` : ''}`);

  // 3. the employee assets are open
  const bad = [];
  for (const route of EMPLOYEE_ASSETS) {
    const r = await get(route);
    const wanted = route.endsWith('.css') ? /text\/css/i : /javascript|ecmascript/i;
    if (r.status !== 200 || !wanted.test(r.type)) bad.push(`${route} ${r.status ? `HTTP ${r.status} ${r.type || 'no content-type'}` : r.failed}`);
  }
  record('employee-assets-open', bad.length === 0, bad.length ? bad.join('; ') : `${EMPLOYEE_ASSETS.length} files served`);

  // 4. the employee API wants a token and says so itself, not through the judge gate
  const whoami = await get('/api/whoami');
  const inbox = await get('/api/inbox');
  const key = await get(`/api/file-access/${NIL_UUID}/key`, { method: 'POST', body: '{}' });
  const tokenProblems = [];
  for (const [route, r] of [['/api/whoami', whoami], ['/api/inbox', inbox]]) {
    if (r.status !== 401) tokenProblems.push(`${route} ${describe(r)}`);
    else if (sayingGate(r)) tokenProblems.push(`${route} answered with the judge sign-in text`);
  }
  if (key.status !== 401) tokenProblems.push(`POST key ${describe(key)}`);
  else if (sayingGate(key)) tokenProblems.push('POST key answered with the judge sign-in text');
  record('employee-api-needs-token-not-signin', tokenProblems.length === 0, tokenProblems.length ? tokenProblems.join('; ') : 'whoami, inbox and key answered 401 from the token check');

  // 5. the sender pages and API stay behind the judge sign-in
  const gatedProblems = [];
  for (const route of ['/', '/audit.html', '/admin.html']) {
    const r = await get(route);
    if (r.status !== 302 || !r.location.startsWith('/judge-login.html')) gatedProblems.push(`${route} ${describe(r)}${r.location ? ` -> ${r.location.slice(0, 60)}` : ''}`);
  }
  const tasks = await get('/api/tasks');
  if (tasks.status !== 401 || !sayingGate(tasks)) gatedProblems.push(`/api/tasks ${describe(tasks)}${tasks.status === 401 ? ' without the sign-in text' : ''}`);
  record('sender-pages-gated', gatedProblems.length === 0, gatedProblems.length ? gatedProblems.join('; ') : '/, /audit.html, /admin.html redirect to the sign-in and /api/tasks answers 401');

  // 6. the sign-in page is open
  const login = await get('/judge-login.html');
  record('login-page-open', login.status === 200, describe(login));

  // 7. the page asked for is kept for after the sign-in
  const next = await get('/audit.html?x=1');
  const kept = next.status === 302 && next.location.includes('next=') && next.location.includes(encodeURIComponent('/audit.html'));
  record('next-param-kept', kept, next.status === 302 ? (kept ? 'redirect carries next= with the encoded path' : `redirect without next: ${next.location.slice(0, 80)}`) : describe(next));

  // 8. a foreign address in next= is not echoed back
  const evil = await get('/judge-login.html?next=https%3A%2F%2Fevil.example%2F');
  record('no-open-redirect', evil.status === 200 && !evil.text.includes('evil.example') && !evil.location,
    evil.status !== 200 ? describe(evil) : (evil.text.includes('evil.example') ? 'the foreign address appears in the page' : 'HTTP 200, static page, address not echoed'));

  const failed = results.filter(ok => !ok).length;
  write(`SUMMARY ${failed ? 'FAIL' : 'PASS'} checks=${results.length} passed=${results.length - failed} failed=${failed}`);
  return failed ? 1 : 0;
}

export async function main(env = process.env, argv = process.argv.slice(2), options = {}) {
  let origin;
  try {
    if (argv.length) throw new Error('no command-line arguments are accepted; use SMOKE_BASE_URL to change the target');
    origin = resolveOrigin(env);
  } catch (error) {
    process.stderr.write(`CONFIG ERROR: ${error?.message || 'configuration could not be read'}\n`);
    process.stderr.write('Usage: [SMOKE_BASE_URL=https://<host>] node scripts/hosted-employee-probe.mjs   (needs no credential)\n');
    return 2;
  }
  const write = options.write || out;
  write(`INFO target ${origin} credentials=none`);
  try { return await runProbe(origin, { fetchImpl: options.fetchImpl, write }); }
  catch (error) { process.stderr.write(`FAIL probe: unexpected error: ${String(error?.message || error).slice(0, 200)}\n`); return 1; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const code = await main();
  process.stdout.write('', () => process.exit(code));
}
