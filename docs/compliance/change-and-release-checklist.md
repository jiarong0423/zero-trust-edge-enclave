# Change And Release Checklist

Written 2026-10-08 against branch `improve/2026-10-08`. Re-verified against the code on 2026-10-08 (see `verification-log-2026-10-08.md`).

> **Disclaimer.** This lists the release gates that exist in this repository and what a person must still
> judge. It is not a certified change-management process. The project holds no certification. The commands
> were read from `package.json`, `scripts/` and the commit hook; they were not executed for this document
> (apart from `node scripts/generate-sbom.mjs`, which was run once to inspect its output). Evidence is
> cited as file plus symbol or test title; if a symbol moved, `grep -rn '<symbol>' *.js` finds it.

## 1. Gates That Exist

| Gate | Where it runs | What it checks | Enforced by |
| --- | --- | --- | --- |
| Commit hook (`[security-gate]`) | On `git commit`, from `.git/hooks/pre-commit`, which calls `/Users/sunjiarong/Developer/tools/pre_commit_security_gate.sh` | Prints `[security-gate] staged secret scan` and `[security-gate] staged mutable artifact scan`, each a Python audit over staged files (`--staged-only`); prints `[security-gate] passed` on success, or `ERROR [security-gate] ... nothing was committed` plus up to 20 finding lines on failure. Reports go to `/tmp/codex_secret_gate.log` and `/tmp/codex_mutable_gate.log` | The hook script only. **GAP:** the script and the installer live outside this repository and per clone; a fresh clone has no hook, and `--no-verify` bypasses it |
| Syntax check | `npm run check` (`scripts/check-syntax.mjs`) | `node --check` on every `.js` and `.mjs` file: the tracked and new files from `git ls-files -co --exclude-standard`, or, outside a git checkout, a directory walk that skips `node_modules`, `.git`, `output`, `logs`, `security-audit-output`, `data` and `data-*`. Prints `syntax ok: <n> files` or `ERROR syntax <file>` and exits 1 | Manual |
| Workflow test | `npm test` | Runs `scripts/local-workflow.test.mjs` only (117 tests per `README.md`) | Manual |
| Full suite | `node --test "scripts/*.test.mjs"` (`npm run test:all`) | All unit and integration tests with isolated synthetic stores and no provider requests (320 tests per `README.md`; this index did not re-run it) | Manual |
| Bill of materials | `node scripts/generate-sbom.mjs` and `node scripts/generate-sbom.mjs --check` | The first prints a CycloneDX 1.5 document generated from `package.json`; the second exits 1 if `package.json` declares any dependency of any kind. Covered by `scripts/generate-sbom.test.mjs` | Manual |
| Hosted preflight | `npm run preflight:hosted` | Runs the real server on a temporary directory and reports: volume mode refusal, empty volume answers 503, setup on a private volume, server reachable on `0.0.0.0`, pages served, unauthenticated routes refused (401), four security headers on `/` (`content-security-policy`, `x-content-type-options`, `x-frame-options`, `referrer-policy`), restart after a non-graceful stop (advisory, not blocking). Never prints a token. Exit 1 if any blocking check fails | Manual |
| Audit chain verifier | `node scripts/verify-audit-chain.mjs <DATA_DIR>` | Recomputes every `eventHash`, the links and archive pages. Exit 0 `OK <n> records, head <12 hex>`, 1 broken chain, 2 usage or I/O error | Manual |
| Release candidate builder | `node scripts/build-release-candidate.mjs <absolute nonexistent directory>` | Copies exactly the files in the `public-export-manifest.md` allowlist, rejects symlinks and non-regular sources, `.env*`, `.git`, `data`, `logs`, `output`, `node_modules`, `security-audit-output`, a target inside the repository and any existing target, and writes a SHA-256 inventory | Manual |
| Candidate scans | Run on the built candidate | Scanner dispositions are recorded in `SECURITY_SCAN_EVIDENCE.md` and `docs/agent/security-gate-summary.md`. **GAP:** the exact scanner invocations are not recorded in the repository | Manual |
| Adviser benchmark | `node scripts/bench-adviser.mjs` | Fixture mode: 36 inputs, no network | Manual |
| Browser acceptance | `scripts/browser-file-workflow.mjs` | End-to-end Chromium flow on synthetic data with external requests blocked | Manual, opt-in |

