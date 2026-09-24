# Zeabur Deployment

Written 2026-09-18, revised 2026-09-24. Modelled on the Shared Room MCP deployment already running
on Zeabur. Status: deployed on 2026-09-24 at `https://zero-trust-edge-enclave.zeabur.app`, with a
Token Factory key, a spending cap and a judge sign-in.

## What Zeabur Runs

One Node process. `server.js` serves the API and the four pages in `public/` (sender, decode,
audit, admin) from the same origin, so there is no separate frontend service to deploy. There are
no third-party runtime packages, so the build is `npm ci` against a lockfile-free tree plus
`npm start`.

Zeabur detects Node from `package.json`; no Dockerfile is required. `engines` requires Node 20.11
or newer.

## Environment Variables

| Variable | Deployed value | Why |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | The local default stays `127.0.0.1`. That default is deliberate — a developer running this on a laptop should not expose it — so the loopback binding is overridden per deployment rather than changed in code. |
| `PORT` | supplied by Zeabur | Already read from the environment. |
| `DATA_DIR` | `/data` | Must point at a mounted volume. Without one, ciphertext, wrapped keys, the access registry and the audit trail are lost on every restart. |
| `LOCAL_ONLY` | `false` | Both halves of the switch are on, so judges see real Token Factory advice rather than the synthetic fixture. |
| `COORDINATOR_PROVIDER` | `nebius` | A key alone would not enable inference; this is the other half. |
| `NEBIUS_API_KEY` | Zeabur secret | The project owner's key. Its exposure is bounded by the spending cap below, not by leaving it out. |
| `NEBIUS_BUDGET_USD` | `20` | Spending ceiling for the Token Factory outlet. See Spending Cap. |
| `NEBIUS_PRICE_INPUT_PER_M` / `NEBIUS_PRICE_OUTPUT_PER_M` | `0.30` / `0.90` | USD per million tokens. Input matches the owner's billing; output is set above the billed 0.80 so the cap trips early rather than late. A budget without prices counts as spent. |
| `NEBIUS_BASE_URL` | `https://api.tokenfactory.nebius.com/v1` | The adviser refuses any other host. |
| `NEBIUS_MODEL` | `nvidia/nemotron-3-super-120b-a12b` | Must start with `nvidia/` or the adviser refuses it. |
| `TOKEN_SIGNING_SECRET` | Zeabur secret | Signs timed decode credentials. |
| `DEMO_FALLBACK_ENABLED` | `false` | The default is `true`, which returns a synthetic result carrying its own warning that it is not submission evidence. A demo should fail visibly instead of quietly serving that. |
| `NODE_ENV` | `production` | Makes `TOKEN_SIGNING_SECRET` mandatory, so credentials survive a restart. |
| `REQUIRE_DEMO_GATE` | `true` | Puts the judge sign-in in front of every page and API route except `/api/health`. |
| `DEMO_GATE_USER` / `DEMO_GATE_PASSWORD` | Zeabur secrets | The judge sign-in. Given to judges in the submission's testing instructions. |
| `HOSTED_REGISTRY_B64` | hash-only registry | A registry prepared locally with `setup-local.mjs --business --until`. It carries token hashes only; the plaintext role tokens stay with the owner and go to judges with the sign-in. Installed only when the volume has no registry. |

`LOCAL_MODEL_BASE_URL` and `LOCAL_MODEL_NAME` are for the loopback outlet and have no meaning on a
hosted instance: that outlet only accepts loopback hosts, by design.

## Post-Deploy Verification

`GET /api/health` is unauthenticated and reports posture without reporting any secret value:

```json
{ "ok": true, "project": "zero-trust-edge-enclave", "localOnly": false,
  "nebiusConfigured": true, "nebiusBaseUrl": "...", "nebiusModel": "...",
  "demoFallbackEnabled": false,
  "nebiusBudget": { "limited": true, "limitUsd": 20, "spentUsd": 0, "exhausted": false } }
```

`nebiusConfigured` is `!localOnly && Boolean(NEBIUS_API_KEY)`, so it answers "is real inference
actually enabled", not "was a key pasted somewhere". Expect `localOnly: false`,
`nebiusConfigured: true`, `demoFallbackEnabled: false`. Any other combination means the deployment
is not demonstrating what the submission claims.

