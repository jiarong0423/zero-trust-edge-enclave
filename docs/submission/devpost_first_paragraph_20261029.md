# Devpost first paragraph (2026-10-29)

Paste as the opening of the Devpost text. Line 1 is the judge-access pointer; the paragraph below it carries the numbers. Devpost itself is not changed by this repository.

## Judge access line

Judge access: the site sign-in and the role tokens are in `ZTE-Judges.zip` under "Additional info" on this submission (open `README.txt` first); the repository README repeats the path under "Try It" > "Hosted demo", and `docs/demo/README.md` is the step-by-step walkthrough. Without the zip, "Run Locally" in the README needs no key.

## First paragraph (121 words)

On Nebius Token Factory, Nemotron 3 Super answered 60 follow-up calls with 100% reason coherence at p95 1.2 s once the prompt was rewritten as lookup tables (88.3%, p95 1.7 s as prose). Nemotron 3 Ultra, run once on the same 36 inputs, escalated in 11 of the 12 inputs where the fixture escalates, at a median 0.9 s. The suite has 872 tests (GitHub Actions: 866 pass, 6 ffmpeg-gated video tests skipped on the runner; all 872 pass locally). The boundary is fixed code and could be an `if`; the adviser is a Nemotron model because every answer is validated and logged per call, so prompt form and model size can be measured and swapped; these numbers are that measurement.

## Source of every number

| Claim | Source (worktree path:line) |
| --- | --- |
| 60 calls per prompt form, hosted model | `SECURITY_SCAN_EVIDENCE.md:257-259` ("measured against the hosted model over 60 calls each") |
| prose: reason coherent 88.3%, p95 1728 ms | `SECURITY_SCAN_EVIDENCE.md:263` |
| lookup table: reason coherent 100%, p95 1205 ms | `SECURITY_SCAN_EVIDENCE.md:264` |
| Ultra: one run, same 36 inputs, `nvidia/Nemotron-3-Ultra-550b-a55b` | `docs/agent/followup-adviser-comparison-2026-10-08.md:156-161`; `README.md:139-141` |
| Ultra escalated in 11 of the 12 fixture-escalate inputs | `docs/agent/followup-adviser-comparison-2026-10-08.md:172` |
| Ultra latency median 895 ms (0.9 s) | `docs/agent/followup-adviser-comparison-2026-10-08.md:170` |
| 872 tests in the full suite; 872 pass / 0 skipped locally | `README.md:14`; `npm run test:all` on this branch, 2026-10-29: `tests 872 / pass 872 / fail 0 / skipped 0`, 24.5 s, with ffmpeg installed |
| CI 866 pass / 6 skipped | GitHub Actions log at b8c74a5 (`# tests 872 / pass 866 / fail 0 / skipped 6`), cited in `docs/ai-generated/.../judges/judge_eligibility.md:10` (workspace, not this repo) |
| 6 skipped = `{ skip: !hasFfmpeg }` tests | `scripts/compose-demo-video.test.mjs:9,86,121,138,151,199,215` |
| "could be an `if`"; validated and logged per call | `README.md:59-65` (boundary enforced by fixed code, workflow completes with `synthetic_fixture`); `README.md:80-86` (evidence chain stores every adviser call and its validation) |

Not used because no source in the repository: "40,000 projections / 2,400 worker ticks" fuzz run (only narrated in `SECURITY_SCAN_EVIDENCE.md:127-131` and `SUBMISSION_GAP_CHECK.md:26`; no script or output file was ever committed, checked with `git log --all -S fuzz -- '*.mjs' '*.js'`).
