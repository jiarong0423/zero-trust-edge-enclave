# AI Governance

Written 2026-10-08 against branch `improve/2026-10-08`. Re-verified against the code on 2026-10-08 (see `verification-log-2026-10-08.md`).

> **Disclaimer.** A description of how the AI component is bounded in this code, for a reviewer. It is not
> an AI risk assessment, a conformity assessment or a certificate against any AI framework. The project
> holds no certification. Evidence is cited as file plus symbol and as test titles; if a symbol moved,
> `grep -rn '<symbol>' *.js` finds it.

## 1. What The AI Is

Two model-backed "advisers" propose a bounded choice; fixed code validates and decides. A third path,
the deterministic `synthetic_fixture`, needs no model and is the default. Two outlets share one contract
(`file-adviser.js` `requestFileAdvice()`):

| Outlet | Model name as used in code | Where it runs | Selected by |
| --- | --- | --- | --- |
| Hosted | `nvidia/nemotron-3-super-120b-a12b` | Nebius Token Factory (`https://api.tokenfactory.nebius.com/v1`) | `COORDINATOR_PROVIDER=nebius`, `LOCAL_ONLY=false`, `NEBIUS_API_KEY` |
| Local | `nvidia-nemotron-3-nano-4b` | A loopback OpenAI-compatible runtime on the same host | `COORDINATOR_PROVIDER=local_openai_compatible` |
| Cascade (opt-in) | Local first, then hosted | Local call on loopback; a hosted call only after the local call failed | `COORDINATOR_PROVIDER=local_then_nebius`, `LOCAL_ONLY=false`, `LEGACY_HOSTED_ADVICE=off`, `NEBIUS_BUDGET_USD` with both prices, `NEBIUS_API_KEY` |
| None | `synthetic_fixture` | In process | Default |

The cascade is not a third model. It asks the local outlet first, and asks the hosted outlet only when the local call was unreachable (refused connection, timeout, transport error) or its output was unusable (HTTP error, malformed body, or an answer the validator refuses). A valid local answer, including WAIT, ESCALATE or PAUSE, is final and the hosted model is not called. The hosted outlet is asked at most once per adviser call, with the identical five-field projection, and the server refuses to start in this mode unless `LOCAL_ONLY=false`, `LEGACY_HOSTED_ADVICE=off` and a Token Factory budget (`NEBIUS_BUDGET_USD` with both prices) are set (`file-adviser-outlet.js` `cascadeStartupProblem()`). The coordinator tool `file_recommend` is answered by the local outlet only under the cascade, because it leaves no evidence-trail entry. Default off. Details and tests: [cascade outlet](../agent/cascade-outlet.md).

The outlet is chosen per call in `file-adviser-outlet.js` `createFileAdviser()`. The two decisions are asked at different times: **routing** (once a job is approved: send on an approved
channel, or hold) and **follow-up** (only for a delivery that must be acknowledged and has not been
collected).

## 2. What The AI May See

The input is exactly five fields per decision. An exact-key check and per-kind format checks run before
any dispatch, and a violation is rejected with 422 without a network call (`file-adviser.js` `requestFileAdvice()`: `exact(metadata, kind.keys)` and `ADVICE_KINDS.*.accepts`).

Routing projection, produced by `file-routing.js` `fileRoutingMetadata()`:

| Field | Value domain |
| --- | --- |
| `taskAlias` | Random UUID created per snapshot; not derived from any identifier (`private-mapping.js` `createPrivateMapping()`) |
| `snapshotVersion` | Positive integer |
| `channels` | Non-empty subset of `email`, `internal_queue` approved in the snapshot |
| `state` | One of `PENDING_CHECK`, `RETRY_WAIT`, `DRY_RUN_PREPARED`, `PAUSED`, `OUTCOME_UNKNOWN` |
| `attempts` | Integer 0 to 5 |

Follow-up projection, produced by `delivery-followup.js` `followupMetadata()`:

