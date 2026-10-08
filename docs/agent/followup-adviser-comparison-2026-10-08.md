# Follow-Up Adviser Comparison, 2026-10-08

An evidence record. It compares what three deciders answer for the same 36 follow-up inputs: the
deterministic fixture (`syntheticFollowupAdvice` in `delivery-followup.js`), a local NVIDIA
Nemotron 3 Nano 4B, and NVIDIA Nemotron 3 Super 120B on Nebius Token Factory. It reports what was
measured and what that does and does not show. The fixture is a blunt stand-in, not ground truth, so
agreement with it is not accuracy.

## Setup

- Inputs: every combination of `timeCode` (`WINDOW_FULL`, `WINDOW_MOST`, `WINDOW_LITTLE`,
  `WINDOW_LAST`) x `pickupCode` (`PICKUP_NONE`, `PICKUP_SOME`, `PICKUP_ALL`) x `nudgeCount` (0, 1, 2)
  = 36 synthetic inputs. One fixed synthetic `taskAlias`, `snapshotVersion` 1. No real task, person or
  document is involved.
- Path: the production path, `requestFileAdvice` in `file-adviser.js` with `kind: 'followup'`: same
  system boundary (`FOLLOWUP_ADVISER_BOUNDARY`), same five-field projection, same output schema, same
  validator (`validateFollowupAdvice`). Only the endpoint rule differs between the two models.
- Local 4B: `nvidia-nemotron-3-nano-4b` through LM Studio on one Mac, llama.cpp runtime 2.46.0
  (the runtime version is as reported by the operator; the result file does not record it), endpoint
  `http://127.0.0.1:1234/v1`, `reasoning_effort: 'none'`, `temperature: 0`, `json_schema` response
  format (the `local_openai_compatible` entry of `ADVISER_PROVIDERS`). 36 calls.
- Hosted 120B: `nvidia/nemotron-3-super-120b-a12b` on Token Factory, the `nebius` entry of
  `ADVISER_PROVIDERS` (`json_object` response format, `enable_thinking: false`). 36 calls, 1.2 s apart.
- One run per input per model. No repeats.
- Result files (under `output/experiments/` of the original checkout; that directory is git-ignored,
  so these files are not in the repository):
  `followup-compare-2026-10-08T01-47-13-694Z.json` (4B),
  `followup-compare-cloud-2026-10-08T02-38-45-623Z.json` (120B),
  `followup-reasoning-2026-10-08T02-21-56-420Z.json` (reasoning experiment).

## Per-Input Actions

`REFUSED` means the validator rejected the answer (reason `FOLLOWUP_REASON_INCOHERENT`); nothing from
it is used. Only the action is shown; reason codes are in the result files.

