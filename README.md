# Zero-Trust Edge Enclave

MIT-licensed local hackathon prototype for encrypted document handoff with a restricted AI adviser. Extracted from the Shared Room MCP direction; not a production security certification.

## Why This Boundary

Data residency rules, the US CLOUD Act and EU AI Act Article 10 make "send the document
to an API" the wrong answer for regulated material. The usual response is to move every
workload on-premises. This prototype takes the other route: keep the workload where it
is and bound what crosses.

What crosses to the model: `taskAlias`, `snapshotVersion`, `channels`, `state`,
`attempts`. Five pseudonymous workflow fields, validated by exact-key and format checks;
anything else is rejected before dispatch.

What never crosses: the document, the recipient, the address, the key.

The adviser's small surface is the design, not an unfinished part. A model is the
component an injected instruction attacks, so it cannot also be the component that
enforces the boundary. Work on tool-using agents converged on the same answer between
2024 and 2026 — enforce with deterministic policy outside the model rather than training
it to refuse — and supervision is moving the same way, with FINRA treating AI agents as a
distinct risk category and the AI AGENT Act of 2026 requiring human approval for
sensitive transactions. The backend here re-verifies identity, authorization, revocation,
snapshot version, channel allowlist, expiry and retry budget on every dispatch, and the
whole workflow completes with `COORDINATOR_PROVIDER=synthetic_fixture` and no model at
all.

Limits: this is a local prototype, not a certified deployment. There is no independent
KMS or TEE. The five metadata fields do reach Nebius Token Factory; only the document
content, recipient identity, address and keys are kept inside the boundary.

## Current Workflow

1. Import a sender credential and choose an existing authorization.
2. Select DOCX, PDF or CSV bytes (up to 5 MiB). Browser encryption happens without a document-content preview.
3. Review department-filtered recipients and channels. Confirm twice against the same immutable snapshot; changes require fresh confirmation.
4. A backend worker prepares simulated email notices with bounded retries. AI advice passes fixed authorization checks.
5. The authenticated recipient obtains ciphertext and a separate short-lived, one-use key ticket, decrypts in the browser and downloads the original file.
6. Receipt reports distinguish verification, download request and acknowledgement. None proves reading or legally effective delivery.

REQUIRED_ACK adds no extra file cutoff but never bypasses grant expiry or revocation. TIME_LIMITED rejects new access at its approved deadline. Released bytes, keys and plaintext cannot be recalled.

## Run Locally

Requires Node.js 20.11 or newer; no third-party Node runtime packages.

```bash
npm run setup:local
npm test
SKIP_LOCAL_ENV=true LOCAL_ONLY=true npm run dev
```

Open http://127.0.0.1:3344/ or http://127.0.0.1:3344/zh-TW/. The language button switches the current page without reloading.

Import generated operator.token on the sender page and select local-review. Import recipient-a.token on the recipient page; recipient-b is intentionally unauthorized. Setup generates private random tokens and refuses existing files. These are local bearer identities, not enterprise SSO.

For a separate departmental demo with an administrator:

```bash
node scripts/setup-local.mjs data-business --business
SKIP_LOCAL_ENV=true LOCAL_ONLY=true DATA_DIR=data-business npm run dev
```

Use a new private directory and a free port. Do not share a running server's data directory. Import admin.token only on admin.html for department, person and grant administration. Business setup provides procurement and audit grants.

## NVIDIA / Nebius

Default mode is synthetic_fixture with no model request. Real file-task advice requires LOCAL_ONLY=false, COORDINATOR_PROVIDER=nebius and a backend NEBIUS_API_KEY. A key alone does not enable it. Configure an untracked environment file using env.sample; never place secrets in Git, browser code or model context. Start without SKIP_LOCAL_ENV=true only when deliberately loading that private configuration.

The configured model is nvidia/nemotron-3-super-120b-a12b through Nebius Token Factory. The file adviser receives exactly taskAlias, snapshotVersion, channels, state and attempts. It cannot read documents, addresses, real identities or keys, change recipients, extend expiry or authorize execution.

[Red/white defense material](docs/ai-generated/2026Q3/human-ai-boundary-material_20260907.md) separates real model calls, input rejection and injected-output gate tests. Earlier failed calls remain disclosed. These results do not prove superiority to deterministic routing, general injection resistance or compatibility with an untested local model.

## Architecture

Three views. Each is drawn from the implementation, not from intent: the state names come from the
audit allowlist in `audit-boundary.js`, the resumable reason codes from `task-operations.js`, and the
adviser projection from `file-routing.js`.

**What each party can reach.** Plaintext exists only on the two human devices. The adviser sits
outside the boundary and is reached by two dashed edges and nothing else.

![Trust boundary](docs/assets/architecture-trust-boundary.svg)

**The order things happen in.** Sixteen messages from browser-side encryption to receipt reporting.
The adviser lifeline ends at step 5: it is absent for the key exchange, the decryption and the
reporting that follow.

![Delivery sequence](docs/assets/architecture-sequence.svg)

**What a task can do next.** Ten states and the reason codes that decide whether a paused job may
resume. `RETRY_EXHAUSTED` and `DELIVERY_WINDOW_CLOSED` both stop a job, for different reasons: the
first has spent its attempts, the second still has attempts but the download window closed first.

![Task state machine](docs/assets/architecture-state-machine.svg)

Polling is drawn as polling. The sender's page asks the backend once a second; there is no push
channel, and none is claimed.

The stdio MCP adapter exposes metadata-only file_status/file_recommend and legacy compatibility tools. It cannot deliver file bytes or release credentials. See [MCP permissions](MCP_SERVER_ALLOWLIST.md).

Backend storage includes ciphertext AND wrapped keys. The key service shares the app host and process: a compromised backend is outside this prototype's protection boundary. No independent KMS or hardware enclave is claimed.

## Verification And Limits

```bash
npm run check
npm test
node scripts/generate-business-fixtures.mjs
```

Tests use isolated synthetic stores and no provider requests. The fixture generator creates synthetic CSV and native-document source data, never reads user documents, and refuses differing existing outputs. Optional native rendering/browser testing is documented in [local workflow](docs/agent/local-workflow.md).

Email remains dry-run. No enterprise identity, malware inspection of ciphertext, legal signature or multi-host delivery guarantee is implemented. Legacy text/passphrase endpoints are compatibility paths, not this file workflow.

[Security](SECURITY.md) | [Threat model](THREAT_MODEL.md) | [Release review](docs/agent/security-gate-summary.md) | [Export manifest](public-export-manifest.md)

Publication and free judge access remain pending release review and organizer clarification.