| Field | Value domain |
| --- | --- |
| `taskAlias` | As above |
| `snapshotVersion` | As above |
| `timeCode` | `WINDOW_FULL`, `WINDOW_MOST`, `WINDOW_LITTLE`, `WINDOW_LAST`: a countdown cut at one half, three quarters and seven eighths of the task's own window (`delivery-followup.js` `BAND_EDGES`), never a clock value |
| `nudgeCount` | Integer 0 to 2 (`delivery-followup.js` `MAX_NUDGES`) |
| `pickupCode` | `PICKUP_NONE`, `PICKUP_SOME`, `PICKUP_ALL`: ordinal, never a count |

The adviser never receives the document, ciphertext, file name, recipient identifiers, names, emails,
group codes, headcounts, keys, tokens or deadlines. Evidence: `scripts/delivery-followup.test.mjs` test "the projection is exactly five fields and carries no recipient information";
`scripts/delivery-followup.test.mjs` test "an identical position in different windows yields the same code, so wall-clock never leaks";
`scripts/local-adviser-outlet.test.mjs` test "the local outlet receives the same five-field projection and nothing else";
`scripts/private-mapping.test.mjs` test "group codes never reach the legacy coordinator projection sent to a provider";
`scripts/model-negative.test.mjs` (twelve injection-style inputs, each refused before dispatch with no
network call). The stored inputs are scanned against the task's real identifiers and the count is shown to
the sender (`task-evidence.js` `countRealValues()`; `scripts/task-evidence.test.mjs` test "the leak check is live: a real identifier placed in an adviser input is counted").

Visible to the provider in hosted mode despite the projection (stated in `THREAT_MODEL.md`): the stable
alias per snapshot, the number and timing of calls, the channel names, and the host's network address.

**GAP (scope of the five-field claim):** it covers the file workflow only. `POST /api/policy/recommend`
(`server.js` `callNebiusPolicy()`) and the legacy coordinator `recommend` (`server.js` `coordinatorCall()`) send different, larger inputs
to the hosted model by default when the hosted model is configured: six enumerated policy values for the first, the `safeMetadata` object including one opaque alias per recipient for the second
(control-mapping row 11b). `LEGACY_HOSTED_ADVICE=off` keeps both local (section 7).

## 3. What The AI May Output

Schemas (`file-adviser.js` `ADVICE_KINDS.route.schema` and `ADVICE_KINDS.followup.schema`); fields not listed are refused.

| Decision | Fields | Enumerations |
| --- | --- | --- |
| Routing | `taskAlias`, `snapshotVersion`, `action`, `channel`, `reasonCode` | `action`: `ROUTE`, `PAUSE`. `reasonCode`: `APPROVED_CHANNEL`, `RETRY_ALTERNATIVE`, `INSUFFICIENT_INFORMATION`. `channel` must be one of the supplied channels |
| Follow-up | `taskAlias`, `snapshotVersion`, `action`, `reasonCode` | `action`: `WAIT`, `REMIND`, `ESCALATE`. `reasonCode`: `WINDOW_EARLY`, `NO_PICKUP_YET`, `PARTIAL_PICKUP`, `DEADLINE_NEAR`, `NUDGES_EXHAUSTED`, `INSUFFICIENT_INFORMATION` |

