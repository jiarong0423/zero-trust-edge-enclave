import { readFileSync } from 'node:fs';
import { fail } from './access-control.js';
import { principalEnabled } from './registry-schema.js';
import { securityHeaders, sendJson } from './http-helpers.js';
import { createIdpClient, newPkce, parseSubjectMap, readSubjectMap, resolveSubject, ssoConfigFromEnv } from './sso-oidc.js';
import { createOneTimeTable, createSessionStore, digest, randomToken, safeEqualDigest } from './sso-session.js';

/**
 * Optional OIDC single sign-on routes. Off unless SSO_ISSUER is set.
 *
 *   GET  /api/sso/status    {enabled}; no secrets, no state.
 *   GET  /api/sso/login     starts a sign-in: sets the flow cookie, redirects to the provider.
 *   GET  /api/sso/callback  the redirect URI. Consumes the pending sign-in, redeems the code,
 *                           validates the ID token, maps it to an existing principal, sets a
 *                           one-minute hand-off cookie and redirects to "/".
 *   POST /api/sso/session   header x-sso-exchange: 1 plus the hand-off cookie; returns the session
 *                           token once, in the body. The page then sends it as a Bearer token.
 *   POST /api/sso/logout    Authorization: Bearer <session token>; revokes it.
 *
 * The factory returns the route handler itself, (req, res, url) => Promise<boolean>, resolving true
 * when it answered. Its properties are what the rest of the server needs: `resolveSession` for
 * authenticateWithSession() and `knowsSession` so a live session token is never counted as a
 * password guess.
 *
 * Which callback failures count toward the sign-in lock (auth-throttle.js semantics: only real
 * guesses count): an unknown, expired or replayed state, a state that does not belong to this
 * browser, a refused code, a refused ID token, an unknown hand-off. These do NOT count: a bare or
 * malformed visit, the person cancelling at the provider, a provider outage, and a valid identity
 * that is simply not registered or is disabled.
 */
const FLOW_COOKIE = 'enclave_sso_flow';
const HANDOFF_COOKIE = 'enclave_sso_handoff';
const FLOW_TTL_MS = 600_000;
const HANDOFF_TTL_MS = 60_000;
const LANDING_PATH = '/';

function cookieValue(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return '';
}

function appendCookie(res, cookie) {
  const existing = res.getHeader('set-cookie');
  res.setHeader('set-cookie', [...(Array.isArray(existing) ? existing : existing ? [existing] : []), cookie]);
}

function redirect(res, location) {
  res.writeHead(302, { location, 'cache-control': 'no-store', ...securityHeaders(res.req) });
  res.end();
}

const inactive = Object.assign(async () => false, {
  state: 'off', resolveSession: () => null, knowsSession: () => false, sessions: null
});

