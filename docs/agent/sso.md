# Optional OIDC single sign-on

Status 2026-10-08. New modules, **off by default**, wired into `server.js` on the integration branch (`createSsoRoutes` is built at start-up and answers `/api/sso/*` only when `SSO_ISSUER` is set). With `SSO_ISSUER` unset the request path is the one it was before. Tested only against a mock provider on loopback; no real identity provider was contacted.

SSO adds a second way to obtain a bearer token. It does not add a second way to be authorised: a signed-in person is mapped to an **existing** registry principal, and from there every check in `access-control-matrix.md` applies unchanged. SSO never creates a principal, never sets a role, and never touches the registry file.

## Files

| File | Role |
| --- | --- |
| `sso-oidc.js` | Protocol: env parsing, subject map, discovery and JWKS client, code exchange, ID token validation. `node:crypto` and built-in `fetch` only. |
| `sso-session.js` | Bounded in-memory tables: single-use pending sign-ins and hand-offs, and the session store (SHA-256 digests only). |
| `sso-routes.js` | `createSsoRoutes(options)` returns the route handler `(req, res, url) => Promise<boolean>`, with `resolveSession` and `knowsSession` attached. |
| `access-control.js` | One added pure function, `authenticateWithSession(config, header, resolveSession)`. `authenticate()` and every other existing export are untouched (the diff is 21 added lines and nothing removed). |
| `scripts/mock-idp.mjs` | Test helper: a loopback-only mock provider that can sign deliberately broken tokens, plus a cookie-keeping test browser. Not for production. |
| `scripts/sso-*.test.mjs` | The tests (see "Tests"). |

## Flow

```
browser                       enclave (this server)                      identity provider
  | GET /api/sso/login ---------> state, nonce, PKCE verifier, flow id          |
  |                               pending sign-in stored (digest of state)      |
  | <-- 302 + flow cookie ------- (HttpOnly, SameSite=Lax, Path=/api/sso)       |
  | -------------------------------- GET authorization_endpoint (S256) -------> |
  | <------------------------------- 302 redirect_uri?code&state ------------- |
  | GET /api/sso/callback ------> take(state) once; flow cookie must match      |
  |                               POST token_endpoint (code, verifier) -------> |
  |                               <------------------------------- id_token --- |
  |                               validate token, map sub/e-mail -> principal   |
  | <-- 302 / + hand-off cookie -- (HttpOnly, SameSite=Strict, 60 s, one use)   |
  | POST /api/sso/session -------> header x-sso-exchange: 1 + hand-off cookie   |
  | <-- {token, expiresAt, kind} - session token in the body, once              |
  | Authorization: Bearer <token> on every API call (same as a registry token)  |
```

The session token is returned in a response body, never in a URL, so it does not reach history, referrers or access logs. The page that lands on `/` must call `POST /api/sso/session` once and keep the token where it keeps a pasted token today.

## Configuration

All optional. SSO is off unless `SSO_ISSUER` is set.

| Variable | Meaning |
| --- | --- |
| `SSO_ISSUER` | Issuer URL, matched **exactly** (a trailing slash matters). https only. |
| `SSO_CLIENT_ID` | Required when `SSO_ISSUER` is set. |
| `SSO_CLIENT_SECRET` | Optional. Absent: public client, PKCE only. Present: HTTP Basic at the token endpoint; PKCE is still sent. |
| `SSO_REDIRECT_URI` | Required. Must be exactly `https://<your host>/api/sso/callback` (no query). Register the same value at the provider. |
| `SSO_SCOPES` | Default `openid email`. Must contain `openid`. |
| `SSO_SUBJECT_MAP` | Required. Path to the local subject map file (below). |
| `SSO_SESSION_MINUTES` | Default 30, 1 to 480. Absolute lifetime; no sliding renewal. |
| `SSO_ALLOW_LOOPBACK_IDP` | Exactly `true` allows `http` for `127.0.0.1`, `localhost` and `[::1]` (issuer, endpoints, redirect URI). For tests; logs a WARN at startup. |

