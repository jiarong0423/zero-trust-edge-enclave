import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { authenticate, authenticateWithSession, validateAccess } from '../access-control.js';
import { countsAsGuess, createAuthThrottle } from '../auth-throttle.js';
import { sendJson } from '../http-helpers.js';
import { createSsoRoutes } from '../sso-routes.js';
import { createBrowser, startMockIdp } from './mock-idp.mjs';

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const REGISTRY_TOKEN = crypto.randomBytes(32).toString('base64url');
const SECRET = 'confidential-secret-marker-9f3a';

const USERS = {
  alice: { sub: 'u-alice', email: 'alice@example.org', email_verified: true },
  bob: { sub: 'u-bob', email: 'bob@example.org', email_verified: true },
  root: { sub: 'u-root', email: 'root@example.org', email_verified: true },
  dave: { sub: 'u-dave', email: 'dave@example.org', email_verified: true },
  ghost: { sub: 'u-ghost', email: 'ghost@example.org', email_verified: true },
  stranger: { sub: 'u-stranger', email: 'stranger@example.org', email_verified: true }
};

function registry() {
  return validateAccess({
    principals: [
      { id: 'alice', kind: 'operator', tokenHash: sha256(REGISTRY_TOKEN) },
      { id: 'bob', kind: 'recipient', tokenHash: sha256('bob-token') },
      { id: 'root', kind: 'administrator', tokenHash: sha256('root-token') },
      { id: 'dave', kind: 'operator', tokenHash: sha256('dave-token'), disabled: true }
    ],
    grants: []
  });
}

const SUBJECT_MAP = {
  version: 1,
  entries: [
    { sub: 'u-alice', principalId: 'alice' },
    { email: 'bob@example.org', principalId: 'bob' },
    { sub: 'u-root', principalId: 'root' },
    { sub: 'u-dave', principalId: 'dave' },
    { sub: 'u-ghost', principalId: 'ghost' }
  ]
};

/** A throw-away app: the SSO handler in front of a whoami route that authenticates the way server.js does. */
async function setup(t, { envExtra = {}, limits = {}, throttle = null, idpOptions = {}, mapOverride, fetchImpl, startIdp = true } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sso-routes-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const mapFile = path.join(dir, 'subjects.json');
  await fs.writeFile(mapFile, mapOverride ?? JSON.stringify(SUBJECT_MAP));
  const clock = { t: Date.now() };
  const now = () => clock.t;
  const idp = await startMockIdp({ now, ...idpOptions });
  t.after(() => idp.close());
  const lines = [];
  const state = { access: registry(), guesses: 0 };
  const context = { handler: null };
  const app = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (await context.handler(req, res, url)) return;
      if (url.pathname === '/api/whoami') {
        const header = req.headers.authorization;
        try {
          const principal = authenticateWithSession(state.access, header, context.handler.resolveSession);
          sendJson(res, 200, { ok: true, kind: principal.kind, id: principal.id });
        } catch (error) {
          if (error.status === 401 && countsAsGuess(state.access, header) && !context.handler.knowsSession(header)) state.guesses += 1;
          throw error;
        }
        return;
      }
      throw Object.assign(new Error('not found'), { status: 404 });
    } catch (error) {
      if (error?.status === 429 && Number.isSafeInteger(error.retryAfter)) res.setHeader('retry-after', String(error.retryAfter));
      sendJson(res, error.status || 500, { ok: false, error: error.message });
    }
  });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(() => { app.closeAllConnections(); app.close(); });
  const base = `http://127.0.0.1:${app.address().port}`;
  idp.redirectUri = `${base}/api/sso/callback`;
  const env = { SSO_ISSUER: idp.issuer, SSO_CLIENT_ID: idp.clientId, SSO_REDIRECT_URI: idp.redirectUri, SSO_SUBJECT_MAP: mapFile,
    SSO_ALLOW_LOOPBACK_IDP: 'true', ...envExtra };
  context.handler = createSsoRoutes({ env, loadConfig: async () => state.access, throttle, clientKey: () => 'client-1', now,
    log: line => lines.push(line), limits, idpTimeoutMs: 1000, ...(fetchImpl ? { fetchImpl } : {}) });
  void startIdp;
  const ctx = { base, idp, clock, lines, state, mapFile, handler: context.handler, dir };

  ctx.authorize = async browser => {
    const login = await browser.get(`${base}/api/sso/login`);
    const authorize = login.status === 302 ? await browser.get(login.headers.get('location')) : null;
    return { login, authorize, callbackUrl: authorize?.headers.get('location') };
  };
  ctx.exchange = browser => browser.request(`${base}/api/sso/session`, { method: 'POST', headers: { 'x-sso-exchange': '1' } });
  ctx.signIn = async (browser, user = USERS.alice) => {
    idp.behavior.user = user;
    const step = await ctx.authorize(browser);
    const callback = await browser.get(step.callbackUrl);
    const session = await ctx.exchange(browser);
    return { ...step, callback, session, body: session.status === 200 ? await session.json() : null };
  };
  ctx.whoami = token => fetch(`${base}/api/whoami`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  return ctx;
}

