# Zeabur Deployment

Written 2026-09-18, revised 2026-09-24. Modelled on the Shared Room MCP deployment already running
on Zeabur. Status: deployed on 2026-09-24 at `https://zero-trust-edge-enclave.zeabur.app`, with a
Token Factory key, a spending cap and a judge sign-in.

## What Zeabur Runs

One Node process. `server.js` serves the API and the four pages in `public/` (sender, decode,
audit, admin), plus the judge sign-in page, from the same origin, so there is no separate frontend service to deploy. There are
no third-party runtime packages, so there is no build step: `zbpack.json` starts
`node scripts/start-hosted.mjs`.

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
| `DEMO_FALLBACK_ENABLED` | `false` | The default is `true`, which returns a synthetic result carrying its own warning that it is not submission evidence. A demo should fail visibly instead of quietly serving that. The one exception is the spending-cap fallback, which the page labels. |
| `NODE_ENV` | `production` | Makes `TOKEN_SIGNING_SECRET` mandatory, so credentials survive a restart. |
| `TRUST_PROXY` | `true`, only after confirming the platform proxy overwrites `X-Forwarded-For` | Without it every client arrives from the proxy's address, so the failed sign-in throttle and the judge sign-in limit act on all judges together: one noisy client could lock the others out for a minute. With it set behind a proxy that does not overwrite the header, a client could spoof its address. Check which case applies before enabling. |
| `FILE_TASK_LIMIT` | `300` | Staged file deliveries are kept indefinitely and the instance refuses the next one (507 `Local file staging quota reached`) once this many exist; the default of 50 is used up quickly by a demo that many people try. Worst case disk use is this number times the largest file (5 MiB); check the volume. `scripts/hosted-capacity.mjs` shows the count. |
| `EDGE_SECRET` | Zeabur secret, at least 32 characters; the same value is the Cloudflare Worker's `EDGE_SECRET` | Makes the server believe the visitor address that the edge (`deploy/cloudflare-edge/`) forwards in `X-Verified-Client-IP`, only together with a matching `X-Origin-Auth`. Without it the platform proxy's address is what the throttles see. |
| `REQUIRE_EDGE` / `EDGE_REDIRECT_TO` | `true` / `https://enclave.jace0423.com` | Requests that go around the edge (the platform address) are not served: a GET or HEAD is sent with a 307 to the same path on `EDGE_REDIRECT_TO`, anything else gets 403; `/api/health` stays open. Needs `EDGE_SECRET`; the server will not start without it. Set only after the edge address is verified. |
| `REQUIRE_DEMO_GATE` | `true` | Puts the judge sign-in in front of every page and API route except `/api/health`. |
| `DEMO_GATE_USER` / `DEMO_GATE_PASSWORD` | Zeabur secrets | The judge sign-in. Given to judges in the file uploaded privately with the submission. |
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
in the file uploaded privately with the submission, and the spending cap bounds what a shared credential can cost.

## Owner Smoke Test (credentials stay in your terminal)

`scripts/hosted-smoke.mjs` runs one synthetic delivery end to end against the hosted instance and prints one `PASS`/`FAIL` line per step: health (adviser provider, whether the demo fallback is off, budget), judge sign-in, identities, staging, approval, worker routing, which provider answered (from the evidence trail), recipient decrypt, refusal of a non-recipient, and revoke. Configuration comes only from the process environment; nothing is read from a `.env` file, and no token, password, cookie, key or ciphertext is printed.

```bash
SMOKE_BASE_URL=https://<host> SMOKE_TOKEN_DIR=<private-dir> \
SMOKE_GATE_USER=<user> SMOKE_GATE_PASSWORD=<password> \
SMOKE_EXPECT_PROVIDER=nebius_token_factory node scripts/hosted-smoke.mjs
```

`<private-dir>` holds `manager-sender.token`, `sales-a.token` and `sales-b.token` (mode 0600, directory not group or other readable). It makes one real Token Factory call per routing decision, so the cost is a fraction of a cent. The task it creates expires after 15 minutes and is revoked at the end; the sealed packet stays on the volume (access is closed, not deleted).

## The public address and the edge

The site is reached at https://enclave.jace0423.com, a Cloudflare Worker (`deploy/cloudflare-edge/`) that forwards to this service's
platform address and adds the visitor's real address behind a shared secret (see SECURITY.md, "Client addresses behind an edge").
The platform address `zero-trust-edge-enclave.zeabur.app` stays as the Worker's origin; with `REQUIRE_EDGE=true` and
`EDGE_REDIRECT_TO`, links that still carry it are sent on to the public address. To roll back, unset `REQUIRE_EDGE` and
`EDGE_REDIRECT_TO`: both addresses then serve directly.

## Extending the authorizations

The authorizations' end date (`--until` when the registry was prepared) lives in the registry on the hosted volume, which is
read from `HOSTED_REGISTRY_B64` only when the volume has none, so changing the variable does not move it. Use the administrator
interface instead: `node scripts/hosted-extend-grants.mjs` (a dry run) and then `--apply`, run by the owner in their own terminal
(it asks for the judge sign-in and reads `admin.token` from the private token directory; it prints no credential and only ever moves a
date later). Each changed authorization moves to the next version, so deliveries approved before the change stop opening and the
recipient inbox shows them as expired; deliveries made afterwards are unaffected.