Misconfiguration with `SSO_ISSUER` set fails closed: `ssoConfigFromEnv()` throws a 503 error naming the variable (never its value), the same style as `createNetworkPolicy()`. `createSsoRoutes()` catches it, logs `ERROR SSO_CONFIG_INVALID <message>`, and returns a handler that answers every `/api/sso/*` request with 503 `SSO is not available`. Registry tokens keep working. If the deployment would rather refuse to start, call `ssoConfigFromEnv(process.env)` directly at startup; it throws.

### Subject map

A local JSON file, readable by the server user only, kept outside the repository (a tracked `.json` is rejected by the pre-commit gate and would not belong in git anyway).

```json
{
  "version": 1,
  "entries": [
    { "sub": "00u1abcd", "principalId": "alice" },
    { "email": "bob@example.org", "principalId": "bob" }
  ]
}
```

- Each entry has exactly one of `sub` or `email`, and a `principalId` that must already exist in the registry. Unknown fields, a second entry for the same `sub` or e-mail, a bad id and the reserved names `__proto__`, `constructor` and `prototype` make the whole file invalid (503), not "last one wins". A repeated JSON key *inside one entry* (two `principalId` keys, say) is not detected: `JSON.parse` keeps the last. E-mail addresses are compared after folding only A to Z, and a map e-mail must be printable ASCII, so a look-alike such as the Kelvin sign (U+212A) never matches.
- `sub` is the stable key and wins when both match. An `email` entry matches only when the provider sent `email_verified` as the boolean `true`; the string `"true"` does not count.
- The file is validated at startup and re-read on every sign-in, so an edit applies to the next sign-in and a file that disappears refuses sign-ins (503) instead of allowing or denying everyone.
- Mapping an administrator is the operator's decision. The map is the trust anchor: anyone who can edit it can choose who signs in as whom. Protect it like the registry.

## What is validated

| Check | Where | Failure code (log) |
| --- | --- | --- |
| Discovery over https (loopback http only when allowed), no redirects, 5 s timeout, 256 KiB cap, JSON content type | `fetchJson()` | `SSO_IDP_URL_REFUSED`, `SSO_IDP_UNREACHABLE`, `SSO_IDP_RESPONSE_TOO_LARGE`, `SSO_IDP_RESPONSE_INVALID` |
| Discovery `issuer` equals `SSO_ISSUER`; three endpoints are https URLs without credentials; `code` and `S256` supported when advertised | `createIdpClient()` | `SSO_DISCOVERY_FAILED`, `SSO_DISCOVERY_ISSUER_MISMATCH`, `SSO_DISCOVERY_INVALID`, `SSO_DISCOVERY_UNSUPPORTED` |
| JWKS shape, at most 50 keys; refetch on unknown `kid` at most every 30 s; cached 10 min | `createIdpClient()` | `SSO_JWKS_INVALID`, `SSO_JWKS_FAILED` |
| Token is three base64url segments, at most 16 KiB, JSON object header and payload | `verifyIdToken()` | `SSO_ID_TOKEN_MALFORMED` |
| `alg` is RS256 or ES256 only (`none`, `HS*`, `RS384`, `PS*` and anything else refused); `crit` refused; `jku`, `x5u` and embedded `jwk` are never followed | `selectKey()` | `SSO_ID_TOKEN_ALG_UNSUPPORTED`, `SSO_ID_TOKEN_CRIT_UNSUPPORTED` |
| Key chosen by `kid` and by algorithm and type (RSA, EC P-256), `use` and `key_ops` respected, RSA at least 2048 bits, only public members imported | `selectKey()`, `importKey()` | `SSO_ID_TOKEN_KEY_NOT_FOUND`, `_KEY_AMBIGUOUS`, `_KEY_INVALID`, `_KEY_WEAK` |
| Signature (ES256 as raw r\|s, 64 bytes) | `verifyIdToken()` | `SSO_ID_TOKEN_SIGNATURE` |
| `iss` exact; `aud` string or array containing the client id; `azp` equals the client id when present, and is required when `aud` has several entries | `verifyIdToken()` | `SSO_ID_TOKEN_ISSUER`, `_AUDIENCE`, `_AZP` |
| `exp` required, `nbf` and `iat` checked, 60 s skew | `verifyIdToken()` | `SSO_ID_TOKEN_EXPIRED`, `_EXP_MISSING`, `_NOT_YET_VALID`, `_IAT` |
| `nonce` equals the one stored for this sign-in (constant time) | `verifyIdToken()` | `SSO_ID_TOKEN_NONCE` |
| `state` single use, 10 minutes, bound to the browser by the flow cookie (constant time digest compare); optional `iss` parameter (RFC 9207) must match | `callback()` | `SSO_STATE_INVALID`, `SSO_STATE_COOKIE_MISMATCH`, `SSO_ISS_PARAMETER_MISMATCH` |
| PKCE S256: 32 random bytes, 43 characters; the verifier is sent only to the token endpoint | `newPkce()`, `exchangeCode()` | `SSO_TOKEN_REJECTED` |
| Principal exists and its person and department are enabled, at callback, at hand-off, and on every later request | `registeredPrincipal()`, `authenticateWithSession()` | `SSO_PRINCIPAL_UNAVAILABLE` |

