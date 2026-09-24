# Agent Security Gate Summary

Review date: 2026-09-08. Status: LOCAL VALIDATION ONLY; PUBLICATION NOT APPROVED.

## Real Issues Fixed

- Historical export collection omitted public/i18n.js and scripts/i18n.test.mjs because its filename pattern excluded digits. The first revised candidate failed with a missing module. Both are now explicit allowlist entries.
- The export manifest now includes all current source/test dependencies instead of a legacy partial list. build-release-candidate.mjs copies exact paths, rejects symlinks and existing targets, and emits a separate hash inventory.
- README, security/threat documents and rule alignment now describe actual file bytes, twice-approved snapshots, local bearer authentication, wrapped-key custody and dry-run delivery. Claims about a shared passphrase, missing double confirmation or unverified real model calls were stale.
- env.sample now exposes safe LOCAL_ONLY=true and synthetic_fixture defaults. Provider activation remains explicit.
- Clean-checkout instructions now generate synthetic fixture sources before optional DOCX/PDF rendering.

Direct cause: stale export patterns and documents. Root cause: the runtime expanded after the original S8 release review without refreshing its release contract. Defense: explicit producer allowlist, separate candidate/runtime directories, non-overwriting builds, clean-candidate tests and fresh release review. No runtime records were deleted.

## Baseline Raw Findings

These counts are from the original pre-fix candidate, not a zero-warning claim about later builds.

| Tool | Original result |
| --- | --- |
| ai-security-rules | 0 CRITICAL, 4 HIGH, 62 MEDIUM; export-gate PASS with no gate blockers |
| release-boundary-safety-gate | 0 findings |
| localguard-dev-safety-gate | 2 CRITICAL, 10 HIGH, 43 MEDIUM; process exit zero does not clear findings |

Fresh run reports and exact candidate hashes are retained privately. Changes to reviewed source require re-review.

## Scoped High-Severity Adjudication

The following are reviewer-assessed false positives at the inspected matches, NOT automatic owner-approved exceptions.

| Rule / files | Inspected cause | Evidence |
| --- | --- | --- |
| AI secret_exposure; LG-SECRET-001: scripts/file-adviser.test.mjs | Two literal synthetic canaries | Injected fetch and diagnostic privacy assertions; no real provider authentication |
| AI secret_exposure; LG-SECRET-001: scripts/model-negative.test.mjs | Two synthetic credential literals | Invalid inputs assert zero dispatch; control uses fake Response |
| LG-SECRET-002: scripts/model-boundary-smoke.mjs; scripts/model-four-groups.mjs | High-entropy fixture aliases | Fixed synthetic task UUIDs, not credentials |
| LG-PRIVACY-001: directory-admin.js | email property projection | requireAdministrator before directory response; HTTP role-denial tests |
| LG-PRIVACY-001: recipient-directory.js | email property projection | Operator identity and owned active grant intersect the directory |
| LG-PRIVACY-001: public/admin.js | Empty email normalization | Schema field handling, not embedded personal data |
| LG-PRIVACY-001: server.js | Localized route dictionary | Static route strings, not private records |
| LG-PRIVACY-001: public/i18n.js; scripts/i18n.test.mjs | Translation key and synthetic location pathname | UI language strings and mocked locale, not personal records; restored files expose these additional heuristic hits |
| LG-AUTH-001: public/admin.js | Credential-download visibility reset | Object URL cleared; backend administer privilege checked independently |
| LG-AUTH-001: public/app.js | Review/confirmation control reset | Immutable snapshot and grant verification on backend |
| LG-AUTH-001: public/auth.js | Hidden native file picker | Input remains page-memory; server authenticates bearer requests |
| LG-AUTH-001: public/styles.css | Hidden-field presentation rule | CSS is not the authorization mechanism |

No tests, canaries or scanner rules were removed to reduce counts. Genuine protected-directory data is intentionally available to authorized humans, never the adviser.

## Medium Findings And Residual Risk

- API-route and cache heuristics: public route names do not confer access. Protected APIs authenticate; private projections check ownership/roles. JSON and static responses set no-store. No localStorage, sessionStorage, service worker or Cache API is used by current frontend source. This does not erase files deliberately downloaded by a recipient.
- Temporary-file heuristics in audit-retention.js, local-array-store.js and registry-store.js: exclusive private files, sync, rename/link and cleanup are implemented; corruption and symlink tests are separate evidence. This remains single-process persistence, not a power-loss or multi-host guarantee.
- Business/IP/privacy terms in fixture tests are synthetic scenario labels. Real files and private runtime evidence are excluded from the release manifest.
- AI scanner credential/agent/command/network/process heuristics include documentation, fixed local test subprocesses and explicit provider adapters. These require scope review, not blanket suppression. Live-provider scripts are opt-in; npm test does not invoke them.
- Production rate limiting, enterprise identity, independent KMS, archive capacity and host compromise remain real limitations. They are not renamed as false positives.

## Functional Evidence

The corrected clean candidate passed npm run check and all npm tests (49 at the time of that candidate; 114 on 2026-09-25, thirty consecutive runs, after the loopback outlet, the 2026-09-18 regression locks, the delivery follow-up contract, the judge sign-in, the spending cap, the hosted lock fix, the refused-advice classification, the evidence chain, the local reasoning switch and the 2026-09-25 review fixes) using fresh temporary stores, with no provider calls or mail. The earlier missing-module failure is preserved in private history. Separate Chromium acceptance passed CSV, procurement DOCX and audit PDF flows: sender/recipient credential import, department/subset selection, private mapping, double confirmation, unauthorized recipient denial, exact-byte download and acknowledgement. Administrator mutation/rotation and desktop/mobile checks also passed. Synthetic fixtures were regenerated from shipped source; external browser requests were blocked.

## Publication Boundary

Fresh scanner counts remain separate from these dispositions. The repository has been public since 2026-09-18, and a hosted instance with a judge sign-in has run since 2026-09-24; free judge access no longer depends on organizer clarification. Every push still requires a fresh candidate scan and Git-index review. Historical S8 passes are not current clearance.

The corrected candidate scan (86 files at that time; the manifest is now 116, and the 2026-09-24 counts are in `SUBMISSION_GAP_CHECK.md`) reports AI scanner 0 CRITICAL / 4 HIGH / 63 MEDIUM (export-gate PASS), release-boundary 0 findings, and LocalGuard 2 CRITICAL / 12 HIGH / 40 MEDIUM. The two additional LocalGuard HIGH hits come from the restored language files above. Raw findings are not suppressed; owner exception approval remains pending.