The local outlet asks for the schema as a strict `json_schema` response format with
`reasoning_effort: none` and temperature 0; the hosted outlet asks for `json_object` with thinking
disabled (`file-adviser.js` `ADVISER_PROVIDERS.*.shape`). Only the local outlet constrains decoding to the schema; for the hosted
model the validators below are the sole enforcement. Hosted requests send temperature 1 and top_p 0.95
(`requestFileAdvice()` request body; the local outlet's shape overrides the temperature to 0), so hosted answers can differ from run to run.

## 4. Validators And Fixed-Code Authority

| Control | Behaviour | Evidence |
| --- | --- | --- |
| Routing validator | Exact keys; alias and version must equal the request; action, channel and reason in the allowlists; channel must be in the snapshot | `file-routing.js` `validateFileAdvice()`; `scripts/file-routing.test.mjs` test "file routing exposes only approved codes and rejects stale or expanded advice" |
| Follow-up validator | Exact keys; alias and version must match; nudge ceiling of 2 enforced in code; only WAIT is accepted once everything is collected; a reason that contradicts the input is refused | `delivery-followup.js` `validateFollowupAdvice()`; `scripts/delivery-followup.test.mjs` test "the nudge ceiling is enforced by code, not by the prompt that states it"; `scripts/delivery-followup.test.mjs` test "a completed delivery cannot be chased" |
| Channel choice bounded three times | `validateFileAdvice` accepts only a snapshot channel; `resolvePrivateRoute` re-checks it against the snapshot; `advanceDelivery` checks the grant's channels at dispatch | `file-routing.js` `validateFileAdvice()`, `private-mapping.js` `resolvePrivateRoute()`, `access-control.js` `advanceDelivery()` called from `file-worker.js` `advanceFileJobs()` (`THREAT_MODEL.md`, Adviser steering the route) |
| Recipients never come from the adviser | Targets are resolved from the snapshot mapping and, for reminders, from receipts the adviser never sees | `file-worker.js` `advanceFileJobs()` (`resolvePrivateRoute()`) and `advanceFollowups()` (`outstanding`); `scripts/delivery-followup-worker.test.mjs` test "a reminder passes over whoever already collected, in silence" |
| Authority reloaded after the answer | Registry reloaded; grant, snapshot, operator and recipients re-checked before any effect | `file-worker.js` `advanceFileJobs()` and `advanceFollowups()` (`reloadConfig()`); `scripts/delivery-followup-worker.test.mjs` test "a grant revoked while the adviser was answering stops the reminder it advised" |
| Refused answers | Not stored; only a fixed reason code and a pattern-checked detail are kept; a refused routing answer pauses the job (`ADVICE_INVALID`), a refused follow-up answer is recorded and reconsidered | `file-worker.js` `recordAdvice()`; `scripts/delivery-followup-worker.test.mjs` test "an answer the validator refused is recorded apart from an adviser that never answered" |
| Response handling | No redirects, response capped at 16,384 bytes, deadline 5 s hosted / 10 s local, token ceiling 512 hosted / 1536 local; answer read from `content`, or from `reasoning_content` when `content` is empty, and validated either way | `file-adviser.js` `requestFileAdvice()` (`redirect: 'error'`, the 16,384-byte check, `message.reasoning_content`) and `ADVISER_PROVIDERS.*.timeoutMs` and `maxTokens` |
| Outlet rules | Hosted: https, exact host, no port, key present, model starts `nvidia/`. Local: loopback host only. `LOCAL_ONLY` blocks the hosted outlet | `file-adviser.js` `ADVISER_PROVIDERS.nebius.accepts`, `ADVISER_PROVIDERS.local_openai_compatible.accepts`, `requestFileAdvice()` (`FILE_EXTERNAL_INFERENCE_DISABLED`); `scripts/local-adviser-outlet.test.mjs` test "a non-loopback host is refused even when it claims the local provider"; `scripts/local-adviser-outlet.test.mjs` test "an external outlet stays blocked while LOCAL_ONLY is set". These rules apply to the file-workflow outlet only, not to the two legacy call sites |
| Retry limits | Routing retries an unreachable adviser 3 times, 30 s apart, then pauses for the sender; follow-up retries 3 times a minute apart, then halves toward the deadline | `file-worker.js` `ADVICE_RETRY_LIMIT`, `ADVICE_RETRY_MS`, `FOLLOWUP_QUICK_RETRIES`; `scripts/delivery-followup-worker.test.mjs` test "an adviser that stays down is asked three times a minute apart, then at the halving cadence" |
| Spend cap | Each hosted call reserves its worst case before sending and is refused beyond the ceiling; the fallback is the fixture | `nebius-budget.js` `createBudget()`, `fetch()`; `file-adviser-outlet.js` `createFileAdviser()`; `scripts/nebius-budget.test.mjs` test "budget settles to reported usage, persists, and refuses before crossing the ceiling" |

The model is not the boundary. `THREAT_MODEL.md` and the code comments state that prompt text is not the
security boundary; the validators and the fixed checks above are.

## 5. Human Approval Points

| Point | What a person does | Code |
| --- | --- | --- |
| Recipient and channel selection | The sender chooses recipients and channels from the grant, in a department-filtered directory | `recipient-directory.js` `listRecipients()` |
| Double confirmation | The sender confirms an immutable snapshot twice; any edit invalidates earlier confirmations | `snapshot-lifecycle.js` `confirmFirst()`, `confirmSecond()`, `reviseTask()`; `scripts/snapshot-lifecycle.test.mjs` test "each material edit invalidates prior confirmations and unused token, preserves hash" |
| Resume after a pause | A paused job (adviser unavailable, invalid or pausing; recipient or operator disabled) continues only when the sender requests it | `task-operations.js` `resumeFileTask()`, `resumableReasons` |
| Escalation | `ESCALATE` records `FOLLOWUP_ESCALATED` and an audit event; a person has to look. Nothing is sent or changed | `file-worker.js` `advanceFollowups()` |
| Evidence review | Only the sender opens the adviser evidence chain; each view is audited (at most once a minute per task) | `task-evidence.js` `taskEvidence()`, `server.js` route `GET /api/tasks/<id>/evidence` (`evidenceViews`) |
| Configuration | Choosing the outlet, `LOCAL_ONLY`, `LEGACY_HOSTED_ADVICE` and the follow-up floor is an operator decision at start-up | section 7 |

**GAP:** there is no human review of an individual adviser answer before it takes effect. A ROUTE inside the
approved channel set is executed automatically, by design. **GAP:** no notification is generated for an
escalation or an overdue delivery; the sender sees them only in the page and in the audit trail.

## 6. Logging Of Adviser Calls (Evidence Trail)

- **Per job, persisted in `tasks.json` (`adviceTrail`):** call kind, time, outlet label
  (`nebius_token_factory`, `local_openai_compatible`, `synthetic_fixture`), the exact projection sent, and
  either the validated answer or a refusal code. When the opt-in cascade asked a second outlet, the entry also
  carries `cascade: { from: 'local_openai_compatible', reason: 'LOCAL_UNREACHABLE' | 'LOCAL_REJECTED' }`, a closed
  vocabulary (`file-worker.js` `normalizeCascade()`); `source` still names the outlet that answered. Unreachable-adviser failures are recorded as well
  (`file-worker.js` `recordAdvice()`). Retention: the last 20 entries, 10 per kind.
- **Fixed-code decisions (`followups`):** each follow-up decision with `floor: true/false`, so a floored
  escalation is distinguishable from the adviser's own answer (`file-worker.js` `advanceFollowups()`; `task-evidence.js` `taskEvidence()`).
- **Audit events (`audit.json`):** `DELIVERY_TRANSITION` with reasons such as `ADVISER_UNAVAILABLE`,
  `ADVICE_INVALID`, `ADVICE_PAUSED`; `DELIVERY_FOLLOWUP` with `FOLLOWUP_WAIT`, `FOLLOWUP_REMIND`,
  `FOLLOWUP_ESCALATE`; `EVIDENCE_VIEWED` (`audit-boundary.js` `auditProjection()`).
- **Process log:** one line per call with kind, outlet, model, latency, action and reason, never the alias
  or an identity (`file-adviser-outlet.js` `createFileAdviser()`); failures log an `ERROR adviser` line. In
  the cascade each outlet call has its own line and any line after a local failure ends in
  `cascade=LOCAL_UNREACHABLE` or `cascade=LOCAL_REJECTED`.
- **Computed leak check:** the evidence chain reports how many real identifiers appear in each stored
  input (`task-evidence.js` `countRealValues()`).
- **Not recorded:** the content of a refused answer, the provider's reported token usage per call (only
  the cumulative spend ledger exists), and the model identifier returned by the provider (the comparison
  `diagnostics.responseModelMatches` in `file-adviser.js` `requestFileAdvice()` is a diagnostic that the server does not use; only the opt-in `scripts/model-boundary-smoke.mjs` reads it). **GAP:** entries older than the last
  10 per kind per job are dropped, and there is no export; the process log is not retained by the
  application.

