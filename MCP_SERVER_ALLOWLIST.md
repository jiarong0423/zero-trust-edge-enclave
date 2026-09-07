# MCP Server Allowlist

Review date: 2026-09-07
Owner: project maintainer

## Allowed MCP Surface

This project does not ship a standalone `.mcp.json` server configuration. The current MVP exposes an MCP-style local HTTP transport shell through the app server.

Allowed local tool names:

- `create_sealed_package`
- `route_package`
- `prepare_email_delivery`
- `check_endpoint_receipt`
- `issue_timed_credential`
- `read_fallback_status`
- `read_audit_log`

## Command Path Or Transport

- Transport: local HTTP API.
- Tool discovery: `GET /api/mcp/tools`.
- Tool execution: `POST /api/mcp/call`.
- Runtime command: `npm run dev` or `npm start`.

## Permission Scope

- May create ciphertext-only demo package records.
- May prepare route receipts.
- May prepare dry-run email notice text.
- May issue timed credentials.
- May read sanitized fallback and audit status.

## Explicit Deny List

- No plaintext read.
- No decryption.
- No provider key access.
- No filesystem-wide access.
- No shell command execution.
- No destructive operation.
- No real email send in the MVP.
- No wildcard network access.

## Network Behavior

- Local HTTP only for the app shell.
- Nebius Token Factory outbound request only through the backend policy recommendation route when `NEBIUS_API_KEY` is configured.
- Email adapter is dry-run only.
