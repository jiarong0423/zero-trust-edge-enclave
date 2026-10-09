# Cascade Outlet (Opt-In)

Written 2026-10-08, from the code at this revision. `COORDINATOR_PROVIDER=local_then_nebius` asks the
local edge model first (`nvidia-nemotron-3-nano-4b`, LM Studio on loopback) and asks the hosted model
(`nvidia/nemotron-3-super-120b-a12b`, Nebius Token Factory) only when the local call failed. It is off
unless that exact value is set. Every other `COORDINATOR_PROVIDER` value behaves as before.

## When The Hosted Model Is Asked

The trigger is failure, never confidence: the models return no confidence value, so there is nothing to
threshold on.

| Local call | Result | Hosted model |
| --- | --- | --- |
| Valid answer, any action (ROUTE, PAUSE, WAIT, REMIND, ESCALATE) | Used. A WAIT or ESCALATE is a decision, not a doubt | Not called |
| Refused connection, timeout, transport error (`FILE_PROVIDER_UNREACHABLE`) | Cascade, marker `LOCAL_UNREACHABLE` | Asked once |
| HTTP error status, empty, oversized or unparseable body (`FILE_PROVIDER_RESPONSE_REJECTED`) | Cascade, marker `LOCAL_REJECTED` | Asked once |
| Answer the validator refuses (`adviceRejected`) | Cascade, marker `LOCAL_REJECTED` | Asked once |
| Refused before any request: misconfigured local URL, rejected metadata (`FILE_PROVIDER_UNAVAILABLE`, `FILE_METADATA_REJECTED`, `FOLLOWUP_METADATA_REJECTED`) | Error, not retried | Not called |

`LOCAL_REJECTED` also covers an HTTP error status from the local runtime (for example a model that is not
loaded), not only a validator refusal; the enum has two values and this is how the second is defined.
A misconfigured local endpoint is deliberately not a trigger: it is an operator error, and quietly asking
another outlet would change where data goes without anyone having chosen it.