export function createSsoRoutes({ env = process.env, loadConfig, throttle = null, clientKey = () => 'shared', now = Date.now,
  fetchImpl = globalThis.fetch, idpTimeoutMs, log = line => console.error(line), limits = {} } = {}) {
  let config;
  try {
    config = ssoConfigFromEnv(env);
    if (config) parseSubjectMap(readFileSync(config.subjectMapPath, 'utf8'));
  } catch (error) {
    const named = error?.code === 'SSO_CONFIG_INVALID' ? error.message : 'SSO is misconfigured: SSO_SUBJECT_MAP';
    log(`ERROR SSO_CONFIG_INVALID ${named}`);
    return Object.assign(async (req, res, url) => {
      if (!url.pathname.startsWith('/api/sso/')) return false;
      return fail('SSO is not available', 503);
    }, { state: 'misconfigured', resolveSession: () => null, knowsSession: () => false, sessions: null });
  }
  if (!config) return inactive;
  if (typeof loadConfig !== 'function') throw new Error('createSsoRoutes needs loadConfig');

  const idp = createIdpClient(config, { now, fetchImpl, ...(idpTimeoutMs ? { timeoutMs: idpTimeoutMs } : {}) });
  const flows = createOneTimeTable({ maxEntries: limits.maxFlows ?? 1000, maxPerOwner: limits.maxFlowsPerClient ?? 10,
    ttlMs: limits.flowTtlMs ?? FLOW_TTL_MS, now });
  const handoffs = createOneTimeTable({ maxEntries: limits.maxHandoffs ?? 1000, maxPerOwner: limits.maxHandoffsPerClient ?? 10,
    ttlMs: limits.handoffTtlMs ?? HANDOFF_TTL_MS, now });
  const sessions = createSessionStore({ maxSessions: limits.maxSessions ?? 1000, maxPerPrincipal: limits.maxSessionsPerPrincipal ?? 5,
    ttlMs: config.sessionMinutes * 60_000, now });
  const secure = config.secureCookies ? '; Secure' : '';
  const flowCookie = (value, seconds) => `${FLOW_COOKIE}=${value}; Path=/api/sso; HttpOnly; SameSite=Lax; Max-Age=${seconds}${secure}`;
  const handoffCookie = (value, seconds) => `${HANDOFF_COOKIE}=${value}; Path=/api/sso; HttpOnly; SameSite=Strict; Max-Age=${seconds}${secure}`;
  const flowSeconds = Math.ceil((limits.flowTtlMs ?? FLOW_TTL_MS) / 1000);

  log('INFO SSO_ENABLED');
  if (config.allowLoopback) log('WARN SSO_LOOPBACK_IDP_ENABLED');

  function countFailure(req) {
    try { throttle?.fail(clientKey(req)); } catch { /* the lock must not turn a refusal into a crash */ }
  }

  function refuse(req, code, status, message, { count = false } = {}) {
    log(`ERROR ${code}`);
    if (count) countFailure(req);
    throw Object.assign(new Error(message), { status });
  }

  function providerFailure(req, error) {
    const code = typeof error?.code === 'string' && error.code.startsWith('SSO_') ? error.code : 'SSO_INTERNAL';
    log(`ERROR ${code}`);
    if (error?.status === 401) countFailure(req);
    if (error?.status === 401 || error?.status === 503) throw error;
    throw Object.assign(new Error('SSO sign-in failed'), { status: 500 });
  }

  async function registeredPrincipal(principalId) {
    const access = await loadConfig();
    const principal = access.principals.find(entry => entry.id === principalId);
    return principalEnabled(access, principal) ? principal : null;
  }

  async function login(req, res) {
    const key = clientKey(req);
    throttle?.check(key);
    let url;
    const state = randomToken();
    const nonce = randomToken();
    const flowId = randomToken();
    const { verifier, challenge } = newPkce();
    try { url = await idp.authorizationUrl({ state, nonce, challenge }); }
    catch (error) { providerFailure(req, error); }
    flows.put(digest(state), { nonce, verifier, flowHash: digest(flowId) }, key);
    appendCookie(res, flowCookie(flowId, flowSeconds));
    log('INFO SSO_LOGIN_STARTED');
    redirect(res, url);
  }

  async function callback(req, res, url) {
    const key = clientKey(req);
    throttle?.check(key);
    appendCookie(res, flowCookie('', 0));
    const state = url.searchParams.get('state');
    const code = url.searchParams.get('code');
    const providerError = url.searchParams.get('error');
    const iss = url.searchParams.get('iss');
    if (!state || state.length > 512 || (!code && !providerError) || (code && code.length > 2048)) {
      refuse(req, 'SSO_CALLBACK_MALFORMED', 400, 'SSO sign-in could not be completed');
    }
    // A callback that carries no flow cookie is not counted as a guess: any page can make a victim's
    // browser send such a GET, and counting it would let that page lock the victim's address out.
    // The cookie is only sent along with a sign-in this browser started.
    const presented = cookieValue(req, FLOW_COOKIE);
    const flow = flows.take(digest(state));
    if (!flow) refuse(req, 'SSO_STATE_INVALID', 400, 'SSO sign-in could not be completed', { count: Boolean(presented) });
    if (!presented || !safeEqualDigest(digest(presented), flow.flowHash)) {
      refuse(req, 'SSO_STATE_COOKIE_MISMATCH', 400, 'SSO sign-in could not be completed', { count: Boolean(presented) });
    }
    if (iss !== null && iss !== config.issuer) refuse(req, 'SSO_ISS_PARAMETER_MISMATCH', 401, 'SSO sign-in rejected', { count: true });
    if (providerError) refuse(req, 'SSO_PROVIDER_DECLINED', 401, 'SSO sign-in was not completed');

    let claims;
    try {
      const idToken = await idp.exchangeCode({ code, verifier: flow.verifier });
      claims = await idp.verify(idToken, { nonce: flow.nonce });
    } catch (error) { providerFailure(req, error); }

    let map;
    try { map = await readSubjectMap(config.subjectMapPath); }
    catch { refuse(req, 'SSO_SUBJECT_MAP_UNAVAILABLE', 503, 'SSO is not available'); }
    const resolved = resolveSubject(map, claims);
    if (!resolved.principalId) refuse(req, resolved.reason, 403, 'SSO identity is not registered');
    const principal = await registeredPrincipal(resolved.principalId);
    if (!principal) refuse(req, 'SSO_PRINCIPAL_UNAVAILABLE', 403, 'SSO identity is not registered');

    const handoffId = randomToken();
    handoffs.put(digest(handoffId), { principalId: principal.id }, key);
    appendCookie(res, handoffCookie(handoffId, Math.ceil((limits.handoffTtlMs ?? HANDOFF_TTL_MS) / 1000)));
    log('INFO SSO_LOGIN_VERIFIED');
    redirect(res, LANDING_PATH);
  }

  async function exchange(req, res) {
    if (req.headers['x-sso-exchange'] !== '1') refuse(req, 'SSO_EXCHANGE_HEADER_MISSING', 400, 'SSO exchange header required');
    const key = clientKey(req);
    throttle?.check(key);
    req.resume();
    const presented = cookieValue(req, HANDOFF_COOKIE);
    appendCookie(res, handoffCookie('', 0));
    if (!presented) refuse(req, 'SSO_HANDOFF_MISSING', 401, 'SSO sign-in required');
    const entry = handoffs.take(digest(presented));
    if (!entry) refuse(req, 'SSO_HANDOFF_INVALID', 401, 'SSO sign-in required', { count: true });
    const principal = await registeredPrincipal(entry.principalId);
    if (!principal) refuse(req, 'SSO_PRINCIPAL_UNAVAILABLE', 403, 'SSO identity is not registered');
    let session;
    try { session = sessions.issue(principal.id); }
    catch (error) { refuse(req, 'SSO_SESSION_CAPACITY', error.status || 503, 'SSO sessions are unavailable'); }
    log('INFO SSO_SESSION_ISSUED');
    sendJson(res, 200, { ok: true, token: session.token, expiresAt: new Date(session.expiresAt).toISOString(), kind: principal.kind });
  }

  function logout(req, res) {
    req.resume();
    const header = req.headers.authorization;
    const revoked = typeof header === 'string' && header.startsWith('Bearer ') && sessions.revoke(header.slice(7));
    if (revoked) log('INFO SSO_SESSION_REVOKED');
    sendJson(res, 200, { ok: true });
  }

  const routes = {
    '/api/sso/status': { GET: (req, res) => sendJson(res, 200, { ok: true, enabled: true }) },
    '/api/sso/login': { GET: login },
    '/api/sso/callback': { GET: callback },
    '/api/sso/session': { POST: exchange },
    '/api/sso/logout': { POST: logout }
  };

  const handle = async (req, res, url) => {
    if (!url.pathname.startsWith('/api/sso/')) return false;
    const route = Object.hasOwn(routes, url.pathname) ? routes[url.pathname] : null;
    if (!route) return false;
    if (!Object.hasOwn(route, req.method)) fail('Method not allowed', 405);
    await route[req.method](req, res, url);
    return true;
  };

  return Object.assign(handle, {
    state: 'on',
    resolveSession: token => sessions.resolve(token),
    knowsSession: header => typeof header === 'string' && header.startsWith('Bearer ') && sessions.knows(header.slice(7)),
    sessions
  });
}
