# Submission Gap Check

Updated: 2026-09-27 Asia/Taipei

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
| Working demo URL | Done | `https://zero-trust-edge-enclave.zeabur.app`, behind a judge sign-in, grants valid to 2026-12-16; the repository is also a test build |
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
