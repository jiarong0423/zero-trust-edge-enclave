# Follow-up prompt profile `FOLLOWUP_PROMPT=directive` (2026-10-08)

Status: opt-in, off by default, measured on the local 4B only. Not recommended for the hosted model until it has been tested there (see Limitations).

## Why

With the shipped prompt the local `nvidia-nemotron-3-nano-4b` answered WAIT for 23 of 23 accepted reachable inputs: the `JUDGEMENT:` paragraph calls time still to run "the reason to leave a delivery alone", treats ignored reminders as evidence another will not work, and never says when to ESCALATE. This module looked for a `JUDGEMENT:` paragraph that is active (REMIND/ESCALATE when warranted) and still coherent (the validator accepts the reason).

## Method

- Inputs: the 24 inputs the product can send to the model: 4 `timeCode` x `PICKUP_NONE`/`PICKUP_SOME` x `nudgeCount` 0..2. `PICKUP_ALL` is never sent (fixed code skips fully collected deliveries). 12 of the 36 inputs of the earlier experiment were therefore unreachable.
- Settings: production local settings, `reasoning_effort` none, temperature 0, `json_schema` strict with `ADVICE_KINDS.followup.schema`, loopback `127.0.0.1:1234` only, no cloud or hosted call. One run per variant per input (temperature 0, no repeats).
- Only the `JUDGEMENT:` paragraph is swapped; the rest of the system text, the user message, the schema and `validateFollowupAdvice` are unchanged.
- "Accepted" = `validateFollowupAdvice` passes. "Same action as fixture" = same action as `syntheticFollowupAdvice`, which is a deliberately blunt stand-in and NOT ground truth: agreement is not accuracy.
- Script: `/private/tmp/claude-501/q2/variants.mjs` (scratch, not shipped); raw rows in `/private/tmp/claude-501/q2/results-*.json`.

## Results (24 inputs each, one run each)

| Variant | Accepted | WAIT | REMIND | ESCALATE | Same action as fixture (of accepted) |
|---|---|---|---|---|---|
| shipped prompt (earlier measurement on these 24 inputs) | 23 | 24 | 0 | 0 | not recomputed here |
| V1 | 24 | 10 | 6 | 8 | 18 |
| V2 | 23 | 8 | 6 | 10 | 19 |
| V3 | 18 | 13 | 7 | 4 | 10 |
| V4 (selected, `directive`) | 24 | 8 | 6 | 10 | 20 |

Earlier runs of the same script on the earlier input set (36 inputs including 12 unreachable ones) are not comparable one to one: a "principles" variant had 19 accepted and 5 refused; an explicit ordered "table" variant had 24 accepted, W7/R7/E10, 21/24 same action as fixture (these counts are as reported to this module, not re-run).

Refusals: V1 none; V2 one (WINDOW_LITTLE/PICKUP_NONE/nudge 1: REMIND with PARTIAL_PICKUP, reason incoherent); V3 six (reason incoherent: wrong pickup reason on REMIND, DEADLINE_NEAR outside WINDOW_LAST, WINDOW_EARLY at WINDOW_LAST); V4 none.

V4 remaining differences from the fixture (all accepted, all WAIT where the fixture acts): WINDOW_FULL with nudgeCount 2 (both pickup states) and WINDOW_MOST/WINDOW_LITTLE with PICKUP_NONE and nudgeCount 0 (two inputs). Whether those WAITs are wrong is a policy question the fixture cannot answer.

## Tried JUDGEMENT texts (exact)

V1:

> JUDGEMENT: Your job is to get this delivery acknowledged before the window closes, so choose the smallest action that does it. Waiting is only right while a lot of time is still ahead (WINDOW_FULL). Once the window is shrinking (WINDOW_MOST or WINDOW_LITTLE) and anything is still uncollected, send a reminder, provided reminders remain (nudgeCount below 2). Ask a person to look (ESCALATE) when the window is nearly over (WINDOW_LAST), or when the reminders are used up (nudgeCount 2), because another reminder cannot do what a person can. Name the reason that is true of the input: the pickup state for a reminder, DEADLINE_NEAR or NUDGES_EXHAUSTED for an escalation, WINDOW_EARLY for waiting. The KEY below fixes what each value means.

V2:

> JUDGEMENT: Silence is not success, so act on what the input shows. Nothing is needed while the whole window is ahead (WINDOW_FULL): WAIT. After that, an uncollected delivery should be chased while chasing is still possible: when the window is shrinking (WINDOW_MOST or WINDOW_LITTLE) and nudgeCount is below 2, REMIND. A reminder cannot be sent again once nudgeCount reaches 2, and a reminder at WINDOW_LAST comes too late to matter, so in either of those cases ESCALATE and let a person act. When you REMIND, give the reason that matches pickupCode (NO_PICKUP_YET for PICKUP_NONE, PARTIAL_PICKUP for PICKUP_SOME). When you ESCALATE, give NUDGES_EXHAUSTED if nudgeCount is 2, otherwise DEADLINE_NEAR. When you WAIT, give WINDOW_EARLY. The KEY below fixes what each value means.

