// A mock OpenID Connect provider for the SSO tests. Test helper only: it binds to loopback and
// refuses any other host, holds throw-away keys generated at start, and signs whatever its
// `behavior` object says, including deliberately broken tokens. It is not a model of a real
// provider and must never be pointed at by a real deployment.
//
//   node scripts/mock-idp.mjs        starts one on a random loopback port and prints its issuer
import crypto from 'node:crypto';
import http from 'node:http';
import { pathToFileURL } from 'node:url';

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

function defaultBehavior() {
  return {
    user: { sub: 'idp-user-1', email: 'alice@example.org', email_verified: true },
    alg: 'RS256',
    signWith: 'published',
    kid: undefined,
    claims: {},
    omitClaims: [],
    nonce: undefined,
    authorizeState: undefined,
    authorizeError: null,
    sendIss: false,
    publishRogue: false,
    discovery: { status: 200, doc: {} },
    jwksStatus: 200,
    jwksBody: null,
    tokenStatus: 200,
    tokenBody: null,
    tokenDelayMs: 0
  };
}

const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');

export async function startMockIdp({ clientId = 'enclave-test-client', clientSecret = null, now = Date.now, host = '127.0.0.1' } = {}) {
  if (!LOOPBACK.has(host)) throw new Error('The mock identity provider binds to loopback only');
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const rogue = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const publicKeyPem = rsa.publicKey.export({ type: 'spki', format: 'pem' });
  const jwk = (key, kid, alg) => ({ ...key.export({ format: 'jwk' }), kid, use: 'sig', alg });
  const codes = new Map();
  const state = {
    behavior: defaultBehavior(),
    stats: { discovery: 0, jwks: 0, authorize: 0, token: 0, lastAuthorize: null, tokenRequests: [] },
    redirectUri: null
  };
  let issuer = '';

  function sign(alg, kid, payload) {
    const header = { alg, typ: 'JWT', kid };
    const signingInput = `${encode(header)}.${encode(payload)}`;
    const data = Buffer.from(signingInput);
    const key = state.behavior.signWith === 'rogue' ? rogue.privateKey : rsa.privateKey;
    if (alg === 'RS256') return `${signingInput}.${crypto.sign('sha256', data, key).toString('base64url')}`;
    if (alg === 'ES256') {
      const signature = crypto.sign('sha256', data, { key: ec.privateKey, dsaEncoding: 'ieee-p1363' });
      return `${signingInput}.${signature.toString('base64url')}`;
    }
    if (alg === 'none') return `${signingInput}.`;
    if (alg === 'HS256') return `${signingInput}.${crypto.createHmac('sha256', publicKeyPem).update(data).digest('base64url')}`;
    throw new Error(`The mock cannot sign with ${alg}`);
  }

  function mintIdToken(nonce, overrides = {}) {
    const { behavior } = state;
    const at = Math.floor(now() / 1000);
    const payload = {
      iss: issuer, sub: behavior.user.sub, aud: clientId, iat: at, exp: at + 300, nonce: behavior.nonce ?? nonce,
      email: behavior.user.email, email_verified: behavior.user.email_verified, ...behavior.claims, ...overrides
    };
    for (const name of behavior.omitClaims) delete payload[name];
    const kid = behavior.kid ?? (behavior.alg === 'ES256' ? 'ec-1' : 'rsa-1');
    return sign(behavior.alg, kid, payload);
  }

  function text(res, status, body) {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(body);
  }

  function json(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  }

  function authorize(res, url) {
    state.stats.authorize += 1;
    const query = url.searchParams;
    state.stats.lastAuthorize = Object.fromEntries(query);
    const challenge = query.get('code_challenge') || '';
    if (query.get('client_id') !== clientId || query.get('redirect_uri') !== state.redirectUri ||
        query.get('response_type') !== 'code' || query.get('code_challenge_method') !== 'S256' ||
        !/^[A-Za-z0-9_-]{43}$/.test(challenge) || !query.get('state') || !query.get('nonce') ||
        !(query.get('scope') || '').split(' ').includes('openid')) {
      text(res, 400, 'invalid authorization request');
      return;
    }
    const target = new URL(state.redirectUri);
    const { behavior } = state;
    target.searchParams.set('state', behavior.authorizeState ?? query.get('state'));
    if (behavior.sendIss) target.searchParams.set('iss', behavior.sendIss === true ? issuer : behavior.sendIss);
    if (behavior.authorizeError) {
      target.searchParams.set('error', behavior.authorizeError);
    } else {
      const code = crypto.randomBytes(24).toString('base64url');
      codes.set(code, { challenge, nonce: query.get('nonce'), used: false });
      target.searchParams.set('code', code);
    }
    res.writeHead(302, { location: target.href });
    res.end();
  }

  async function token(req, res) {
    state.stats.token += 1;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const params = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
    state.stats.tokenRequests.push({ authorization: req.headers.authorization || null, params: Object.fromEntries(params) });
    if (state.behavior.tokenDelayMs) await new Promise(resolve => setTimeout(resolve, state.behavior.tokenDelayMs));
    if (state.behavior.tokenStatus !== 200) {
      json(res, state.behavior.tokenStatus, state.behavior.tokenBody ?? { error: 'server_error' });
      return;
    }
    const denied = () => json(res, 400, { error: 'invalid_grant' });
    const entry = codes.get(params.get('code') || '');
    if (params.get('grant_type') !== 'authorization_code' || !entry) { denied(); return; }
    if (entry.used) { denied(); return; }
    entry.used = true;
    let authenticated;
    if (clientSecret) {
      const expected = `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString('base64')}`;
      authenticated = req.headers.authorization === expected;
    } else {
      authenticated = params.get('client_id') === clientId && !req.headers.authorization;
    }
    const verifier = params.get('code_verifier') || '';
    const expectedChallenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    if (!authenticated || params.get('redirect_uri') !== state.redirectUri || expectedChallenge !== entry.challenge) {
      json(res, 400, { error: 'invalid_grant' });
      return;
    }
    json(res, 200, state.behavior.tokenBody ?? {
      access_token: 'mock-access-token', token_type: 'Bearer', expires_in: 300, id_token: mintIdToken(entry.nonce)
    });
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, issuer);
      const { behavior } = state;
      if (req.method === 'GET' && url.pathname === '/.well-known/openid-configuration') {
        state.stats.discovery += 1;
        if (behavior.discovery.status !== 200) { text(res, behavior.discovery.status, 'unavailable'); return; }
        json(res, 200, {
          issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`,
          response_types_supported: ['code'], code_challenge_methods_supported: ['S256'],
          id_token_signing_alg_values_supported: ['RS256', 'ES256'], subject_types_supported: ['public'], ...behavior.discovery.doc
        });
      } else if (req.method === 'GET' && url.pathname === '/jwks') {
        state.stats.jwks += 1;
        if (behavior.jwksStatus !== 200) { text(res, behavior.jwksStatus, 'unavailable'); return; }
        json(res, 200, behavior.jwksBody ?? { keys: [jwk(rsa.publicKey, 'rsa-1', 'RS256'), jwk(ec.publicKey, 'ec-1', 'ES256'),
          ...(behavior.publishRogue ? [jwk(rogue.publicKey, 'rogue-1', 'RS256')] : [])] });
      } else if (req.method === 'GET' && url.pathname === '/authorize') {
        authorize(res, url);
      } else if (req.method === 'POST' && url.pathname === '/token') {
        await token(req, res);
      } else {
        text(res, 404, 'not found');
      }
    } catch {
      text(res, 500, 'mock failure');
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, host, resolve); });
  const port = server.address().port;
  issuer = `http://${host === '::1' ? '[::1]' : host}:${port}`;

  return {
    issuer, port, clientId, clientSecret, publicKeyPem,
    behavior: state.behavior,
    stats: state.stats,
    get redirectUri() { return state.redirectUri; },
    set redirectUri(value) { state.redirectUri = value; },
    reset() { state.behavior = defaultBehavior(); this.behavior = state.behavior; },
    mintIdToken,
    close: () => new Promise(resolve => { server.close(() => resolve()); server.closeAllConnections(); })
  };
}

/**
 * A minimal cookie-keeping client that never follows a redirect by itself, so a test can look at
 * every hop. Cookies are kept per origin, matched by path, and removed on Max-Age=0.
 */
export function createBrowser() {
  const jars = new Map();
  const seen = [];
  return {
    seen,
    async request(target, { method = 'GET', headers = {}, body } = {}) {
      const url = new URL(target);
      const jar = jars.get(url.origin) ?? new Map();
      const cookie = [...jar].filter(([, entry]) => url.pathname.startsWith(entry.path)).map(([name, entry]) => `${name}=${entry.value}`).join('; ');
      const response = await fetch(url, { method, body, redirect: 'manual', headers: { ...headers, ...(cookie ? { cookie } : {}) } });
      for (const line of response.headers.getSetCookie()) {
        const [pair, ...attributes] = line.split(';').map(part => part.trim());
        const index = pair.indexOf('=');
        const name = pair.slice(0, index);
        const value = pair.slice(index + 1);
        const path = attributes.find(part => /^path=/i.test(part))?.slice(5) ?? '/';
        seen.push({ origin: url.origin, name, value, path, attributes });
        if (attributes.some(part => /^max-age=0$/i.test(part)) || value === '') jar.delete(name);
        else jar.set(name, { value, path });
      }
      jars.set(url.origin, jar);
      return response;
    },
    get(target, init) { return this.request(target, init); },
    cookie(origin, name) { return jars.get(origin)?.get(name)?.value; },
    setCookie(origin, name, value, path = '/') {
      const jar = jars.get(origin) ?? new Map();
      jar.set(name, { value, path });
      jars.set(origin, jar);
    }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const idp = await startMockIdp();
  console.log(`mock identity provider on ${idp.issuer} (client id ${idp.clientId})`);
  process.once('SIGINT', async () => { await idp.close(); process.exit(0); });
}
