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
- A hosted call that is refused before it is sent (no `NEBIUS_API_KEY`, outlet misconfigured) is reported as
  the local failure, with the local outlet as `source` and retryable, because the hosted outlet was never reached.
- Validator, nudge budget and floor apply unchanged to whichever answer is used.

## LOCAL_ONLY

Hosted is never reachable from an edge-only deployment. Two layers:

1. `createFileAdviser` throws `CASCADE_REQUIRES_LOCAL_ONLY_FALSE` (and logs
   `ERROR adviser local_then_nebius refused at start-up: ...`) when `COORDINATOR_PROVIDER` is the cascade
   value and `localOnly` is not exactly `false`. In `server.js` that is the call at start-up, so the process
   does not come up.
2. If the environment is switched after start-up, the request path still never asks the hosted outlet
   (`hostedBlocked`), and requestFileAdvice's own `FILE_EXTERNAL_INFERENCE_DISABLED` guard remains behind it.

The cascade therefore needs `LOCAL_ONLY=false`. That setting is also what opens the two legacy hosted
paths (README "Scope of the five-field promise"), so set `LEGACY_HOSTED_ADVICE=off` with it.

## Evidence And Logs

- Trail entry (`adviceTrail`, shown by `taskEvidence`): `source` is the outlet that actually answered or
  failed last (`nebius_token_factory`, or `synthetic_fixture` when the budget was spent); `cascade` is
  `{ from: 'local_openai_compatible', reason: 'LOCAL_UNREACHABLE' | 'LOCAL_REJECTED' }`. The marker is
  checked against that closed list on write (`recordAdvice`) and on read (`taskEvidence`); free text, an
  unknown `from`, or a marker next to a local `source` is dropped. A local answer has `cascade: null`.
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

- The worker retries an unreachable adviser (routing: 3 times, 30 s apart; follow-up: its own cadence). Each
  retry is a new adviser call and, if the local runtime is still down, a new hosted call. The per-call limit
  is one; the per-decision ceiling is that limit times the retries, bounded in money by the spending cap.
- A local outage plus a spent cap lets the synthetic fixture decide (a ROUTE on the first channel for a
  first check). It is recorded as `synthetic_fixture` with the cascade marker. Hosted mode already behaves
  this way when the cap is spent.
- The hosted model sees the five fields only after the local model failed; the provider-side visibility
  risk in `docs/compliance/ai-governance.md` section 10 applies to those calls.
- Nothing measured here: no live run of the cascade against LM Studio or Token Factory was made.

## Verify

```bash
node --test scripts/cascade-outlet.test.mjs
```

No network is used. Both outlets are answered by injected transports; the global `fetch` is replaced by a
guard that only passes `127.0.0.1`, and one case drives a real refused connection on a closed loopback port.

## Wiring For The Lead

`server.js` was not edited (it is being refactored elsewhere).

**Required wiring: none for the cascade to work.** `createFileAdviser({ nebiusBudget, localOnly,
localModelBaseUrl, localModelName, nebiusBaseUrl, nebiusModel })` (currently `server.js` line 1065) already
passes everything the cascade needs and reads `COORDINATOR_PROVIDER` and `NEBIUS_API_KEY` on each call. After
the refactor, keep passing exactly those six values and do not pass `localRequest` or `hostedRequest` (they
exist for tests; absent, both outlets use the global `fetch`). `createFileAdviser` must stay on the
start-up path, because the `LOCAL_ONLY` refusal is a throw from it. The legacy coordinator `recommend`
(`process.env.COORDINATOR_PROVIDER === 'nebius'`) is not enabled by the cascade value, which is intended.

**Proposed `env.sample` lines** (commented, next to the other optional lines):

```
# Off by default. local_then_nebius: ask the local model first and the hosted model only if the local call failed or its answer is unusable (same five fields, at most one hosted call per decision). Needs LOCAL_ONLY=false and NEBIUS_API_KEY; with LOCAL_ONLY=true the server refuses to start. LOCAL_ONLY=false also opens the legacy hosted paths, so set LEGACY_HOSTED_ADVICE=off with it. See docs/agent/cascade-outlet.md.
# COORDINATOR_PROVIDER=local_then_nebius
```

**Optional follow-ups outside the files this change owned** (nothing breaks without them, but they would
describe the cascade wrongly):

- `public/app.js` (`showModelRuntime`, line 17) and `public/audit.js` (line 38) key the status label on
  `adviserProvider === 'local_openai_compatible'` or `'nebius'`; for `local_then_nebius` both fall through to
  "Local simulation; no real model call" or "Demo", which is wrong because a real local model is called.
- `scripts/hosted-smoke.mjs` `providerLabel()` and its `PROVIDERS` list do not know the new value.
- `/api/health` already reports `adviserProvider: 'local_then_nebius'` and the existing `localOutlet*`,
  `nebius*` fields; no new field is required.
