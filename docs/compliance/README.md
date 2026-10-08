# Compliance Mapping And Evidence Index

Written 2026-10-08 against branch `improve/2026-10-08`, from the code at this revision. Re-verified against
the code on 2026-10-08; the corrections are listed in [verification-log-2026-10-08.md](verification-log-2026-10-08.md).

> **Disclaimer.** These documents are a control mapping and an evidence index for an enterprise
> reviewer. They are not a certificate, an audit report or an attestation. This project holds no
> certification and has not been audited against ISO/IEC 27001, SOC 2, the NIST AI RMF or any other
> framework. Framework pointers are loose theme names, not control numbers, and do not claim that any
> requirement is met. Every statement names code (a file plus a function, constant or route string) or a
> test; anything the code does not do is marked **GAP**. The project is a hackathon prototype for synthetic
> documents (see `SECURITY.md`).

Evidence is cited by symbol or test name; if a symbol moved, `grep -rn '<symbol>' *.js` finds it.

## Files

| File | What it answers |
| --- | --- |
| [control-mapping.md](control-mapping.md) | Per control objective: what is implemented, evidence, status (IMPLEMENTED / PARTIAL / GAP), loose framework themes. |
| [data-protection-and-retention.md](data-protection-and-retention.md) | Every kind of data stored or sent, where it lives, who can read it, retention numbers, deletion, what leaves the host per mode, personal data. |
| [access-control-matrix.md](access-control-matrix.md) | Roles by routes, the enforcing check and the denial status code; the unauthenticated surface. |
| [key-management.md](key-management.md) | Document keys, the local key vault, the one-use key ticket, token rotation, what is not provided, recommendations. |
| [ai-governance.md](ai-governance.md) | What the AI sees and may answer, validators, human approval points, evidence trail, controls, evaluation evidence, residual risk. |
| [sbom.md](sbom.md) and `node scripts/generate-sbom.mjs` | CycloneDX 1.5 bill of materials, generated on demand: the application, zero third-party runtime packages, the Node.js requirement, two model components. |
| [change-and-release-checklist.md](change-and-release-checklist.md) | The release gates that exist, the exact commands, human review points, and incident handling with its gaps. |
| [verification-log-2026-10-08.md](verification-log-2026-10-08.md) | What was re-checked against the code on 2026-10-08, each statement that was wrong or overstated, and what it was changed to. |

## Conventions

- Status words: **IMPLEMENTED** (code and a test or a direct code read back it), **PARTIAL** (some of
  the objective is met; the gap is stated), **GAP** (not provided).
- Code evidence is cited as a file name plus the function, constant, route string or error string that
  proves the statement. Test evidence is cited as test file plus test title. Neither depends on line
  numbers, which drift as `server.js` is split into modules (`docs/agent/server-split-plan.md`). Route
  handlers are in `server.js` `routeApi()` and, for the recipient routes under `/api/file-access/<id>/`, in `routes/file-access.js`
  `handleFileAccess()` at the time of writing; if they move again, search for the route string.
- **RECOMMENDATION** marks advice that is not a feature of the code.
- Nothing here was verified by running the test suite for this index; the commands to do so are in the
  release checklist. Test titles cited in these files were checked to exist in the named test files on
  2026-10-08; whether a given test passes was not re-run.
- These files are listed in `public-export-manifest.md`, except `verification-log-2026-10-08.md`, which was
  added afterwards. A release candidate built from the manifest therefore omits that one file, and the
  links to it would dangle; the maintainer decides whether to add it.

## Reporting a vulnerability

`SECURITY.md` has a "Reporting" section that describes how to write a report (minimal synthetic
reproductions, no real documents or credentials) but names **no reporting channel, contact address or
response time**. The channel is TO BE SET BY THE MAINTAINER. This index does not invent one.

## Headline gaps

1. No independent key management: the key vault, wrapped keys and ciphertext share one host and one process; no KMS, HSM or TEE; no master-key rotation; a missing `master.key` is silently regenerated.
2. No enterprise identity: bearer role tokens without expiry; no SSO, MFA or device attestation.
3. The audit chain is unkeyed and its head is not anchored off-host; no log shipping.
4. No data deletion or erasure path, no backup and restore procedure.
5. No CI, no versioned release gate (the commit hook lives outside the repository), and no test pins the routing prompt text (the follow-up default is hash-pinned by a test committed on this branch).
6. No incident process: no on-call, no alerting, no breach notification procedure.
7. Legacy endpoints (`/api/policy/recommend`, the legacy coordinator `recommend`) send more than the five-field projection to the hosted model by default; `LEGACY_HOSTED_ADVICE=off` keeps both local, and the legacy call sites do not apply the file-workflow outlet's host rule.