The access token the provider returns is ignored and dropped. No userinfo call is made. Only `sub`, `email` and `email_verified` leave `verifyIdToken()`.

## Failure counting

Reuses `auth-throttle.js` (`check` before work, `fail` after a real guess), with the same client key as token sign-ins, so the lock is shared.

| Counts as a failure | Does not count |
| --- | --- |
| Unknown, expired or replayed `state`, or a `state` not from this browser, **when the request carries the flow cookie** (a callback with no flow cookie is refused but not counted: any page can make a visitor's browser send one); `iss` parameter mismatch; code refused by the provider (4xx); ID token refused (any `SSO_ID_TOKEN_*`); unknown hand-off cookie | Bare or malformed callback visit; the person cancelling at the provider; provider outage, timeout or 5xx; identity valid but not mapped, unverified e-mail, or principal disabled; missing hand-off cookie |

A locked client gets 429 with `Retry-After` from `login`, `callback` and `session`.

## Tables and bounds

| Table | Bound | At the bound |
| --- | --- | --- |
| Pending sign-ins | 1000 total, 10 per client key, 10 minute life | Oldest of that client goes, then oldest overall |
| Hand-offs | 1000 total, 10 per client key, 60 second life | Same |
| Sessions | 1000 total, 5 per principal, `SSO_SESSION_MINUTES` life | Oldest session of that principal is replaced; a full table of live sessions answers 503 `SSO session capacity reached` rather than signing someone else out |

Nothing is persisted and no timer runs: a restart signs everyone out, which is the safe direction. A deployment with more than one process cannot use SSO as written, because the pending sign-in lives in the process that issued it.

## Log lines

Codes only, one per line, no values: `INFO SSO_ENABLED`, `WARN SSO_LOOPBACK_IDP_ENABLED`, `INFO SSO_LOGIN_STARTED`, `INFO SSO_LOGIN_VERIFIED`, `INFO SSO_SESSION_ISSUED`, `INFO SSO_SESSION_REVOKED`, and `ERROR <code>` for every refusal (codes above, plus `SSO_CONFIG_INVALID`, `SSO_CALLBACK_MALFORMED`, `SSO_PROVIDER_DECLINED`, `SSO_SUBJECT_UNMAPPED`, `SSO_EMAIL_UNVERIFIED`, `SSO_SUBJECT_MAP_UNAVAILABLE`, `SSO_EXCHANGE_HEADER_MISSING`, `SSO_HANDOFF_MISSING`, `SSO_HANDOFF_INVALID`, `SSO_SESSION_CAPACITY`, `SSO_TOKEN_ENDPOINT_FAILED`, `SSO_TOKEN_NO_ID_TOKEN`, `SSO_INTERNAL`). No principal id, subject, e-mail, token, state, nonce, verifier or secret is ever logged; to find who signed in, correlate with the provider's own log. Client-facing messages are generic (`SSO sign-in rejected`, `SSO identity is not registered`, `SSO identity provider unavailable`).

## Wiring for the lead

`server.js` is not edited by this change. Apply these four edits.

**1. Imports.** Extend the existing `access-control.js` import and add the routes import:

```js
import { loadAccess, authenticate, authenticateWithSession, activeGrant, authorizeRecord, safeMetadata, validateAdvice, advanceDelivery, exact, fail } from './access-control.js';
import { createSsoRoutes } from './sso-routes.js';
```

**2. Construct it next to `authThrottle` and `networkPolicy`.** `apiQueue` is defined further down; `loadConfig` is only called per request, so the forward reference is safe. Reading the registry through the queue keeps it from racing a registry write.

```js
const sso = createSsoRoutes({
  env: process.env,
  loadConfig: () => apiQueue.chain(() => loadAccess(accessPath), run => run.catch(() => {})),
  throttle: authThrottle,
  clientKey: req => clientKey(req, trustProxy)
});
```

**3. In the request handler**, after the `gateAllows` block and before `if (url.pathname.startsWith('/api/'))`. It runs outside `apiQueue` on purpose: the handler makes network calls to the provider (5 s timeout each) and must not stall every other API request.

```js
    if (url.pathname.startsWith('/api/sso/') && await sso(req, res, url)) return;
```

**4. In `routeApi`**, replace the `authenticate` call and its guess counting:

```js
  let principal;
  try { principal = authenticateWithSession(config, req.headers.authorization, sso.resolveSession); }
  catch (error) {
    // A live SSO session token is not a guess, even when its person has since been disabled.
    if (error.status === 401 && countsAsGuess(config, req.headers.authorization) &&
        !sso.knowsSession(req.headers.authorization)) authThrottle.fail(throttleKey);
    throw error;
  }
```

With SSO off, `sso.resolveSession` returns `null` and `sso.knowsSession` returns `false`, and edit 3 is a `false` return, so the request path is identical to today's (proved by the "SSO unset" tests).

**Proposed `env.sample` lines** (commented, like the other optional blocks):

```
# Optional OIDC single sign-on (authorization code + PKCE). Off unless SSO_ISSUER is set; see docs/agent/sso.md. Any mistake once SSO_ISSUER is set makes every /api/sso/* route answer 503.
# SSO_ISSUER=https://idp.example.org
# SSO_CLIENT_ID=
# Leave empty for a public client (PKCE only). Never commit a value.
# SSO_CLIENT_SECRET=
# Must be exactly https://<this host>/api/sso/callback
# SSO_REDIRECT_URI=https://enclave.example.org/api/sso/callback
# SSO_SCOPES=openid email
# Local JSON file mapping IdP sub or verified e-mail to an existing registry principal id. Keep it outside the repository.
# SSO_SUBJECT_MAP=data/sso-subjects.json
# 1 to 480
# SSO_SESSION_MINUTES=30
# Tests only: allow http for 127.0.0.1, localhost and [::1].
# SSO_ALLOW_LOOPBACK_IDP=false
```

**Also needed outside this change** (pages are not mine to edit):

- A "Sign in with SSO" control that appears when `GET /api/sso/status` returns `enabled: true` and links to `/api/sso/login`.
- On load of `/`, one `POST /api/sso/session` with header `x-sso-exchange: 1` and `credentials: 'same-origin'`; on 200 use `token` as the Bearer token, on 401 do nothing. Call `POST /api/sso/logout` with the Bearer token to sign out.
- Interplay: the network allowlist and the demo gate run first. **Do not combine SSO with the demo gate.** The gate cookie is `SameSite=Strict` and `/api/sso/*` is not an open path, so the identity provider's redirect back to `/api/sso/callback` (a cross-site navigation) arrives without the gate cookie and is answered 401 before SSO runs. The gate is a device for the hosted judge demo; SSO is for a deployment that does not use it. Behind a proxy set `TRUST_PROXY=true` so the client key is the real address, and make the proxy preserve `Host` or set `SSO_REDIRECT_URI` explicitly (it is always explicit here).
- `docs/compliance/access-control-matrix.md` (a new row 7a in section 1 and five routes in section 3) and `THREAT_MODEL.md` ("Stolen token" row: a session token has an absolute life of at most 8 hours) should mention SSO when it is wired.

## Tests

```
node --test scripts/sso-session.test.mjs scripts/sso-oidc.test.mjs scripts/sso-routes.test.mjs
```

| File | Covers |
| --- | --- |
| `sso-session.test.mjs` | Token format, digest-only keys, absolute expiry, revoke, per-principal and global bounds, single-use tables, invalid bounds |
| `sso-oidc.test.mjs` | Env parsing and every misconfiguration, subject map, claim and signature validation (RS256, ES256, alg none, HS256 keyed with the public key, other algs, crit, key selection, weak and malformed keys, all time claims, aud and azp), PKCE, discovery and JWKS (cache, failure, mismatch, insecure endpoints, redirect, oversize, timeout, rotation refresh), code exchange (public and confidential, replay, errors) |
| `sso-routes.test.mjs` | Happy path end to end including cookie attributes and no secret in logs; ES256; confidential client; 13 token failure cases; mapping failures; disabled principal before and after sign-in; session expiry; state forged, replayed, unbound, expired; hand-off rules; table bounds; discovery failure fails closed; provider outage not counted; failure counting with the real throttle and lock; methods and paths; Secure cookie; misconfiguration 503; "SSO unset" equivalence of `authenticateWithSession` with `authenticate` across headers and resolvers, an inert handler that never touches the network, and registry tokens unchanged with SSO on |

I ran nine one-line mutations of the validation code (nonce check removed, signature check removed, cookie binding removed, `azp` check removed, `email_verified` not required, algorithm allowlist off, issuer unchecked, single-use `take` not consuming, principal-enabled check removed); each made at least one test fail.

## Not covered

- Exercised once against a real provider, **Keycloak 26.0 in Docker on loopback over plain http** (`SSO_ALLOW_LOOPBACK_IDP=true`, a confidential client with `client_secret_basic`, RS256 ID tokens, realm created from an import file), 2026-10-08: sign-in with a mapped, verified user; the one-use hand-off exchange; a session token that authenticates as the mapped registry operator; logout revoking it; a mapped user whose e-mail the provider reports as unverified refused (403); an unmapped user refused (403); a wrong password never reaching the callback; a tampered state, a replayed callback and a callback from a browser without the flow cookie each refused (400). 12 of 12 checks passed. Not covered by that run: https (a real redirect URI), a public client without a secret, ES256, a `sub`-keyed map entry, and any other provider. Earlier statements below that no real provider was contacted describe the module's own test suite, which still uses only the mock.
- No other real identity provider has been contacted. Behaviour with Entra ID, Okta, Keycloak, Google or others (claim quirks such as `email_verified` sent as a string, different `iss` forms, `client_secret_post`-only token endpoints, opaque or non-RS256/ES256 signing) is untested.
- Only `client_secret_basic` or a public client is supported. No `private_key_jwt`, no mTLS, no refresh tokens, no logout at the provider (RP-initiated or back-channel), no session binding to IP or user agent.
- The browser pages are not changed, so nothing in the UI uses these routes yet.
- Sign-in and sign-out events go to the process log, not to the hash-chained audit trail.
- TLS validation of the provider relies on Node's default trust store. There is no pinning, and no check that discovery endpoints resolve to public addresses (SSRF through a hostile discovery document is limited to https URLs of the provider's choosing).
- Single process only; sessions and pending sign-ins are memory-resident.
- The 60 second clock skew and the 5 second fetch timeout are constants, not settings.
- Found in the red-team pass and left as documented limits, not fixed: (a) a person removed from the subject map, or whose registry token hash is rotated, keeps any live SSO session until it expires (30 minutes by default, 8 hours at most); only disabling the principal ends it at once (`revokePrincipal()` exists and nothing calls it); (b) `/api/sso/login` is not counted by the throttle, so one client key can evict another visitor's pending sign-in behind a shared address or a spoofable `X-Forwarded-For` (only with `TRUST_PROXY=true`); (c) the flow cookie has no `__Host-` prefix because it is scoped to `/api/sso`, so a sibling subdomain could toss a cookie; (d) at session capacity, issuing a session can first remove that principal's oldest session and then answer 503; (e) a forced callback GET from another site is still counted while the visitor has a flow cookie, that is, during the minutes of a sign-in they started; (f) the red-team run was stopped part way, so route-level cases (cookie attributes, hand-off race, cross-origin exchange POST, redirect and size limits on discovery) were covered only by the project's own tests.
