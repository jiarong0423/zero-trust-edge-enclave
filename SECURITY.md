# Security Policy

Review date: 2026-09-07
Owner: project maintainer

## Supported Scope

This repository is a hackathon MVP for a zero-trust, edge-sealed internal data delivery workflow. It demonstrates:

- browser-side encryption before package creation;
- metadata-only AI policy recommendation through Nebius Token Factory and NVIDIA Nemotron;
- ciphertext-only backend storage;
- signed timed access credentials;
- MCP-style transport shell for create, route, receipt, credential, fallback, and audit flows;
- one-way email delivery dry-run notices that do not include plaintext, keys, IV, or salt.

## Secret Boundary

Secrets must stay outside Git.

Required local environment names:

- `NEBIUS_API_KEY`
- `TOKEN_SIGNING_SECRET`

Storage location:

- local `.env` during development;
- platform secret manager for any deployed environment.

Rotation path:

- rotate `NEBIUS_API_KEY` in the Nebius console or Token Factory key management surface;
- rotate `TOKEN_SIGNING_SECRET` by replacing the environment value and invalidating existing timed credentials.

Revoke path:

- revoke provider keys at the provider account level;
- increment package revocation version or clear active demo data for local MVP credentials.

The browser bundle must never contain provider API keys or signing secrets. The server is the only component allowed to call Nebius Token Factory.

## Production Limits

This MVP does not claim production-grade KMS, device attestation, TEE isolation, eDiscovery retention, or compliance certification. The demo passphrase exists only to make the browser-side AES-GCM flow inspectable during the hackathon.

## Public Reporting

Do not include private data, customer documents, plaintext samples, `.env` contents, provider keys, signed credentials, or runtime package stores in issues, pull requests, screenshots, or demo submissions.
