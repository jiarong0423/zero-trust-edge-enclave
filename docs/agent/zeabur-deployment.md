# Zeabur Deployment

Written 2026-09-18. Modelled on the Shared Room MCP deployment already running on Zeabur.
Status: configuration reference only. No deployment has been performed and none is authorized here.

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
| `LOCAL_ONLY` | `true` | The default. Both adviser kinds fall back to `synthetic_fixture`, which is the intended posture for an instance deployed without a key. |
| `COORDINATOR_PROVIDER` | `synthetic_fixture` | The default. A key alone would not enable inference either; both halves of the switch are left off. |
| `NEBIUS_API_KEY` | not set | Deliberately omitted. Without it both advisers stay on the synthetic fixture and issue no provider request, so a hosted instance spends no quota and carries no credential. Evidence for real inference lives in `SECURITY_SCAN_EVIDENCE.md`, measured where the key is held. |
| `NEBIUS_BASE_URL` | `https://api.tokenfactory.nebius.com/v1` | The adviser refuses any other host. |
| `NEBIUS_MODEL` | `nvidia/nemotron-3-super-120b-a12b` | Must start with `nvidia/` or the adviser refuses it. |
| `TOKEN_SIGNING_SECRET` | Zeabur secret | Signs timed decode credentials. |
| `DEMO_FALLBACK_ENABLED` | `false` | The default is `true`, which returns a synthetic result carrying its own warning that it is not submission evidence. A demo should fail visibly instead of quietly serving that. |

`LOCAL_MODEL_BASE_URL` and `LOCAL_MODEL_NAME` are for the loopback outlet and have no meaning on a
hosted instance: that outlet only accepts loopback hosts, by design.

## Post-Deploy Verification

`GET /api/health` is unauthenticated and reports posture without reporting any secret value:

```json
{ "ok": true, "project": "zero-trust-edge-enclave", "localOnly": false,
  "nebiusConfigured": true, "nebiusBaseUrl": "...", "nebiusModel": "...",
  "demoFallbackEnabled": false }
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

## Quota Exposure

The deployed key is the project owner's. Provider calls are bounded by controls that already exist,
so no additional rate limiting was added:

- every route that can reach a provider requires a bearer token
- staged file tasks are capped at 50 (`507` beyond that)
- `maxAttempts` is validated to 1–5 per grant, so the routing pass asks at most five times per task
- the follow-up pass asks a bounded number of further times: it applies only to `REQUIRED_ACK`
  deliveries, stands down at the deadline, and reconsiders at the midpoint of what is left with a
  floor of an eighth of the window, which is four decision points from approval
- each request carries an abort deadline and a token ceiling, five seconds and 512 hosted

Both callers together are therefore bounded at roughly nine provider calls per task, and the
50-task cap puts the worst case in the low hundreds, not an open endpoint. The follow-up pass is
counted here because it is a second caller on a schedule `maxAttempts` does not govern.

## Security Posture Of A Hosted Instance

The threat model states that a compromised backend is outside this prototype's protection boundary,
and that the key service shares the app host and process. Locally that sentence means "the laptop".
Deployed it means "the Zeabur instance", and the wrapped keys and vault master key live on that
instance's disk.

A hosted instance is therefore a demonstration surface for synthetic material only. The fixture
generators mark every document `MOCK_TEST_DATA_DO_NOT_USE` and use `@example.com` addresses; that
property must hold for anything uploaded to a deployed instance.

## Unresolved Before Deploying

Judges need a bearer token to operate the sender and recipient pages. Tokens are generated as files
by `scripts/setup-local.mjs`. Publishing one in the submission makes it a shared credential, bounded
by the 50-task quota and the synthetic-only rule above; not publishing one leaves judges unable to
test. This is the same question already sent to the organizer and still awaiting an answer, so it is
recorded here rather than decided.
