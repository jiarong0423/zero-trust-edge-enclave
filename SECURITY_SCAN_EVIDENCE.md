# Security Scan Evidence

Review date: 2026-09-07
Owner: project maintainer

## Scope

Current working tree intended for public GitHub submission.

## Tool

- Node.js syntax check
- ai-security-rules scan
- ai-security-rules export-gate
- release-boundary-safety-gate

## Result

Status: pass

Results:

- `npm run check`: pass.
- private working tree `ai-security-rules scan`: critical=0, high=0, medium=26. Medium findings are package/config review signals, not secret exposure.
- private working tree `ai-security-rules export-gate`: fail because `.env` exists locally by design. This private-tree failure is expected and is not the public package decision.
- sanitized public export staging `ai-security-rules export-gate`: pass, blocking=0, P0=0, P1=0, P2=0.
- sanitized public export staging `release-boundary-safety-gate`: pass, blocking=0.
- local Git `ai-security-rules history-scan`: critical=0, high=0, medium=26 after initial commit.

Local-only report run ids:

- `ai_security_rules_zero_trust_edge_enclave_20260907_scan`
- `ai_security_rules_zero_trust_edge_enclave_20260907_export`
- `ai_security_rules_zero_trust_edge_enclave_20260907_export_staging`
- `release_boundary_zero_trust_edge_enclave_20260907_staging`
- `ai_security_rules_zero_trust_edge_enclave_20260907_history`

## Accepted Residual Risk

This is a hackathon MVP. Production claims are limited: no production KMS, TEE attestation, enterprise IAM integration, or real outbound email send is claimed by this evidence.
