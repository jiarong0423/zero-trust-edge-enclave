# Submission Gap Check

Updated: 2026-09-27 Asia/Taipei

## Update 2026-10-15 (checked today; the sections below are the 2026-09-27 state and are kept as history)

- Repository: public, MIT detected by GitHub, README with Run Locally; GitHub main is `895c001` (2026-10-10). The local branch is ahead by two commits plus uncommitted work (the video recording tools, text fixes); nothing of that is on GitHub yet.
- Hosted demo: `https://enclave.jace0423.com` (the earlier `zero-trust-edge-enclave.zeabur.app` answers 307 to it). The sender, audit and administration pages sit behind a judge sign-in; the employee pages and the employee inbox and file-access calls do not, and each of those calls still has to present a registered token. The hosted build has the employee inbox and role separation.
- Devpost organizer notice, 2026-10-15: the submission lacks the required access. The judge sign-in and tokens are in `ZTE-Judges.zip` under Devpost "Additional info", which the organizer did not find. To do on the Devpost form (not in this repository): put a "How to test (for judges)" block in the project description, with the demo URL, where the credentials are, the 5-minute path and the no-sign-in route (Run Locally). Step 2 of the path now reads: open the "Recipient link (send this to the employee)" under Package result.
- Gate results, 2026-10-16: the repository secret audit (P0), the mutable-artifact audit and a scan of the whole Git history (157 commits, gitleaks) find nothing; the public list, the tracked files and the files on GitHub are the same 283. The release-boundary scan of the 283 public files reports BLOCKED with 5 HIGH, and they are wording heuristics, not secrets or private data: `README.md:13` and `docs/agent/dual-mode-edge.md:16` describe where an edge deployment would be reached, and three technical notes (`docs/agent/followup-prompt-profile-2026-10-08.md:55`, `docs/agent/nvidia-model-provenance.md:23`, `docs/compliance/ai-governance.md:173`) name the follow-up adviser's instruction text or quote the model card. **Owner decision, 2026-10-16: accept all five and keep the wording**, because each one describes this project's own design and none carries a secret, a private record or an instruction aimed at an agent. The 2026-09-27 line "release-boundary: PASS, findings 0" below is therefore out of date.
- Tests: the full suite is 872 tests, all passing; `npm test` (one file) is 117.
- Applicable scenarios, 2026-10-16: README ("Where This Applies") and the Devpost story now name two cases (a price quote to two named account managers, a patient file to two clinicians) with two sources: ONC Data Brief No. 51 (about seven in 10 U.S. non-federal acute care hospitals used mail or fax for summary of care records in 2018; the figure is from 2018, not current) and NIST SP 800-53 AC-3 (via a third-party reference site, not NIST's own page). Both say the prototype was tested with synthetic documents and is not certified for medical use or for classified information. Military and classified use is deliberately not claimed: the sources found say classified transmission needs NSA-authorized cryptography, which this project does not have.
- Video: the new cut (178 s, YouTube shows 2:59) was uploaded as public on 2026-10-16: https://youtu.be/1zP4q8UwYsw. README and the Devpost video link carry it. The earlier 1:47 recording (https://youtu.be/klBuNhS5eYM, 2026-09-27) is kept on the channel.
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
| Demo video URL | Done | https://youtu.be/1zP4q8UwYsw, 178 s (YouTube shows 2:59), public, uploaded 2026-10-16; shows the real Token Factory call and the local-first cascade. Earlier recording: https://youtu.be/klBuNhS5eYM (1:47, 2026-09-27, [record](docs/agent/submission-record-2026-09-27.md)) |
| Builders and Brews city | Done (form) | Taipei; attended 2026-09-19 |
| Submitter type, country, declarations | Done (form) | Filled in the Devpost form |

## Documentation Drift

The sixteen statements found on 2026-09-19 to describe only one adviser were corrected in commit
`09110a1`. A second sweep on 2026-09-24 corrected statements that predated the hosted instance:
the deployment guide's no-key posture, the pending judge-access question, the rule-alignment
status, the export manifest's publication status and six files missing from it, and test counts
across the README and evidence files.