## 7. Opt-In Controls

| Control | Default | Effect |
| --- | --- | --- |
| `COORDINATOR_PROVIDER` | `synthetic_fixture` (no model request) | `nebius`, `local_openai_compatible` or `local_then_nebius` (the cascade) selects an outlet (`file-adviser-outlet.js` `createFileAdviser()`). It also gates the legacy coordinator `recommend` (`nebius` only; the cascade value does not enable it); it does not gate `POST /api/policy/recommend` |
| `LOCAL_ONLY` | on (anything but the string `false`) (`server.js` `localOnly`) | Blocks the hosted outlet with `FILE_EXTERNAL_INFERENCE_DISABLED`; does not block loopback; keeps both legacy paths local. With `COORDINATOR_PROVIDER=local_then_nebius` it stops start-up (`CASCADE_REQUIRES_LOCAL_ONLY_FALSE`; `CASCADE_REQUIRES_LEGACY_HOSTED_ADVICE_OFF` and `CASCADE_REQUIRES_TOKEN_FACTORY_BUDGET` stop it likewise), and the request path never asks the hosted outlet either (`scripts/cascade-outlet.test.mjs` test "under LOCAL_ONLY the cascade never reaches the hosted outlet") |
| `NEBIUS_API_KEY` | unset | A key alone does not enable the hosted file-workflow outlet (that also needs `COORDINATOR_PROVIDER=nebius` and `LOCAL_ONLY=false`). With `LOCAL_ONLY=false` it does enable the hosted call in `POST /api/policy/recommend` whatever `COORDINATOR_PROVIDER` is, unless `LEGACY_HOSTED_ADVICE=off` (`server.js` `callNebiusPolicy()`) |
| `LEGACY_HOSTED_ADVICE` | unset (legacy paths may call the hosted model when it is configured); only the exact string `off` changes behaviour | `POST /api/policy/recommend` and the legacy coordinator `recommend` answer from local code and never call the hosted model (`server.js` `legacyHostedAdviceOff`, `callNebiusPolicy()`, `coordinatorCall()`; `scripts/legacy-hosted-advice.test.mjs` tests "LEGACY_HOSTED_ADVICE=off keeps the legacy policy path entirely local" and "only the exact value off changes behaviour", which cover the policy path; the coordinator path is established by reading the code) |
| `NEBIUS_BUDGET_USD` with prices | unset (no cap) | Spending ceiling; a budget without prices counts as spent (`nebius-budget.js` `createBudget()`, `usable`) |
| `FOLLOWUP_FLOOR` | off; only the exact string `true` enables it (`followup-floor.js` `followupFloorEnabled()`, read at each follow-up pass) | Fixed code turns an accepted WAIT at `WINDOW_LAST` with pickup incomplete (not `PICKUP_ALL`) into ESCALATE `DEADLINE_NEAR`; the adviser's answer stays in the trail (`followup-floor.js` `applyFloor()`, applied in `file-worker.js` `advanceFollowups()`; `scripts/followup-floor.test.mjs` test "the adviser original answer stays in the trail; the floor is recorded apart from it"; `scripts/followup-floor.test.mjs` test "default off: a passive WAIT at WINDOW_LAST with nothing collected stays WAIT") |
| `FOLLOWUP_PROMPT` | unset (original prompt); only the exact string `directive` selects the alternative `JUDGEMENT:` paragraph | Committed on this branch (see section 8); changes follow-up wording only, not what the model sees or may answer (`file-adviser.js` `followupBoundary()`) |
| Outlet endpoint and model | `NEBIUS_BASE_URL`, `NEBIUS_MODEL`, `LOCAL_MODEL_BASE_URL`, `LOCAL_MODEL_NAME` | Values the outlet rule does not accept are refused for the file workflow (`FILE_PROVIDER_UNAVAILABLE`); the two legacy call sites use `NEBIUS_BASE_URL` as given |

