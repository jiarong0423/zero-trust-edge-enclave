import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';

/**
 * OpenID Connect authorization-code flow with PKCE, relying-party side, on node:crypto and the
 * built-in fetch only. Optional: nothing in the server loads this unless SSO_ISSUER is set.
 *
 * What is validated, and where: the discovery document (issuer exact match, https endpoints), the
 * JWKS (shape, key type, strength), the ID token (algorithm allowlist RS256 and ES256, signature,
 * iss, aud, azp, exp, nbf, iat, nonce) and the identity mapping (verified e-mail only). What is
 * deliberately not done: no access token is kept or used, no userinfo call is made, no token is
 * ever written to disk or to a log line.
 *
 * Failures carry a stable `code` for greppable logs and a generic message for the client.
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const SKEW_SECONDS = 60;
const MAX_DOCUMENT_BYTES = 262_144;
const MAX_TOKEN_RESPONSE_BYTES = 65_536;
const MAX_ID_TOKEN_CHARS = 16_384;
const MAX_SUBJECT_MAP_BYTES = 262_144;
const MAX_SUBJECT_MAP_ENTRIES = 10_000;
const MAX_JWKS_KEYS = 50;
const FETCH_TIMEOUT_MS = 5_000;
const DISCOVERY_TTL_MS = 3_600_000;
const JWKS_TTL_MS = 600_000;
const JWKS_REFRESH_MIN_MS = 30_000;
const FAILURE_CACHE_MS = 5_000;
const PRINCIPAL_ID = /^[a-zA-Z0-9_-]{1,64}$/;
const SCOPE_TOKEN = /^[\x21\x23-\x5b\x5d-\x7e]{1,64}$/;

const ALGORITHMS = Object.freeze({
  RS256: Object.freeze({ kty: 'RSA' }),
  ES256: Object.freeze({ kty: 'EC', crv: 'P-256' })
});

const unavailable = code => Object.assign(new Error('SSO identity provider unavailable'), { status: 503, code });
const rejected = (code, status = 401) => Object.assign(new Error('SSO sign-in rejected'), { status, code });
const configError = name => Object.assign(new Error(`SSO is misconfigured: ${name}`), { status: 503, code: 'SSO_CONFIG_INVALID' });

/** A URL object when the value is an https URL (or an http loopback URL when allowed) with no credentials. */
export function checkedUrl(value, allowLoopback) {
  if (typeof value !== 'string' || !value || value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.username || url.password) return null;
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:' && allowLoopback && LOOPBACK_HOSTS.has(url.hostname)) return url;
  return null;
}

/**
 * Reads SSO_* from the environment. Returns null when SSO_ISSUER is unset or empty (feature off).
 * When it is set, anything wrong throws a 503 error, the same style as createNetworkPolicy().
 */
export function ssoConfigFromEnv(env = process.env) {
  const issuer = env.SSO_ISSUER;
  if (issuer === undefined || issuer === '') return null;
  const allowLoopback = env.SSO_ALLOW_LOOPBACK_IDP === 'true';
  const issuerUrl = checkedUrl(issuer, allowLoopback);
  if (!issuerUrl || issuerUrl.search || issuerUrl.hash) throw configError('SSO_ISSUER');

  const clientId = env.SSO_CLIENT_ID;
  if (typeof clientId !== 'string' || !clientId || clientId.length > 256 || /[\u0000-\u001f\u007f\s]/.test(clientId)) {
    throw configError('SSO_CLIENT_ID');
  }

  const rawSecret = env.SSO_CLIENT_SECRET;
  if (rawSecret !== undefined && rawSecret !== '' &&
      (typeof rawSecret !== 'string' || rawSecret.length > 512 || /[\u0000-\u001f\u007f]/.test(rawSecret))) {
    throw configError('SSO_CLIENT_SECRET');
  }
  const clientSecret = rawSecret === undefined || rawSecret === '' ? null : rawSecret;

  const redirect = checkedUrl(env.SSO_REDIRECT_URI, allowLoopback);
  if (!redirect || redirect.search || redirect.hash || redirect.pathname !== '/api/sso/callback') throw configError('SSO_REDIRECT_URI');

  const scopeText = env.SSO_SCOPES === undefined || env.SSO_SCOPES === '' ? 'openid email' : env.SSO_SCOPES;
  const scopes = typeof scopeText === 'string' ? scopeText.split(' ') : [];
  if (!scopes.length || scopes.length > 20 || scopes.some(scope => !SCOPE_TOKEN.test(scope)) || !scopes.includes('openid')) {
    throw configError('SSO_SCOPES');
  }

  const subjectMapPath = env.SSO_SUBJECT_MAP;
  if (typeof subjectMapPath !== 'string' || !subjectMapPath || subjectMapPath.length > 1024 || /[\u0000-\u001f\u007f]/.test(subjectMapPath)) {
    throw configError('SSO_SUBJECT_MAP');
  }

  let sessionMinutes = 30;
  if (env.SSO_SESSION_MINUTES !== undefined && env.SSO_SESSION_MINUTES !== '') {
    if (!/^\d{1,3}$/.test(env.SSO_SESSION_MINUTES)) throw configError('SSO_SESSION_MINUTES');
    sessionMinutes = Number(env.SSO_SESSION_MINUTES);
    if (sessionMinutes < 1 || sessionMinutes > 480) throw configError('SSO_SESSION_MINUTES');
  }

  return Object.freeze({
    issuer, clientId, clientSecret, redirectUri: redirect.href, scopes: scopes.join(' '),
    subjectMapPath, sessionMinutes, allowLoopback, secureCookies: redirect.protocol === 'https:'
  });
}

