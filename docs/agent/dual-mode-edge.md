# Dual-Mode: Edge And Hosted

Written 2026-10-08, from the code at this revision. The project runs in two modes that share one
contract. Which mode is active is configuration.

- **Edge mode.** The adviser is NVIDIA Nemotron 3 Nano 4B (`nvidia-nemotron-3-nano-4b`) on the same
  machine as the backend, behind a loopback-only OpenAI-compatible runtime. Adviser calls do not leave
  the host. Intended for organisations that keep files inside a private network (hospitals, defence,
  enterprises). This is a design goal, not a deployment: no such organisation uses this prototype.
- **Hosted mode.** The adviser is NVIDIA Nemotron 3 Super 120B (`nvidia/nemotron-3-super-120b-a12b`)
  on Nebius Token Factory. This is what the hosted judge demo uses.

Where edge mode has been run: a Mac mini (model identifier Mac14,12; Apple M2 Pro, 10 cores; 16 GB of
memory; macOS 26.6.2) with LM Studio, which serves Nemotron 3 Nano 4B (2.84 GB on disk) on loopback. That is
a small always-on host of the kind edge mode targets: the application, the models and the data live on the
host, and users reach it from their own devices through one private address or one domain (a headless
server plus a browser; see `private-network-deployment.md` for `HOST`, TLS, `TRUST_PROXY` and
`ALLOWED_CLIENT_CIDRS`). Measured there: median 2.85 s per follow-up decision. Not measured: memory in use,
power draw, throughput under load. Not run on NVIDIA edge hardware (Jetson, DGX Spark). Beyond the
measurements above, what this document says about edge behaviour is what the code guarantees.

## Comparison

| | Edge mode | Hosted mode |
| --- | --- | --- |
| Adviser model | Nemotron 3 Nano 4B | Nemotron 3 Super 120B |
| Where the adviser runs | Same machine as the backend, via an OpenAI-compatible runtime on a loopback address | Nebius Token Factory (`https://api.tokenfactory.nebius.com/v1`) |
| What leaves the host for the adviser | Nothing. The request goes to a loopback address | Five pseudonymous fields per decision, over https |
| Key needed | None. The loopback outlet is never given the cloud key | `NEBIUS_API_KEY` held by the backend |
| `COORDINATOR_PROVIDER` | `local_openai_compatible` | `nebius` |
| `LOCAL_ONLY` | `true` | `false` |
| Median latency measured, follow-up decision, 2026-10-08 | 2856 ms (min 2575, max 7835), LM Studio llama.cpp runtime 2.46.0, one Mac, reasoning off | 987 ms (min 746, max 1483) |
| Outlet rule enforced in code | Loopback hosts only (`127.0.0.1`, `::1`, `[::1]`, `localhost`); model name must match `^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$` | `https`, host `api.tokenfactory.nebius.com`, no port, an API key present, model name starting `nvidia/` |
| Spending control | Not applicable | USD cap enforced in code (`nebius-budget.js`); a spent budget falls back to the synthetic adviser |
| Evidence | [Follow-up comparison](followup-adviser-comparison-2026-10-08.md) | Same |

The outlet rules are the `accepts` functions in `ADVISER_PROVIDERS` (`file-adviser.js`). Both outlets
also require a base URL with no credentials, query or fragment and the path `/v1`.

## The Single Contract

Both modes go through `requestFileAdvice` in `file-adviser.js`:

- One projection of five pseudonymous fields per decision. Routing: `taskAlias`, `snapshotVersion`,
  `channels`, `state`, `attempts`. Follow-up: `taskAlias`, `snapshotVersion`, `timeCode`,
  `nudgeCount`, `pickupCode`. An exact-key check and format checks reject anything else before dispatch.
- One system boundary text per decision (`FILE_ADVISER_BOUNDARY`, `FOLLOWUP_ADVISER_BOUNDARY`), one
  output schema per decision, and one validator per decision (`validateFileAdvice`,
  `validateFollowupAdvice`). The adviser's answer is untrusted data; the validator decides what is
  valid, and the backend re-verifies identity, authorization, revocation, snapshot version, channel
  allowlist, expiry and retry budget on every dispatch.
- Only the endpoint rule and the request shape (`json_object` for Token Factory; `json_schema`,
  `reasoning_effort: 'none'` and `temperature: 0` for the local runtime) differ.

The adviser never receives the document, the recipient, the address or a key, in either mode.

