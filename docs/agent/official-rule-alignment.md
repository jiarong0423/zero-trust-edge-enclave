# Official Rule Alignment

Review date: 2026-09-07
Source: Nebius x NVIDIA Global AI Hackathon Devpost page, reviewed 2026-09-07.

## Required Platform Use

Official requirement:

- Submissions must run on either Nebius Token Factory or Nebius AI Cloud.

Project alignment:

- The backend policy route calls Nebius Token Factory through an OpenAI-compatible chat completions API.
- Demo fallback is clearly labeled as non-submission evidence when the provider key is not configured.

Status: aligned for local MVP, pending hosted demo evidence.

## Required NVIDIA Open Source Model Use

Official requirement:

- Submissions must use at least one NVIDIA open source model.

Project alignment:

- The configured model is `nvidia/nemotron-3-super-120b-a12b`.
- The README explains that NVIDIA Nemotron is used for metadata-only permission routing and policy recommendation.

Status: aligned after real Token Factory call evidence, pending final demo narration.

## Track Fit

Best fit:

- Best Apps and Agents Track.

Reason:

- The project is a usable enterprise workflow app: sender enclave, decode gate, transport shell, audit dashboard, timed credential, and one-way delivery dry-run.
- It uses Nemotron on Nebius for policy recommendation rather than presenting AI as a cosmetic wrapper.

Status: aligned.

## Working Demo Requirement

Official requirement:

- Provide a working demo, hosted application, or test build.

Project alignment:

- Local working demo exists.
- Hosted demo remains pending.

Status: pending deployment or downloadable test-build decision.

## Demo Video Requirement

Official requirement:

- Provide a public demo video of 3 minutes or shorter.
- Audio should cover how Nebius Token Factory and NVIDIA Nemotron are used.

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
- Public export staging passed local safety gates.
- GitHub remote and public visibility are intentionally not created yet.

Status: locally ready, not pushed.

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

Status: aligned, but final Devpost wording should repeat the disclosure.
