# Official Rule Alignment

Review date: 2026-09-07
Sources: [Official rules](https://nebiusglobalaihackathon.devpost.com/rules) and [overview](https://nebiusglobalaihackathon.devpost.com/), reviewed 2026-09-07. Alignment is a project assessment, not organizer approval.

## Latest Submission Decision (Supersedes Readiness Claims Below)

Official rules sections 4 and 6 were rechecked on 2026-09-07. This is a dated interpretation, not a fresh rules check. The user subsequently reports sending the organizer clarification email; an answer is pending.

- Local recording plus a downloadable functional test build is a valid submission direction; hosting the application is not mandatory. Runtime Token Factory inference satisfies the platform route, but synthetic responses do not.
- Judges may choose not to test, but free testing access must remain available through judging. Video alone does not replace a test-build/demo URL.
- Private development may stay private. The public submission repository must include necessary working source, assets, license and instructions; mock files or a wrapper dependent on undisclosed private core code are insufficient.
- Do not publish API keys, existing bearer credentials, operational stores or private logs. Synthetic test identities should be generated during setup.
- Submission materials require English or English translations, including video, descriptions and testing instructions.
- MCP is a tool boundary, not automatic novelty. Humans approve recipients, models propose routes, and fixed code enforces authorization and cryptography. Real model usefulness versus deterministic routing needs evidence.
- Current state: bounded real NVIDIA/Nebius calls are recorded in the red/white defense material, including failed calls and separate successful retests. No superiority to rules or production security claim follows. Current release review supersedes historical export passes; remote visibility is not established by this review.
- Remaining delivery: accessible test-build URL, public functional source, short public video, platform feedback, dated prior-work disclosure and free judge-access clarification.
- Unresolved organizer question: does a local test build requiring judges to supply their own paid/provider key satisfy free unrestricted testing, and which access alternative is acceptable without exposing developer keys? Obtain organizer clarification; do not assume BYO-key-only access is sufficient.

Recommended separation: private development assets; public reproducible functional submission; public video/screenshots. This review neither authorizes publication nor changes repository visibility.

## Required Platform Use

Official requirement:

- Submissions must run on either Nebius Token Factory or Nebius AI Cloud.
- The rules explicitly accept a runtime Token Factory inference API call. Nebius compute deployment is an alternative; Serverless deployment is encouraged, not mandatory for Best Apps and Agents.

Project alignment:

- The backend policy route calls Nebius Token Factory through an OpenAI-compatible chat completions API.
- Demo fallback is clearly labeled as non-submission evidence when the provider key is not configured.

Status: integration exists; retain reproducible real-call evidence. A hosted Nebius deployment is not an additional mandatory condition for the API integration route.

## Required NVIDIA Open Source Model Use

Official requirement:

- Submissions must use at least one NVIDIA open source model.

Project alignment:

- The configured model is `nvidia/nemotron-3-super-120b-a12b`.
- NVIDIA Nemotron provides bounded code-only route proposals, not permission decisions or document analysis.

Status: aligned after real Token Factory call evidence, pending final demo narration.

## Track Fit

Best fit:

- Best Apps and Agents Track.

Reason:

- The project is a usable enterprise workflow app: sender enclave, decode gate, transport shell, audit dashboard, timed credential, and one-way delivery dry-run.
- It uses Nemotron on Nebius for restricted route proposals. Its added value over fixed rules remains limited and must not be overstated.

Status: aligned.

## Working Demo Requirement

Official requirement:

- Provide a working demo, hosted application, or test build.

Project alignment:

- Local working demo exists.
- Hosted demo remains pending.

Status: pending reviewer-accessible URL for a working demo or test build. A loopback URL alone is not accessible to judges.

## Demo Video Requirement

Official requirement:

- Provide a publicly visible YouTube demo video, with a target duration below three minutes.
- Show the application working; explain Nebius and NVIDIA usage in the submission. Narration is our presentation recommendation.

Project alignment:

- Demo should show three flows: sender sealing, timed credential decode, and audit/fallback evidence.
- Narration must explicitly state that AI sees only non-content metadata.

Status: pending.

## Public Repository Requirement

Official requirement:

- Submit a publicly accessible code repository URL.
- Repository must include an open source license visible at the top of the repository page.
- README must include setup instructions and clear guidance for running the project.

Project alignment:

- MIT license exists.
- README setup instructions exist.
- Local Git repository exists.
- Historical export passes do not clear current code; see security-gate-summary.md.
- GitHub visibility is not changed or verified by this preparation.

Status: candidate preparation only; no publication clearance.

## Feedback Requirement

Official requirement:

- Provide feedback on Nebius Token Factory, AI Cloud, and any NVIDIA tools, models, or technologies used.

Project alignment:

- Feedback text is not written yet.

Status: pending.

## Pre-Existing Project Disclosure

Official requirement:

- If the project existed before the submission period, include a written explanation of what was significantly updated during the submission period.

Project alignment:

- This is a new independent repo extracted from the older Shared Room MCP direction.
- README already states that this is a new hackathon-oriented framework extracted from the Shared Room MCP direction.

Status: disclosure started; list the concrete changes and their dates in the final submission. A new repository name alone does not establish a new project.

## Submission Readiness

- Pending: public repository URL, reviewer-accessible demo/test-build URL, public YouTube video, platform feedback, and dated prior-work disclosure.
- Use synthetic input for the demo and show real provider mode separately from demo fallback.
- Keep claims consistent with README: simulated transport, local bearer identities rather than SSO/device attestation, and no hardware enclave.
- Eligibility and organizer acceptance have not been independently established by these technical checks.
