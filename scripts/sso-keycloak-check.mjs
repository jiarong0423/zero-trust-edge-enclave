import fs from 'node:fs';
import path from 'node:path';

// Runs against a Keycloak made by scripts/keycloak-local.mjs and an app started from its enclave.env.
// It plays the browser: follows redirects, keeps cookies, fills the Keycloak form. 12 checks, exit 1 on any failure.
const directory = process.argv[2];
if (!directory) { console.error('ERROR usage: sso-keycloak-check.mjs DIRECTORY (the one given to keycloak-local.mjs)'); process.exit(2); }
const env = Object.fromEntries(fs.readFileSync(path.join(path.resolve(directory), 'creds.env'), 'utf8').trim().split('\n').map(line => line.split(/=(.*)/s).slice(0, 2)));
const APP = process.env.APP_URL || 'http://127.0.0.1:3345';
const results = [];
const record = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' :: ' + detail : ''}`); };

function jar() {
  const store = [];
  return {
    header(url) {
      const u = new URL(url);
      return store.filter(c => u.pathname.startsWith(c.path)).map(c => `${c.name}=${c.value}`).join('; ');
    },
    absorb(url, response) {
      for (const raw of response.headers.getSetCookie()) {
        const [pair, ...attrs] = raw.split(';').map(s => s.trim());
        const i = pair.indexOf('=');
        const name = pair.slice(0, i); const value = pair.slice(i + 1);
        const path = (attrs.find(a => /^path=/i.test(a)) || 'path=/').split('=')[1];
        const maxAge = attrs.find(a => /^max-age=/i.test(a));
        const k = store.findIndex(c => c.name === name && c.path === path);
        if (k >= 0) store.splice(k, 1);
        if (value && !(maxAge && Number(maxAge.split('=')[1]) <= 0)) store.push({ name, value, path });
      }
    },
    names() { return store.map(c => c.name); }
  };
}
async function browse(j, url, init = {}, trail = []) {
  for (let hop = 0; hop < 12; hop += 1) {
    const response = await fetch(url, { ...init, redirect: 'manual', headers: { ...(init.headers || {}), cookie: j.header(url) } });
    j.absorb(url, response);
    trail.push({ url, status: response.status });
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      url = new URL(response.headers.get('location'), url).toString();
      init = {};
      continue;
    }
    return { response, url, trail };
  }
  throw new Error('too many redirects');
}
async function signIn(username, password) {
  const j = jar();
  const first = await browse(j, `${APP}/api/sso/login`);
  const html = await first.response.text();
  const action = (html.match(/id="kc-form-login"[^>]*action="([^"]+)"/) || html.match(/action="([^"]+)"[^>]*id="kc-form-login"/) || [])[1];
  if (!action) return { j, stage: 'no-form', status: first.response.status };
  const form = new URLSearchParams({ username, password, credentialId: '' });
  const submitted = await browse(j, action.replaceAll('&amp;', '&'), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form });
  return { j, submitted, finalUrl: submitted.url, status: submitted.response.status, trail: submitted.trail };
}
async function exchange(j) {
  const r = await fetch(`${APP}/api/sso/session`, { method: 'POST', headers: { 'x-sso-exchange': '1', cookie: j.header(`${APP}/api/sso/session`) } });
  let body = null; try { body = await r.json(); } catch {}
  return { status: r.status, body };
}
const whoami = token => fetch(`${APP}/api/whoami`, { headers: { authorization: `Bearer ${token}` } }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));

// 1 success
const ok = await signIn('manager.test', env.KC_USER_PASSWORD);
record('1 manager.test signs in through the real provider and lands on /', ok.finalUrl === `${APP}/` && ok.status === 200, `final=${new URL(ok.finalUrl).pathname} status=${ok.status}`);
const ex = await exchange(ok.j);
record('2 hand-off cookie is exchanged once for a 43-char session token', ex.status === 200 && /^[A-Za-z0-9_-]{43}$/.test(ex.body?.token || '') && ex.body.kind === 'operator', `status=${ex.status} kind=${ex.body?.kind}`);
const token = ex.body?.token;
const me = await whoami(token);
record('3 the session token authenticates as a registry operator (same answer as the registry token)', me.status === 200 && me.body?.kind === 'operator', `status=${me.status} kind=${me.body?.kind}`);
const again = await exchange(ok.j);
record('4 a second exchange with the same hand-off is refused', again.status === 401, `status=${again.status}`);
const noHeader = await fetch(`${APP}/api/sso/session`, { method: 'POST' });
record('5 exchange without the x-sso-exchange header is refused', noHeader.status === 400, `status=${noHeader.status}`);
// logout
const lo = await fetch(`${APP}/api/sso/logout`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
const after = await whoami(token);
record('6 logout revokes the session token', lo.status === 200 && after.status === 401, `logout=${lo.status} after=${after.status}`);

// 2 unverified e-mail
const unv = await signIn('unverified.test', env.KC_USER_PASSWORD);
record('7 a verified-at-provider-false e-mail is refused (mapped but unverified)', unv.finalUrl.includes('/api/sso/callback') && unv.status === 403, `status=${unv.status}`);
// 3 unmapped
const unm = await signIn('unmapped.test', env.KC_USER_PASSWORD);
record('8 a valid provider identity that is not in the subject map is refused', unm.finalUrl.includes('/api/sso/callback') && unm.status === 403, `status=${unm.status}`);
// 4 wrong password
const bad = await signIn('manager.test', 'definitely-wrong-password');
record('9 a wrong password never reaches the enclave callback', !bad.finalUrl?.includes('/api/sso/callback'), `ended at ${bad.finalUrl ? new URL(bad.finalUrl).host : bad.stage}`);

// 5 replay + tamper
{
  const j = jar();
  const first = await browse(j, `${APP}/api/sso/login`);
  const html = await first.response.text();
  const action = html.match(/id="kc-form-login"[^>]*action="([^"]+)"/)[1].replaceAll('&amp;', '&');
  // capture the callback URL without following it
  const r = await fetch(action, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: j.header(action) }, body: new URLSearchParams({ username: 'manager.test', password: env.KC_USER_PASSWORD, credentialId: '' }) });
  const callback = r.headers.get('location');
  const tampered = callback.replace(/state=[^&]+/, 'state=' + 'A'.repeat(43));
  const t = await browse(j, tampered);
  record('10 a callback with a tampered state is refused', t.response.status === 400, `status=${t.response.status}`);
  const j2 = jar();
  const f2 = await browse(j2, `${APP}/api/sso/login`); const h2 = await f2.response.text();
  const a2 = h2.match(/id="kc-form-login"[^>]*action="([^"]+)"/)[1].replaceAll('&amp;', '&');
  const r2 = await fetch(a2, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: j2.header(a2) }, body: new URLSearchParams({ username: 'manager.test', password: env.KC_USER_PASSWORD, credentialId: '' }) });
  const cb2 = r2.headers.get('location');
  const first2 = await browse(j2, cb2);
  const replay = await browse(j2, cb2);
  record('11 replaying the same callback is refused', first2.response.status === 200 && replay.response.status === 400, `first=${first2.response.status} replay=${replay.response.status}`);
  const j3 = jar();
  const noCookie = await browse(j3, cb2);
  record('12 a callback presented by a browser without the flow cookie is refused', noCookie.response.status === 400, `status=${noCookie.response.status}`);
}
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