A third, opt-in value, `COORDINATOR_PROVIDER=local_then_nebius`, combines the two without changing the
contract: the local model is asked first, and the hosted model is asked only when the local call failed
(see [Cascade](#cascade-opt-in)). Nothing is cascaded by default.

## What The Models Did (Measured)

36 synthetic follow-up inputs through the production path, one run each (full table in the
[comparison record](followup-adviser-comparison-2026-10-08.md)):

| | Fixture | Local 4B | Hosted 120B |
| --- | --- | --- | --- |
| Accepted by the validator | 36 | 34 | 36 |
| WAIT / REMIND / ESCALATE | 16 / 8 / 12 | 34 / 0 / 0 | 31 / 4 / 1 |

Both models are passive near the deadline. The fixture is a blunt stand-in, not ground truth. The
design does not rely on the adviser being decisive: fixed code decides who is contacted, the countdown
schedules decisions, the validator checks coherence, and the opt-in floor `FOLLOWUP_FLOOR=true`
(`followup-floor.js`) escalates an accepted WAIT at `WINDOW_LAST` to a person with reason
`DEADLINE_NEAR`, whichever model answered. This record does not claim the model beats rules.

## Switching Modes

Both sets of variables are read in `server.js`.

Edge mode:

| Variable | Value | Effect |
| --- | --- | --- |
| `COORDINATOR_PROVIDER` | `local_openai_compatible` | Adviser calls go to the local outlet |
| `LOCAL_MODEL_BASE_URL` | `http://127.0.0.1:1234/v1` (default) | Must be a loopback host and the path `/v1`, otherwise `FILE_PROVIDER_UNAVAILABLE` |
| `LOCAL_MODEL_NAME` | `nvidia-nemotron-3-nano-4b` (default) | Model name sent to the runtime |
| `LOCAL_ONLY` | `true` (default; anything other than the string `false` counts as true) | Blocks the Token Factory outlet with `FILE_EXTERNAL_INFERENCE_DISABLED`; the loopback outlet is not blocked by it |

Hosted mode:

| Variable | Value | Effect |
| --- | --- | --- |
| `COORDINATOR_PROVIDER` | `nebius` | Adviser calls go to Token Factory |
| `LOCAL_ONLY` | `false` | Required; a key alone does not enable the outlet |
| `NEBIUS_API_KEY` | set privately on the backend | Never committed, never sent to the loopback outlet |
| `NEBIUS_BASE_URL`, `NEBIUS_MODEL` | defaults `https://api.tokenfactory.nebius.com/v1`, `nvidia/nemotron-3-super-120b-a12b` | Other values are refused by the outlet rule |
| `NEBIUS_BUDGET_USD`, `NEBIUS_PRICE_INPUT_PER_M`, `NEBIUS_PRICE_OUTPUT_PER_M` | optional | Spending cap; see [Zeabur deployment](zeabur-deployment.md) |

`COORDINATOR_PROVIDER=synthetic_fixture` (the default) issues no model request in either mode.
There is no automatic fallback between edge and hosted: each value above uses one outlet, and an edge
deployment whose local model is down pauses and retries rather than calling the hosted model. The only way
to get a second outlet is the explicit cascade below.
`GET /api/health` reports `localOnly`, `adviserProvider`, `localOutletBaseUrl` and `localOutletModel`.

## Cascade (Opt-In)

`COORDINATOR_PROVIDER=local_then_nebius` asks the local Nemotron 3 Nano 4B first and asks Nemotron 3 Super
120B on Token Factory only when the local call failed. It is off unless that exact value is set.

| Local call | What happens |
| --- | --- |
| Valid answer, any action (including WAIT, ESCALATE, PAUSE) | Final. The hosted model is not called |
| Unreachable: refused connection, timeout, transport error | Hosted model asked once; marker `LOCAL_UNREACHABLE` |
| Unusable output: HTTP error, empty, oversized or unparseable body, or an answer the validator refuses | Hosted model asked once; marker `LOCAL_REJECTED` |
| Refused before any request (misconfigured local URL, rejected metadata) | Error; the hosted model is not called |

The trigger is failure only. The models return no confidence value, so there is nothing to threshold on.
What the hosted model receives is the same five-field projection and the same system text the local model
received (`scripts/cascade-outlet.test.mjs` test "the hosted model receives the identical five-field projection and boundary the local model received"),
over https to `api.tokenfactory.nebius.com` with the backend key; the loopback call never carries the key.
The validator, the nudge budget and the floor apply to whichever answer is used. A spent Token Factory
budget falls to the synthetic fixture, as in hosted mode.

It needs `LOCAL_ONLY=false`; with `LOCAL_ONLY=true` the server refuses to start in this mode and the request
path would not ask the hosted outlet anyway, so an edge-only deployment can never reach the hosted model
through it. `LOCAL_ONLY=false` also lets the two legacy paths reach the hosted model unless
`LEGACY_HOSTED_ADVICE=off` (see the README section "Scope of the five-field promise"); set it. The evidence trail
records the outlet that answered in `source` and, after a cascade, `cascade: { from, reason }`; the sender page
shows both. Full description, log lines, limits and the wiring note: [cascade outlet](cascade-outlet.md).

## Air-Gapped Profile

Settings for a host that keeps adviser traffic and file traffic on a private network. Copy, then fill
in the host-specific values; secrets are set privately and are not shown here.

```bash
# Backend listens on the private interface only, with its own certificate.
HOST=10.0.0.5
PORT=3344
DATA_DIR=/var/lib/enclave-data
TLS_CERT_FILE=/etc/enclave/cert.pem
TLS_KEY_FILE=/etc/enclave/key.pem
# Refuse every client outside the private networks (loopback is not implicit).
ALLOWED_CLIENT_CIDRS=10.0.0.0/24
# Edge adviser: loopback runtime, no external inference, no key.
LOCAL_ONLY=true
COORDINATOR_PROVIDER=local_openai_compatible
LOCAL_MODEL_BASE_URL=http://127.0.0.1:1234/v1
LOCAL_MODEL_NAME=nvidia-nemotron-3-nano-4b
# Optional: escalate a WAIT at the last part of the window to a person.
FOLLOWUP_FLOOR=true
```

Run with `npm start`. Set `TOKEN_SIGNING_SECRET` privately if `NODE_ENV=production` (`server.js`
requires it). Add `TRUST_PROXY=true` only behind a proxy that overwrites `X-Forwarded-For`. TLS is
required beyond loopback because the document key travels in a JSON body and Web Crypto needs a
secure context; the reasoning is in [private-network deployment](private-network-deployment.md), which
also covers the failed sign-in throttle (`auth-throttle.js`), the allowlist (`network-policy.js`) and
the prepared-notice outbox (`notice-outbox.js`, a file for an operator's own gateway; the application
sends no email).

What the code enforces for this profile:

- A non-loopback `LOCAL_MODEL_BASE_URL` is refused before any request, even under the local provider name.
- With `LOCAL_ONLY=true` the Token Factory outlet is refused, so a stray `COORDINATOR_PROVIDER=nebius`
  cannot send a request.
- In the backend's top-level `.js` files, the only request sites are the Token Factory calls (each
  behind `localOnly`) and the adviser outlet request. `server.js` gives the loopback outlet its own
  endpoint and model and passes it no API key.
- A client outside `ALLOWED_CLIENT_CIDRS` gets 403 before any route runs, pages and `/api/health`
  included.

What the code does not do: it does not isolate the host from the internet, it does not install or
start the local model runtime, and it does not make a deployment certified. There is no independent
KMS or TEE; whoever controls the backend controls the keys. Documents and keys still reach the
backend over the private network (see the table in [private-network deployment](private-network-deployment.md)).

## Verified And Not Verified On Edge Hardware

Verified:

- The local outlet ran against LM Studio (llama.cpp runtime 2.46.0 for the 2026-10-08 follow-up
  measurement) with `nvidia-nemotron-3-nano-4b` on one Mac. Follow-up decisions: 34 of 36 accepted,
  median 2856 ms. The README also records an earlier
  measurement after the 2026-09-24 LM Studio change: 40 of 40 accepted at 2.3 to 2.7 s per call.
- The outlet rules, the key not reaching the loopback outlet and the allowlist are covered by unit
  tests that need no model and no network (commands below).
- The local outlet's behaviour changed with the LM Studio engine version, not the weights; a different
  runtime can behave differently.

Not verified:

- Any run on a Jetson or another NVIDIA edge device. No latency, memory or accuracy figure exists
  for such hardware.
- Any run with a runtime other than LM Studio.
- Any deployment inside a hospital, defence or enterprise network.
- Any comparison against ground truth: the fixture is not ground truth.

## What You Can Verify Yourself

No network or model is needed for the tests:

```bash
node --test scripts/local-adviser-outlet.test.mjs   # loopback rule, key never lent to loopback
node --test scripts/file-adviser.test.mjs           # both outlets, validator, request shape
node --test scripts/cascade-outlet.test.mjs         # opt-in cascade: triggers, one hosted call, LOCAL_ONLY, key, projection
node --test scripts/network-policy.test.mjs         # ALLOWED_CLIENT_CIDRS
node --test scripts/followup-floor.test.mjs         # FOLLOWUP_FLOOR
node --test scripts/*.test.mjs                      # full suite
```

With the server running (default `http://127.0.0.1:3344`):

```bash
curl -s http://127.0.0.1:3344/api/health            # localOnly, adviserProvider, localOutletBaseUrl
```

With a loopback runtime loaded, the server logs one line per adviser call
(`adviser followup local_openai_compatible <model> <ms>ms <ACTION> <REASON>`), which shows the outlet,
model and latency actually used.