/**
 * Subject map: a local JSON file that names, for each IdP identity, an EXISTING registry principal.
 * { "version": 1, "entries": [ { "sub": "...", "principalId": "alice" },
 *                              { "email": "alice@example.org", "principalId": "alice" } ] }
 * It cannot create a principal or choose a role; a principal id it names that the registry does not
 * hold (or holds disabled) simply cannot sign in. Duplicate keys are an error, not "last one wins".
 */
export function parseSubjectMap(text) {
  let data;
  try { data = JSON.parse(text); } catch { throw configError('SSO_SUBJECT_MAP'); }
  const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!isObject(data) || data.version !== 1 || !Array.isArray(data.entries) ||
      Object.keys(data).some(key => !['version', 'entries'].includes(key)) ||
      data.entries.length > MAX_SUBJECT_MAP_ENTRIES) throw configError('SSO_SUBJECT_MAP');
  const bySub = new Map();
  const byEmail = new Map();
  for (const entry of data.entries) {
    if (!isObject(entry) || Object.keys(entry).some(key => !['sub', 'email', 'principalId'].includes(key)) ||
        typeof entry.principalId !== 'string' || !PRINCIPAL_ID.test(entry.principalId) ||
        (entry.sub === undefined) === (entry.email === undefined)) throw configError('SSO_SUBJECT_MAP');
    if (entry.sub !== undefined) {
      if (typeof entry.sub !== 'string' || !entry.sub || entry.sub.length > 255 || /[\u0000-\u001f\u007f]/.test(entry.sub) ||
          bySub.has(entry.sub)) throw configError('SSO_SUBJECT_MAP');
      bySub.set(entry.sub, entry.principalId);
    } else {
      const email = typeof entry.email === 'string' ? entry.email.toLowerCase() : '';
      if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || /[\u0000-\u001f\u007f]/.test(email) ||
          byEmail.has(email)) throw configError('SSO_SUBJECT_MAP');
      byEmail.set(email, entry.principalId);
    }
  }
  return { bySub, byEmail };
}

export async function readSubjectMap(file) {
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > MAX_SUBJECT_MAP_BYTES) throw configError('SSO_SUBJECT_MAP');
  return parseSubjectMap(await fs.readFile(file, 'utf8'));
}

/**
 * Maps validated claims to a registry principal id. The stable `sub` wins. An e-mail address is a
 * mapping key only when the IdP says it verified it (the boolean true, not a string).
 */
export function resolveSubject(map, claims) {
  if (map.bySub.has(claims.sub)) return { principalId: map.bySub.get(claims.sub) };
  if (typeof claims.email === 'string' && map.byEmail.has(claims.email.toLowerCase())) {
    if (claims.email_verified !== true) return { reason: 'SSO_EMAIL_UNVERIFIED' };
    return { principalId: map.byEmail.get(claims.email.toLowerCase()) };
  }
  return { reason: 'SSO_SUBJECT_UNMAPPED' };
}

export function newPkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
}

