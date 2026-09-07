# Threat Model

Review date: 2026-09-07
Owner: project maintainer

## Assets

- Confidential user-selected document content.
- Browser-generated ciphertext package material.
- Package hash and policy hash.
- Signed timed access credentials.
- Nebius Token Factory API key.
- Server-side token signing secret.
- Audit records and route receipts.

## Trust Boundary

- Browser Staging Enclave: may handle plaintext before encryption.
- Backend API: stores ciphertext package records and policy metadata, but should not receive AI-readable plaintext summaries.
- Nebius Token Factory and NVIDIA Nemotron: receive non-content policy metadata only.
- MCP Transport Shell: routes sealed package metadata and delivery receipts only.
- Recipient Decode Gate: receives ciphertext only after signed credential validation.
- Local runtime data: ignored from Git and excluded from public export.

## Data Flow

1. Sender enters or stages content in the browser.
2. Browser encrypts content locally with Web Crypto AES-GCM.
3. Browser sends only non-content policy metadata to the policy recommendation endpoint.
4. Server calls Nebius Token Factory with metadata-only prompt content.
5. Server validates the policy recommendation and creates a signed policy envelope.
6. Server stores ciphertext package material locally for the demo.
7. MCP Transport Shell creates route receipts and optional email dry-run notices.
8. Recipient requests a short-lived credential.
9. Server validates credential claims before releasing ciphertext package material to the Decode Gate.
10. Browser decrypts locally only after policy checks pass.

## Threats

- Accidental plaintext leakage to AI provider.
- Provider key exposure in browser code or Git.
- Runtime data committed to public GitHub.
- Timed credential replay after expiry or package revocation.
- Transport shell returning ciphertext or cryptographic material through read tools.
- Email notification containing protected content or cryptographic material.
- Misleading production security claims beyond the MVP implementation.

## Controls

- Metadata-only AI boundary in `/api/policy/recommend`.
- Backend-only Nebius API call.
- `.env` and `.env.*` ignored by Git.
- `data/*.json` and `logs/` excluded from public export.
- Signed credential claims bind package id, package hash, policy hash, role, device claim, expiry, max use, and revocation version.
- MCP read tools are designed to return metadata, receipts, and audit summaries only.
- Email delivery is dry-run only and blocks plaintext, ciphertext, keys, IV, salt, and raw payload wording.
- Production mode requires `TOKEN_SIGNING_SECRET`.
