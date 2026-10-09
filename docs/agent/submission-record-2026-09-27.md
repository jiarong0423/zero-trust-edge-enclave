# Submission Record, 2026-09-27

Zero-Trust Edge Enclave was submitted to the Nebius x NVIDIA Global AI Hackathon, track Best Apps
and Agents, on 2026-09-27. Deadline: 2026-10-30 10:00 PDT.

## What was submitted

| Item | Value |
| --- | --- |
| Demo video | https://youtu.be/klBuNhS5eYM (1:47, public) |
| Hosted demo | https://zero-trust-edge-enclave.zeabur.app (judge sign-in) |
| Code | https://github.com/jiarong0423/zero-trust-edge-enclave (MIT) |
| Judge access | Uploaded to the Devpost "Additional info" page, which is visible to judges and organizers only |

The judge package holds the site sign-in, three role tokens (manager-sender, sales-a, sales-b),
the three synthetic sample files from `docs/demo/samples/` and an English walkthrough. It does not
hold the administrator token. None of it is committed here.

## Demo video

The narration was rewritten to fit the 1:47 cut rather than stretching the picture. Voice is Gemini
2.5 Flash TTS; the English subtitles are burned into the picture. Pro TTS was tried and rejected: it
reads about a fifth slower, and the audit section needed 27.5 seconds against 22.8 on screen.

Sections, in order: sender approves a delivery for Sales A only; Sales A decrypts in the browser;
Sales B, signed in but not picked, is denied; the follow-up adviser on Nemotron 3 Super through the
Nebius Token Factory API and the evidence chain; a fake model that adds a recipient is refused; the
same contract on Nemotron 3 Nano 4B on the local machine; the judge sign-in page.

The local section was recorded against a separate server on port 3345 with
`COORDINATOR_PROVIDER=local_openai_compatible`, `LOCAL_ONLY=true`, no environment file and a
fresh data directory, so no hosted data or provider key was involved.

## Latency shown in the video

| Outlet | Latency | Source |
| --- | --- | --- |
| Super 120B, Nebius Token Factory | 1.1 to 1.8 s | 6 calls, 2026-09-18, `SECURITY_SCAN_EVIDENCE.md` |
| Nano 4B, local, warm | 2.6 to 3.5 s | 6 calls, 2026-09-27, routing and follow-up |
| Nano 4B, local, first run | 6.1 to 6.4 s | 2 calls, 2026-09-27, first routing and follow-up after start |

All eight local calls were accepted by the validator (routing ROUTE APPROVED_CHANNEL, follow-up
WAIT NO_PICKUP_YET).

## Corrections made on the way

- The Devpost form for this hackathon has no "Testing instructions" field. An earlier draft assumed
  one; judge access goes through the private file upload instead.
- One Devpost answer still quoted the retired local latency of 3.7 to 4.1 s; it now reads 2.3 to
  2.7 s with reasoning turned off.

## Update 2026-10-09: code and hosted instance

The submission itself is unchanged. What changed afterwards, in the repository and on the hosted instance:

| Item | State |
| --- | --- |
| GitHub `main` | `4098255` (was `7001730`, 27 commits, fast-forward) |
| Hosted instance | redeployed from the `4098255` tree on 2026-10-09; owner ran `scripts/hosted-smoke.mjs` against it: 12 of 12 steps passed with the Token Factory provider, a non-recipient was refused (403) and the task was revoked; the spend ledger was kept across the redeploy |
| Tests | 595 in the full suite (`npm run test:all`), 117 in `npm test`; a candidate built from `public-export-manifest.md` (211 files) passes the same 595 |
| Fixed since the submission | the first reminder notice could be lost when the follow-up pass replaced it; IPv6 clients were refused when a network allowlist was set; half-typed tokens counted toward the sign-in lock; a request body that never completed could stall the serial API queue |
| Added, all off by default | OIDC sign-in (run once against Keycloak 26.0 on loopback http, with a sign-in button), signed webhook notices, a failure-driven local-then-hosted cascade, tooling for human-labelled answers, department and id shown next to every candidate recipient |
| Not changed on the hosted instance | SSO, webhook and cascade are not configured there. `LEGACY_HOSTED_ADVICE` was on at the 2026-10-09 redeploy and was set to `off` later the same day (environment variable plus a restart, no new upload; `/api/health` then reported `legacyHostedAdviceOff: true`), so on the hosted instance both legacy paths now answer from local code. The default for a local run is unchanged: on |

The Devpost description and the video are still the versions of 2026-09-27 until the owner replaces them; the replacement drafts are kept with the project notes, not in this repository. Known limits are in `README.md`, `docs/agent/sso.md`, `docs/agent/webhook-notices.md` and `docs/agent/cascade-outlet.md`.

## After judging

- Rotate the judge role tokens from the administrator page.
- Delete the local credential packages used for recording and judging.
- `public/judge-login.html` still says the tokens are listed in the submission's testing
  instructions; they are in the uploaded file. Harmless, fix at the next deploy.