async function readCapped(response, limit) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => {});
    throw unavailable('SSO_IDP_RESPONSE_TOO_LARGE');
  }
  if (!response.body) return '';
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > limit) throw unavailable('SSO_IDP_RESPONSE_TOO_LARGE');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * One bounded request to the identity provider: https only (http only for loopback when allowed),
 * no redirects, a timeout, a response size cap. Returns { status, json }; `json` is null when a
 * non-2xx body is not JSON. Transport trouble, an oversized body, or a 2xx that is not JSON throws.
 */
export async function fetchJson(target, { method = 'GET', headers = {}, body, timeoutMs = FETCH_TIMEOUT_MS,
  maxBytes = MAX_DOCUMENT_BYTES, allowLoopback = false, fetchImpl = globalThis.fetch } = {}) {
  const url = checkedUrl(target, allowLoopback);
  if (!url) throw unavailable('SSO_IDP_URL_REFUSED');
  let response;
  let text;
  try {
    response = await fetchImpl(url.href, { method, headers, body, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    text = await readCapped(response, maxBytes);
  } catch (error) {
    if (error?.code && String(error.code).startsWith('SSO_')) throw error;
    throw unavailable('SSO_IDP_UNREACHABLE');
  }
  const ok = response.status >= 200 && response.status < 300;
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  if (ok && (!/json/i.test(response.headers.get('content-type') || '') || json === null || typeof json !== 'object')) {
    throw unavailable('SSO_IDP_RESPONSE_INVALID');
  }
  return { status: response.status, json };
}

function jwtParts(token) {
  if (typeof token !== 'string' || token.length > MAX_ID_TOKEN_CHARS ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/.test(token)) throw rejected('SSO_ID_TOKEN_MALFORMED');
  const [header, payload, signature] = token.split('.');
  const decode = segment => {
    try {
      const value = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
      if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('shape');
      return value;
    } catch { throw rejected('SSO_ID_TOKEN_MALFORMED'); }
  };
  return { header: decode(header), payload: decode(payload), signature, signingInput: `${header}.${payload}` };
}

function selectKey(keys, header) {
  if (typeof header.alg !== 'string' || !Object.hasOwn(ALGORITHMS, header.alg)) throw rejected('SSO_ID_TOKEN_ALG_UNSUPPORTED');
  if (header.crit !== undefined) throw rejected('SSO_ID_TOKEN_CRIT_UNSUPPORTED');
  const spec = ALGORITHMS[header.alg];
  if (header.kid !== undefined && typeof header.kid !== 'string') throw rejected('SSO_ID_TOKEN_MALFORMED');
  const candidates = keys.filter(key => key !== null && typeof key === 'object' && key.kty === spec.kty &&
    (spec.crv === undefined || key.crv === spec.crv) &&
    (key.use === undefined || key.use === 'sig') &&
    (key.alg === undefined || key.alg === header.alg) &&
    (key.key_ops === undefined || (Array.isArray(key.key_ops) && key.key_ops.includes('verify'))) &&
    (header.kid === undefined || key.kid === header.kid));
  if (!candidates.length) throw rejected('SSO_ID_TOKEN_KEY_NOT_FOUND');
  if (candidates.length > 1) throw rejected('SSO_ID_TOKEN_KEY_AMBIGUOUS');
  return { jwk: candidates[0], spec };
}

function importKey(jwk, spec) {
  const clean = spec.kty === 'RSA' ? { kty: 'RSA', n: jwk.n, e: jwk.e } : { kty: 'EC', crv: jwk.crv, x: jwk.x, y: jwk.y };
  let key;
  try { key = crypto.createPublicKey({ key: clean, format: 'jwk' }); } catch { throw rejected('SSO_ID_TOKEN_KEY_INVALID'); }
  if (spec.kty === 'RSA' && !(key.asymmetricKeyDetails?.modulusLength >= 2048)) throw rejected('SSO_ID_TOKEN_KEY_WEAK');
  return key;
}

const sameText = (a, b) => {
  const left = crypto.createHash('sha256').update(String(a)).digest();
  const right = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(left, right);
};

/**
 * Validates an ID token against a set of JWKs and the expectations of this sign-in. Pure apart from
 * node:crypto. Returns only { sub, email, email_verified }; every other claim is dropped.
 */
export function verifyIdToken(token, keys, { issuer, clientId, nonce, nowMs = Date.now(), skewSeconds = SKEW_SECONDS }) {
  const { header, payload, signature, signingInput } = jwtParts(token);
  const { jwk, spec } = selectKey(Array.isArray(keys) ? keys : [], header);
  const key = importKey(jwk, spec);
  const signatureBytes = Buffer.from(signature, 'base64url');
  const data = Buffer.from(signingInput, 'ascii');
  let valid = false;
  if (spec.kty === 'EC') {
    valid = signatureBytes.length === 64 && crypto.verify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, signatureBytes);
  } else {
    valid = signatureBytes.length > 0 && crypto.verify('sha256', data, key, signatureBytes);
  }
  if (!valid) throw rejected('SSO_ID_TOKEN_SIGNATURE');

  const now = nowMs / 1000;
  if (typeof payload.iss !== 'string' || payload.iss !== issuer) throw rejected('SSO_ID_TOKEN_ISSUER');
  const audiences = typeof payload.aud === 'string' ? [payload.aud] : payload.aud;
  if (!Array.isArray(audiences) || !audiences.length || audiences.some(entry => typeof entry !== 'string') ||
      !audiences.includes(clientId)) throw rejected('SSO_ID_TOKEN_AUDIENCE');
  if (payload.azp !== undefined && payload.azp !== clientId) throw rejected('SSO_ID_TOKEN_AZP');
  if (audiences.length > 1 && payload.azp !== clientId) throw rejected('SSO_ID_TOKEN_AZP');
  if (typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 255) throw rejected('SSO_ID_TOKEN_SUBJECT');
  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) throw rejected('SSO_ID_TOKEN_EXP_MISSING');
  if (now >= payload.exp + skewSeconds) throw rejected('SSO_ID_TOKEN_EXPIRED');
  if (payload.nbf !== undefined && (typeof payload.nbf !== 'number' || !Number.isFinite(payload.nbf) || now + skewSeconds < payload.nbf)) {
    throw rejected('SSO_ID_TOKEN_NOT_YET_VALID');
  }
  if (typeof payload.iat !== 'number' || !Number.isFinite(payload.iat) || payload.iat > now + skewSeconds) throw rejected('SSO_ID_TOKEN_IAT');
  if (typeof payload.nonce !== 'string' || typeof nonce !== 'string' || !sameText(payload.nonce, nonce)) throw rejected('SSO_ID_TOKEN_NONCE');
  return {
    sub: payload.sub,
    email: typeof payload.email === 'string' ? payload.email : undefined,
    email_verified: payload.email_verified === true
  };
}

