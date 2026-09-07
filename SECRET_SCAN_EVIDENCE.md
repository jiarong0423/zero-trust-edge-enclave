# Secret Scan Evidence

Review date: 2026-09-07
Owner: project maintainer

## Scope

Current working tree intended for public GitHub submission.

## Tool

- ai-security-rules scan
- ai-security-rules export-gate
- release-boundary-safety-gate

## Result

Status: pass

Results:

- `npm run check`: pass
- private working tree `ai-security-rules scan`: pass for critical/high findings; governance warning remains because `.env` exists locally by design and is excluded from public export.
- sanitized public export staging `ai-security-rules export-gate`: pass, blocking=0, P0=0, P1=0, P2=0.
- sanitized public export staging `release-boundary-safety-gate`: pass, blocking=0.
- local Git `ai-security-rules history-scan`: pass for critical/high findings after initial commit.

Local-only report run ids:

- `ai_security_rules_zero_trust_edge_enclave_20260907_scan`
- `ai_security_rules_zero_trust_edge_enclave_20260907_export_staging`
- `release_boundary_zero_trust_edge_enclave_20260907_staging`
- `ai_security_rules_zero_trust_edge_enclave_20260907_history`

Secret values were not printed into this file.

## Accepted Residual Risk

Local `.env`, `.env.*`, `data/*.json`, and `logs/` are excluded from Git and public export. The current Git history starts at the reviewed initial commit.
