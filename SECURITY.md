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