function discoveryDocument(doc, config) {
  const isObject = doc !== null && typeof doc === 'object' && !Array.isArray(doc);
  if (!isObject || doc.issuer !== config.issuer) throw unavailable('SSO_DISCOVERY_ISSUER_MISMATCH');
  const endpoints = {};
  for (const name of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
    const url = checkedUrl(doc[name], config.allowLoopback);
    if (!url || url.hash) throw unavailable('SSO_DISCOVERY_INVALID');
    endpoints[name] = url.href;
  }
  const lists = ['response_types_supported', 'code_challenge_methods_supported', 'id_token_signing_alg_values_supported'];
  for (const name of lists) if (doc[name] !== undefined && !Array.isArray(doc[name])) throw unavailable('SSO_DISCOVERY_INVALID');
  if (doc.response_types_supported && !doc.response_types_supported.includes('code')) throw unavailable('SSO_DISCOVERY_UNSUPPORTED');
  if (doc.code_challenge_methods_supported && !doc.code_challenge_methods_supported.includes('S256')) throw unavailable('SSO_DISCOVERY_UNSUPPORTED');
  if (doc.id_token_signing_alg_values_supported &&
      !doc.id_token_signing_alg_values_supported.some(alg => Object.hasOwn(ALGORITHMS, alg))) throw unavailable('SSO_DISCOVERY_UNSUPPORTED');
  return endpoints;
}

/**
 * The identity-provider client: cached discovery and JWKS, the authorization URL, the code
 * exchange and ID token verification. Any trouble reaching or reading the provider is a 503 and
 * therefore a refused sign-in; nothing falls back to a weaker path. A failed discovery is
 * remembered for a few seconds so a broken provider is not hammered by every login attempt, and a
 * key id that is not in the cached JWKS triggers at most one refresh per half minute.
 */
