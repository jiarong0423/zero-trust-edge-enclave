import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createIdpClient, fetchJson, newPkce, parseSubjectMap, readSubjectMap, resolveSubject, ssoConfigFromEnv, verifyIdToken } from '../sso-oidc.js';
import { startMockIdp } from './mock-idp.mjs';

const ISSUER = 'https://idp.example.org';
const CLIENT = 'client-1';
const NONCE = 'nonce-value';
const nowMs = Date.now();
const nowSeconds = Math.floor(nowMs / 1000);

const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const rsaWeak = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = (key, kid, extra = {}) => ({ ...key.publicKey.export({ format: 'jwk' }), kid, ...extra });
const KEYS = [jwk(rsa, 'rsa-1'), jwk(ec, 'ec-1')];
const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');

function claims(overrides = {}) {
  return { iss: ISSUER, aud: CLIENT, sub: 'user-1', iat: nowSeconds, exp: nowSeconds + 300, nonce: NONCE,
    email: 'alice@example.org', email_verified: true, ...overrides };
}

function token({ alg = 'RS256', kid = 'rsa-1', payload = claims(), key, header = {}, signature } = {}) {
  const head = { alg, typ: 'JWT', ...(kid === null ? {} : { kid }), ...header };
  const input = `${b64(head)}.${b64(payload)}`;
  if (signature !== undefined) return `${input}.${signature}`;
  if (alg === 'RS256') return `${input}.${crypto.sign('sha256', Buffer.from(input), (key ?? rsa).privateKey).toString('base64url')}`;
  if (alg === 'ES256') {
    return `${input}.${crypto.sign('sha256', Buffer.from(input), { key: (key ?? ec).privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
  }
  throw new Error('unsupported in helper');
}

const verify = (jwt, keys = KEYS, extra = {}) => verifyIdToken(jwt, keys, { issuer: ISSUER, clientId: CLIENT, nonce: NONCE, nowMs, ...extra });
const rejects = (jwt, code, keys = KEYS, extra = {}) => assert.throws(() => verify(jwt, keys, extra),
  error => error.code === code && error.status === 401 && error.message === 'SSO sign-in rejected', code);

test('RS256 and ES256 tokens verify and only sub, email and email_verified come back', () => {
  for (const jwt of [token(), token({ alg: 'ES256', kid: 'ec-1' })]) {
    assert.deepEqual(verify(jwt), { sub: 'user-1', email: 'alice@example.org', email_verified: true });
  }
  const noKid = verify(token({ kid: null }), [KEYS[0]]);
  assert.equal(noKid.sub, 'user-1');
});

test('email_verified is true only for the boolean true', () => {
  for (const value of ['true', 1, 'yes', null, undefined, false]) {
    assert.equal(verify(token({ payload: claims({ email_verified: value }) })).email_verified, false, String(value));
  }
});

test('issuer must match exactly, including a trailing slash', () => {
  rejects(token({ payload: claims({ iss: 'https://evil.example.org' }) }), 'SSO_ID_TOKEN_ISSUER');
  rejects(token({ payload: claims({ iss: `${ISSUER}/` }) }), 'SSO_ID_TOKEN_ISSUER');
  rejects(token({ payload: claims({ iss: undefined }) }), 'SSO_ID_TOKEN_ISSUER');
  rejects(token({ payload: claims({ iss: [ISSUER] }) }), 'SSO_ID_TOKEN_ISSUER');
});

test('audience: string or array containing the client id; azp rules; anything else is refused', () => {
  rejects(token({ payload: claims({ aud: 'other-client' }) }), 'SSO_ID_TOKEN_AUDIENCE');
  rejects(token({ payload: claims({ aud: ['a', 'b'] }) }), 'SSO_ID_TOKEN_AUDIENCE');
  rejects(token({ payload: claims({ aud: [] }) }), 'SSO_ID_TOKEN_AUDIENCE');
  rejects(token({ payload: claims({ aud: [CLIENT, 5] }) }), 'SSO_ID_TOKEN_AUDIENCE');
  rejects(token({ payload: claims({ aud: undefined }) }), 'SSO_ID_TOKEN_AUDIENCE');
  assert.equal(verify(token({ payload: claims({ aud: [CLIENT] }) })).sub, 'user-1');
  rejects(token({ payload: claims({ aud: [CLIENT, 'other'] }) }), 'SSO_ID_TOKEN_AZP');
  rejects(token({ payload: claims({ aud: [CLIENT, 'other'], azp: 'other' }) }), 'SSO_ID_TOKEN_AZP');
  assert.equal(verify(token({ payload: claims({ aud: [CLIENT, 'other'], azp: CLIENT }) })).sub, 'user-1');
  rejects(token({ payload: claims({ azp: 'other' }) }), 'SSO_ID_TOKEN_AZP');
});

test('time claims: skew is small and bounded, exp is required, nbf and iat are enforced', () => {
  assert.equal(verify(token({ payload: claims({ exp: nowSeconds - 30 }) })).sub, 'user-1');
  rejects(token({ payload: claims({ exp: nowSeconds - 61 }) }), 'SSO_ID_TOKEN_EXPIRED');
  rejects(token({ payload: claims({ exp: nowSeconds }) }), 'SSO_ID_TOKEN_EXPIRED', KEYS, { nowMs: (nowSeconds + 61) * 1000 });
  rejects(token({ payload: claims({ exp: undefined }) }), 'SSO_ID_TOKEN_EXP_MISSING');
  rejects(token({ payload: claims({ exp: String(nowSeconds + 300) }) }), 'SSO_ID_TOKEN_EXP_MISSING');
  assert.equal(verify(token({ payload: claims({ nbf: nowSeconds + 30 }) })).sub, 'user-1');
  rejects(token({ payload: claims({ nbf: nowSeconds + 120 }) }), 'SSO_ID_TOKEN_NOT_YET_VALID');
  rejects(token({ payload: claims({ nbf: 'soon' }) }), 'SSO_ID_TOKEN_NOT_YET_VALID');
  rejects(token({ payload: claims({ iat: nowSeconds + 120 }) }), 'SSO_ID_TOKEN_IAT');
  rejects(token({ payload: claims({ iat: undefined }) }), 'SSO_ID_TOKEN_IAT');
});

test('nonce must match and must be present', () => {
  rejects(token({ payload: claims({ nonce: 'other' }) }), 'SSO_ID_TOKEN_NONCE');
  rejects(token({ payload: claims({ nonce: undefined }) }), 'SSO_ID_TOKEN_NONCE');
  rejects(token({ payload: claims({ nonce: 7 }) }), 'SSO_ID_TOKEN_NONCE');
  assert.throws(() => verify(token(), KEYS, { nonce: undefined }), error => error.code === 'SSO_ID_TOKEN_NONCE');
});

test('subject must be a non-empty string of sane length', () => {
  rejects(token({ payload: claims({ sub: '' }) }), 'SSO_ID_TOKEN_SUBJECT');
  rejects(token({ payload: claims({ sub: 12 }) }), 'SSO_ID_TOKEN_SUBJECT');
  rejects(token({ payload: claims({ sub: 'x'.repeat(256) }) }), 'SSO_ID_TOKEN_SUBJECT');
});

test('a bad signature is refused: other key, tampered payload, tampered signature, truncated ES256', () => {
  rejects(token({ key: other }), 'SSO_ID_TOKEN_SIGNATURE');
  const good = token();
  const [head, , signature] = good.split('.');
  rejects(`${head}.${b64(claims({ sub: 'admin' }))}.${signature}`, 'SSO_ID_TOKEN_SIGNATURE');
  rejects(`${good.slice(0, -4)}AAAA`, 'SSO_ID_TOKEN_SIGNATURE');
  rejects(token({ alg: 'ES256', kid: 'ec-1', signature: crypto.randomBytes(63).toString('base64url') }), 'SSO_ID_TOKEN_SIGNATURE');
  rejects(token({ signature: '' }), 'SSO_ID_TOKEN_SIGNATURE');
});

test('alg none, HS256 keyed with the public key, HS384, RS384, PS256, a missing alg and crit are all refused', () => {
  const pem = rsa.publicKey.export({ type: 'spki', format: 'pem' });
  const input = `${b64({ alg: 'HS256', typ: 'JWT', kid: 'rsa-1' })}.${b64(claims())}`;
  const hmac = crypto.createHmac('sha256', pem).update(input).digest('base64url');
  rejects(`${input}.${hmac}`, 'SSO_ID_TOKEN_ALG_UNSUPPORTED');
  rejects(`${b64({ alg: 'none', typ: 'JWT' })}.${b64(claims())}.`, 'SSO_ID_TOKEN_ALG_UNSUPPORTED');
  rejects(`${b64({ alg: 'None', typ: 'JWT' })}.${b64(claims())}.`, 'SSO_ID_TOKEN_ALG_UNSUPPORTED');
  for (const alg of ['HS384', 'HS512', 'RS384', 'RS512', 'PS256', 'ES384', 'EdDSA', '', 5, null]) {
    rejects(`${b64({ alg, kid: 'rsa-1' })}.${b64(claims())}.${crypto.randomBytes(64).toString('base64url')}`, 'SSO_ID_TOKEN_ALG_UNSUPPORTED');
  }
  rejects(`${b64({ kid: 'rsa-1' })}.${b64(claims())}.${crypto.randomBytes(64).toString('base64url')}`, 'SSO_ID_TOKEN_ALG_UNSUPPORTED');
  rejects(token({ header: { crit: ['exp'] } }), 'SSO_ID_TOKEN_CRIT_UNSUPPORTED');
  rejects(token({ header: { __proto__: null, alg: 'constructor' } }), 'SSO_ID_TOKEN_ALG_UNSUPPORTED');
});

test('the algorithm must fit the key type: an ES256 token pointed at an RSA key finds no key', () => {
  rejects(token({ alg: 'ES256', kid: 'rsa-1', key: ec }), 'SSO_ID_TOKEN_KEY_NOT_FOUND');
  rejects(token({ kid: 'ec-1' }), 'SSO_ID_TOKEN_KEY_NOT_FOUND');
});

test('key lookup: unknown kid, ambiguous kid, no kid with several candidates, restricted use or alg, weak and malformed keys', () => {
  rejects(token({ kid: 'nope' }), 'SSO_ID_TOKEN_KEY_NOT_FOUND');
  rejects(token(), 'SSO_ID_TOKEN_KEY_AMBIGUOUS', [jwk(rsa, 'rsa-1'), jwk(rsa, 'rsa-1')]);
  rejects(token({ kid: null }), 'SSO_ID_TOKEN_KEY_AMBIGUOUS', [jwk(rsa, 'a'), jwk(other, 'b')]);
  rejects(token(), 'SSO_ID_TOKEN_KEY_NOT_FOUND', [jwk(rsa, 'rsa-1', { use: 'enc' })]);
  rejects(token(), 'SSO_ID_TOKEN_KEY_NOT_FOUND', [jwk(rsa, 'rsa-1', { alg: 'RS512' })]);
  rejects(token(), 'SSO_ID_TOKEN_KEY_NOT_FOUND', [jwk(rsa, 'rsa-1', { key_ops: ['encrypt'] })]);
  rejects(token(), 'SSO_ID_TOKEN_KEY_NOT_FOUND', []);
  rejects(token(), 'SSO_ID_TOKEN_KEY_NOT_FOUND', 'not an array');
  rejects(token({ key: rsaWeak, kid: 'weak' }), 'SSO_ID_TOKEN_KEY_WEAK', [jwk(rsaWeak, 'weak')]);
  rejects(token(), 'SSO_ID_TOKEN_KEY_INVALID', [{ kty: 'RSA', kid: 'rsa-1', n: 5, e: 'AQAB' }]);
  assert.equal(verify(token(), [null, 5, 'x', ...KEYS]).sub, 'user-1');
});

test('a private key published by mistake is never used as one: only the public members are imported', () => {
  const leaked = { ...rsa.privateKey.export({ format: 'jwk' }), kid: 'rsa-1' };
  assert.equal(verify(token(), [leaked]).sub, 'user-1');
});

test('malformed tokens: wrong segment count, bad alphabet, non-JSON, non-object, oversized', () => {
  for (const value of [undefined, null, 5, '', 'a.b', 'a.b.c.d', 'a b.c.d', '...', `${b64('str')}.${b64({})}.x`,
    `${b64([])}.${b64({})}.x`, `${b64({ alg: 'RS256' })}.${b64('str')}.x`, `${b64({ alg: 'RS256' })}.${b64(null)}.x`,
    `${Buffer.from('{bad').toString('base64url')}.${b64({})}.x`, `${'a'.repeat(20_000)}.b.c`]) {
    rejects(value, 'SSO_ID_TOKEN_MALFORMED');
  }
});

test('PKCE: the verifier is 43 base64url characters and the challenge is its S256 digest', () => {
  const { verifier, challenge } = newPkce();
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(challenge, crypto.createHash('sha256').update(verifier).digest('base64url'));
  assert.notEqual(newPkce().verifier, verifier);
});

const baseEnv = (extra = {}) => ({ SSO_ISSUER: ISSUER, SSO_CLIENT_ID: CLIENT, SSO_REDIRECT_URI: 'https://app.example.org/api/sso/callback',
  SSO_SUBJECT_MAP: '/etc/enclave/sso-map.json', ...extra });
const configInvalid = (env, name) => assert.throws(() => ssoConfigFromEnv(env),
  error => error.status === 503 && error.code === 'SSO_CONFIG_INVALID' && error.message.includes(name) && !error.message.includes('secret-value'), name);

test('SSO is off unless SSO_ISSUER is set, whatever else is in the environment', () => {
  assert.equal(ssoConfigFromEnv({}), null);
  assert.equal(ssoConfigFromEnv({ SSO_ISSUER: '' }), null);
  assert.equal(ssoConfigFromEnv({ SSO_CLIENT_ID: 'x', SSO_CLIENT_SECRET: 'secret-value', SSO_REDIRECT_URI: 'bogus' }), null);
});

test('a complete configuration is read with its defaults, and is frozen', () => {
  const config = ssoConfigFromEnv(baseEnv());
  assert.deepEqual({ ...config }, { issuer: ISSUER, clientId: CLIENT, clientSecret: null, redirectUri: 'https://app.example.org/api/sso/callback',
    scopes: 'openid email', subjectMapPath: '/etc/enclave/sso-map.json', sessionMinutes: 30, allowLoopback: false, secureCookies: true });
  assert.throws(() => { config.sessionMinutes = 480; }, TypeError);
  const custom = ssoConfigFromEnv(baseEnv({ SSO_CLIENT_SECRET: 'secret-value', SSO_SCOPES: 'openid profile email', SSO_SESSION_MINUTES: '480' }));
  assert.equal(custom.clientSecret, 'secret-value');
  assert.equal(custom.scopes, 'openid profile email');
  assert.equal(custom.sessionMinutes, 480);
  assert.equal(ssoConfigFromEnv(baseEnv({ SSO_CLIENT_SECRET: '' })).clientSecret, null);
});

test('every misconfiguration is a 503 that names the variable and never echoes a secret', () => {
  configInvalid(baseEnv({ SSO_ISSUER: 'http://idp.example.org' }), 'SSO_ISSUER');
  configInvalid(baseEnv({ SSO_ISSUER: 'https://u:p@idp.example.org' }), 'SSO_ISSUER');
  configInvalid(baseEnv({ SSO_ISSUER: 'https://idp.example.org/?a=1' }), 'SSO_ISSUER');
  configInvalid(baseEnv({ SSO_ISSUER: ' https://idp.example.org' }), 'SSO_ISSUER');
  configInvalid(baseEnv({ SSO_ISSUER: 'not a url' }), 'SSO_ISSUER');
  configInvalid(baseEnv({ SSO_CLIENT_ID: undefined }), 'SSO_CLIENT_ID');
  configInvalid(baseEnv({ SSO_CLIENT_ID: 'has space' }), 'SSO_CLIENT_ID');
  configInvalid(baseEnv({ SSO_CLIENT_SECRET: `secret-value${'x'.repeat(600)}` }), 'SSO_CLIENT_SECRET');
  configInvalid(baseEnv({ SSO_REDIRECT_URI: undefined }), 'SSO_REDIRECT_URI');
  configInvalid(baseEnv({ SSO_REDIRECT_URI: 'http://app.example.org/api/sso/callback' }), 'SSO_REDIRECT_URI');
  configInvalid(baseEnv({ SSO_REDIRECT_URI: 'https://app.example.org/other' }), 'SSO_REDIRECT_URI');
  configInvalid(baseEnv({ SSO_REDIRECT_URI: 'https://app.example.org/api/sso/callback?x=1' }), 'SSO_REDIRECT_URI');
  configInvalid(baseEnv({ SSO_SCOPES: 'email' }), 'SSO_SCOPES');
  configInvalid(baseEnv({ SSO_SCOPES: 'openid  email' }), 'SSO_SCOPES');
  configInvalid(baseEnv({ SSO_SUBJECT_MAP: undefined }), 'SSO_SUBJECT_MAP');
  for (const minutes of ['0', '481', '-5', 'abc', '1.5', '1000']) configInvalid(baseEnv({ SSO_SESSION_MINUTES: minutes }), 'SSO_SESSION_MINUTES');
});

test('http is accepted only for loopback and only when SSO_ALLOW_LOOPBACK_IDP=true', () => {
  const loop = { SSO_ISSUER: 'http://127.0.0.1:9999', SSO_REDIRECT_URI: 'http://127.0.0.1:3344/api/sso/callback' };
  configInvalid(baseEnv(loop), 'SSO_ISSUER');
  configInvalid(baseEnv({ ...loop, SSO_ALLOW_LOOPBACK_IDP: 'yes' }), 'SSO_ISSUER');
  const config = ssoConfigFromEnv(baseEnv({ ...loop, SSO_ALLOW_LOOPBACK_IDP: 'true' }));
  assert.equal(config.allowLoopback, true);
  assert.equal(config.secureCookies, false);
  configInvalid(baseEnv({ ...loop, SSO_ISSUER: 'http://idp.example.org', SSO_ALLOW_LOOPBACK_IDP: 'true' }), 'SSO_ISSUER');
  configInvalid(baseEnv({ ...loop, SSO_REDIRECT_URI: 'http://app.example.org/api/sso/callback', SSO_ALLOW_LOOPBACK_IDP: 'true' }), 'SSO_REDIRECT_URI');
});

test('subject map: sub and e-mail entries map to existing principal ids; anything ambiguous or malformed is refused', () => {
  const map = parseSubjectMap(JSON.stringify({ version: 1, entries: [
    { sub: 'u-1', principalId: 'alice' }, { email: 'Bob@Example.org', principalId: 'bob' }] }));
  assert.deepEqual(resolveSubject(map, { sub: 'u-1' }), { principalId: 'alice' });
  assert.deepEqual(resolveSubject(map, { sub: 'x', email: 'bob@example.org', email_verified: true }), { principalId: 'bob' });
  assert.deepEqual(resolveSubject(map, { sub: 'x', email: 'bob@example.org', email_verified: false }), { reason: 'SSO_EMAIL_UNVERIFIED' });
  assert.deepEqual(resolveSubject(map, { sub: 'x', email: 'nobody@example.org', email_verified: true }), { reason: 'SSO_SUBJECT_UNMAPPED' });
  assert.deepEqual(resolveSubject(map, { sub: 'x' }), { reason: 'SSO_SUBJECT_UNMAPPED' });
  assert.deepEqual(resolveSubject(map, { sub: 'u-1', email: 'bob@example.org', email_verified: false }), { principalId: 'alice' },
    'the stable subject wins and needs no verified e-mail');
  const bad = [
    'not json', '[]', '{}', JSON.stringify({ version: 2, entries: [] }), JSON.stringify({ version: 1, entries: {} }),
    JSON.stringify({ version: 1, entries: [], extra: 1 }),
    JSON.stringify({ version: 1, entries: [{ sub: 'a', email: 'a@b.co', principalId: 'alice' }] }),
    JSON.stringify({ version: 1, entries: [{ principalId: 'alice' }] }),
    JSON.stringify({ version: 1, entries: [{ sub: 'a', principalId: 'has space' }] }),
    JSON.stringify({ version: 1, entries: [{ sub: 'a', principalId: 'alice', role: 'administrator' }] }),
    JSON.stringify({ version: 1, entries: [{ sub: 'a', principalId: 'alice' }, { sub: 'a', principalId: 'bob' }] }),
    JSON.stringify({ version: 1, entries: [{ email: 'a@b.co', principalId: 'alice' }, { email: 'A@B.co', principalId: 'bob' }] }),
    JSON.stringify({ version: 1, entries: [{ email: 'no-at-sign', principalId: 'alice' }] }),
    JSON.stringify({ version: 1, entries: [{ sub: '', principalId: 'alice' }] }),
    JSON.stringify({ version: 1, entries: [null] })
  ];
  for (const text of bad) assert.throws(() => parseSubjectMap(text), error => error.code === 'SSO_CONFIG_INVALID' && error.status === 503, text);
});

test('subject map file: read from disk, size capped, a missing file fails', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sso-map-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'map.json');
  await fs.writeFile(file, JSON.stringify({ version: 1, entries: [{ sub: 'u', principalId: 'alice' }] }));
  assert.deepEqual(resolveSubject(await readSubjectMap(file), { sub: 'u' }), { principalId: 'alice' });
  await fs.writeFile(file, ' '.repeat(300_000));
  await assert.rejects(readSubjectMap(file), error => error.code === 'SSO_CONFIG_INVALID');
  await assert.rejects(readSubjectMap(path.join(dir, 'missing.json')));
});

async function withIdp(t, options) {
  const idp = await startMockIdp(options);
  idp.redirectUri = 'http://127.0.0.1:1/api/sso/callback';
  t.after(() => idp.close());
  const config = ssoConfigFromEnv({ SSO_ISSUER: idp.issuer, SSO_CLIENT_ID: idp.clientId, SSO_REDIRECT_URI: idp.redirectUri,
    SSO_SUBJECT_MAP: 'unused', SSO_ALLOW_LOOPBACK_IDP: 'true' });
  return { idp, config };
}

test('discovery and JWKS are fetched once and cached; the authorization URL carries PKCE S256, state and nonce', async t => {
  const { idp, config } = await withIdp(t);
  const client = createIdpClient(config);
  const meta = await client.metadata();
  assert.equal(meta.authorization_endpoint, `${idp.issuer}/authorize`);
  const url = new URL(await client.authorizationUrl({ state: 's', nonce: 'n', challenge: 'c'.repeat(43) }));
  assert.deepEqual(Object.fromEntries(url.searchParams), { response_type: 'code', client_id: idp.clientId, redirect_uri: idp.redirectUri,
    scope: 'openid email', state: 's', nonce: 'n', code_challenge: 'c'.repeat(43), code_challenge_method: 'S256' });
  await client.metadata();
  assert.equal(idp.stats.discovery, 1);
  const first = await client.verify(idp.mintIdToken(NONCE), { nonce: NONCE });
  await client.verify(idp.mintIdToken(NONCE), { nonce: NONCE });
  assert.equal(first.sub, 'idp-user-1');
  assert.equal(idp.stats.jwks, 1);
});

test('discovery failure fails closed with 503 and is not retried on every attempt', async t => {
  const { idp, config } = await withIdp(t);
  idp.behavior.discovery.status = 500;
  const client = createIdpClient(config);
  for (let i = 0; i < 3; i += 1) {
    await assert.rejects(client.metadata(), error => error.status === 503 && error.code === 'SSO_DISCOVERY_FAILED' && error.message === 'SSO identity provider unavailable');
  }
  assert.equal(idp.stats.discovery, 1, 'a failed discovery is remembered briefly');
});

test('discovery is refused when the document names another issuer or an insecure or partial endpoint set', async t => {
  const { idp, config } = await withIdp(t);
  const cases = [
    [{ issuer: 'http://127.0.0.1:1' }, 'SSO_DISCOVERY_ISSUER_MISMATCH'],
    [{ issuer: `${idp.issuer}/` }, 'SSO_DISCOVERY_ISSUER_MISMATCH'],
    [{ token_endpoint: 'http://evil.example.org/token' }, 'SSO_DISCOVERY_INVALID'],
    [{ jwks_uri: 'ftp://evil.example.org/jwks' }, 'SSO_DISCOVERY_INVALID'],
    [{ authorization_endpoint: undefined }, 'SSO_DISCOVERY_INVALID'],
    [{ authorization_endpoint: 'https://u:p@idp.example.org/auth' }, 'SSO_DISCOVERY_INVALID'],
    [{ code_challenge_methods_supported: ['plain'] }, 'SSO_DISCOVERY_UNSUPPORTED'],
    [{ response_types_supported: ['token'] }, 'SSO_DISCOVERY_UNSUPPORTED'],
    [{ id_token_signing_alg_values_supported: ['HS256', 'none'] }, 'SSO_DISCOVERY_UNSUPPORTED'],
    [{ response_types_supported: 'code' }, 'SSO_DISCOVERY_INVALID']
  ];
  for (const [doc, code] of cases) {
    idp.behavior.discovery.doc = doc;
    await assert.rejects(createIdpClient(config).metadata(), error => error.status === 503 && error.code === code, code);
  }
});

test('transport guards: a redirect, an oversized body, a slow answer and a non-JSON answer are all refused', async t => {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    if (req.url === '/redirect') { res.writeHead(302, { location: '/ok' }); res.end(); }
    else if (req.url === '/ok') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"a":1}'); }
    else if (req.url === '/big') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ pad: 'x'.repeat(300_000) })); }
    else if (req.url === '/chunked') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"pad":"');
      const timer = setInterval(() => res.write('x'.repeat(100_000)), 2);
      res.on('close', () => clearInterval(timer));
    } else if (req.url === '/slow') { setTimeout(() => { res.writeHead(200); res.end('{}'); }, 2000).unref(); }
    else if (req.url === '/html') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('{"a":1}'); }
    else if (req.url === '/error') { res.writeHead(400, { 'content-type': 'text/plain' }); res.end('nope'); }
    else { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (route, options = {}) => fetchJson(base + route, { allowLoopback: true, timeoutMs: 300, ...options });
  assert.deepEqual((await get('/ok')).json, { a: 1 });
  hits.length = 0;
  await assert.rejects(get('/redirect'), error => error.code === 'SSO_IDP_UNREACHABLE' && error.status === 503);
  assert.deepEqual(hits, ['/redirect'], 'the redirect target was never requested');
  await assert.rejects(get('/big'), error => error.code === 'SSO_IDP_RESPONSE_TOO_LARGE');
  await assert.rejects(get('/chunked'), error => error.code === 'SSO_IDP_RESPONSE_TOO_LARGE');
  await assert.rejects(get('/slow'), error => error.code === 'SSO_IDP_UNREACHABLE');
  await assert.rejects(get('/html'), error => error.code === 'SSO_IDP_RESPONSE_INVALID');
  assert.deepEqual(await get('/error'), { status: 400, json: null });
  await assert.rejects(fetchJson(base + '/ok', { allowLoopback: false }), error => error.code === 'SSO_IDP_URL_REFUSED');
  await assert.rejects(fetchJson('http://evil.example.org/', { allowLoopback: true }), error => error.code === 'SSO_IDP_URL_REFUSED');
  await assert.rejects(fetchJson('file:///etc/passwd', { allowLoopback: true }), error => error.code === 'SSO_IDP_URL_REFUSED');
});

test('an unknown kid triggers one JWKS refresh, rate limited; a rotated key then verifies', async t => {
  const { idp, config } = await withIdp(t);
  const clock = { t: Date.now() };
  const client = createIdpClient(config, { now: () => clock.t });
  await client.verify(idp.mintIdToken(NONCE), { nonce: NONCE });
  assert.equal(idp.stats.jwks, 1);
  idp.behavior.signWith = 'rogue';
  idp.behavior.kid = 'rogue-1';
  await assert.rejects(client.verify(idp.mintIdToken(NONCE), { nonce: NONCE }), error => error.code === 'SSO_ID_TOKEN_KEY_NOT_FOUND');
  assert.equal(idp.stats.jwks, 1, 'inside the minimum interval the cached set is not re-fetched');
  idp.behavior.publishRogue = true;
  clock.t += 31_000;
  assert.equal((await client.verify(idp.mintIdToken(NONCE), { nonce: NONCE })).sub, 'idp-user-1');
  assert.equal(idp.stats.jwks, 2);
});

test('JWKS trouble fails closed: an unreachable set, a set without a keys array, and too many keys', async t => {
  const { idp, config } = await withIdp(t);
  const jwt = idp.mintIdToken(NONCE);
  idp.behavior.jwksStatus = 500;
  await assert.rejects(createIdpClient(config).verify(jwt, { nonce: NONCE }), error => error.status === 503);
  idp.behavior.jwksStatus = 200;
  for (const body of [{ keys: 'x' }, { nokeys: [] }, { keys: Array.from({ length: 51 }, () => ({})) }]) {
    idp.behavior.jwksBody = body;
    await assert.rejects(createIdpClient(config).verify(jwt, { nonce: NONCE }), error => error.status === 503 && error.code === 'SSO_JWKS_INVALID');
  }
});

test('code exchange: public client sends client_id and PKCE; a confidential client uses HTTP Basic and sends no secret in the body', async t => {
  const pub = await withIdp(t);
  const client = createIdpClient(pub.config);
  const { verifier, challenge } = newPkce();
  const authorize = await fetch(await client.authorizationUrl({ state: 's'.repeat(43), nonce: NONCE, challenge }), { redirect: 'manual' });
  const code = new URL(authorize.headers.get('location')).searchParams.get('code');
  const idToken = await client.exchangeCode({ code, verifier });
  assert.equal((await client.verify(idToken, { nonce: NONCE })).sub, 'idp-user-1');
  const sent = pub.idp.stats.tokenRequests[0];
  assert.equal(sent.authorization, null);
  assert.equal(sent.params.client_id, pub.idp.clientId);
  assert.equal(sent.params.code_verifier, verifier);
  assert.equal(sent.params.grant_type, 'authorization_code');

  const secret = await withIdp(t, { clientSecret: 'confidential-secret-value' });
  const confidential = createIdpClient({ ...secret.config, clientSecret: 'confidential-secret-value' });
  const pkce = newPkce();
  const answer = await fetch(await confidential.authorizationUrl({ state: 's'.repeat(43), nonce: NONCE, challenge: pkce.challenge }), { redirect: 'manual' });
  const secretCode = new URL(answer.headers.get('location')).searchParams.get('code');
  assert.equal(typeof await confidential.exchangeCode({ code: secretCode, verifier: pkce.verifier }), 'string');
  const request = secret.idp.stats.tokenRequests[0];
  assert.match(request.authorization, /^Basic /);
  assert.equal(request.params.client_secret, undefined);
  assert.equal(request.params.client_id, undefined);
});

test('code exchange: a wrong verifier, a replayed code and a provider error are refused with the right class', async t => {
  const { idp, config } = await withIdp(t);
  const client = createIdpClient(config);
  const { verifier, challenge } = newPkce();
  const redeem = async () => new URL((await fetch(await client.authorizationUrl({ state: 's'.repeat(43), nonce: NONCE, challenge }), { redirect: 'manual' }))
    .headers.get('location')).searchParams.get('code');
  const code = await redeem();
  await assert.rejects(client.exchangeCode({ code, verifier: newPkce().verifier }), error => error.code === 'SSO_TOKEN_REJECTED' && error.status === 401);
  await assert.rejects(client.exchangeCode({ code, verifier }), error => error.code === 'SSO_TOKEN_REJECTED', 'a code is single use at the provider');
  idp.behavior.tokenStatus = 503;
  await assert.rejects(client.exchangeCode({ code: await redeem(), verifier }), error => error.code === 'SSO_TOKEN_ENDPOINT_FAILED' && error.status === 503);
  idp.behavior.tokenStatus = 200;
  idp.behavior.tokenBody = { access_token: 'only-an-access-token', token_type: 'Bearer' };
  await assert.rejects(client.exchangeCode({ code: await redeem(), verifier }), error => error.code === 'SSO_TOKEN_NO_ID_TOKEN');
});
