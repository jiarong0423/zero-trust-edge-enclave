# Adviser Evidence Table (2026-10-29, rows 9 and 9b added 2026-10-30)

One table for every number this project quotes about the follow-up adviser, with the date it was measured,
where the record is, and whether a judge can recompute it from this tree. All model calls listed were real
calls on the date given; the inputs are the 36 synthetic cells of `followup-table.js`
(4 time codes x 3 pickup codes x nudge count 0 to 2) unless the row says otherwise. "Coherent" means accepted
by the production validator (`validateFollowupAdvice`), which refuses an answer whose reason does not fit the
input. The lookup table is the fixed floor and a blunt stand-in, not ground truth; agreement with it is not
accuracy.

`node scripts/compare-followup-advisers.mjs` (no network) recomputes every row marked "rows" from the
per-input records in `docs/agent/fixtures/`; rows marked "summary" exist only as a recorded summary and are
printed as copied.

| # | Measurement | Model | Thinking | Date | Calls | Result | Record | Recompute |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Prompt as prose, follow-up contract | Nemotron 3 Super 120B, Token Factory | off | 2026-09-18 | 60 | schema 100%, reason coherent 88.3%, logic 88.3%, p95 1728 ms | `SECURITY_SCAN_EVIDENCE.md:255-264` | summary |
| 2 | Prompt as lookup tables (shipped form) | Nemotron 3 Super 120B, Token Factory | off | 2026-09-18 | 60 | schema 100%, reason coherent 100%, logic 100%, p95 1205 ms | `SECURITY_SCAN_EVIDENCE.md:255-264` | summary |
| 3 | 36 inputs, default prompt | Nemotron 3 Super 120B, Token Factory | off | 2026-10-08 | 36 | 36/36 coherent; WAIT 31 / REMIND 4 / ESCALATE 1; ESCALATE on 1 of the 12 inputs where the table does; same action as table 18/36 (6/24 reachable); latency 746 / 987 / 1483 ms (min / median / max) | `docs/agent/followup-adviser-comparison-2026-10-08.md:36-85`; `docs/agent/fixtures/followup-advisers-recorded.json` | rows (latency: summary) |
| 4 | 36 inputs, default prompt | Nemotron 3 Nano 4B, loopback LM Studio | off (`reasoning_effort: none`) | 2026-10-08 | 36 | 34/36 coherent (2 refused `FOLLOWUP_REASON_INCOHERENT`); WAIT 34; ESCALATE on 0 of 12; same as table 14/34; latency 2575 / 2856 / 7835 ms | same as row 3 | rows (latency: summary) |
| 5 | 36 inputs, default prompt | Nemotron 3 Ultra 550B, Token Factory | off | 2026-10-16 | 36 | 33/36 coherent; WAIT 20 / REMIND 2 / ESCALATE 11; ESCALATE on 11 of 12; same as table 26/33 (17/24 reachable); latency 681 / 895 / 1468 ms, p95 1468 ms | `docs/agent/fixtures/bench-ultra-2026-10-16.json`; summarised in `docs/agent/followup-adviser-comparison-2026-10-08.md:156-180` | rows |
| 6 | 6 critical inputs (`WINDOW_LAST`, pickup incomplete), reasoning on | Nemotron 3 Nano 4B, loopback | on (`reasoning_effort` low / high) | 2026-10-08 | 6 + 6 | low: ESCALATE 1, same as table 3/6, median 21292 ms; high: ESCALATE 1, same 3/6, median 20953 ms; against `none`: ESCALATE 0, same 2/6, median 2841 ms | `docs/agent/followup-adviser-comparison-2026-10-08.md:95-108` | summary |
| 7 | 24 reachable inputs, opt-in `FOLLOWUP_PROMPT=directive` | Super 120B / Nano 4B | off | 2026-10-08 | 24 + 24 | Super WAIT 4 / REMIND 11 / ESCALATE 9, same as table 20/24; Nano WAIT 8 / REMIND 6 / ESCALATE 10, same 20/24 | `docs/agent/followup-adviser-comparison-2026-10-08.md:154`; `docs/agent/followup-prompt-profile-2026-10-08.md` | summary |
| 8 | Lookup table, no model | `tableFollowupAdvice` | n/a | computed on each run | 36 | 36/36 coherent; WAIT 16 / REMIND 8 / ESCALATE 12; ESCALATE on 12 of 12; about 1 ms per input | `followup-table.js` | rows |
| 9 | 6 critical inputs (`WINDOW_LAST`, pickup incomplete), through the production request function (outside the worker and the USD 20 cap), thinking off and on | Nemotron 3 Super 120B, Token Factory | off (`enable_thinking: false`, production shape) and on (`enable_thinking: true`, 4096 tokens, 60 s, not the default) | 2026-10-30 | 6 + 6 | off: 6/6 accepted by the validator, REMIND 4 / ESCALATE 2, same as table 2/6, latency 786 / 928 / 1908 ms (min / median / max); on: 6/6 accepted, REMIND 3 / ESCALATE 3, same as table 3/6, latency 5119 / 6405 / 8827 ms. "Accepted" means consistent with its input, not that it matched the fixed table (the table is a yardstick, not ground truth; it escalates on all six inputs). Hosted calls sample at temperature 1 and the script calls `requestFileAdvice` directly (same prompt code path, request shape and validator; not through the worker or the spending cap), so a rerun will not repeat these exact figures. Six inputs per setting is too few to rank the settings; the figures are what was measured. Cost of one call: a separate single call on 2026-10-30 (thinking off, `WINDOW_LAST` / `PICKUP_NONE` / nudge 0) reported 1,010 prompt tokens, 992 of them served from cache, and 70 completion tokens in the provider's `usage` field; at the list prices in `env.sample` ($0.30 input, $0.90 output per million tokens; the same figures appear in Nebius's public Token Factory model listing for this model, read on 2026-10-30) that is under $0.0004 per follow-up call, counting every prompt token at the full input price. One call, one input; the comparison script does not record usage, so the provider's usage object is stored separately in `docs/agent/fixtures/hosted-call-usage-2026-10-30.json`. | `docs/agent/fixtures/hosted-thinking-2026-10-30.json` | record only (`--cloud --yes-spend --thinking both` repeats it with your own key, 12 calls) |
| 9b | 36 inputs, default prompt, second full hosted run | Nemotron 3 Super 120B, Token Factory | off (`enable_thinking: false`) | 2026-10-30 (evening) | 36 | 29/36 accepted: 5 refused `FOLLOWUP_ADVICE_REJECTED` (reason did not fit the input), 2 `FILE_PROVIDER_UNREACHABLE` (past the 5 s deadline); WAIT 24 / REMIND 5 / ESCALATE 0; ESCALATE on 0 of the 12 inputs where the table does; same as table 16/36; latency 1076 / 1923 / 4196 ms (min / median / max, accepted answers only). Of the 29 inputs answered in both this run and row 3, 4 got a different action. Nothing was rerun or dropped. | `docs/agent/fixtures/hosted-all36-2026-10-30.json` | record only (per-input rows are in the fixture; `--cloud --yes-spend --thinking off --cells all --max-calls 40` repeats it, 36 calls) |
| 10 | Full test suite | - | - | 2026-10-29 | 882 tests | local with ffmpeg: 882 pass, 0 skipped (872 before `scripts/compare-followup-advisers.test.mjs`); GitHub Actions at 60f55d8: success, with the 6 `ffmpeg`-gated tests in `scripts/compose-demo-video.test.mjs` skipped | `README.md` Proof line; CI log | `npm run test:all` |
| 11 | Fuzz over projections and worker ticks | - | - | 2026-09-18 | 40,000 projections, 2,400 ticks | 0 invariant violations | `SECURITY_SCAN_EVIDENCE.md:127-134`; `SUBMISSION_GAP_CHECK.md:23` | not reproducible: one-off script, never committed; the same invariants are asserted on fixed inputs by `scripts/delivery-followup.test.mjs` and `scripts/delivery-followup-worker.test.mjs` |