**GAP:** no CI configuration exists in the repository, so none of the manual gates is enforced on a push or
a merge. **GAP:** nothing in the repository shows required review or protected branches.

## 2. Release Checklist

Run from the repository root with Node.js 20.11 or newer. Tick each item in the release notes.

1. Record the starting point: `git status --short` and `git rev-parse HEAD`. Do not release with
   unexplained modified files.
2. Confirm no secrets or runtime data are tracked: `git ls-files | grep -E '(^|/)\.env|\.token$|^data'`
   must print nothing (`.gitignore` excludes `.env*`, `data/`, `data-*/`, `logs/`, `output/`).
3. Syntax: `npm run check` (every `.js` and `.mjs` file).
4. Fast workflow test: `npm test`.
5. Full suite: `node --test "scripts/*.test.mjs"`. All tests must pass. Repeat if any test is flaky; the
   record in `SUBMISSION_GAP_CHECK.md` used thirty consecutive runs.
6. Deployment posture: `npm run preflight:hosted`. Zero blocking failures. Read any advisory line
   (a stale `server.lock` after a non-graceful stop is the known advisory).
7. If `file-adviser.js`, `file-routing.js`, `delivery-followup.js`, `followup-floor.js` or either system
   prompt changed: run `node scripts/bench-adviser.mjs` and compare with
   `docs/agent/followup-adviser-comparison-2026-10-08.md`. With a loopback runtime, also
   `node scripts/bench-adviser.mjs --local`. The hosted run, `NEBIUS_API_KEY=<set privately>
   node scripts/bench-adviser.mjs --cloud --yes-spend --out <new file>`, spends money and needs an explicit
   human decision. Never paste the key into a document or chat.
8. If the browser pages, `public/file-envelope.js` or the file routes changed, run the browser acceptance:
   ```bash
   node scripts/generate-business-fixtures.mjs
   python3 scripts/generate-native-fixtures.py        # needs python-docx and reportlab
   PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node scripts/browser-file-workflow.mjs
   ```
   `BROWSER_EXECUTABLE=<path>` is optional. The script sets `SKIP_LOCAL_ENV=true`, `LOCAL_ONLY=true`,
   `COORDINATOR_PROVIDER=synthetic_fixture`, a temporary `DATA_DIR` and `PORT=0` itself, and requires
   `PLAYWRIGHT_MODULE` or it throws.
9. If `package.json` changed, run `node scripts/generate-sbom.mjs --check` (it fails on any declared dependency),
   confirm the package still has no `dependencies`, then update the hand-kept template in `scripts/generate-sbom.mjs`, `sbom.md` and
   `PACKAGE_REPUTATION_EVIDENCE.md`. A new dependency is a supply-chain change that must be reviewed
   before install.
10. Update `public-export-manifest.md` if files were added or removed (a new document under `docs/compliance/`
    is not in the manifest until it is added there), then build a candidate with
    `node scripts/build-release-candidate.mjs /absolute/new/dir` and scan the candidate, not the working
    tree. Record the counts in `SECURITY_SCAN_EVIDENCE.md`.
11. Commit. Watch for `[security-gate] passed`. If the hook prints `ERROR [security-gate]`, nothing was
    committed: read the named report and fix the cause; do not use `--no-verify`.
12. Deploy (hosted demo): set the variables in `docs/agent/zeabur-deployment.md` (`DATA_DIR` on a mounted
    volume, `LOCAL_ONLY`, `COORDINATOR_PROVIDER`, `NODE_ENV=production` with `TOKEN_SIGNING_SECRET`,
    `REQUIRE_DEMO_GATE`, the spending cap, `TRUST_PROXY` only after confirming the proxy overwrites
    `X-Forwarded-For`). Keys and passwords are set in the platform, never in Git. RECOMMENDATION: decide
    explicitly whether `LEGACY_HOSTED_ADVICE=off` and `ALLOWED_CLIENT_CIDRS` are wanted; both are off by default.