| # | timeCode | pickupCode | nudgeCount | Fixture | 4B | 120B |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | WINDOW_FULL | PICKUP_NONE | 0 | WAIT | WAIT | WAIT |
| 2 | WINDOW_FULL | PICKUP_NONE | 1 | WAIT | WAIT | WAIT |
| 3 | WINDOW_FULL | PICKUP_NONE | 2 | ESCALATE | WAIT | WAIT |
| 4 | WINDOW_FULL | PICKUP_SOME | 0 | WAIT | REFUSED | WAIT |
| 5 | WINDOW_FULL | PICKUP_SOME | 1 | WAIT | WAIT | WAIT |
| 6 | WINDOW_FULL | PICKUP_SOME | 2 | ESCALATE | WAIT | WAIT |
| 7 | WINDOW_FULL | PICKUP_ALL | 0 | WAIT | REFUSED | WAIT |
| 8 | WINDOW_FULL | PICKUP_ALL | 1 | WAIT | WAIT | WAIT |
| 9 | WINDOW_FULL | PICKUP_ALL | 2 | WAIT | WAIT | WAIT |
| 10 | WINDOW_MOST | PICKUP_NONE | 0 | REMIND | WAIT | WAIT |
| 11 | WINDOW_MOST | PICKUP_NONE | 1 | REMIND | WAIT | REMIND |
| 12 | WINDOW_MOST | PICKUP_NONE | 2 | ESCALATE | WAIT | WAIT |
| 13 | WINDOW_MOST | PICKUP_SOME | 0 | REMIND | WAIT | WAIT |
| 14 | WINDOW_MOST | PICKUP_SOME | 1 | REMIND | WAIT | WAIT |
| 15 | WINDOW_MOST | PICKUP_SOME | 2 | ESCALATE | WAIT | WAIT |
| 16 | WINDOW_MOST | PICKUP_ALL | 0 | WAIT | WAIT | WAIT |
| 17 | WINDOW_MOST | PICKUP_ALL | 1 | WAIT | WAIT | WAIT |
| 18 | WINDOW_MOST | PICKUP_ALL | 2 | WAIT | WAIT | WAIT |
| 19 | WINDOW_LITTLE | PICKUP_NONE | 0 | REMIND | WAIT | WAIT |
| 20 | WINDOW_LITTLE | PICKUP_NONE | 1 | REMIND | WAIT | WAIT |
| 21 | WINDOW_LITTLE | PICKUP_NONE | 2 | ESCALATE | WAIT | WAIT |
| 22 | WINDOW_LITTLE | PICKUP_SOME | 0 | REMIND | WAIT | WAIT |
| 23 | WINDOW_LITTLE | PICKUP_SOME | 1 | REMIND | WAIT | WAIT |
| 24 | WINDOW_LITTLE | PICKUP_SOME | 2 | ESCALATE | WAIT | WAIT |
| 25 | WINDOW_LITTLE | PICKUP_ALL | 0 | WAIT | WAIT | WAIT |
| 26 | WINDOW_LITTLE | PICKUP_ALL | 1 | WAIT | WAIT | WAIT |
| 27 | WINDOW_LITTLE | PICKUP_ALL | 2 | WAIT | WAIT | WAIT |
| 28 | WINDOW_LAST | PICKUP_NONE | 0 | ESCALATE | WAIT | REMIND |
| 29 | WINDOW_LAST | PICKUP_NONE | 1 | ESCALATE | WAIT | REMIND |
| 30 | WINDOW_LAST | PICKUP_NONE | 2 | ESCALATE | WAIT | ESCALATE |
| 31 | WINDOW_LAST | PICKUP_SOME | 0 | ESCALATE | WAIT | WAIT |
| 32 | WINDOW_LAST | PICKUP_SOME | 1 | ESCALATE | WAIT | REMIND |
| 33 | WINDOW_LAST | PICKUP_SOME | 2 | ESCALATE | WAIT | WAIT |
| 34 | WINDOW_LAST | PICKUP_ALL | 0 | WAIT | WAIT | WAIT |
| 35 | WINDOW_LAST | PICKUP_ALL | 1 | WAIT | WAIT | WAIT |
| 36 | WINDOW_LAST | PICKUP_ALL | 2 | WAIT | WAIT | WAIT |

## Summary

| | Fixture | Local 4B | Hosted 120B |
| --- | --- | --- | --- |
| Accepted by the validator | 36 | 34 | 36 |
| Refused by the validator | 0 | 2 (`FOLLOWUP_REASON_INCOHERENT`, rows 4 and 7) | 0 |
| WAIT | 16 | 34 | 31 |
| REMIND | 8 | 0 | 4 |
| ESCALATE | 12 | 0 | 1 |
| Same action as the fixture | n/a | 14 | 18 |
| Latency min / median / max (ms) | n/a | 2575 / 2856 / 7835 | 746 / 987 / 1483 |

Counts for the 4B are over its 34 accepted answers; the 2 refused answers produced no usable action
and are excluded from the WAIT / REMIND / ESCALATE counts.

The six inputs where the fixture escalates because the window is nearly gone and the pickup is not
complete (`WINDOW_LAST` with `PICKUP_NONE` or `PICKUP_SOME`, rows 28 to 33): the 4B answered WAIT
six times; the 120B answered REMIND three times, ESCALATE once (row 30, reminders spent) and WAIT
twice.

## Reasoning Experiment (Local 4B)

