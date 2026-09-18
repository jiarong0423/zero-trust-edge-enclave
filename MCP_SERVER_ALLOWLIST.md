# MCP Server Allowlist

Review date: 2026-09-07
Owner: project maintainer

## Legacy Operator Application Surface

This project does not ship a standalone `.mcp.json` server configuration. The current MVP exposes an MCP-style local HTTP transport shell through the app server.

Allowed local tool names:

- `create_sealed_package`
- `route_package`
- `prepare_email_delivery`
- `check_endpoint_receipt`
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
- Credential issuance is disabled on this operator tool surface; use the authenticated recipient API, never MCP.
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
- Cloud inference is disabled by default (LOCAL_ONLY). Explicitly configured provider adapters may make bounded Token Factory requests only when cloud mode is enabled; a key alone does not enable file-task inference.
- Email adapter is dry-run only.

## Implemented Codex Coordinator Profile

Current dedicated tools: legacy status/recommend/deliver and file_status/file_recommend. File tools accept taskAlias and snapshotVersion only; return code-only status/advice, never documents or keys. The file worker consumes backend adviser output behind the fixed gate, not direct MCP execution commands. Provider credentials stay backend-only; synthetic responses do not count as real cloud evidence.

Status: implemented through the separate `scripts/coordinator-mcp.mjs` adapter and coordinator endpoint. The application HTTP tools require an operator token. Credential issuance is recipient-only and unavailable through MCP. See `docs/agent/local-workflow.md` for configuration and tested limits.

- Humans configure grants and confirm each file-task snapshot twice. Only subsequent bounded worker actions run unattended; AI cannot approve a snapshot.
- Expose sanitized receipt, fallback, and audit status; allow bounded route and notice requests only through a deterministic authorization gate.
- Package creation stays with the sender application. Credential issuance stays with the authenticated recipient service; do not expose credential tokens to Codex.
- Do not forward raw outputs from the existing tool surface. A dedicated adapter must project approved metadata fields and opaque handles, excluding filenames, recipient addresses, document content, and cryptographic material.
- Codex may request metadata-only Nemotron recommendations through a dedicated backend adapter; the provider credential never enters model context.
- Enforce finite retry budgets, idempotency, channel restrictions, and expiry limits before execution. Model/provider failures use a preapproved deterministic fallback or pause.
- Escalate only authorization changes and unresolved exceptions. Neither AI can approve its own escalation or extend access.