## What the table says about "Nemotron or an `if`"

- The `if` exists and is kept: row 8 is the lookup table, 36/36 coherent in about a millisecond, and the
  product's fixed code, validator and opt-in `FOLLOWUP_FLOOR` sit on it. Nothing in this table claims a model
  beats that table on these 36 inputs; the table is the yardstick, not the truth.
- What a model adds is measured per call, not assumed: rows 1 and 2 are the same 60 inputs with the prompt in
  two forms, and the lookup-table form is what moved reason coherence from 88.3% to 100% and p95 from
  1728 ms to 1205 ms on the shipped model. That is a prompt finding, obtained only because the validator and
  the evidence chain score every answer.
- The same setting is not a constant: on 2026-10-08 Super had 36/36 accepted answers (row 3); on the evening of 2026-10-30 it had 29/36 (row 9b), with 5 answers refused by the validator and 2 calls past the 5 s deadline, at roughly twice the latency. A refusal or a timeout costs a late nudge, not a wrong recipient, which is what the validator is for. Two full runs are a pair of draws, not a distribution; the figures above are what each run measured.
- Model size changes the decision where the default prompt leaves the 120B passive: on the 12 inputs where the
  table escalates, Super escalates in 1 (row 3), Ultra in 11 at a median 0.9 s (row 5), and the 4B in 0 (row 4).
  The directive prompt makes the 120B and the 4B decisive too (row 7, 20/24 each). Which of those is right is
  for a person to label (`docs/agent/human-labels.md`); the fixture is not ground truth.
- Reasoning on has two records. On the 4B (row 6): one changed answer out of six for about seven times the
  latency. On the hosted 120B (row 9, run 2026-10-30): median 6.4 s with thinking on against 0.9 s off, and all six
  thinking-on calls (5.1 to 8.8 s) would have hit the 5 s production deadline. Agreement with the table was 3 of 6
  against 2 of 6, which cannot be separated from run-to-run variation: sampling is at temperature 1, the table escalates on all six
  inputs, and the 2026-10-08 thinking-off run on the same six escalated once against twice on 2026-10-30. Six calls
  per setting is a probe, not a ranking, and thinking on is not the shipped setting.
