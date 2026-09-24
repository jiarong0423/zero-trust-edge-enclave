# Public Export Manifest

Review date: 2026-09-24 (was 2026-09-18). Status: public on GitHub since 2026-09-18; this list is the allowlist every push is checked against.

The following exact paths are the release allowlist, not directory wildcards. Runtime data, credentials, environment secrets, logs, output, dependencies, Git metadata, screenshots and raw provider evidence are excluded even when untracked. New source files require explicit review and a manifest update.

Run node scripts/build-release-candidate.mjs ABSOLUTE_NEW_DIRECTORY to create a non-overwriting candidate and sibling SHA256 inventory. This copies only regular files below the source root and rejects symbolic-link paths. It does not scan, commit, publish or approve the result.

## Exact File Allowlist

```text
.gitignore
.zeaburignore
LICENSE
MCP_SERVER_ALLOWLIST.md
PACKAGE_REPUTATION_EVIDENCE.md
README.md
SECRET_SCAN_EVIDENCE.md
SECURITY.md
SECURITY_SCAN_EVIDENCE.md
SUBMISSION_GAP_CHECK.md
THREAT_MODEL.md
access-control.js
audit-boundary.js
audit-outbox.js
audit-retention.js
delivery-followup.js
demo-gate.js
directory-admin.js
docs/agent/approved-delivery-architecture.md
docs/agent/change-record-2026-09-24-25.md
docs/agent/local-workflow.md
docs/agent/official-rule-alignment.md
docs/agent/security-gate-summary.md
docs/agent/zeabur-deployment.md
docs/assets/architecture-sequence.jpg
docs/assets/architecture-sequence.png
docs/assets/architecture-sequence.svg
docs/assets/architecture-state-machine.jpg
docs/assets/architecture-state-machine.png
docs/assets/architecture-state-machine.svg
docs/assets/architecture-trust-boundary.jpg
docs/assets/architecture-trust-boundary.png
docs/assets/architecture-trust-boundary.svg
download-policy.js
env.sample
file-adviser.js
file-receipts.js
file-routing.js
file-worker.js
local-array-store.js
local-key-vault.js
nebius-budget.js
package.json
private-mapping.js
public-export-manifest.md
public/admin.html
public/admin.js
public/app.js
public/audit.html
public/audit.js
public/auth.js
public/authorization-picker.js
public/crypto-utils.js
public/decode.html
public/decode.js
public/evidence-chain.js
public/file-envelope.js
public/i18n.js
public/index.html
public/judge-login.html
public/judge-login.js
public/recipient-picker.js
public/styles.css
public/task-history.js
recipient-directory.js
registry-schema.js
registry-store.js
retention-policy.js
scripts/audit-outbox.test.mjs
scripts/audit-retention.test.mjs
scripts/browser-file-workflow.mjs
scripts/build-release-candidate.mjs
scripts/business-fixtures.mjs
scripts/business-fixtures.test.mjs
scripts/coordinator-mcp.mjs
scripts/delivery-followup-worker.test.mjs
scripts/delivery-followup.test.mjs
scripts/demo-gate.test.mjs
scripts/directory-admin.test.mjs
scripts/download-policy.test.mjs
scripts/file-adviser.test.mjs
scripts/file-envelope.test.mjs
scripts/file-receipts.test.mjs
scripts/file-routing.test.mjs
scripts/file-worker.test.mjs
scripts/generate-business-fixtures.mjs
scripts/generate-native-fixtures.py
scripts/hosted-lock.mjs
scripts/hosted-lock.test.mjs
scripts/hosted-preflight.mjs
scripts/i18n.test.mjs
scripts/live-provider-smoke.mjs
scripts/local-adviser-outlet.test.mjs
scripts/local-array-store.test.mjs
scripts/local-key-vault.test.mjs
scripts/local-tls-cert.mjs
scripts/local-workflow.test.mjs
scripts/model-boundary-smoke.mjs
scripts/model-four-groups.mjs
scripts/model-negative.test.mjs
scripts/nebius-budget.test.mjs
scripts/private-mapping.test.mjs
scripts/recipient-directory.test.mjs
scripts/registry-schema.test.mjs
scripts/render-architecture.mjs
scripts/retention-policy.test.mjs
scripts/setup-local.mjs
scripts/smoke-test.mjs
scripts/snapshot-lifecycle.test.mjs
scripts/start-hosted.mjs
scripts/task-evidence.test.mjs
scripts/task-operations.test.mjs
server.js
snapshot-lifecycle.js
task-evidence.js
task-operations.js
zbpack.json
```

## Release Conditions

Run functional tests and all three local scanners on the exact candidate. Owner acceptance of scoped false positives is separate from raw scan results. Do not export existing runtime identities or provider keys. Generate synthetic credentials during setup. Fresh Git-index/history review is required separately before any push.
