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
| `LOCAL_ONLY` | `false` | Left at the default `true`, every route recommendation is `synthetic_fixture` and a judge cannot observe a real provider call. |
| `COORDINATOR_PROVIDER` | `nebius` | A key alone does not enable inference; this is the second half of the switch. |
| `NEBIUS_API_KEY` | Zeabur secret | Backend only. Never in Git, never in browser code, never in model context. |
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
- `maxAttempts` is validated to 1–5 per grant, so each task retries at most five times
- each request carries a five-second abort and `max_tokens: 512`

Worst case is therefore in the low hundreds of calls, not an open endpoint.

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
