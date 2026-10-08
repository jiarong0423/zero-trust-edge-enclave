import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ssoEnabled, ssoExchange, ssoLogout } from '../public/sso-client.js';

const reply = (status, body) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const TOKEN = 'A'.repeat(43);

test('the SSO row appears only when the server says SSO is on', async () => {
  assert.equal(await ssoEnabled(reply(200, { ok: true, enabled: true })), true);
  assert.equal(await ssoEnabled(reply(200, { ok: true, enabled: false })), false);
  assert.equal(await ssoEnabled(reply(200, { ok: true })), false);
  assert.equal(await ssoEnabled(reply(401, { ok: false })), false);
  assert.equal(await ssoEnabled(reply(503, { ok: false })), false);
  assert.equal(await ssoEnabled(async () => { throw new Error('offline'); }), false);
  assert.equal(await ssoEnabled(async () => ({ ok: true, json: async () => { throw new Error('not json'); } })), false);
});

test('the exchange sends the required header and accepts only a 43-character token', async () => {
  let seen = null;
  const spy = async (url, init) => { seen = { url, init }; return { ok: true, json: async () => ({ ok: true, token: TOKEN }) }; };
  assert.equal(await ssoExchange(spy), TOKEN);
  assert.equal(seen.url, '/api/sso/session');
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.headers['x-sso-exchange'], '1');
  assert.equal(seen.init.credentials, 'same-origin');
  for (const bad of [{ token: 'short' }, { token: `${TOKEN}x` }, { token: 42 }, { token: `${'A'.repeat(42)}!` }, {}, null]) {
    assert.equal(await ssoExchange(reply(200, bad)), null, JSON.stringify(bad));
  }
  assert.equal(await ssoExchange(reply(401, { error: 'x' })), null);
  assert.equal(await ssoExchange(async () => { throw new Error('offline'); }), null);
});

test('logout sends the session token as a bearer and reports the outcome', async () => {
  let seen = null;
  const spy = async (url, init) => { seen = { url, init }; return { ok: true }; };
  assert.equal(await ssoLogout(TOKEN, spy), true);
  assert.equal(seen.url, '/api/sso/logout');
  assert.equal(seen.init.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(await ssoLogout(TOKEN, async () => ({ ok: false })), false);
  assert.equal(await ssoLogout(TOKEN, async () => { throw new Error('offline'); }), false);
});

test('the page code stores no token in browser storage and every new label has a zh-TW string', () => {
  const page = readFileSync(new URL('../public/auth.js', import.meta.url), 'utf8') + readFileSync(new URL('../public/sso-client.js', import.meta.url), 'utf8');
  assert.equal(/localStorage|sessionStorage|indexedDB|document\.cookie/.test(page), false);
  const i18n = readFileSync(new URL('../public/i18n.js', import.meta.url), 'utf8');
  for (const label of ['Sign in with SSO', 'Sign out of SSO', 'Signed in with SSO', 'Signed out of SSO']) {
    assert.match(i18n, new RegExp(`'${label}': '[^']+'`), label);
  }
});