13. Post-deploy: `GET /api/health` must show `localOnly: false`, `nebiusConfigured: true`,
    `demoFallbackEnabled: false` for a hosted-model deployment, and a `nebiusBudget` block when a cap is
    configured; `legacyHostedAdviceOff` shows whether the two legacy hosted paths are disabled. Then run `node scripts/verify-audit-chain.mjs <DATA_DIR>` on the live volume.
14. Keep the audit chain head hash from the last step somewhere the application cannot write
    (RECOMMENDATION). The verifier prints the first 12 hex characters of the head.

## 3. What A Human Must Review

Automated gates do not decide these:

- Any change to `access-control.js`, `snapshot-lifecycle.js`, the route gates in `server.js` (`routeApi()`), or
  `directory-admin.js`: re-read `access-control-matrix.md` and confirm every route still has its gate and
  that a new route is mapped to a role.
- Any change to the adviser projections, validators or outlet rules: confirm the field list in
  `ai-governance.md` is still exact and that `exact(...)` key checks are unchanged.
- Any change to the two system prompts or to the `FOLLOWUP_PROMPT` profile: no test pins the routing prompt
  (**GAP**) and the follow-up default is pinned by hash only in `scripts/followup-prompt-profile.test.mjs`,
  so review the diff by eye and rerun the benchmark.
- Any change to what is logged or stored: confirm `auditProjection` still builds records from an allowlist
  and that no identity, address, key or filename enters the audit or the adviser trail.
- Any change to key handling (`local-key-vault.js`, the intake, ticket and key routes): re-read
  `key-management.md`.
- Any change to the notice outbox (`notice-outbox.js` `noticeRecord()`): confirm the key list and the two `SUBJECT_CODES` in
  `data-protection-and-retention.md` are still exact.
- Spending: before any `--cloud --yes-spend` run or a change to `NEBIUS_BUDGET_USD` and prices.
- Scanner findings: raw counts are not suppressed; the adjudications in `SECURITY_SCAN_EVIDENCE.md` are
  reviewer opinions, and `docs/agent/security-gate-summary.md` records owner exception approval as pending.
- Documentation claims: `README.md` and the compliance documents must still describe what the code does;
  `verification-log-2026-10-08.md` shows what was last re-checked.

## 4. Incident Handling

This section states only what exists. It is not an incident response plan.

### 4.1 What exists