V3 (reason named per action; weakest, 18 accepted):

> JUDGEMENT: Reason from what is left to try. Count the chances: time left (WINDOW_FULL has the most, WINDOW_LAST the least) and reminders left (nudgeCount 2 means none). If a lot of time is left, WAIT with reason WINDOW_EARLY. If time is running down (WINDOW_MOST or WINDOW_LITTLE) and a reminder is still available, REMIND, with reason NO_PICKUP_YET when pickupCode is PICKUP_NONE and PARTIAL_PICKUP when it is PICKUP_SOME. If no reminder is left, ESCALATE with reason NUDGES_EXHAUSTED. If the window is at its last stage, ESCALATE with reason DEADLINE_NEAR, since there is no time for a reminder to work. Do not choose a reason that is not true of the input. The KEY below fixes what each value means.

V4 (selected; this is `FOLLOWUP_JUDGEMENT_DIRECTIVE` in `file-adviser.js`):

> JUDGEMENT: Your job is to get this delivery acknowledged before the window closes, so choose the smallest action that does it. Reminders are the cheap tool and a person is the expensive one: use the cheap tool while it still exists, and the expensive one when it does not. If nudgeCount is 2, no reminder is left at any stage of the window, so ESCALATE. Otherwise, if the window is at its last stage (WINDOW_LAST), a reminder comes too late, so ESCALATE. Otherwise, if the window is only at its start (WINDOW_FULL), WAIT. In every other case (WINDOW_MOST or WINDOW_LITTLE, with reminders left) the window is shrinking and nothing has been fully collected, so REMIND now rather than wait. Name the reason that is true of the input: the pickup state for a reminder, NUDGES_EXHAUSTED or DEADLINE_NEAR for an escalation, WINDOW_EARLY for waiting. The KEY below fixes what each value means.

Honest note on form: V4 states the reason for each branch in words (cheap tool before expensive tool, a late reminder cannot work, no reminder left) but its branches are ordered and close to a decision rule. That is what made the 4B both active and coherent in this run; principle-only wording (V3, and the earlier "principles" variant) did not.

## What the profile changes

- `FOLLOWUP_PROMPT=directive` (exact string, read at each call from `process.env`) replaces only the `JUDGEMENT:` line of the follow-up system prompt. Any other value, case variant, padded value or unset variable yields today's prompt, byte-identical (test asserts sha256 `4cd4068e...926d13f`, 3988 characters).
- `ADVICE_KINDS.followup.boundary` is still the original string. New: `followupBoundary(env)` and `ADVICE_KINDS.followup.boundaryFor`; `requestFileAdvice` uses `boundaryFor(process.env)` when a kind defines it. The route kind is untouched.

## What it does not change

- The model still cannot choose who is contacted, cannot approve, extend or send anything; its output stays untrusted data.
- Schema, projection keys (`taskAlias`, `snapshotVersion`, `timeCode`, `nudgeCount`, `pickupCode`), route kind, `validateFollowupAdvice` (reason coherence, nudge budget, `PICKUP_ALL` rule) are unchanged; fixed code still validates every answer.
- The opt-in floor `FOLLOWUP_FLOOR` (`followup-floor.js`) still applies after the adviser answers.
- The system text contains no identifier-like content (test: no UUID, address, URL, long hex or long number, in either profile).

## Limitations

- 4B only; the hosted 120B was NOT tested with the new prompt and must be tested before the profile is recommended for it.
- One run per variant per input at temperature 0; no run-to-run or model-version variance measured. Four variants only, selected on the same 24 inputs they were measured on (selection bias; no held-out set).
- The fixture is not ground truth; agreement with it is not accuracy. No claim is made that the profile is better in general, only that on these 24 inputs it was active and the validator accepted all 24 answers.
- 12 of the earlier 36 inputs were unreachable (`PICKUP_ALL`), so earlier counts are not directly comparable.
- No cloud or hosted-model calls were made; the local server was stopped afterwards.

## Verification

- `node --check file-adviser.js`
- `node --test scripts/followup-prompt-profile.test.mjs scripts/file-adviser.test.mjs scripts/local-adviser-outlet.test.mjs scripts/model-negative.test.mjs scripts/delivery-followup.test.mjs` : 45 pass, 0 fail.