At most one hosted request is made per adviser call (`createFileAdviser`'s returned function), no loops,
no hosted retry inside the call. What the hosted call returns or throws is final for that call.

**The coordinator tool `file_recommend` never reaches the hosted model.** `POST /api/coordinator/call` with
`file_recommend` can be repeated at will and leaves no entry in the sender's evidence trail, so under the
cascade it is answered by the local outlet only (`routes/coordinator.js` passes `{ hosted: false }`): a local
failure is returned as the local failure and the console line ends `cascade=NO_HOSTED_FOR_TOOL`. Only the
delivery worker's own calls (routing and follow-up), which are recorded on the trail with the cascade marker,
can cascade. Test: "file_recommend under the cascade is answered by the local outlet alone" (five calls with
the local outlet down, zero hosted requests) and the real-server test of the same name in
`scripts/cascade-outlet.test.mjs`. `COORDINATOR_PROVIDER=nebius` is unchanged: `file_recommend` still calls the
hosted model there, bounded by `NEBIUS_BUDGET_USD` only.

## What Is Sent Where

- Local call: the five-field projection for the decision, to the loopback `LOCAL_MODEL_BASE_URL`. No
  credential header; the cloud key is never placed in the local outlet's options.
- Hosted call (only after a local failure): the identical projection and the identical system text,
  through the existing Token Factory outlet (`https`, `api.tokenfactory.nebius.com`, backend key) and the
  spending-cap fetch (`nebiusBudget.fetch`). Nothing is added: routing sends `taskAlias`, `snapshotVersion`,
  `channels`, `state`, `attempts`; follow-up sends `taskAlias`, `snapshotVersion`, `timeCode`, `nudgeCount`,
  `pickupCode`.
- A spent Token Factory budget (checked only when a cascade is about to happen) answers from the synthetic
  fixture, exactly as `COORDINATOR_PROVIDER=nebius` does. No hosted request is made.
- A reservation refused by the cap while the ledger is still below the limit (for example spent 0.0049 of
  0.005 USD, where the worst case of one request no longer fits) is treated the same way: the hosted request is
  not sent, the synthetic fixture decides, and the trail says `synthetic_fixture` with the cascade marker. The
  console shows the refused hosted attempt (`... FILE_PROVIDER_UNREACHABLE cascade=LOCAL_UNREACHABLE
  NEBIUS_BUDGET_EXHAUSTED`) followed by the fixture line. Before this fix such a refusal was recorded as a
  hosted failure and the decision paused after four attempts. This applies to the cascade only;
  `COORDINATOR_PROVIDER=nebius` still reports a refused reservation as a hosted failure.
- A hosted call that is refused before it is sent (no `NEBIUS_API_KEY`, outlet misconfigured) is reported as
  the local failure, with the local outlet as `source` and retryable, because the hosted outlet was never reached.
- A hosted key that cannot be an HTTP header value (a CR, LF or NUL, or a character above Latin-1) is such a
  pre-request refusal: `FILE_PROVIDER_UNAVAILABLE`, marked `ADVICE_NO_RETRY`, never sent, and the key text is
  not in the message or the logs. A key with surrounding spaces is still sent (the header value is trimmed).
- One deadline covers a cascaded call: 10 s in total (`CASCADE_DEADLINE_MS`). The local attempt may use at most
  75 % of it (7.5 s); the hosted attempt gets what is left, never more than its own 5 s limit, and is skipped if
  nothing is left. A call that fails fast leaves the hosted attempt its full 5 s. So the stall one adviser call
  can put on the shared API queue is bounded at 10 s, like the local outlet alone; the unbounded sum (10 s local
  hang + 5 s hosted hang = 15 s) no longer occurs. The cost: in cascade mode a local call that needs more than
  7.5 s (a cold first call was measured up to about 8 s) counts as unreachable and cascades.
- Validator, nudge budget and floor apply unchanged to whichever answer is used.

## Start-Up Preconditions

`createFileAdviser` refuses to build, logs `ERROR adviser local_then_nebius refused at start-up: <code>` and
throws, so `server.js` does not come up, when `COORDINATOR_PROVIDER` is the cascade value and any of these is
missing (checked in this order, `cascadeStartupProblem()`):

| Code | Missing | Why |
| --- | --- | --- |
| `CASCADE_REQUIRES_LOCAL_ONLY_FALSE` | `LOCAL_ONLY=false` | Hosted is never reachable from an edge-only deployment |
| `CASCADE_REQUIRES_LEGACY_HOSTED_ADVICE_OFF` | `LEGACY_HOSTED_ADVICE=off` (exactly) | `LOCAL_ONLY=false` also opens `POST /api/policy/recommend` to the hosted model, which sends more than the five fields; a cascade that promises the five-field projection must close it. `server.js` passes `legacyHostedAdviceOff` in |
| `CASCADE_REQUIRES_TOKEN_FACTORY_BUDGET` | `NEBIUS_BUDGET_USD` > 0 with both `NEBIUS_PRICE_INPUT_PER_M` and `NEBIUS_PRICE_OUTPUT_PER_M` > 0 | A cascade can reach the hosted model on every local failure and the worker retries; an unbounded cascade is a spend risk |

If the environment is switched after start-up, the request path still never asks the hosted outlet under
`LOCAL_ONLY` (`hostedBlocked`), and `requestFileAdvice`'s own `FILE_EXTERNAL_INFERENCE_DISABLED` guard remains
behind it. Tests: "the cascade refuses to start without a usable Token Factory budget", "the cascade refuses
to start while the legacy hosted paths are open", and the real-server test that starts `server.js` and sees it
exit with each code.

`COORDINATOR_PROVIDER` is matched against its four values (`synthetic_fixture`, `nebius`,
`local_openai_compatible`, `local_then_nebius`) as own properties. Any other value, including the names every
object has (`constructor`, `__proto__`, `toString`), is refused per call as `FILE_PROVIDER_UNAVAILABLE`, not
retried, and start-up logs one `WARN adviser COORDINATOR_PROVIDER "..." is not one of ...` line. Start-up does
not fail for it.

## Evidence And Logs

- Trail entry (`adviceTrail`, shown by `taskEvidence`): `source` is the outlet that actually answered or
  failed last (`nebius_token_factory`, or `synthetic_fixture` when the budget was spent); `cascade` is
  `{ from: 'local_openai_compatible', reason: 'LOCAL_UNREACHABLE' | 'LOCAL_REJECTED' }`. The marker is
  checked against that closed list on write (`recordAdvice`) and on read (`taskEvidence`); free text, an
  unknown `from`, or a marker next to a local `source` is dropped. A local answer has `cascade: null`.
- Stored values are read back through the same allowlists they are written with (`file-worker.js`
  `normalizeAdviceSource()`, `storedCascade()`): an unknown or non-string `source` is shown as no outlet, and a
  marker next to any source other than `nebius_token_factory` or `synthetic_fixture` is dropped. The page looks
  labels up as own properties only, so a stored `constructor` or `__proto__` cannot print as a function.
- The sender evidence chain (steps 3 and 4) appends "After the local model gave no answer" or "After the
  local answer was unusable" to the outlet label, with zh-TW strings in `public/i18n.js`.
- The local failure itself is not a separate trail entry; the marker is how the trail says it happened.
  The console has both: one line per outlet call, codes only, never the alias.

```
ERROR adviser route local_openai_compatible nvidia-nemotron-3-nano-4b 12ms FILE_PROVIDER_UNREACHABLE cascade=LOCAL_UNREACHABLE
adviser route nebius_token_factory nvidia/nemotron-3-super-120b-a12b 981ms ROUTE APPROVED_CHANNEL cascade=LOCAL_UNREACHABLE
```

Both fail: the second line is `ERROR adviser route nebius ... FILE_PROVIDER_RESPONSE_REJECTED cascade=LOCAL_UNREACHABLE`, and the error
carries source `nebius_token_factory` with the marker. Under LOCAL_ONLY after start-up the local failure
line ends `cascade=BLOCKED_LOCAL_ONLY` and nothing else is asked.

## Limits

- The worker retries an unreachable adviser (routing: 4 attempts in all, the first plus 3 retries, at least 30 s
  apart (`ADVICE_RETRY_LIMIT`, `ADVICE_RETRY_MS`); follow-up: its own cadence). Each
  retry is a new adviser call and, if the local runtime is still down, a new hosted call. The per-call limit
  is one; the per-decision ceiling is that limit times the retries, bounded in money by the spending cap.
- A local outage plus a spent cap lets the synthetic fixture decide (a ROUTE on the first channel for a
  first check). It is recorded as `synthetic_fixture` with the cascade marker. Hosted mode already behaves
  this way when the cap is spent.
- The status labels (`public/app.js`, `public/audit.js`, state from `cascadeState()` in `public/i18n.js`) name the
  cascade in three states, never "no model is called": ready (local first, Token Factory if it fails), budget
  spent (a local failure is answered by the synthetic adviser), and no usable Token Factory key (only the local
  model is called; on failure the task is retried, then paused).
- The hosted model sees the five fields only after the local model failed; the provider-side visibility
  risk in `docs/compliance/ai-governance.md` section 10 applies to those calls.
- Nothing measured here: no live run of the cascade against LM Studio or Token Factory was made.

## Verify

```bash
node --test scripts/cascade-outlet.test.mjs
```

No network is used. Both outlets are answered by injected transports; the global `fetch` is replaced by a
guard that only passes `127.0.0.1`, and one case drives a real refused connection on a closed loopback port.
Two tests start the real `server.js` as a child process (loopback hosted mock, the Token Factory host rewritten to
it by a preload, any other non-loopback address refused): one for the start-up refusals, one for `file_recommend`
sending nothing to the hosted mock while the local outlet is down.

## A real run, 2026-10-10

Before this the cascade had been exercised only against mocks. It was then run for real on one Mac: the backend
with `COORDINATOR_PROVIDER=local_then_nebius`, `LOCAL_ONLY=false`, `LEGACY_HOSTED_ADVICE=off`, a 0.5 USD budget, the
local outlet `nvidia-nemotron-3-nano-4b` in LM Studio and the hosted outlet `nvidia/nemotron-3-super-120b-a12b` on
Token Factory. Each run was one full delivery of a synthetic file (`scripts/hosted-smoke.mjs`, 11 of 11 steps passed
each time).

| Run | Local model | What happened to the routing decision |
|---|---|---|
| 1 | loaded, first call after idle | the local call did not answer within its share of the deadline (7.5 s), the log says `cascade=LOCAL_UNREACHABLE`, and Token Factory answered in 1.7 s; the follow-up decision that came after was answered locally in 5.6 s |
| 2 | loaded and warm | answered locally in 3.7 s; Token Factory was not called |
| 3 | server stopped (connection refused in 5 ms) | Token Factory answered the routing decision in 1.3 s and the follow-up in 1.0 s |

Total spend across the three runs: 0.000856 USD. Findings: the fallback works in all three shapes; the first local
call after the model has been idle can take longer than the local share, so a cold edge model costs one cloud
call; warming the model before use avoids it. The evidence trail names the outlet that answered in every run.
Single machine, three runs, a synthetic file: this shows the mechanism works, not how often each path is taken.

## Wiring

`server.js` passes `legacyHostedAdviceOff` to `createFileAdviser({ nebiusBudget, localOnly, localModelBaseUrl,
localModelName, nebiusBaseUrl, nebiusModel, legacyHostedAdviceOff })`; the cascade reads `COORDINATOR_PROVIDER`,
`NEBIUS_API_KEY` and the budget variables from the environment. Do not pass `localRequest`, `hostedRequest` or
`cascadeDeadlineMs` (tests only). `createFileAdviser` must stay on the start-up path because the refusals above
are throws from it. The legacy coordinator `recommend` (`process.env.COORDINATOR_PROVIDER === 'nebius'`) is not
enabled by the cascade value, which is intended.

**Proposed `env.sample` lines** (commented, next to the other optional lines; `env.sample` was not part of this change):

```
# Off by default. local_then_nebius: ask the local model first and the hosted model only if the local call failed or its answer is unusable (same five fields, at most one hosted call per decision, 10 s in all). The server refuses to start unless LOCAL_ONLY=false, LEGACY_HOSTED_ADVICE=off and NEBIUS_BUDGET_USD with both prices are set; it also needs NEBIUS_API_KEY for the hosted call to be possible. See docs/agent/cascade-outlet.md.
# COORDINATOR_PROVIDER=local_then_nebius
```

`scripts/hosted-smoke.mjs` `providerLabel()` and its `PROVIDERS` list are owned elsewhere and were not touched here.
