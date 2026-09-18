# Security Policy

Review date: 2026-09-08. Scope: local hackathon prototype, synthetic documents only.

## Boundaries

Humans configure grants and confirm each snapshot twice. Browser cryptography encrypts file bytes; AI does not perform encryption. Fixed backend checks enforce current identity, grant version, snapshot, recipient membership, expiry, channels and replay limits.

The model and coordinator receive allowlisted metadata only. Model proposals cannot authorize execution. Recipients authenticate separately and redeem short-lived one-use key tickets. Download reports are client assertions, not proof of reading.

## Key Custody

The backend stores ciphertext, wrapped document keys and private authorization/mapping records. Its key service shares the application host and process. A compromised backend can access cryptographic material: this is not ciphertext-only storage or independently administered KMS.

Provider credentials, signing material, bearer credentials, key-vault material and runtime stores stay outside Git. Rotate provider credentials at the provider; rotate principals through authenticated administration. Explicit revocation denies future access but cannot recall released keys or plaintext. Do not delete runtime or audit history as a substitute for revocation.

## Limits

No enterprise SSO, device attestation, TEE, ciphertext malware inspection, compliance certification, real mail or legal-signature guarantee is claimed. The current file workflow does not use a shared passphrase; legacy compatibility endpoints are separately scoped.

Single-process serialization is not a distributed transaction. Retention inventory is read-only. Capacity exhaustion requires operator handling. Production rate limiting, independently administered keys and deployment hardening require separate review.

## Reporting

Use minimal synthetic reproductions. Never include documents, real identities, credentials, raw provider responses or private logs in public reports. Current finding dispositions are in docs/agent/security-gate-summary.md. Historical passes are not current clearance; publication still requires owner review.