## Volume

`DATA_DIR` holds `tasks.json`, `packages.json`, `audits.json`, the access registry, and the
`private-keys` directory created by the local key vault. The vault refuses a directory whose mode
allows group or other access, and refuses a symlinked path.

`.gitignore` and `.zeaburignore` both exclude `data/`, so nothing from a local run is ever uploaded;
the deployed instance generates its own.

The volume also keeps `server.lock` between containers. A deployment on 2026-09-24 crash-looped on a
leftover lock until Zeabur suspended the service, and two changes came out of it. `zbpack.json`
starts the wrapper with `exec`, so Node rather than `sh` is pid 1 and the platform's stop signal
reaches it; the wrapper forwards it to the server, whose shutdown handler removes the lock. A lock
that survives anyway, after a kill, is cleared unless its pid leads its own thread group and is
running `server.js`: a bare `kill(pid, 0)` also succeeds for a thread id, and container pid
numbering is deterministic, so the wrapper's own threads could occupy the pid the old server held.

## Spending Cap

Token Factory documents no per-key spending limit, and a card-backed balance may go negative before
the card is charged, so the ceiling is enforced in `nebius-budget.js`. All three call sites share
one ledger in `DATA_DIR`. Each call reserves its worst case on disk before the request leaves, then
settles to the `usage` the provider reports; a crash between the two can only overstate spending.
A call whose worst case would cross the ceiling is never sent, and the advisers fall back to the
synthetic fixture instead. The ledger lives on the volume, so a restart does not reset it.

## Quota Exposure

The deployed key is the project owner's. Beyond the spending cap, provider calls are bounded by
controls that already exist:

- every page and route that can reach a provider sits behind the judge sign-in and a bearer token
- staged file tasks are capped at 50 (`507` beyond that)
- `maxAttempts` is validated to 1–5 per grant, so the routing pass asks at most five times per task;
  an adviser that cannot be reached on the first check adds at most three retries, 30 seconds
  apart, before the job pauses, and a failure before any request leaves is not retried
- the follow-up pass asks a bounded number of further times: it applies only to `REQUIRED_ACK`
  deliveries that someone has not yet collected, stands down at the deadline, and reconsiders at the
  midpoint of what is left with a floor of an eighth of the window, which is four decision points
  from approval; when the adviser keeps failing it retries three times a minute apart and then halves
  toward the deadline, so failures add a logarithmic number of calls, not one a minute
- each request carries an abort deadline and a token ceiling, five seconds and 512 hosted

Both callers together therefore stay bounded: about nine provider calls per task when the adviser
answers (five routing, four follow-up), somewhat more when it keeps failing, and the 50-task cap puts the worst case in the hundreds,
not an open endpoint. The spending cap stops it outright before that. The follow-up pass is
counted here because it is a second caller on a schedule `maxAttempts` does not govern.

## Security Posture Of A Hosted Instance

The threat model states that a compromised backend is outside this prototype's protection boundary,
and that the key service shares the app host and process. Locally that sentence means "the laptop".
Deployed it means "the Zeabur instance", and the wrapped keys and vault master key live on that
instance's disk.

A hosted instance is therefore a demonstration surface for synthetic documents only. The fixture
generators mark every document `MOCK_TEST_DATA_DO_NOT_USE` and use `@example.com` addresses; that
property must hold for anything uploaded to a deployed instance. The model advice it serves is real;
the documents and identities are not.

## Judge Access

Judges need a bearer token to operate the sender and recipient pages, and sharing one makes it a
shared credential. The deployment answers that with two layers. An outer sign-in (`demo-gate.js`)
keeps anonymous traffic away from the billed outlet; the browser holds an HMAC derived from the
sign-in, never the password, and changing either value signs every session out. Inside it, each
role still presents its own token, checked against the hash-only registry. The registry's grants
run to 2026-12-16, past the end of judging. Both the sign-in and the role tokens are given to judges
in the testing instructions, and the spending cap bounds what a shared credential can cost.
