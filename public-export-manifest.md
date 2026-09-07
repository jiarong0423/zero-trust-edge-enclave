# Public Export Manifest

Review date: 2026-09-07
Owner: project maintainer
Repository visibility target: private during build, public only for Devpost submission review.

## Public-Export Allowed

- `.gitignore`
- `LICENSE`
- `README.md`
- `SECURITY.md`
- `THREAT_MODEL.md`
- `MCP_SERVER_ALLOWLIST.md`
- `PACKAGE_REPUTATION_EVIDENCE.md`
- `SECRET_SCAN_EVIDENCE.md`
- `SECURITY_SCAN_EVIDENCE.md`
- `public-export-manifest.md`
- `docs/agent/security-gate-summary.md`
- `docs/agent/official-rule-alignment.md`
- `env.sample`
- `package.json`
- `server.js`
- `public/index.html`
- `public/decode.html`
- `public/audit.html`
- `public/crypto-utils.js`
- `public/app.js`
- `public/decode.js`
- `public/audit.js`
- `public/styles.css`
- `scripts/smoke-test.mjs`

## Public-Export Denied

- `.env`
- `.env.*`
- `data/*.json`
- `logs/`
- `.DS_Store`
- `node_modules/`
- local screenshots that contain private account state
- provider keys
- signed timed credential tokens
- runtime audit stores
- runtime package stores
- raw confidential payloads

## Public Submission Boundary

The public repository should show code, architecture, threat model, and dry-run evidence only. It must not contain local runtime data or real provider credentials. Real Token Factory evidence should be summarized in README or Devpost without exposing the key, request payload secrets, or confidential document content.