## 8. Change Control For Prompts

- The two system prompts are string constants in code (`file-adviser.js` `FILE_ADVISER_BOUNDARY` and
  `FOLLOWUP_ADVISER_BOUNDARY`), so they change only through ordinary commits and the
  commit hook described in `change-and-release-checklist.md`.
- Test coverage of prompt text is partial. **GAP:** no test pins the routing prompt (`FILE_ADVISER_BOUNDARY`):
  a search of `scripts/*.test.mjs` finds no import of it (`scripts/followup-prompt-profile.test.mjs` test "the route kind prompt does not move" asserts only that `ADVICE_KINDS.route.boundary` is a string and has no `boundaryFor`), and tests assert the user message (the projection),
  the request shape, the validators and the outlet rules. The default follow-up prompt is pinned by length
  and SHA-256 in `scripts/followup-prompt-profile.test.mjs` test "default prompt is byte-identical to the original and ADVICE_KINDS.followup.boundary stays a string"; that
  test was committed together with the opt-in profile described below. `scripts/bench-adviser.mjs` imports `FOLLOWUP_ADVISER_BOUNDARY` (to size its spend estimate) and `ADVICE_KINDS`, and the opt-in
  `scripts/model-boundary-smoke.mjs` imports `FILE_ADVISER_BOUNDARY` and asserts the request carries it. A routing-prompt edit is therefore caught by code review, not by the
  suite.
