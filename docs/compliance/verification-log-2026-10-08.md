# Verification Log, 2026-10-08

> **Disclaimer.** This log records a documentation re-check. It is part of a control mapping and evidence
> index, not a certificate, an audit report or an attestation. The project holds no certification.

Evidence is cited by symbol or test name; if a symbol moved, `grep -rn '<symbol>' *.js` finds it.

## 1. What was done

1. Every `file:line` citation in the seven compliance documents (379 of them: `control-mapping.md` 100,
   `access-control-matrix.md` 93, `data-protection-and-retention.md` 68, `ai-governance.md` 55,
   `key-management.md` 40, `change-and-release-checklist.md` 22, `sbom.md` 1; `README.md` had none but described the convention) was replaced by a file
   name plus the function, constant, route string, error string or test title that proves the statement.
   Line numbers were abandoned because `server.js` is being split into modules (`docs/agent/server-split-plan.md`).
2. Each row touched was checked against the code or a test in the worktree. Where a statement was false,
   overstated or no longer true it was corrected in place; those corrections are in section 3.
3. All 79 test-title citations in the documents were checked to exist in the named test file (a script
   compared each quoted title with the file text). That proves the title exists, not that the test passes.
4. `node scripts/generate-sbom.mjs` and `node scripts/generate-sbom.mjs --check` were run once, locally, to
   inspect their output. Nothing else was executed; the test suite was not run. No network or model call
   was made, and no `.env` or `*.token` file was read.

## 2. State that was checked

The worktree on branch `improve/2026-10-08` at commit `fcedbe4` (`feat: compliance index, provenance, prompt
profile and first server.js split`) **plus uncommitted working-tree changes made by other modules while this check ran**:
`server.js` (being split), new `api-queue.js`, `audit.js`, `file-adviser-outlet.js`, `request-context.js`, `worker-schedule.js`, `routes/file-access.js`, and modified
`static-files.js`, `worker-pass.js`, `scripts/check-syntax.mjs`, `scripts/generate-sbom.mjs`, `scripts/generate-sbom.test.mjs`,
`scripts/legacy-hosted-advice.test.mjs`, `scripts/worker-pass.test.mjs`, `docs/agent/server-split-plan.md`, and new `scripts/api-queue.test.mjs`, `scripts/audit.test.mjs`,
`scripts/static-files.test.mjs`. The documents describe the code as it stood at the end of this check. Anything below marked
"depends on an uncommitted change" is true only while that change stays.

## 3. Statements that were wrong, overstated or stale