Same system boundary, same user message, same schema; only `reasoning_effort` changed. Six critical
cases, one run each.

| Setting | WAIT | REMIND | ESCALATE | Same action as fixture | Median latency |
| --- | --- | --- | --- | --- | --- |
| none (production) | 6 | 0 | 0 | 2 of 6 | 2.8 s (2841 ms) |
| low | 5 | 0 | 1 | 3 of 6 | 21 s (21292 ms) |
| high | 5 | 0 | 1 | 3 of 6 | 21 s (20953 ms) |

With reasoning on, the one ESCALATE was the same case in both settings (deadline close, reminders
spent). The case "deadline close, partial pickup" was still WAIT at every setting. Reasoning cost
about seven times the latency (median 2.8 s versus 21 s) for one changed answer out of six.

## Limitations

- One run per input per model; temperature 0 on the 4B. No variance is measured. The 120B ran at
  temperature 1 and top_p 0.95 (what `requestFileAdvice` sends for the hosted outlet), so its answers
  could differ on another run.
- No ground truth. The fixture is a deterministic stand-in written for tests. Agreement with it is not
  accuracy, and disagreement is not an error.
- 36 synthetic inputs over a four-by-three-by-three grid. They are not drawn from real deliveries.
- The 4B ran on one Mac under LM Studio. The same weights behaved differently across LM Studio engine
  versions (see the comments above `ADVISER_PROVIDERS` in `file-adviser.js`: reasoning_effort `none`
  and temperature 0 since 2026-09-24), so these numbers belong to runtime 2.46.0 on that machine.
  Nothing here was run on a Jetson or any other NVIDIA edge device.
- Latency for the 120B includes the network path from the author's machine to Token Factory.
- The reasoning experiment is six cases at three settings. It is a probe, not a benchmark.

## Conclusion

Both models are passive near the deadline. The 4B answered WAIT in every accepted case. The 120B also
waited in most cases where the fixture escalates: it escalated once in the 12 inputs where the fixture
does. This record does not show that either model beats a rule, and it does not show the reverse; it
shows that the safety of the delivery cannot depend on the adviser being decisive.

The design already assumes that. Fixed code decides who is contacted; the countdown (`timeCode`)
schedules when a decision is asked for; the validator refuses incoherent answers (2 of 36 from the
4B); and the opt-in fixed floor `FOLLOWUP_FLOOR=true` (`followup-floor.js`) turns an accepted WAIT at
`WINDOW_LAST` with the pickup incomplete into ESCALATE with reason `DEADLINE_NEAR`, whichever model
answered. The adviser's own answer stays in the evidence trail. The floor is off by default.

## Re-Running

The result files above came from throwaway scripts in `output/experiments/`. A repeatable benchmark
over the same 36 inputs, `scripts/bench-adviser.mjs`, was added in this branch:

```bash
node scripts/bench-adviser.mjs                       # fixture only: no network, no model
node scripts/bench-adviser.mjs --local               # loopback runtime only
node scripts/bench-adviser.mjs --cloud --yes-spend   # hosted model; spends money
```

Add `--out <file>` to write JSON (it refuses to overwrite). The script header lists its environment
variables.

## Addendum: the 24 reachable inputs, and the directive prompt on the hosted model

Twelve of the 36 inputs above have everything already collected; fixed code never sends those to a model. On the 24 inputs the product can send, with the current prompt: fixture WAIT 4 / REMIND 8 / ESCALATE 12; local 4B 23 WAIT (23 accepted of 24); hosted 120B WAIT 19 / REMIND 4 / ESCALATE 1 (24 accepted, same action as the fixture on 6). With the opt-in `FOLLOWUP_PROMPT=directive` profile the hosted 120B gave WAIT 4 / REMIND 11 / ESCALATE 9, 24 accepted, same action as the fixture on 20 (one run, temperature 1), and the local 4B gave WAIT 8 / REMIND 6 / ESCALATE 10, 24 accepted, same on 20 (one run, temperature 0). Details and caveats: `followup-prompt-profile-2026-10-08.md`. The fixture is a blunt stand-in, not ground truth.
