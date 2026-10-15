# Submission Gap Check

Updated: 2026-09-27 Asia/Taipei

## Update 2026-10-15 (checked today; the sections below are the 2026-09-27 state and are kept as history)

- Repository: public, MIT detected by GitHub, README with Run Locally; GitHub main is `895c001` (2026-10-10). The local branch is ahead by two commits plus uncommitted work (the video recording tools, text fixes); nothing of that is on GitHub yet.
- Hosted demo: `https://enclave.jace0423.com` (the earlier `zero-trust-edge-enclave.zeabur.app` answers 307 to it). Every page sits behind a judge sign-in; the hosted build has the employee inbox and role separation.
- Devpost organizer notice, 2026-10-15: the submission lacks the required access. The judge sign-in and tokens are in `ZTE-Judges.zip` under Devpost "Additional info", which the organizer did not find. To do on the Devpost form (not in this repository): put a "How to test (for judges)" block in the project description, with the demo URL, where the credentials are, the 5-minute path and the no-sign-in route (Run Locally). Step 2 of the path now reads: open the "Recipient link (send this to the employee)" under Package result.
- Gate results today: export gate passes (blocking 0); release-boundary scan reports BLOCKED with 5 HIGH, identical on GitHub main and on the local tree (wording heuristics on README line 11, `docs/agent/dual-mode-edge.md:16`, and three "system prompt" phrases), so they are not new; the owner has not yet decided to accept or reword them. The 2026-09-27 line "release-boundary: PASS, findings 0" below is therefore out of date.
- Tests: the full suite is 843 tests, all passing; `npm test` (one file) is 117.
- Video: the 1:47 narrated recording of 2026-09-27 is still the one linked from README and Devpost. A new cut of at most 178 s (the Devpost limit is 3 minutes) exists locally, with narration being finalized, and has not been uploaded; when it is, the README "Demo video" line and the Devpost video link change together.
- Manifest: 272 paths on GitHub; 277 locally (the recording tools and the new Swift pointer helper are added).

## Current Gate Status

Local self-checks against the 122-file candidate built from `public-export-manifest.md` (2026-09-27):

```text
export-gate:      pass, blocking 0, P0 0, P1 0, P2 0, critical 0, high 7, medium 99
release-boundary: PASS, findings 0
localguard:       92 findings, 3 CRITICAL / 15 HIGH / 61 MEDIUM / 13 LOW
npm test:         115 of 115, thirty consecutive runs
preflight:hosted: 7 of 8, 0 blocking, 1 advisory
fuzz:             40,000 projections, 2,400 worker ticks, 0 invariant violations (2026-09-18)
```

The CRITICAL and HIGH findings are adjudicated false positives recorded in
`SECURITY_SCAN_EVIDENCE.md`: deliberate canary strings and a synthetic wrong password in tests,
field names rather than values for the privacy rule, and a model filename matched as a
high-entropy literal.

## Devpost Required Items

| Requirement | Status | Evidence |
|---|---|---|
| Public code repository | Done | `https://github.com/jiarong0423/zero-trust-edge-enclave` |
| MIT license, visible at repository top | Done | `LICENSE` |
| README with setup instructions | Done | `README.md`, section Run Locally, verified from a fresh clone |
| README highlights NVIDIA model use | Done | `README.md`, section NVIDIA / Nebius |
| README states where Token Factory carried the work | Done | same section |
| README states other Nebius services used | Done | same section, states none are used |
| Architecture diagrams | Done | `docs/assets/`, redrawn 2026-09-25 from the code |
| Working demo URL | Done | `https://enclave.jace0423.com`, behind a judge sign-in, grants valid to 2026-12-16; the repository is also a test build |
| Runs on Token Factory | Done | Hosted instance calls Token Factory at runtime, under a USD 20 spending cap |
| Judge access | Done | The form has no testing-instructions field; sign-in, role tokens and an English walkthrough are in the private Devpost file upload |
| Track | Done (form) | Best Apps and Agents |
| New or existing project | Done (form) | New; first commit 2026-09-07, after the 2026-08-26 start |
| Platform feedback | Done | Answered in the Devpost form questions on models, Nebius capabilities, improvements and the Nemotron team |
| Demo video URL | Done | https://youtu.be/klBuNhS5eYM, 1:47, public, narration covers how Token Factory is used; submitted 2026-09-27 ([record](docs/agent/submission-record-2026-09-27.md)) |
| Builders and Brews city | Done (form) | Taipei; attended 2026-09-19 |
| Submitter type, country, declarations | Done (form) | Filled in the Devpost form |

## Documentation Drift

The sixteen statements found on 2026-09-19 to describe only one adviser were corrected in commit
`09110a1`. A second sweep on 2026-09-24 corrected statements that predated the hosted instance:
the deployment guide's no-key posture, the pending judge-access question, the rule-alignment
status, the export manifest's publication status and six files missing from it, and test counts
across the README and evidence files.
