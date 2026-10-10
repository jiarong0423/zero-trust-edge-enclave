# Security Policy

Review date: 2026-09-08, scope extended 2026-09-25 to the hosted demo (judge sign-in, USD 20 Token Factory cap). Scope: hackathon prototype, synthetic documents only.

## Boundaries

Humans configure grants and confirm each snapshot twice. Browser cryptography encrypts file bytes; AI does not perform encryption. Fixed backend checks enforce current identity, grant version, snapshot, recipient membership, expiry, channels and replay limits.

The model and coordinator receive allowlisted metadata only, in two separate projections: one for routing and one for delivery follow-up. Model proposals cannot authorize execution. Two further ceilings are enforced in code rather than asked for in a prompt: a delivery is reminded at most twice, and a fully collected delivery cannot be chased at all. Who a reminder reaches is resolved by fixed code from receipts no adviser sees. Recipients authenticate separately and redeem short-lived one-use key tickets. Download reports are client assertions, not proof of reading.

## Key Custody

The backend stores ciphertext, wrapped document keys and private authorization/mapping records. Its key service shares the application host and process. A compromised backend can access cryptographic material: this is not ciphertext-only storage or independently administered KMS.

Provider credentials, signing material, bearer credentials, key-vault material and runtime stores stay outside Git. Rotate provider credentials at the provider; rotate principals through authenticated administration. Explicit revocation denies future access but cannot recall released keys or plaintext. Do not delete runtime or audit history as a substitute for revocation.

## Limits

No enterprise SSO, device attestation, TEE, ciphertext malware inspection, compliance certification, real mail or legal-signature guarantee is claimed. The current file workflow does not use a shared passphrase; legacy compatibility endpoints are separately scoped.

Single-process serialization is not a distributed transaction. Retention inventory is read-only. Capacity exhaustion requires operator handling. Production rate limiting, independently administered keys and deployment hardening require separate review.

## Reporting

Use minimal synthetic reproductions. Never include documents, real identities, credentials, raw provider responses or private logs in public reports. Current finding dispositions are in docs/agent/security-gate-summary.md. Historical passes are not current clearance; every publication is owner-reviewed and preceded by a fresh candidate scan.

See also: [compliance control mapping and evidence index](docs/compliance/README.md) (a mapping of what the code does, not a certification).

## Request bodies and the API queue

Every `/api/` request runs on one serial queue. The server reads a request's body **before** the request joins
that queue (`createBodyGate` in `http-helpers.js`), so a body that never finishes cannot hold the queue. A
body that stops arriving is cut off after 15 s, and the whole read after 30 s (120 s for the large file route).
Each client may have 8 bodies being read or waiting at once and the server 24; a request that finds the slots
full waits up to 10 s for one and is then refused with 429. Measured on 2026-10-10 with a stand-in client: four
authenticated stalled connections delayed a normal request by 59.9 s before this change and by 17 ms after;
40 concurrent deliveries all completed. The limits count clients by address, so behind a proxy that does not
forward the real address all clients share one share (`TRUST_PROXY`).

## The receiving side and the judge sign-in

The shared judge sign-in (hosted demo only) guards sending, the audit trail, administration and every route that can reach the
model outlet. The receiving side stands on its own: the receiving page and the scripts it loads, `GET /api/whoami`,
`GET /api/inbox` and the `/api/file-access/<id>/*` calls are open to a visitor who has not signed in, because an employee who
was sent a file should need only their own token. Each of those calls still has to present a registered token and the
recipient must be on the approved snapshot; none of them calls the model; their bodies are capped at 16 KB.

Because these calls now meet unsigned traffic, the failed-token lockout changed: it refuses a request that **fails to
authenticate**, and a valid token is no longer refused because of an address's earlier failures. Before, a lock refused every
token from that address, so anyone sending ten bad tokens from a shared proxy address could have locked every employee out for a
minute. The cost is that during a lock a correct guess would still succeed. Tokens are 256-bit random values, so the lock limits
noise; it is not what makes guessing infeasible. Responses still distinguish an unknown token (401) from a valid token of the
wrong kind (403), as before.

Known and accepted: a registered recipient token can tell whether a task id exists (a real task not on their snapshot answers 403,
an unknown id 404). Task ids are random UUIDs. Open slots for request bodies are counted per client address, so behind a proxy that
does not forward the real address (`TRUST_PROXY`), clients share one allowance.

## Client addresses behind an edge

The failed-token lockout, the sign-in limit and the request-body slots are counted per client address. Behind the hosting
platform's proxy every visitor arrives from the proxy's address, so one visitor's failures count against everyone. When the
site sits behind an edge this deployment controls (a Cloudflare Worker, `deploy/cloudflare-edge/`), the edge adds the secret
header `X-Origin-Auth` and the visitor's address in `X-Verified-Client-IP`. The server (`edge-trust.js`, `EDGE_SECRET`, at
least 32 characters) believes that address only when the secret matches, compared in constant time; without the secret every
forwarded-address header is ignored, as before. `REQUIRE_EDGE=true` additionally refuses requests that arrive without the
secret (the platform address that goes around the edge), except `/api/health`; it needs `EDGE_SECRET` and the server will not
start without it. With `EDGE_REDIRECT_TO` (an https origin) a GET or HEAD that bypassed the edge is sent with a 307 to the same path and query on that origin, so links already handed out keep working; the target is the configured origin plus the request's own path, so it cannot be pointed elsewhere. The secret lives in the edge's and the origin's environments only, never in Git.
