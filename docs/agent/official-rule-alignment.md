# Official Rule Alignment

Review date: 2026-09-07; rechecked 2026-09-24 and 2026-10-08; submission status 2026-09-27.
Sources: [Official rules](https://nebiusglobalaihackathon.devpost.com/rules) and [overview](https://nebiusglobalaihackathon.devpost.com/), reviewed 2026-09-07. Alignment is a project assessment, not organizer approval.

## 2026-10-08 Recheck

The official page was read again on 2026-10-08. No required item changed since 2026-09-27.

- Submission Period: 2026-08-26 9:00 PT to 2026-10-30 10:00 PT. After it ends, submissions cannot be changed.
- Judging Period: 2026-12-01 9:00 PT to 2026-12-15 12:00 PT. Winners are expected on or around 2027-01-11.
- Stage One is pass/fail: the submission fits the theme and reasonably applies the required APIs.
- Stage Two scores four equally weighted criteria: Technological Implementation, Design, Potential Impact and Quality of the Idea.
- Testing access must be free and unrestricted. The hosted instance and judge access described below remain the means.

## 2026-09-24 Recheck (Supersedes Everything Below Where They Differ)

The rules and overview pages were read again on 2026-09-24.

- The overview's submission list asks for a "Working demo URL (except Physical AI submissions)". The rules accept "a working demo, hosted application, or test build". The stricter reading is followed: a hosted instance is deployed at `https://zero-trust-edge-enclave.zeabur.app`.
- The rules define running on Token Factory as a runtime call to its inference API. The hosted instance makes those calls with the owner's key, under a USD 20 spending cap; Zeabur itself is not Nebius compute and is not claimed as such.
- Free judge access is provided without organizer input: a judge sign-in in front of the site, and per-role tokens behind it, both given in the file uploaded privately with the submission (the form has no testing-instructions field). The earlier organizer question below no longer blocks submission.
- The overview asks for a demo video "with audio covering how you used Nebius Token Factory". Narration is therefore required, not only recommended.

## Submission Decision Of 2026-09-07

Official rules sections 4 and 6 were rechecked on 2026-09-07. This is a dated interpretation, not a fresh rules check. The user subsequently reports sending the organizer clarification email; the 2026-09-24 recheck above made the answer non-blocking.

- Local recording plus a downloadable functional test build is a valid submission direction; hosting the application is not mandatory. Runtime Token Factory inference satisfies the platform route, but synthetic responses do not.
- Judges may choose not to test, but free testing access must remain available through judging. Video alone does not replace a test-build/demo URL.
- Private development may stay private. The public submission repository must include necessary working source, assets, license and instructions; mock files or a wrapper dependent on undisclosed private core code are insufficient.
- Do not publish API keys, existing bearer credentials, operational stores or private logs. Synthetic test identities should be generated during setup.
- Submission materials require English or English translations, including video, descriptions and judge-access material.
- MCP is a tool boundary, not automatic novelty. Humans approve recipients, the model proposes a route and separately whether to chase an unacknowledged delivery, and fixed code enforces authorization and cryptography. Real model usefulness versus deterministic routing needs evidence.
- Current state: bounded real NVIDIA/Nebius calls are recorded in the red/white defense material, including failed calls and separate successful retests. No superiority to rules or production security claim follows. Current release review supersedes historical export passes; remote visibility is not established by this review.
- Remaining delivery: accessible test-build URL, public functional source, short public video, platform feedback, dated prior-work disclosure and free judge-access clarification. All delivered by 2026-09-27; see [the submission record](submission-record-2026-09-27.md).
- Superseded 2026-09-24 by the hosted instance (see the recheck above). Original organizer question: does a local test build requiring judges to supply their own paid/provider key satisfy free unrestricted testing, and which access alternative is acceptable without exposing developer keys? Obtain organizer clarification; do not assume BYO-key-only access is sufficient.

Recommended separation: private development assets; public reproducible functional submission; public video/screenshots. This review neither authorizes publication nor changes repository visibility.

## Required Platform Use

Official requirement:

- Submissions must run on either Nebius Token Factory or Nebius AI Cloud.
- The rules explicitly accept a runtime Token Factory inference API call. Nebius compute deployment is an alternative; Serverless deployment is encouraged, not mandatory for Best Apps and Agents.

Project alignment:

- The backend policy route calls Nebius Token Factory through an OpenAI-compatible chat completions API.
- Demo fallback is clearly labeled as non-submission evidence when the provider key is not configured or the USD 20 cap is spent.

Status: integration exists; retain reproducible real-call evidence. A hosted Nebius deployment is not an additional mandatory condition for the API integration route.

## Required NVIDIA Open Source Model Use

Official requirement:

- Submissions must use at least one NVIDIA open source model.

Project alignment:

- The configured model is `nvidia/nemotron-3-super-120b-a12b`.
- NVIDIA Nemotron provides bounded code-only proposals for two distinct decisions, routing and delivery follow-up, each with its own allowlisted projection and validator. Neither is a permission decision and neither involves document analysis.

Status: aligned; real Token Factory calls recorded, narrated video delivered 2026-09-27.

## Track Fit

Best fit:

- Best Apps and Agents Track.

Reason:

- The project is a usable enterprise workflow app: sender enclave, decode gate, transport shell, audit dashboard, timed credential, and one-way delivery dry-run.
- It uses Nemotron on Nebius for two restricted proposal types. Routing adds little over a fixed rule and that must not be overstated; the follow-up decision has no deterministic equivalent, because when to chase an unacknowledged delivery depends on how time remaining, reminders already ignored and partial collection sit against each other.

Status: aligned.

## Working Demo Requirement

Official requirement:

- Provide a working demo, hosted application, or test build.

Project alignment:

- Local working demo exists.
- Hosted demo deployed 2026-09-24; the repository remains a test build as well.

Status: aligned on 2026-09-24. Hosted instance at `https://zero-trust-edge-enclave.zeabur.app`, behind a judge sign-in, with grants valid to 2026-12-16.

## Demo Video Requirement

Official requirement:

- Provide a publicly visible YouTube demo video, with a target duration below three minutes.
- Show the application working, with audio covering how Nebius Token Factory was used (overview page, rechecked 2026-09-24).

Project alignment:

- The video shows sender approval, recipient decode, a signed-in but unselected recipient being denied, follow-up advice on Token Factory with the evidence chain, a refused fake model, local Nano 4B and the judge sign-in.
- The narration states that the model receives only five anonymous fields and never the document or identities.
- Delivered 2026-09-27: https://youtu.be/klBuNhS5eYM, 1:47, public, English narration and burned-in subtitles.

Status: delivered 2026-09-27.

## Public Repository Requirement

Official requirement:

- Submit a publicly accessible code repository URL.
- Repository must include an open source license visible at the top of the repository page.
- README must include setup instructions and clear guidance for running the project.

Project alignment:

- MIT license exists.
- README setup instructions exist.
- Public at `https://github.com/jiarong0423/zero-trust-edge-enclave` since 2026-09-18, MIT license at the top.
- Historical export passes do not clear current code; see security-gate-summary.md.

Status: aligned.

## Feedback Requirement

Official requirement:

- Provide feedback on Nebius Token Factory, AI Cloud, and any NVIDIA tools, models, or technologies used.

Project alignment:

- Feedback was submitted on 2026-09-27 in the Devpost form questions.

Status: submitted 2026-09-27.

## Pre-Existing Project Disclosure

Official requirement:

- If the project existed before the submission period, include a written explanation of what was significantly updated during the submission period.

Project alignment:

- This is a new independent repo extracted from the older Shared Room MCP direction.
- README already states that this is a new hackathon-oriented framework extracted from the Shared Room MCP direction.

Status: submitted 2026-09-27 as a new project (first commit 2026-09-07, after the 2026-08-26 start), with the Shared Room MCP origin stated in the README. A new repository name alone does not establish a new project; the commit dates do.

## Submission Readiness

- Done: public repository URL, reviewer-accessible hosted demo (2026-09-24).
- Done 2026-09-27: public YouTube video, platform feedback, prior-work disclosure; submitted.
- Use synthetic input for the demo and show real provider mode separately from demo fallback.
- Keep claims consistent with README: simulated transport, local bearer identities rather than SSO/device attestation, and no hardware enclave.
- Eligibility and organizer acceptance have not been independently established by these technical checks.
