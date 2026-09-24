# Submission Gap Check

Updated: 2026-09-24 Asia/Taipei

## Current Gate Status

Local self-checks against the 117-file candidate built from `public-export-manifest.md`:

```text
export-gate:      pass, blocking 0, P0 0, P1 0, P2 0, critical 0, high 7, medium 94
release-boundary: PASS, findings 0
localguard:       89 findings, 3 CRITICAL / 15 HIGH / 62 MEDIUM / 9 LOW
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
| Architecture diagrams | Done | `docs/assets/`, redrawn 2026-09-19 for the second adviser |
| Working demo URL | Done | `https://zero-trust-edge-enclave.zeabur.app`, behind a judge sign-in, grants valid to 2026-12-16; the repository is also a test build |
| Runs on Token Factory | Done | Hosted instance calls Token Factory at runtime, under a USD 20 spending cap |
| Testing instructions for judges | Form-only | Sign-in and role tokens go in the Devpost testing field, in English |
| Track | Form-only | Best Apps and Agents |
| New or existing project | Form-only | New; first commit 2026-09-07, after the 2026-08-26 start |
| Platform feedback | Drafted | Held privately, not yet submitted |
| Demo video URL | Still needed | Under three minutes, public on YouTube, with audio covering how Token Factory was used. Required to submit |
| Builders and Brews city | Form-only | Taipei; attended 2026-09-19 |
| Submitter type, country, declarations | Form-only | Fill directly in Devpost |

## Documentation Drift

The sixteen statements found on 2026-09-19 to describe only one adviser were corrected in commit
`09110a1`. A second sweep on 2026-09-24 corrected statements that predated the hosted instance:
the deployment guide's no-key posture, the pending judge-access question, the rule-alignment
status, the export manifest's publication status and six files missing from it, and test counts
across the README and evidence files.