const hasCode = (ctx, code) => ctx.lines.some(line => line === `ERROR ${code}`);

test('happy path end to end: login, provider, callback, hand-off, session token, whoami, logout', async t => {
  const ctx = await setup(t);
  const browser = createBrowser();
  const { login, callback, session, body } = await ctx.signIn(browser, USERS.alice);

  assert.equal(login.status, 302);
  assert.equal(login.headers.get('cache-control'), 'no-store');
  const flowCookie = browser.seen.find(entry => entry.name === 'enclave_sso_flow' && entry.value !== '');
  assert.match(flowCookie.value, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(flowCookie.attributes.sort(), ['HttpOnly', 'Max-Age=600', 'Path=/api/sso', 'SameSite=Lax']);

  const request = ctx.idp.stats.lastAuthorize;
  assert.equal(request.response_type, 'code');
  assert.equal(request.code_challenge_method, 'S256');
  assert.equal(request.scope, 'openid email');
  assert.equal(request.client_id, ctx.idp.clientId);
  assert.equal(request.redirect_uri, ctx.idp.redirectUri);
  assert.match(request.state, /^[A-Za-z0-9_-]{43}$/);
  assert.match(request.nonce, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(request.state, request.nonce);
  assert.notEqual(request.state, flowCookie.value);
  const verifier = ctx.idp.stats.tokenRequests[0].params.code_verifier;
  assert.equal(crypto.createHash('sha256').update(verifier).digest('base64url'), request.code_challenge);

  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get('location'), '/');
  assert.equal(callback.headers.get('cache-control'), 'no-store');
  assert.equal(callback.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(browser.cookie(ctx.base, 'enclave_sso_flow'), undefined, 'the flow cookie is cleared');
  const handoff = browser.seen.find(entry => entry.name === 'enclave_sso_handoff' && entry.value !== '');
  assert.deepEqual(handoff.attributes.sort(), ['HttpOnly', 'Max-Age=60', 'Path=/api/sso', 'SameSite=Strict']);

  assert.equal(session.status, 200);
  assert.equal(session.headers.get('cache-control'), 'no-store');
  assert.match(body.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(body.kind, 'operator');
  assert.equal(Date.parse(body.expiresAt), ctx.clock.t + 30 * 60_000);
  assert.equal(browser.cookie(ctx.base, 'enclave_sso_handoff'), undefined);

  const who = await ctx.whoami(body.token);
  assert.equal(who.status, 200);
  assert.deepEqual(await who.json(), { ok: true, kind: 'operator', id: 'alice' });
  assert.equal(ctx.state.guesses, 0);

  const out = await fetch(`${ctx.base}/api/sso/logout`, { method: 'POST', headers: { authorization: `Bearer ${body.token}` } });
  assert.equal(out.status, 200);
  assert.equal((await ctx.whoami(body.token)).status, 401);

  const logged = ctx.lines.join('\n');
  for (const secret of [body.token, request.state, request.nonce, flowCookie.value, handoff.value, verifier, 'idp-user-1', 'u-alice', 'alice@example.org', 'mock-access-token']) {
    assert.equal(logged.includes(secret), false, 'a log line carries no token, state, nonce, identity or address');
  }
  assert.deepEqual(ctx.lines.filter(line => line.startsWith('ERROR')), []);
  for (const line of ctx.lines) assert.match(line, /^(INFO|WARN|ERROR) [A-Z_]+$/);
});

test('a session resolves to the SAME principal object the registry token resolves to, for every kind', async t => {
  const ctx = await setup(t);
  for (const [name, user, kind] of [['alice', USERS.alice, 'operator'], ['bob', USERS.bob, 'recipient'], ['root', USERS.root, 'administrator']]) {
    const { body } = await ctx.signIn(createBrowser(), user);
    assert.equal(body.kind, kind);
    const viaSession = authenticateWithSession(ctx.state.access, `Bearer ${body.token}`, ctx.handler.resolveSession);
    assert.equal(viaSession, ctx.state.access.principals.find(p => p.id === name), 'identity, not a copy');
  }
  const viaRegistry = authenticateWithSession(ctx.state.access, `Bearer ${REGISTRY_TOKEN}`, ctx.handler.resolveSession);
  assert.equal(viaRegistry, authenticate(ctx.state.access, `Bearer ${REGISTRY_TOKEN}`));
});

test('ES256 provider tokens work too', async t => {
  const ctx = await setup(t);
  ctx.idp.behavior.alg = 'ES256';
  const { session } = await ctx.signIn(createBrowser(), USERS.alice);
  assert.equal(session.status, 200);
});

test('a confidential client authenticates with HTTP Basic and its secret appears nowhere it should not', async t => {
  const ctx = await setup(t, { envExtra: { SSO_CLIENT_SECRET: SECRET }, idpOptions: { clientSecret: SECRET } });
  const browser = createBrowser();
  const { login, callback, session } = await ctx.signIn(browser, USERS.alice);
  assert.equal(session.status, 200);
  const everything = [ctx.lines.join('\n'), login.headers.get('location'), callback.headers.get('location'), JSON.stringify(ctx.idp.stats.lastAuthorize),
    await ctx.handler.sessions.size().toString()].join('\n');
  assert.equal(everything.includes(SECRET), false);
  assert.match(ctx.idp.stats.tokenRequests[0].authorization, /^Basic /);
});

test('a wrong client secret is a refused code exchange and counts as a failure', async t => {
  const fails = [];
  const ctx = await setup(t, { envExtra: { SSO_CLIENT_SECRET: 'not-the-secret' }, idpOptions: { clientSecret: SECRET }, throttle: { check() {}, fail: key => fails.push(key) } });
  const { callback } = await ctx.signIn(createBrowser(), USERS.alice);
  assert.equal(callback.status, 401);
  assert.equal(hasCode(ctx, 'SSO_TOKEN_REJECTED'), true);
  assert.deepEqual(fails, ['client-1']);
  assert.equal(ctx.lines.join('\n').includes('not-the-secret'), false);
});

const TOKEN_FAILURES = [
  ['wrong issuer', b => { b.claims = { iss: 'http://127.0.0.1:1' }; }, 'SSO_ID_TOKEN_ISSUER'],
  ['wrong audience', b => { b.claims = { aud: 'someone-else' }; }, 'SSO_ID_TOKEN_AUDIENCE'],
  ['audience list without us', b => { b.claims = { aud: ['a', 'b'], azp: 'a' }; }, 'SSO_ID_TOKEN_AUDIENCE'],
  ['multiple audiences without azp', b => { b.claims = { aud: ['enclave-test-client', 'b'] }; }, 'SSO_ID_TOKEN_AZP'],
  ['expired', b => { b.claims = { exp: Math.floor(Date.now() / 1000) - 3600, iat: Math.floor(Date.now() / 1000) - 7200 }; }, 'SSO_ID_TOKEN_EXPIRED'],
  ['not yet valid', b => { b.claims = { nbf: Math.floor(Date.now() / 1000) + 3600 }; }, 'SSO_ID_TOKEN_NOT_YET_VALID'],
  ['issued in the future', b => { b.claims = { iat: Math.floor(Date.now() / 1000) + 3600 }; }, 'SSO_ID_TOKEN_IAT'],
  ['bad signature (unpublished key)', b => { b.signWith = 'rogue'; }, 'SSO_ID_TOKEN_SIGNATURE'],
  ['alg none', b => { b.alg = 'none'; }, 'SSO_ID_TOKEN_ALG_UNSUPPORTED'],
  ['alg HS256 keyed with the public key', b => { b.alg = 'HS256'; }, 'SSO_ID_TOKEN_ALG_UNSUPPORTED'],
  ['wrong nonce', b => { b.nonce = 'another-nonce'; }, 'SSO_ID_TOKEN_NONCE'],
  ['missing nonce', b => { b.omitClaims = ['nonce']; b.nonce = undefined; }, 'SSO_ID_TOKEN_NONCE'],
  ['missing subject', b => { b.omitClaims = ['sub']; }, 'SSO_ID_TOKEN_SUBJECT']
];

for (const [name, mutate, code] of TOKEN_FAILURES) {
  test(`token validation: ${name} is refused with 401, logs ${code}, counts as a failure and issues nothing`, async t => {
    const fails = [];
    const ctx = await setup(t, { throttle: { check() {}, fail: key => fails.push(key) } });
    mutate(ctx.idp.behavior);
    const browser = createBrowser();
    const { callback, session } = await ctx.signIn(browser, USERS.alice);
    assert.equal(callback.status, 401);
    assert.equal(callback.headers.get('location'), null);
    assert.equal(hasCode(ctx, code), true, ctx.lines.join(','));
    assert.equal(browser.cookie(ctx.base, 'enclave_sso_handoff'), undefined);
    assert.equal(session.status, 401);
    assert.equal(ctx.handler.sessions.size(), 0);
    assert.deepEqual(fails, ['client-1']);
    const body = await callback.json();
    assert.deepEqual(body, { ok: false, error: 'SSO sign-in rejected' });
  });
}

test('mapping: unmapped, unverified, disabled and missing principals get 403 with a generic message, a distinct log code, and no lock count', async t => {
  const fails = [];
  const ctx = await setup(t, { throttle: { check() {}, fail: key => fails.push(key) } });
  const cases = [
    [USERS.stranger, 'SSO_SUBJECT_UNMAPPED'],
    [{ ...USERS.bob, sub: 'u-other-bob', email_verified: false }, 'SSO_EMAIL_UNVERIFIED'],
    [USERS.dave, 'SSO_PRINCIPAL_UNAVAILABLE'],
    [USERS.ghost, 'SSO_PRINCIPAL_UNAVAILABLE']
  ];
  for (const [user, code] of cases) {
    const browser = createBrowser();
    const { callback, session } = await ctx.signIn(browser, user);
    assert.equal(callback.status, 403, code);
    assert.deepEqual(await callback.json(), { ok: false, error: 'SSO identity is not registered' });
    assert.equal(hasCode(ctx, code), true, code);
    assert.equal(session.status, 401);
  }
  assert.equal(ctx.handler.sessions.size(), 0);
  assert.deepEqual(fails, [], 'an unregistered person is not a guess');
});

test('mapping: a verified e-mail maps; the same e-mail unverified does not; an e-mail never overrides a mapped subject', async t => {
  const ctx = await setup(t);
  const verified = await ctx.signIn(createBrowser(), USERS.bob);
  assert.equal(verified.body.kind, 'recipient');
  const asString = await ctx.signIn(createBrowser(), { ...USERS.bob, sub: 'x', email_verified: 'true' });
  assert.equal(asString.callback.status, 403);
  const hijack = await ctx.signIn(createBrowser(), { sub: 'u-alice', email: 'bob@example.org', email_verified: true });
  assert.equal((await ctx.whoami(hijack.body.token).then(r => r.json())).id, 'alice');
});

test('a principal disabled after sign-in is refused on the next request with the usual 401, and is not counted as a guess', async t => {
  const ctx = await setup(t);
  const { body } = await ctx.signIn(createBrowser(), USERS.alice);
  assert.equal((await ctx.whoami(body.token)).status, 200);
  ctx.state.access = validateAccess({ principals: ctx.state.access.principals.map(p => (p.id === 'alice' ? { ...p, disabled: true } : p)), grants: [] });
  const refused = await ctx.whoami(body.token);
  assert.equal(refused.status, 401);
  assert.deepEqual(await refused.json(), { ok: false, error: 'Authentication failed' });
  assert.equal(ctx.state.guesses, 0, 'a live session token is never counted as a password guess');
  assert.equal((await ctx.whoami(crypto.randomBytes(32).toString('base64url'))).status, 401);
  assert.equal(ctx.state.guesses, 1, 'an unknown 43-character token still is');
});

test('a disabled principal cannot be handed a session even if disabled between callback and exchange', async t => {
  const ctx = await setup(t);
  ctx.idp.behavior.user = USERS.alice;
  const browser = createBrowser();
  const step = await ctx.authorize(browser);
  assert.equal((await browser.get(step.callbackUrl)).status, 302);
  ctx.state.access = validateAccess({ principals: ctx.state.access.principals.map(p => (p.id === 'alice' ? { ...p, disabled: true } : p)), grants: [] });
  const session = await ctx.exchange(browser);
  assert.equal(session.status, 403);
  assert.equal(ctx.handler.sessions.size(), 0);
});

test('session expiry: valid until the absolute expiry, then refused; the minutes setting is honoured', async t => {
  const ctx = await setup(t, { envExtra: { SSO_SESSION_MINUTES: '5' } });
  const { body } = await ctx.signIn(createBrowser(), USERS.alice);
  assert.equal(Date.parse(body.expiresAt) - ctx.clock.t, 5 * 60_000);
  ctx.clock.t += 5 * 60_000 - 1000;
  assert.equal((await ctx.whoami(body.token)).status, 200);
  ctx.clock.t += 1000;
  assert.equal((await ctx.whoami(body.token)).status, 401);
  assert.equal(ctx.handler.sessions.size(), 0);
});

test('state: a forged or unknown state is refused and, from a browser with a flow cookie, counted', async t => {
  const fails = [];
  const ctx = await setup(t, { throttle: { check() {}, fail: key => fails.push(key) } });
  ctx.idp.behavior.authorizeState = crypto.randomBytes(32).toString('base64url');
  const { callback, session } = await ctx.signIn(createBrowser(), USERS.alice);
  assert.equal(callback.status, 400);
  assert.equal(hasCode(ctx, 'SSO_STATE_INVALID'), true);
  assert.equal(session.status, 401);
  assert.deepEqual(fails, ['client-1']);
});

test('state: a callback replay fails, whether or not the first use succeeded', async t => {
  const ctx = await setup(t);
  ctx.idp.behavior.user = USERS.alice;
  const browser = createBrowser();
  const step = await ctx.authorize(browser);
  assert.equal((await browser.get(step.callbackUrl)).status, 302);
  browser.setCookie(ctx.base, 'enclave_sso_flow', browser.seen.find(entry => entry.name === 'enclave_sso_flow' && entry.value).value, '/api/sso');
  const replay = await browser.get(step.callbackUrl);
  assert.equal(replay.status, 400);
  assert.equal(hasCode(ctx, 'SSO_STATE_INVALID'), true);

  ctx.idp.behavior.claims = { aud: 'wrong' };
  const failing = createBrowser();
  const second = await ctx.authorize(failing);
  assert.equal((await failing.get(second.callbackUrl)).status, 401);
  failing.setCookie(ctx.base, 'enclave_sso_flow', failing.seen.find(entry => entry.name === 'enclave_sso_flow' && entry.value).value, '/api/sso');
  ctx.idp.behavior.claims = {};
  assert.equal((await failing.get(second.callbackUrl)).status, 400, 'a failed first use already consumed the state');
});

test('state is bound to the browser: no cookie, another flow\'s cookie, or a tampered cookie all fail', async t => {
  const fails = [];
  const ctx = await setup(t, { throttle: { check() {}, fail: key => fails.push(key) } });
  ctx.idp.behavior.user = USERS.alice;
  const victim = createBrowser();
  const attackerStep = await ctx.authorize(createBrowser());
  const withoutCookie = await victim.get(attackerStep.callbackUrl);
  assert.equal(withoutCookie.status, 400);
  assert.equal(hasCode(ctx, 'SSO_STATE_COOKIE_MISMATCH'), true);

  const first = createBrowser();
  const second = createBrowser();
  const firstStep = await ctx.authorize(first);
  await ctx.authorize(second);
  first.setCookie(ctx.base, 'enclave_sso_flow', second.cookie(ctx.base, 'enclave_sso_flow'), '/api/sso');
  assert.equal((await first.get(firstStep.callbackUrl)).status, 400);

  const third = createBrowser();
  const thirdStep = await ctx.authorize(third);
  const flowCookie = third.cookie(ctx.base, 'enclave_sso_flow');
  // A different last character, whatever the random cookie ended with; replacing it with a fixed "A"
  // left the cookie intact one time in 64 and made the test fail at random.
  third.setCookie(ctx.base, 'enclave_sso_flow', `${flowCookie.slice(0, -1)}${flowCookie.endsWith('A') ? 'B' : 'A'}`, '/api/sso');
  assert.equal((await third.get(thirdStep.callbackUrl)).status, 400);
  // The first case carried no flow cookie, so it is refused but not counted; the other two did.
  assert.equal(fails.length, 2);
  assert.equal(ctx.handler.sessions.size(), 0);
});

test('a callback without a flow cookie is refused but never counted toward the lock', async t => {
  const fails = [];
  const ctx = await setup(t, { throttle: { check() {}, fail: key => fails.push(key) } });
  const forced = createBrowser();
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const url = `${ctx.base}/api/sso/callback?state=${crypto.randomBytes(32).toString('base64url')}&code=x`;
    assert.equal((await forced.get(url)).status, 400);
  }
  assert.deepEqual(fails, []);
  const cookieHolder = createBrowser();
  await ctx.authorize(cookieHolder);
  const withCookie = await cookieHolder.get(`${ctx.base}/api/sso/callback?state=${crypto.randomBytes(32).toString('base64url')}&code=x`);
  assert.equal(withCookie.status, 400);
  assert.deepEqual(fails, ['client-1']);
});

test('state expires: a sign-in left open longer than ten minutes is refused', async t => {
  const ctx = await setup(t);
  ctx.idp.behavior.user = USERS.alice;
  const browser = createBrowser();
  const step = await ctx.authorize(browser);
  ctx.clock.t += 10 * 60_000;
  const late = await browser.get(step.callbackUrl);
  assert.equal(late.status, 400);
  assert.equal(hasCode(ctx, 'SSO_STATE_INVALID'), true);
});

test('an iss parameter that differs from the configured issuer is refused (RFC 9207)', async t => {
  const ctx = await setup(t);
  ctx.idp.behavior.sendIss = 'http://127.0.0.1:2';
  const { callback } = await ctx.signIn(createBrowser(), USERS.alice);
  assert.equal(callback.status, 401);
  assert.equal(hasCode(ctx, 'SSO_ISS_PARAMETER_MISMATCH'), true);
  ctx.idp.behavior.sendIss = true;
  assert.equal((await ctx.signIn(createBrowser(), USERS.alice)).session.status, 200);
});

test('hand-off: needs the header and the cookie, is single use, and expires after a minute', async t => {
  const ctx = await setup(t);
  ctx.idp.behavior.user = USERS.alice;
  const noHeader = await fetch(`${ctx.base}/api/sso/session`, { method: 'POST' });
  assert.equal(noHeader.status, 400);
  assert.equal((await ctx.exchange(createBrowser())).status, 401);

  const browser = createBrowser();
  const step = await ctx.authorize(browser);
  await browser.get(step.callbackUrl);
  const handoffValue = browser.cookie(ctx.base, 'enclave_sso_handoff');
  assert.equal((await ctx.exchange(browser)).status, 200);
  browser.setCookie(ctx.base, 'enclave_sso_handoff', handoffValue, '/api/sso');
  assert.equal((await ctx.exchange(browser)).status, 401, 'a hand-off is used once');

  const slow = createBrowser();
  const slowStep = await ctx.authorize(slow);
  await slow.get(slowStep.callbackUrl);
  ctx.clock.t += 61_000;
  assert.equal((await ctx.exchange(slow)).status, 401);
  assert.equal(ctx.handler.sessions.size(), 1);
});

test('table bounds: pending sign-ins are capped globally and per client; a full session table refuses with 503', async t => {
  const ctx = await setup(t, { limits: { maxFlows: 3, maxFlowsPerClient: 2, maxSessions: 1, maxSessionsPerPrincipal: 1 } });
  ctx.idp.behavior.user = USERS.alice;
  const steps = [];
  const browsers = [];
  for (let i = 0; i < 3; i += 1) {
    browsers.push(createBrowser());
    steps.push(await ctx.authorize(browsers[i]));
  }
  assert.equal((await browsers[0].get(steps[0].callbackUrl)).status, 400, 'the oldest pending sign-in of a client is dropped past its cap');
  assert.equal((await browsers[1].get(steps[1].callbackUrl)).status, 302);
  assert.equal((await browsers[2].get(steps[2].callbackUrl)).status, 302);

  const aliceSession = await ctx.exchange(browsers[1]);
  assert.equal(aliceSession.status, 200);
  const bobBrowser = createBrowser();
  const bob = await ctx.signIn(bobBrowser, USERS.bob);
  assert.equal(bob.session.status, 503);
  assert.equal(hasCode(ctx, 'SSO_SESSION_CAPACITY'), true);
  assert.equal(ctx.handler.sessions.size(), 1);
});

test('discovery failure fails closed: login answers 503, starts nothing, and registry tokens keep working', async t => {
  const ctx = await setup(t);
  ctx.idp.behavior.discovery.status = 500;
  const browser = createBrowser();
  const login = await browser.get(`${ctx.base}/api/sso/login`);
  assert.equal(login.status, 503);
  assert.deepEqual(await login.json(), { ok: false, error: 'SSO identity provider unavailable' });
  assert.equal(login.headers.get('location'), null);
  assert.equal(login.headers.get('set-cookie'), null);
  assert.equal(hasCode(ctx, 'SSO_DISCOVERY_FAILED'), true);
  assert.equal(ctx.handler.sessions.size(), 0);
  assert.equal((await ctx.whoami(REGISTRY_TOKEN)).status, 200);
  assert.equal((await ctx.whoami(null)).status, 401);
});

test('an unreachable provider mid-flow is a 503 and not a counted failure', async t => {
  const fails = [];
  const ctx = await setup(t, { throttle: { check() {}, fail: key => fails.push(key) } });
  ctx.idp.behavior.user = USERS.alice;
  ctx.idp.behavior.tokenStatus = 503;
  const first = await ctx.signIn(createBrowser(), USERS.alice);
  assert.equal(first.callback.status, 503);
  assert.equal(hasCode(ctx, 'SSO_TOKEN_ENDPOINT_FAILED'), true);
  ctx.idp.behavior.tokenStatus = 200;
  ctx.idp.behavior.tokenDelayMs = 3000;
  const slow = await ctx.signIn(createBrowser(), USERS.alice);
  assert.equal(slow.callback.status, 503);
  assert.equal(hasCode(ctx, 'SSO_IDP_UNREACHABLE'), true);
  assert.deepEqual(fails, []);
});

test('failure counting follows auth-throttle semantics: only real guesses count, and the lock then applies', async t => {
  const throttle = createAuthThrottle({ maxFailures: 3, windowMs: 60_000, lockMs: 30_000 });
  const ctx = await setup(t, { throttle });
  const uncounted = async () => {
    for (let i = 0; i < 5; i += 1) {
      assert.equal((await fetch(`${ctx.base}/api/sso/callback`)).status, 400);
      assert.equal((await fetch(`${ctx.base}/api/sso/callback?state=${'a'.repeat(600)}&code=x`)).status, 400);
    }
    ctx.idp.behavior.authorizeError = 'access_denied';
    for (let i = 0; i < 5; i += 1) assert.equal((await ctx.signIn(createBrowser(), USERS.alice)).callback.status, 401);
    ctx.idp.behavior.authorizeError = null;
    for (let i = 0; i < 5; i += 1) assert.equal((await ctx.signIn(createBrowser(), USERS.stranger)).callback.status, 403);
  };
  await uncounted();
  assert.equal(hasCode(ctx, 'SSO_PROVIDER_DECLINED'), true);
  assert.equal(throttle.size(), 0, 'nothing above was a guess');
  assert.equal((await ctx.signIn(createBrowser(), USERS.alice)).session.status, 200);

  ctx.idp.behavior.authorizeState = crypto.randomBytes(32).toString('base64url');
  for (let i = 0; i < 3; i += 1) assert.equal((await ctx.signIn(createBrowser(), USERS.alice)).callback.status, 400);
  ctx.idp.behavior.authorizeState = undefined;
  const locked = await fetch(`${ctx.base}/api/sso/login`);
  assert.equal(locked.status, 429);
  assert.ok(Number(locked.headers.get('retry-after')) >= 1);
  assert.equal((await fetch(`${ctx.base}/api/sso/callback?state=x&code=y`)).status, 429);
  assert.equal((await fetch(`${ctx.base}/api/sso/session`, { method: 'POST', headers: { 'x-sso-exchange': '1' } })).status, 429);
});

test('methods and paths: wrong methods are 405, unknown /api/sso paths and other prefixes fall through', async t => {
  const ctx = await setup(t);
  assert.equal((await fetch(`${ctx.base}/api/sso/login`, { method: 'POST' })).status, 405);
  assert.equal((await fetch(`${ctx.base}/api/sso/session`)).status, 405);
  assert.equal((await fetch(`${ctx.base}/api/sso/callback`, { method: 'POST' })).status, 405);
  assert.equal((await fetch(`${ctx.base}/api/sso/nothing`)).status, 404);
  assert.equal((await fetch(`${ctx.base}/api/sso/__proto__`)).status, 404);
  assert.equal((await fetch(`${ctx.base}/api/ssoextra`)).status, 404);
  const status = await fetch(`${ctx.base}/api/sso/status`);
  assert.deepEqual(await status.json(), { ok: true, enabled: true });
  const logout = await fetch(`${ctx.base}/api/sso/logout`, { method: 'POST', headers: { authorization: 'Bearer nonsense' } });
  assert.equal(logout.status, 200, 'logout reveals nothing about which tokens exist');
});

test('cookies carry Secure when the redirect URI is https', async t => {
  const stub = async url => {
    const target = String(url);
    assert.ok(target.startsWith('https://idp.example.org'), target);
    return new Response(JSON.stringify({
      issuer: 'https://idp.example.org', authorization_endpoint: 'https://idp.example.org/authorize',
      token_endpoint: 'https://idp.example.org/token', jwks_uri: 'https://idp.example.org/jwks'
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const ctx = await setup(t, {
    envExtra: { SSO_ISSUER: 'https://idp.example.org', SSO_REDIRECT_URI: 'https://app.example.org/api/sso/callback', SSO_ALLOW_LOOPBACK_IDP: '' },
    fetchImpl: stub
  });
  const login = await fetch(`${ctx.base}/api/sso/login`, { redirect: 'manual' });
  assert.equal(login.status, 302);
  assert.match(login.headers.get('set-cookie'), /; HttpOnly; SameSite=Lax; Max-Age=600; Secure$/);
  assert.match(login.headers.get('location'), /^https:\/\/idp\.example\.org\/authorize\?/);
});

test('misconfiguration with SSO_ISSUER set fails closed with 503 on every SSO path and never echoes a secret', async t => {
  const cases = [
    [{ SSO_CLIENT_ID: '' }, 'SSO_CLIENT_ID'],
    [{ SSO_REDIRECT_URI: 'https://app.example.org/wrong' }, 'SSO_REDIRECT_URI'],
    [{ SSO_SESSION_MINUTES: '9999', SSO_CLIENT_SECRET: SECRET }, 'SSO_SESSION_MINUTES'],
    [{ SSO_ALLOW_LOOPBACK_IDP: 'false' }, 'SSO_ISSUER'],
    [{ SSO_SUBJECT_MAP: '/nonexistent/sso-map.json' }, 'SSO_SUBJECT_MAP']
  ];
  for (const [extra, name] of cases) {
    const ctx = await setup(t, { envExtra: extra });
    assert.equal(ctx.handler.state, 'misconfigured', name);
    for (const [route, method] of [['status', 'GET'], ['login', 'GET'], ['callback', 'GET'], ['session', 'POST'], ['logout', 'POST']]) {
      const response = await fetch(`${ctx.base}/api/sso/${route}`, { method });
      assert.equal(response.status, 503, `${name} ${route}`);
      assert.deepEqual(await response.json(), { ok: false, error: 'SSO is not available' });
    }
    assert.equal(ctx.lines.some(line => line.startsWith('ERROR SSO_CONFIG_INVALID') && line.includes(name)), true, name);
    assert.equal(ctx.lines.join('\n').includes(SECRET), false);
    assert.equal(ctx.handler.resolveSession('a'.repeat(43)), null);
    assert.equal((await ctx.whoami(REGISTRY_TOKEN)).status, 200, 'registry tokens are untouched');
  }
});

test('an invalid subject map file is a 503 at startup, not an empty allow or deny list', async t => {
  const ctx = await setup(t, { mapOverride: '{"version":1,"entries":[{"sub":"a","principalId":"x y"}]}' });
  assert.equal(ctx.handler.state, 'misconfigured');
  assert.equal((await fetch(`${ctx.base}/api/sso/login`)).status, 503);
});

test('a subject map that becomes unreadable after startup refuses sign-ins with 503', async t => {
  const ctx = await setup(t);
  await fs.rm(ctx.mapFile);
  const { callback } = await ctx.signIn(createBrowser(), USERS.alice);
  assert.equal(callback.status, 503);
  assert.equal(hasCode(ctx, 'SSO_SUBJECT_MAP_UNAVAILABLE'), true);
});

test('an edit to the subject map takes effect on the next sign-in without a restart', async t => {
  const ctx = await setup(t);
  assert.equal((await ctx.signIn(createBrowser(), USERS.stranger)).callback.status, 403);
  await fs.writeFile(ctx.mapFile, JSON.stringify({ version: 1, entries: [...SUBJECT_MAP.entries, { sub: 'u-stranger', principalId: 'bob' }] }));
  const mapped = await ctx.signIn(createBrowser(), USERS.stranger);
  assert.equal(mapped.body.kind, 'recipient');
});

test('SSO unset: the handler is inert, answers nothing, resolves nothing, and never touches the network', async () => {
  const forbidden = () => { throw new Error('the network must not be used when SSO is off'); };
  for (const env of [{}, { SSO_ISSUER: '' }, { SSO_CLIENT_ID: 'x', SSO_CLIENT_SECRET: SECRET, SSO_REDIRECT_URI: 'junk' }]) {
    const lines = [];
    const handler = createSsoRoutes({ env, loadConfig: forbidden, fetchImpl: forbidden, log: line => lines.push(line) });
    assert.equal(handler.state, 'off');
    for (const pathname of ['/api/sso/login', '/api/sso/callback', '/api/sso/status', '/api/sso/session', '/api/whoami', '/', '/api/sso/']) {
      const res = { writeHead: forbidden, setHeader: forbidden, end: forbidden };
      assert.equal(await handler({ method: 'GET', headers: {} }, res, new URL(pathname, 'http://127.0.0.1')), false, pathname);
    }
    assert.equal(handler.resolveSession('a'.repeat(43)), null);
    assert.equal(handler.knowsSession(`Bearer ${'a'.repeat(43)}`), false);
    assert.deepEqual(lines, []);
  }
});

test('SSO unset: authenticateWithSession behaves exactly like authenticate() for every kind of header', async () => {
  const access = registry();
  const inert = createSsoRoutes({ env: {} });
  const resolvers = [undefined, null, 'not a function', () => null, () => undefined, () => 7, inert.resolveSession];
  const headers = [
    `Bearer ${REGISTRY_TOKEN}`, `Bearer ${crypto.randomBytes(32).toString('base64url')}`, `Bearer ${'a'.repeat(31)}`, `Bearer ${'a'.repeat(32)}`,
    `Bearer ${'a'.repeat(256)}`, `Bearer ${'a'.repeat(257)}`, `bearer ${REGISTRY_TOKEN}`, `Basic ${REGISTRY_TOKEN}`, REGISTRY_TOKEN, '', undefined, null, 5, {},
    `Bearer ${REGISTRY_TOKEN} `, `Bearer  ${REGISTRY_TOKEN}`, `Bearer ${REGISTRY_TOKEN}!`
  ];
  const outcome = (call) => { try { return { principal: call() }; } catch (error) { return { status: error.status, message: error.message }; } };
  for (const header of headers) {
    const baseline = outcome(() => authenticate(access, header));
    for (const resolver of resolvers) {
      const candidate = outcome(() => authenticateWithSession(access, header, resolver));
      assert.deepEqual(candidate, baseline, `${String(header).slice(0, 20)} ${String(resolver)}`);
      if (baseline.principal) assert.equal(candidate.principal, baseline.principal);
    }
  }
  assert.equal(authenticate(access, `Bearer ${REGISTRY_TOKEN}`), access.principals[0]);
  const disabled = access.principals.find(p => p.disabled);
  assert.equal(disabled.id, 'dave');
});

test('SSO on: registry tokens, garbage and prefixes still behave exactly as before', async t => {
  const ctx = await setup(t);
  assert.equal((await ctx.whoami(REGISTRY_TOKEN)).status, 200);
  assert.equal((await ctx.whoami('x'.repeat(43))).status, 401);
  assert.equal((await ctx.whoami('short')).status, 401);
  assert.equal((await ctx.whoami()).status, 401);
  assert.equal(ctx.state.guesses, 1, 'only the well-formed unknown token counted');
  const { body } = await ctx.signIn(createBrowser(), USERS.alice);
  assert.equal((await ctx.whoami(REGISTRY_TOKEN)).status, 200, 'signing in does not disturb the registry token');
  assert.equal((await ctx.whoami(body.token)).status, 200);
});

test('a session token is not a registry token: it grants nothing once revoked, and revoking a principal ends all its sessions', async t => {
  const ctx = await setup(t);
  const one = await ctx.signIn(createBrowser(), USERS.alice);
  const two = await ctx.signIn(createBrowser(), USERS.alice);
  assert.notEqual(one.body.token, two.body.token);
  assert.equal(ctx.handler.sessions.revokePrincipal('alice'), 2);
  assert.equal((await ctx.whoami(one.body.token)).status, 401);
  assert.equal((await ctx.whoami(two.body.token)).status, 401);
});