- **Opt-in follow-up prompt profile** (`docs/agent/followup-prompt-profile-2026-10-08.md`,
  `file-adviser.js` `followupBoundary()`, `FOLLOWUP_JUDGEMENT_CURRENT`, `FOLLOWUP_JUDGEMENT_DIRECTIVE`; committed on this branch).
  `FOLLOWUP_PROMPT=directive` (the exact string only,
  read at each call from the environment: `requestFileAdvice()` passes `process.env` to `kind.boundaryFor`) replaces one paragraph, `JUDGEMENT:`, of the
  follow-up system prompt; any other value returns the original text byte for byte
  (`scripts/followup-prompt-profile.test.mjs` test "only the exact string directive activates the profile",
  `scripts/followup-prompt-profile.test.mjs` test "directive swaps only the JUDGEMENT paragraph"). The projection, schema,
  validator and floor are unchanged. Evidence to date is the contributor's note: measured on the local 4B
  only, 24 reachable inputs, one run each, selected on the same inputs it was measured on; the hosted model
  was not tested with it. **GAP:** the adviser evidence trail does not record which prompt profile produced
  an answer (`file-worker.js` `recordAdvice()` stores kind, input, time and outlet), so an answer cannot later be
  tied to a profile except through the process environment at that time.
- Mitigation by design: because the validators and fixed checks are the boundary, a prompt change cannot
  widen what a model may see or do; it can change how often answers are useful or accepted. After any
  prompt change, re-run `node scripts/bench-adviser.mjs` (fixture, no network) and, if a model is
  available, the `--local` or `--cloud --yes-spend` mode, and compare with the record in
  `docs/agent/followup-adviser-comparison-2026-10-08.md`. RECOMMENDATION: add a test that pins the routing
  prompt as the follow-up default is pinned, and record the active profile in the evidence trail.

## 9. Evaluation Evidence In The Repository