| Capability | How it works | Evidence |
| --- | --- | --- |
| Audit trail | Allowlisted, hash-chained events for snapshot transitions, delivery transitions, credential issue and key release (`DECODE_ATTEMPT`), rejected authenticated requests and evidence views; owners read their own events through `/api/audit`; the chain is verified with `scripts/verify-audit-chain.mjs` | `audit-boundary.js` `auditProjection()`, `server.js` route `GET /api/audit`, `scripts/verify-audit-chain.mjs` `verifyChain()` |
| Per-delivery evidence chain | The sender sees what was approved, what each adviser call was given and answered or why it was refused, how fixed code mapped the outcome back, and key releases and receipts | `task-evidence.js` `taskEvidence()`; `scripts/task-evidence.test.mjs` test "the evidence chain runs from approval through the adviser back to real recipients" |
| Revocation by the sender | `revoke` marks the snapshot revoked and the job `REVOKED`; later packet, ticket and key requests are refused with 409. Already released bytes and keys cannot be recalled | `server.js` route `POST /api/tasks/<id>/revoke`, `snapshot-lifecycle.js` `revokeSnapshot()` |
| Revocation and disabling by an administrator | `grant.update` with `revoked: true`, `person.update` with `disabled: true`, `department.update` with `disabled: true`; effective on the next request because the registry is re-read | `directory-admin.js` `changeDirectory()`, `registry-schema.js` `principalEnabled()` |
| Credential replacement | `person.rotate` replaces a role token hash; older approvals under an affected grant stop and need fresh confirmation | `directory-admin.js` `changeDirectory()` (`person.rotate`, `grant.version++`) |
| Grant expiry | Every authorisation check fails once `expiresAt` passes; the download deadline closes access mid-transfer | `access-control.js` `activeGrant()`, `download-policy.js` `sendDeadlineJson()` |
| Key release limit | At most `maxOpens` key releases per recipient and version; key tickets are single-use and last 5 minutes | `routes/file-access.js` `handleFileAccess()` (route `POST /api/file-access/<id>/credential`) (`File key release limit reached`) |
| Throttle and logs | Repeated guessing locks the client address (IPv4, or the IPv6 /64) with 429 and writes `WARN auth throttle locked client <key> for <n>s` to stderr; each adviser call writes one log line; failures write `ERROR` lines. Only an unregistered 43-character token counts as a guess | `server.js` `throttleFromEnv()` callback, `auth-throttle.js` `countsAsGuess()`, `file-adviser-outlet.js` `createFileAdviser()` |
| Fail-closed storage | A corrupt, missing or symlinked store returns 503 rather than resetting history | `local-array-store.js` `readArray()`; `scripts/local-array-store.test.mjs` test "array store refuses missing corrupt and symlink state without resetting history" |
| Spend containment | A spent hosted budget falls back to the fixture adviser | `nebius-budget.js` `createBudget()`, `file-adviser-outlet.js` `createFileAdviser()` |
| Kill paths for the adviser | Set `COORDINATOR_PROVIDER=synthetic_fixture` or `LOCAL_ONLY=true` and restart. For the two legacy paths also set `LEGACY_HOSTED_ADVICE=off`: `COORDINATOR_PROVIDER=synthetic_fixture` alone does not stop `POST /api/policy/recommend` when `LOCAL_ONLY=false` and a key is set | `file-adviser-outlet.js` `createFileAdviser()`, `server.js` `callNebiusPolicy()` and `legacyHostedAdviceOff` |
| Escalation record | `ESCALATE` and `DELIVERY_OVERDUE` produce an audit event and a task record | `file-worker.js` `advanceFollowups()`, `file-receipts.js` `recordOverdueDeliveries()` |

A suggested first-hour sequence using only these controls (RECOMMENDATION, not an implemented procedure):
(1) stop new risk: revoke the affected snapshot or disable the person or grant; (2) preserve evidence:
copy `audit.json`, `audit-archive/` and `tasks.json` read-only, run the chain verifier, note the head hash;
(3) read the sender's evidence chain for the affected task; (4) rotate affected tokens; (5) rotate the
provider key at the provider if exposed; (6) decide who must be told.

### 4.2 What is missing (GAPs)

- **GAP:** no on-call rota, no named incident owner, no severity scale, no escalation contacts.
- **GAP:** no breach-notification procedure, template or clock (regulator, customer or data-subject
  notification).
- **GAP:** `SECURITY.md` names no vulnerability reporting channel and no response time; the channel is TO
  BE SET BY THE MAINTAINER.
- **GAP:** no alerting: an escalation, an overdue delivery, a chain break or a throttle lock is noticed
  only if someone looks at the page or the log.
- **GAP:** unauthenticated and throttled requests leave no audit record (`audit.js` `auditRejection()` records only authenticated requests); they appear only in the process log, if at all.
- **GAP:** no log retention, shipping or integrity protection for stdout/stderr, which is where throttle
  locks and adviser failures appear.
- **GAP:** the audit chain head is not anchored off the host, so tail truncation is undetectable
  (`scripts/verify-audit-chain.mjs` header; the limitation tests).
- **GAP:** audit events carry no actor identity and directory events no administrator id, which limits
  attribution during an investigation.
- **GAP:** no forensic export, legal-hold or evidence-handling tool; `SECURITY.md` says not to delete
  runtime or audit history, and there is no sanctioned deletion path either.
- **GAP:** no backup and restore procedure, no tabletop exercise, no post-incident review template.
- **GAP:** no tested way to recall released keys or plaintext (`SECURITY.md`).