export function createIdpClient(config, { now = Date.now, fetchImpl = globalThis.fetch, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  let discovery = null;
  let discoveryFailure = null;
  let discoveryFlight = null;
  let jwks = null;
  let jwksFlight = null;
  let jwksAttemptAt = -Infinity;
  const request = (target, options = {}) => fetchJson(target, { allowLoopback: config.allowLoopback, fetchImpl, timeoutMs, ...options });

  async function loadDiscovery() {
    const url = `${config.issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
    const { status, json } = await request(url);
    if (status !== 200) throw unavailable('SSO_DISCOVERY_FAILED');
    return discoveryDocument(json, config);
  }

  async function metadata() {
    const current = now();
    if (discovery && current - discovery.at < DISCOVERY_TTL_MS) return discovery.endpoints;
    if (discoveryFailure && current - discoveryFailure.at < FAILURE_CACHE_MS) throw discoveryFailure.error;
    discoveryFlight ??= loadDiscovery().then(endpoints => {
      discovery = { endpoints, at: now() };
      discoveryFailure = null;
      return endpoints;
    }, error => {
      discoveryFailure = { error, at: now() };
      throw error;
    }).finally(() => { discoveryFlight = null; });
    return discoveryFlight;
  }

  async function loadJwks(endpoint) {
    const { status, json } = await request(endpoint);
    if (status !== 200 || !Array.isArray(json.keys) || json.keys.length > MAX_JWKS_KEYS) throw unavailable('SSO_JWKS_INVALID');
    return json.keys.filter(key => key !== null && typeof key === 'object' && !Array.isArray(key));
  }

  async function keys({ refresh }) {
    const endpoints = await metadata();
    const current = now();
    const stale = !jwks || current - jwks.at >= JWKS_TTL_MS;
    const allowed = current - jwksAttemptAt >= JWKS_REFRESH_MIN_MS;
    if (!jwks && !jwksFlight && current - jwksAttemptAt < FAILURE_CACHE_MS) throw unavailable('SSO_JWKS_FAILED');
    if (stale || (refresh && allowed)) {
      jwksAttemptAt = current;
      jwksFlight ??= loadJwks(endpoints.jwks_uri).then(list => { jwks = { list, at: now() }; return list; })
        .finally(() => { jwksFlight = null; });
      return jwksFlight;
    }
    return jwks.list;
  }

  return {
    metadata,
    async authorizationUrl({ state, nonce, challenge }) {
      const { authorization_endpoint: endpoint } = await metadata();
      const url = new URL(endpoint);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', config.clientId);
      url.searchParams.set('redirect_uri', config.redirectUri);
      url.searchParams.set('scope', config.scopes);
      url.searchParams.set('state', state);
      url.searchParams.set('nonce', nonce);
      url.searchParams.set('code_challenge', challenge);
      url.searchParams.set('code_challenge_method', 'S256');
      return url.href;
    },
    /** Redeems the code and returns the ID token string. The access token in the answer is ignored. */
    async exchangeCode({ code, verifier }) {
      const { token_endpoint: endpoint } = await metadata();
      const form = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: config.redirectUri, code_verifier: verifier });
      const headers = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
      if (config.clientSecret) {
        const pair = `${encodeURIComponent(config.clientId)}:${encodeURIComponent(config.clientSecret)}`;
        headers.authorization = `Basic ${Buffer.from(pair, 'utf8').toString('base64')}`;
      } else {
        form.set('client_id', config.clientId);
      }
      const { status, json } = await request(endpoint, { method: 'POST', headers, body: form.toString(), maxBytes: MAX_TOKEN_RESPONSE_BYTES });
      if (status >= 400 && status < 500) throw rejected('SSO_TOKEN_REJECTED');
      if (status !== 200) throw unavailable('SSO_TOKEN_ENDPOINT_FAILED');
      if (typeof json?.id_token !== 'string') throw rejected('SSO_TOKEN_NO_ID_TOKEN');
      return json.id_token;
    },
    async verify(idToken, { nonce }) {
      const expectations = { issuer: config.issuer, clientId: config.clientId, nonce, nowMs: now() };
      try { return verifyIdToken(idToken, await keys({ refresh: false }), expectations); }
      catch (error) {
        if (error?.code !== 'SSO_ID_TOKEN_KEY_NOT_FOUND') throw error;
      }
      return verifyIdToken(idToken, await keys({ refresh: true }), expectations);
    }
  };
}