| Evidence | What it shows | Limits |
| --- | --- | --- |
| `docs/agent/followup-adviser-comparison-2026-10-08.md` | 36 follow-up inputs, fixture vs local 4B vs hosted 120B on the production path. Validator-accepted: fixture 36, 4B 34, 120B 36. Actions (WAIT / REMIND / ESCALATE): fixture 16 / 8 / 12, 4B 34 / 0 / 0, 120B 31 / 4 / 1. Median latency 4B 2856 ms, 120B 987 ms | One run per input; no ground truth (the fixture is a blunt stand-in); synthetic grid; the 4B ran on one Mac under LM Studio runtime 2.46.0; the result files are git-ignored and not in the repository |
| `scripts/bench-adviser.mjs`, `docs/agent/bench-adviser.md` | Repeatable version of the same 36 inputs. Fixture mode needs no network. Cloud mode needs `--yes-spend` and a key, is capped at 40 calls (`CLOUD_CALL_CAP`) | Cloud mode does not apply the repo's spending ledger |
| `scripts/bench-adviser.test.mjs` | Gates: refusal without `--yes-spend` or key, no key leakage, loopback-only local mode | Does not call a real model |
| `scripts/model-negative.test.mjs`, `scripts/file-adviser.test.mjs`, `scripts/local-adviser-outlet.test.mjs`, `scripts/delivery-followup*.test.mjs`, `scripts/task-evidence.test.mjs` | Input rejection before dispatch, validator behaviour, outlet rules, worker behaviour, evidence chain | Mocked providers; no model quality claim |
| `scripts/live-provider-smoke.mjs`, `scripts/model-boundary-smoke.mjs` | Opt-in live and boundary checks against the hosted outlet (need `--live` and a key) | Not part of the default suite; results are not stored in the repository |
| `README.md`, NVIDIA / Nebius section | Latency and acceptance figures per runtime, with the corrections noted | Figures belong to the stated runtime and date |

Known behaviour: both models are passive on the follow-up task. The 4B answered WAIT for every accepted
input. The 120B waited on most of the inputs where the fixture escalates (REMIND 4, ESCALATE 1). The
design does not depend on the model chasing: fixed code decides who is contacted, the countdown schedules
the decisions, the validator checks coherence, and the opt-in floor escalates a WAIT at the last band. The
record does not show that either model beats a rule, or the reverse.

## 10. Residual Risks

1. **Provider-side visibility (hosted mode).** The five fields, call timing and the host address reach
   Nebius; its retention and training terms are not documented in this repository. Edge mode removes this
   path but has only been run on a Mac mini (Apple M2 Pro, 16 GB) with LM Studio, not on NVIDIA edge hardware.
2. **Unpinned models.** Models are named, not pinned by hash or version; the hosted model can change
   without notice and the code would not detect it (`sbom.md`).
3. **Hosted answers are non-deterministic** (temperature 1) and not schema-constrained; correctness rests on
   the validators, and a change in model behaviour shows up as refusals or passivity, not as an error.
4. **Passivity.** Models may never escalate; mitigated by the countdown, validator and optional floor, not
   removed.
5. **Prompt drift** in the routing prompt is not detected by the suite, and the evidence trail does not record the follow-up prompt profile (section 8).
6. **Legacy endpoints** broaden what reaches the provider by default (control-mapping row 11b); `LEGACY_HOSTED_ADVICE=off` removes that path.
7. **Evidence is capped and local.** The trail keeps the last 10 entries per kind per job; the audit chain
   is unkeyed (`control-mapping.md`, row 7).
8. **No alerting** on escalation or overdue deliveries, and no production quality monitoring.
9. **Automated action within approved bounds.** A ROUTE inside the approved channels executes without a
   per-decision human check.
10. **Extension.** Any new adviser kind must add its own projection, validator and tests; the shared request
    path does not do that automatically.
11. **Cascade (opt-in).** Needs `LOCAL_ONLY=false`, which would also let the legacy paths reach the hosted
    model, so the server refuses to start unless `LEGACY_HOSTED_ADVICE=off` and a Token Factory budget are
    set too. A local outage costs one hosted call per adviser call, and the worker's existing retries (four
    attempts in all for routing) each ask again, so a local runtime that stays down sends the five fields to the
    hosted model on every attempt until the spending cap is spent; a spent cap (or a reservation the cap
    refuses) then answers from the fixture, so a local outage plus a spent cap lets the fixture decide
    (recorded as `synthetic_fixture` with the cascade marker). The coordinator tool `file_recommend` never
    reaches the hosted model under the cascade.