| Document | Row / section | What was wrong | What was changed | Evidence |
| --- | --- | --- | --- | --- |
| `README.md` | Conventions | Said `file:line` references were resolved against the tree and might drift | Now states that citations are by symbol or test name and gives the `grep -rn` fallback (also stated once at the top) | n/a (convention) |
| `README.md` | Conventions, last bullet | Said the compliance files are not yet listed in `public-export-manifest.md` | Corrected: seven files are listed there; only `verification-log-2026-10-08.md` is not | `public-export-manifest.md` lists `docs/compliance/README.md` through `sbom.md` |
| `README.md` | Headline gaps 1, 5, 7 | Gap 5 said the follow-up prompt test was added in this branch without saying it is committed; gap 7 did not say the legacy paths are off-switchable or unrestricted by the outlet host rule; gap 1 omitted the silent master-key regeneration | Amended; every gap kept | `scripts/followup-prompt-profile.test.mjs` is tracked (`git ls-files`); `server.js` `legacyHostedAdviceOff`; `local-key-vault.js` `openLocalKeyVault()` |
| `control-mapping.md` | 4 Encryption in transit | Said CSP, `nosniff`, frame denial and `no-store` are sent on every response | Narrowed: the security headers are on `sendJson()` responses and static 200 responses only; the packet, credential and key responses (`sendDeadlineJson()`), the static 302/403/404 and the demo gate's 302 do not carry them | `http-helpers.js` `sendJson()`, `securityHeaders()`; `download-policy.js` `sendDeadlineJson()` (`writeHead` with content type, `cache-control`, length only); `static-files.js` `createStaticServer()`; `server.js` request handler (302 with `location` and `cache-control` only) |
| `control-mapping.md` | 16 Browser-layer controls | Repeated the "every response" claim | Same narrowing, cross-referenced to row 4 | same as row 4 |
| `control-mapping.md` | 7 Audit logging | Said rejected requests are recorded | Narrowed to authenticated requests: `auditRejection()` returns when no principal is set, so throttled, unauthenticated, allowlist-refused and gate-refused requests are not in the audit trail | `audit.js` `createAudit()` `auditRejection()` (`if (!currentRequest()?.principal ...) return`) |
| `control-mapping.md` | 8 Change control | Said the suite has 320 tests "run by the lead on 2026-10-08, all passing"; not verifiable here | Now attributes the figure to `README.md` and states it was not re-run | `README.md` ("320 tests") ; no test run in this check |
| `control-mapping.md` | 8 and checklist | Said `npm run check` syntax-checks three files | Corrected: it runs `scripts/check-syntax.mjs` over every `.js` and `.mjs` file | `package.json` `scripts.check`; `scripts/check-syntax.mjs` `listFiles()` |
| `control-mapping.md` | 8, 12 and `ai-governance.md` 7, 8 | Said the prompt-profile test was added "in this branch (uncommitted at the time of writing)" | Now says committed on this branch; the routing-prompt GAP is kept and made precise (`scripts/followup-prompt-profile.test.mjs` "the route kind prompt does not move" asserts only type) | `git log -- scripts/followup-prompt-profile.test.mjs` shows `fcedbe4`; the test body |
| `control-mapping.md` | 10 Third-party provenance | Said the SBOM "is in `sbom.cdx.json`" and (GAP) that it is hand-maintained | Corrected: it is generated on demand by `scripts/generate-sbom.mjs`, no `sbom.cdx.json` is tracked; the model, runtime and service entries are a hand-kept template | `git ls-files` (no `sbom.cdx.json`); `scripts/generate-sbom.mjs` `buildSbom()`, `TEMPLATE`, `SERVICES` |
| `control-mapping.md` | 10 | Presented the Nebius host rule as covering the hosted model calls | Added a GAP: the rule (`ADVISER_PROVIDERS.nebius.accepts`) covers the file-workflow outlet only; the two legacy call sites post to `NEBIUS_BASE_URL` as configured with the bearer key | `server.js` `callNebiusPolicy()` and `coordinatorCall()` (`nebiusBudget.fetch(`${nebiusBaseUrl...}/chat/completions`)`) vs `file-adviser.js` `requestFileAdvice()` |
| `control-mapping.md` | 6 Key management | The missing-`master.key` GAP was stated without saying how it works or that no test covers it | Described exactly: absent file is created (`O_CREAT \| O_EXCL`, 32 random bytes) with no warning; an existing file must be a regular 32-byte file with no group/other bits; no test covers the missing-file case | `local-key-vault.js` `openLocalKeyVault()`; `scripts/local-key-vault.test.mjs` (covers reopen, changed bindings, `0644` file, symlinked directory only) |
| `control-mapping.md`, `data-protection-and-retention.md`, `ai-governance.md` | 11b; section 4 Hosted legacy row; sections 2 and 7 | Said `/api/policy/recommend` sends to the hosted model "when `LOCAL_ONLY=false` and a key is set" and described the coordinator payload loosely; omitted `LEGACY_HOSTED_ADVICE=off`; implied `COORDINATOR_PROVIDER` governs both legacy paths | Exact conditions stated: policy path needs `LOCAL_ONLY=false`, a key, `LEGACY_HOSTED_ADVICE` not `off`, cap not spent, and does **not** consult `COORDINATOR_PROVIDER`; coordinator path additionally needs `COORDINATOR_PROVIDER=nebius`. Exact `safeMetadata` fields listed. Six policy values listed; file name, roles and package hash are accepted by the route but not sent. `off` documented with the tests that cover it (policy path only; coordinator path by code reading). Row 11b status kept GAP (default configuration) | `server.js` `callNebiusPolicy()`, `coordinatorCall()`, `legacyHostedAdviceOff`; `access-control.js` `safeMetadata()`; `private-mapping.js` `mappingProjection()`; `policy-envelope.js` `normalizePolicyMetadata()`; `scripts/legacy-hosted-advice.test.mjs` three tests plus the health/warning test. Note: `README.md` ("Scope of the five-field promise") says the policy path sends when `COORDINATOR_PROVIDER=nebius`; the code does not check that variable on that path |
| `control-mapping.md`, `change-and-release-checklist.md` | 12; 4.1 Kill paths | Said the adviser is switched off with `COORDINATOR_PROVIDER=synthetic_fixture` or `LOCAL_ONLY=true` | Added that `COORDINATOR_PROVIDER=synthetic_fixture` alone does not stop `/api/policy/recommend` when `LOCAL_ONLY=false` and a key is set; `LEGACY_HOSTED_ADVICE=off` is needed for the legacy paths | `server.js` `callNebiusPolicy()` |
| `ai-governance.md` | 7 `NEBIUS_API_KEY` | Said a key alone does not enable the hosted outlet | Qualified: true for the file-workflow outlet; with `LOCAL_ONLY=false` a key does enable the legacy policy call | `server.js` `callNebiusPolicy()`; `file-adviser.js` `requestFileAdvice()` |
| `ai-governance.md` | 8 | Said both prompts are imported by `bench-adviser.mjs` and `model-boundary-smoke.mjs` | Corrected: `bench-adviser.mjs` imports `FOLLOWUP_ADVISER_BOUNDARY` (for a spend estimate) and `ADVICE_KINDS`; `model-boundary-smoke.mjs` imports `FILE_ADVISER_BOUNDARY` | the two scripts' `import` lines and `estimateCost()` |
| `ai-governance.md` | 2, 10 | Said the legacy endpoints send more "when enabled" | "by default when the hosted model is configured", with the `off` switch | as 11b |
| `data-protection-and-retention.md` | 1 Private mapping | Said group codes are "reshuffled per snapshot" | Corrected: the position within a group is a fresh permutation per snapshot; the letter is the department's rank among departments present, so it is not reshuffled | `private-mapping.js` `groupCodes()`, `shuffledPositions()` (and the comment above them) |
| `data-protection-and-retention.md` | 1 Server log lines | Said the lock line key is "the client IPv4 address or the IPv6 /64 prefix" | Added the third form, `invalid`, and the exact `v6:xxxx:xxxx:xxxx:xxxx/64` shape | `auth-throttle.js` `addressKey()` |
| `data-protection-and-retention.md` | 1 Notice outbox; 2 | Listed the keys correctly but not that `subjectCode` is a closed two-word vocabulary, that `kind` is only `LOCAL_DRY_RUN`, or what happens at 64 MiB | Added; `OUTBOX_TOO_LARGE` is logged (once a minute per cause) and retried, nothing is lost because the notices stay in `tasks.json` | `notice-outbox.js` `SUBJECT_CODES`, `KINDS`, `noticeRecord()`, `MAX_OUTBOX_BYTES`, `exportNoticesSafe()` |
| `data-protection-and-retention.md` | 2 Retention | Summarised the cleanup-candidate rule as "completed delivery, access closed, nothing pending" | Listed the actual conditions | `retention-policy.js` `fileRetention()` (`KEEP_*` reasons) |
| `data-protection-and-retention.md` | 4 Default mode row | Said "none / Nothing" without noting the legacy policy path is not governed by `COORDINATOR_PROVIDER` | Qualified: nothing while `LOCAL_ONLY` is on (its default); with `LOCAL_ONLY=false` and a key the legacy policy call can still happen | `server.js` `callNebiusPolicy()` |
| `access-control-matrix.md` | 4 Notes (static files) | Said the handler uses a bare prefix test and recommended adding a test and a path-separator comparison | **Depends on an uncommitted change:** the working tree now compares against the directory plus `path.sep` and has a test; text rewritten to match and to record that the earlier version was a bare prefix | `static-files.js` `createStaticServer()`; `scripts/static-files.test.mjs` test "a sibling directory that merely starts with the public directory name is never served" |
| `access-control-matrix.md`, `data-protection-and-retention.md`, `change-and-release-checklist.md` | `/api/health` field lists; step 13 | Field list lacked `legacyHostedAdviceOff` | **Depends on an uncommitted change in `server.js`:** added | `server.js` route `GET /api/health` |
| `access-control-matrix.md` | 1, step 3 | Cited the API queue as a line in `server.js` | Now cites `api-queue.js` `createApiQueue()` | `api-queue.js` |
| `key-management.md` | 4 | Called the protected account the "bootstrap administrator" | The check protects every administrator-kind principal; the API can create none | `directory-admin.js` `changeDirectory()` (`kind === 'administrator'`, `PERSON_KIND_REJECTED`) |
| `change-and-release-checklist.md` | 1 Syntax check | Said `node --check` on `server.js`, `access-control.js`, `scripts/smoke-test.mjs` only | Corrected (see row 8 above) | `scripts/check-syntax.mjs` |
| `change-and-release-checklist.md` | 1 Full suite | Said 307 tests "per README" | `README.md` says 320 | `README.md` |
| `change-and-release-checklist.md` | 1 Hosted preflight, Audit chain verifier, Release candidate builder | Preflight header list unspecific; verifier output unspecific; builder rejection list incomplete | Listed the four headers actually checked, the `OK <n> records, head <12 hex>` output, and the full rejection set | `scripts/hosted-preflight.mjs` ("security headers" record); `scripts/verify-audit-chain.mjs` `main()`; `scripts/build-release-candidate.mjs` |
| `sbom.md` | Disclaimer, Limits | Said the file is written by hand, not generated, and that no generator keeps it in step | Rewritten: generated from `package.json` and git by `scripts/generate-sbom.mjs` (`--check` for dependencies), with a hand-kept template for models, runtimes, tooling and services | `scripts/generate-sbom.mjs`; `scripts/generate-sbom.test.mjs` |
| `sbom.md` | Services paragraph | Said the document lists two `services`. At commit `fcedbe4` the generator emitted none (the model components' `zte:access` pointed at a missing bom-ref) | **Depends on an uncommitted change:** the working-tree generator now emits `services` and a test checks that references resolve; text describes that. If the change is dropped, the paragraph must revert to a GAP | `scripts/generate-sbom.mjs` `SERVICES`; `scripts/generate-sbom.test.mjs` test "the services the model components point at exist in the document" |
| `sbom.md` | Summary, Reproducing | `--check` described as covering dependencies only | **Depends on an uncommitted change:** it now covers `overrides`, bundled dependencies and `workspaces` too | `scripts/generate-sbom.mjs` `declaredMap()`; `scripts/generate-sbom.test.mjs` test "every package.json field that can pull in third-party code is checked, and the count is stated once" |
| `access-control-matrix.md`, `data-protection-and-retention.md`, `key-management.md`, `control-mapping.md` | File-access routes | Cited the recipient file-access routes as living in `server.js` | **Depends on an uncommitted change:** the handler for `POST /api/file-access/<id>/...` now lives in `routes/file-access.js` `handleFileAccess()`; citations updated | `routes/file-access.js`; `server.js` imports `createFileAccessRoutes` |

## 4. Statements checked and left as they were

Throttle semantics (10 / 60 s / 60 s defaults; only a well-formed 43-character token matching no registered
identity counts; IPv6 keyed by /64; the lock is checked before authentication); the network allowlist
(the address, not the throttle key, is matched; loopback not implicit; set-but-empty stops startup); the
follow-up floor (exact string `true`, WAIT at `WINDOW_LAST` with pickup not `PICKUP_ALL` becomes ESCALATE
`DEADLINE_NEAR`, the adviser's answer stays in the trail); the retention numbers (audit window 500 / 400,
trail 20 / 10 per kind, 50 staged tasks, 1,000 directory events, 5-minute tickets, 50 pending tickets, 64 MiB outbox, 12-hour gate cookie,
last 20 legacy delivery receipts); the notice-outbox key list; `FOLLOWUP_PROMPT=directive` (exact string, read at each call, swaps one
paragraph); the adviser timeouts and token ceilings; the browser-storage claim (no `localStorage`, `sessionStorage`,
IndexedDB or service worker in `public/`); the zero-dependency claim and the bare-import search (both re-run);
the commit hook text (`/Users/sunjiarong/Developer/tools/pre_commit_security_gate.sh` prints the quoted lines).

## 5. Not verified

- Whether any test passes, and the figures 117 and 320 (taken from `README.md`); the suite was not run.
- The behaviour of the coordinator `recommend` path under `LEGACY_HOSTED_ADVICE=off` at runtime: established by
  reading `coordinatorCall()` only; the tests cover the policy path.
- What happens at runtime when `master.key` is missing and a key release is attempted (HTTP status): the code
  path was read, not run. The tests do not cover it.
- Statements that depend on documents outside `docs/compliance/` were checked only for the existence of the
  cited section headings (`SECURITY.md` Key Custody, Limits, Reporting; `THREAT_MODEL.md` rows;
  `docs/agent/private-network-deployment.md` Credential Lifetimes and steps 1 and 5; `docs/agent/zeabur-deployment.md` Volume and
  Security Posture): their content was not audited.
- The adviser comparison figures in `ai-governance.md` section 9 were compared with
  `docs/agent/followup-adviser-comparison-2026-10-08.md` (accepted counts, WAIT counts, latencies); the underlying
  result files are git-ignored and were not available.
- Nebius's retention and training terms, the Zeabur platform's TLS and base image, and the maintainer's reporting channel are not in the repository.
- Anything in `server.js` or the new modules that changed after this check ended.
