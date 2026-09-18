# Local Workflow Implementation

Status: local synthetic workflow implemented; no real mail or cloud inference is required by tests.

Current sender transition: select DOCX/PDF/CSV bytes, encrypt locally without content preview, then review the recipient list. First confirmation stages ciphertext and a wrapped key through /api/file-tasks and locks the snapshot; second confirmation creates a durable job. Background worker prepares simulated delivery independently of the browser. Recipient access retrieves ciphertext and a separate one-use short-lived key ticket, decrypts locally and downloads original bytes. No shared demo password or text redaction is used by this page. Intake enforces a 5 MiB file envelope, 7,100,000-byte JSON request ceiling and 50 staged-file-record quota. LOCAL_ONLY defaults true. Use synthetic files only; this is not a production KMS or real transport.

## Current Implementation: Email Dry Run

The local sender confirms twice through a versioned snapshot. Load authorized recipients, filter by registered department or search id/name/email, and explicitly check a subset. Search does not add people or clear hidden selections; the selected count and first-confirmation snapshot show the actual selection. Directory responses are operator-only and intersect the grant before filtering. Changing credentials or authorization resets the selection. File selection encrypts the document locally; first confirmation stages the encrypted file and locks the selected recipient identities, channels and expiry. Second confirmation approves that version. Changing the selection invalidates pending confirmation on the server; search and in-place language switching do not. Records without display fields use their stable id and an unassigned department. Free-form role claims cannot add recipients.

Transport remains email dry-run after both confirmations. `DRY_RUN_PREPARED` means only notice preparation, not complete handoff. Receipt and download-window states are separate. No further sender acknowledgement is required after the recipient reports complete receipt, and there is no promotion to real email.

Humans own the recipient selection and grant. AI is asked two bounded questions and nothing else: which approved channel a prepared job should use, and whether an unacknowledged delivery should be waited on, reminded or escalated. Encryption and authorization remain outside AI, and so does who a reminder reaches, which fixed code resolves from receipts no adviser sees. Documents, cryptographic material, credentials, and the full draft body are not returned through the coordinator model interface. Current tests use synthetic recommendations rather than live Nemotron inference.

The entrypoint uses an authorization id and bounded directory selection. Private task/version mappings and unattended dry-run processing are implemented; arbitrary natural-language role resolution and real endpoint/channel bindings are not. This scope refers to this project's tests, not independently verified legacy Shared Room MCP behavior.

## Start

UI languages have separate direct-entry routes: `/` is English and `/zh-TW/` is Traditional Chinese, with matching decode/audit pages. The fixed language switch updates the existing page in place using history.replaceState, preserving query/hash, DOM inputs, page-memory credentials and confirmation state. It performs no API request or page reload. Explicit data-i18n labels and bound dynamic messages update presentation only; authorization, stored protocol fields, file names, recipient identifiers and decrypted content are not translated. Refreshing or navigating to another functional page still clears page-memory credentials. Native OS file dialogs follow OS language; in-page buttons/status follow the selected UI language. No credential or document persistence is added for language switching.

Use Node 20.11 or newer. From the repository root:

```bash
npm run setup:local
npm test
SKIP_LOCAL_ENV=true npm run dev
```

Setup refuses to overwrite an existing access registry or token files. It creates synthetic principals and a one-day `local-review` grant in `data/access.json`. Only `recipient-a` is on that grant. Tokens are random, saved to private files, and never printed. Keep all runtime files untracked. For the business demo, use the administrator UI to change human-approved recipients, channels, maximum attempts, expiry and open limit; the server increments authorization versions. Do not edit registry files while the service is running. The minimal compatibility demo has no administrator UI identity; any offline registry maintenance must preserve its schema and increment changed grant versions. Changed authority requires fresh sender approval, and revocation denies subsequent access.

Load `operator.token` with the sender page's token file picker, use authorization `local-review`, and seal a synthetic document. The sender then runs the bounded recommendation/delivery flow. Load `recipient-a.token` on the decode page to open; `recipient-b.token` is the negative case. Role and device selectors are removed. These credentials establish possession of a local bearer token, not SSO identity or device attestation.

## Coordinator

The dedicated stdio MCP adapter exposes legacy `status`, `recommend`, `deliver` plus file-task `file_status` and `file_recommend`. The latter accept only taskAlias and snapshotVersion and cannot trigger file delivery or retrieve documents or credentials. It supports initialize, ping, tools/list and tools/call. Local protocol tests exercise this surface; connection to a user's Codex session is not configured automatically.

Configure a local MCP client to launch `node scripts/coordinator-mcp.mjs` from this repository, with `COORDINATOR_TOKEN_FILE` pointing to the private coordinator token and optional `COORDINATOR_BASE_URL` pointing to the loopback app server. The token is loaded by the adapter, not passed as model context. Do not grant the coordinating agent additional filesystem or shell access to the data directory.

The HTTP coordinator accepts taskAlias and snapshotVersion and, for legacy delivery, a request id and allowlisted channel. It does not accept internal package IDs. Its responses are projected metadata, not raw package, credential, or audit records. The old application MCP-style endpoint is operator-only and cannot issue credentials.

Default recommendations are labeled `synthetic_fixture`. Real file inference additionally requires LOCAL_ONLY=false, COORDINATOR_PROVIDER=nebius and backend provider settings; otherwise cloud mode fails closed. Both adviser requests are allowlisted code-only input with a bounded response size and deadline. Each has its own validator: routing advice must carry taskAlias, snapshotVersion, action, channel and reasonCode, and follow-up advice must carry taskAlias, snapshotVersion, action and reasonCode, with no channel key at all. The follow-up validator additionally refuses a reminder past the budget, any action other than WAIT on a fully collected delivery, and a reason that contradicts the input it was given. Worker reloads authorization after advice before dispatch. Adapter tests use fake fetch; they are not live Nemotron evidence or evidence of a semantic advantage over rules.

## State and Persistence

New snapshots contain private task/version-scoped UUID aliases for selected recipients and their approved simulated endpoints. The snapshot commitment binds this mapping; confirmation and dispatch verify it. The coordinator sees only the alias projection, never private recipient ids or endpoint ids. Endpoints are explicitly dry-run identifiers, not real email/address resolution. Pre-mapping snapshots fail closed on the new server; create a new reviewed draft instead of silently migrating old approvals. Existing running servers are not automatically upgraded by source edits.

- `PENDING_CHECK`: no delivery attempt recorded.
- `DRY_RUN_PREPARED`: a local notice was prepared; no email was sent and no remote delivery is claimed. For a delivery that must be acknowledged this is not the end: while its deadline has not passed the job is reconsidered here, and a reminder returns it to this same state rather than moving it on.
- `RETRY_WAIT`: a configured synthetic transient failure, with exponential backoff.
- `OUTCOME_UNKNOWN`: ambiguous outcome; no automatic resend.
- `PAUSED`: attempts exhausted; this processing run stops without automatic resend.

The human-owned grant may set `simulatedOutcomes` to `prepared`, `transient`, or `unknown`. Clients cannot select outcomes. File jobs run in the backend timer with bounded retries, and prepared REQUIRED_ACK jobs are reconsidered there on a cadence taken from each task's own window rather than from the clock. Closing the sender page does not stop either pass. The sender display polls status and offers manual receipt refresh. Legacy package tools retain explicit delivery requests for regression compatibility.

Requests and transitions are persisted with the package. A per-process queue serializes API operations and a data-directory lock prevents two instances of this version from sharing a store. After an unclean crash, inspect the recorded PID before manually clearing a stale lock. Do not run old server versions against this data directory. JSON parse errors fail closed rather than replacing stores with empty arrays.

## Verification and Limits

Snapshot approval and its unique job are stored in one task aggregate. Before dispatch or credential release, the server rereads task/version state; old cache assertions cannot authorize access. An approved version is not overwritten by edits, and a new draft does not revoke it. Explicit revocation prevents future credential release and verification but cannot recall keys or plaintext already obtained.

Audit records use fixed task/version/event/reason/state/time/attempt fields. Identity, endpoint, credential and raw-error fields are excluded; model tools receive only their separate status projection. Snapshot transitions, delivery transitions and follow-up decisions queue sanitized audit events alongside state, then replay and acknowledge each event idempotently. Other legacy audit producers are still separate writes. No full database transaction, power-loss guarantee or tamper-proof storage is claimed.

Tests now also cover four material edits, old confirmation tokens, parallel duplicate confirmations, approved-snapshot preservation, explicit revocation, ciphertext/IV/salt binding, actual server restart, terminal HTTP outcomes and persisted audit privacy. A local browser check verified first confirmation, edit invalidation, version 2 reconfirmation, second confirmation and one-attempt dry-run. Live provider evidence is not part of these checks.

`npm test` creates temporary synthetic stores and removes only those stores after shutting down its child processes. It checks authentication, recipient membership, role spoofing, authorization revision/revocation, credential replay, concurrent idempotency, model field rejection, bounded retry, unknown outcomes, safe email draft projection, and the stdio MCP contract. It never loads project environment files or contacts a provider.

Existing unbound packages are denied; no runtime data migration is performed. The browser uses per-file random keys wrapped by a local key vault module, not the old demo passphrase. Key service and app share the same OS process and host; enterprise identity, hardware isolation, independently administered KMS and real email remain unimplemented. A crash after consuming a ticket but before responding may consume a use; retries must not bypass that limit.

## Local Directory Administration

`node scripts/setup-local.mjs PRIVATE_DIRECTORY --business` explicitly creates a new private business-demo registry. It refuses existing registry/credential files and does not migrate a running demo. This mode creates procurement and audit grants, their departmental identities and a separate `admin` identity. Default setup remains the minimal compatibility demo, without automatic administrator promotion.

The administrator-only `/api/admin/directory` endpoint supports GET for a private directory view and POST for a version-checked mutation. Administrators may also read `/api/admin/retention` and `/api/admin/audit-retention`, but cannot use sender/recipient APIs. Sender, recipient and coordinator credentials cannot administer the registry. GET omits token hashes. POST accepts `expectedRevision`, `operation`, and `value`; supported operations are `department.create`, `department.update`, `person.create`, `person.update`, `person.rotate`, `grant.create`, and `grant.update`. Person creation may create only operator, recipient or coordinator identities. Administrator bootstrap identities cannot be changed through this API.

Department values use `id`, `displayName` and optional `disabled`. Person creation uses `id`, `kind`, `department`, optional `displayName`, `email`, and `disabled`; person update cannot change `id` or `kind`. Rotation accepts only `id`. Creation and rotation return a newly generated credential once to the authenticated private administrator client; only its hash is persisted. Never call these operations through an AI tool, put responses in logs, or expose them to model input. A lost rotation response requires a new explicit rotation.

Grant values use explicit principal IDs: `id`, `operatorId`, `coordinatorId`, `recipients`, `channels`, `expiresAt`, `maxAttempts`, `maxOpens`, and optional `revoked`. Clients cannot supply a grant version. Person changes and changes to a department with grant-bound members increment the affected grant versions; grant updates also increment their version. Approved snapshots do not gain new members and fail their old-version checks after these changes. Restoring a prior field value does not restore the old authorization version. An administrator must not disable their own effective access.

Registry replacement uses the server's serialized request queue, expected revision, exclusive temporary file, sync and atomic rename. A compact event is persisted in the same registry aggregate; no identity, endpoint or credential values are copied into the event. The 1000-event cap fails closed instead of silently deleting administrative history. This is single-process persistence, not a distributed database transaction; out-of-band registry writers are unsupported while the service runs. The administrator UI and business demo are implemented; browser tests cover department/person/grant changes, credential download/rotation and invalidation of the previous credential. Administrative events remain retained, not automatically pruned.

## Runtime Safety and Receipts

Runtime enforcement consists of bounded envelope/schema checks, immutable approval and alias bindings, current authorization checks, private endpoint resolution, strict code-only adviser/MCP projections, bounded retries and credential replay/expiry/open-limit checks. Audit output is built from allowlisted codes. These deterministic controls are not an antivirus scan and cannot inspect malware inside opaque ciphertext. A filename suffix or successful AES-GCM check does not establish document safety.

The three local development/release scanners are not attached to private document ingestion or model context. Run them on the approved sanitized release scope only when preparing publication. Do not claim they inspect ciphertext contents or replace runtime authorization.

Storage initializes only an entirely new array-store set; partial missing stores or corrupt JSON stop processing. Reads reject file symlinks; writes use unique exclusive temporary files, file sync, atomic rename and directory sync. This is single-process local persistence, not a distributed transaction or proof of power-loss safety. Missing history is not silently recreated. Keep backups and inspect stale server locks after an unclean crash.

Dry-run preparation, key release and client-reported download are different evidence levels. Recipient receipt accepts FILE_VERIFIED, DOWNLOAD_REQUESTED and explicit ACKNOWLEDGED after key release, deduplicates by recipient/version/code and marks CLIENT_REPORTED. Acknowledgement requires a saved verification report. Receipt status exposes only the authenticated recipient's flags, even when recording historical events after access expiry; it cannot grant file/key access. The browser retries transient reports up to three times, supports explicit retry, and restores saved confirmation after reauthentication. Sender counts do not prove reading or a digital signature. Saved plaintext and released keys cannot be recalled.

## Two Modes, Recovery and Retention

- REQUIRED_ACK: no extra sender-selected download cutoff; access remains bound to the current authority and immutable snapshot. The sender UI uses the selected grant expiry instead of adding a 1/4/24-hour file cutoff. Expiry/revocation is never bypassed. An overdue acknowledgement remains a delivery obligation, not proof of receipt.
- TIME_LIMITED: an approved downloadUntil limits packet, credential and key access. At cutoff, new access is rejected and the service stops writing remaining response bytes. Already transmitted bytes cannot be recalled. Download-window state and acknowledgement state are independent.
- History recovery: select the latest staged-file task and review again. Pending confirmation is invalidated. No document or key is downloaded into the sender UI. Recipients must be selected again from the current grant, and both confirmations are required on a new version. Approved historical snapshots remain immutable; a changed grant invalidates their old authority. Missing intake responses can be recovered through owner history without uploading another copy.
- Retention inventory is read-only. Drafts, unresolved work, unacknowledged deliveries, active access/tickets, pending audit and unknown state are retained. Only completed delivery with closed access and no blocking state becomes a cleanup candidate for ciphertext and wrapped key together. Task, receipt and administrative history remains retained. No cleanup/delete endpoint was added.
- Audit overflow is archived durably before the active 500-event window is reduced to 400. Archive pages are immutable by content address and verified before active pruning. Previously lost history cannot be recreated by this feature. Archive growth, the 50-file quota and the administrative-event cap remain explicit capacity limits; this local build never silently deletes records to stay below them.

The browser acceptance runner scripts/browser-file-workflow.mjs uses installed Playwright via PLAYWRIGHT_MODULE and an optional BROWSER_EXECUTABLE override, fresh synthetic registries and blocked external browser requests. It covers original CSV plus procurement DOCX and audit PDF, department/subset selection, removed/foreign recipient denial, sender-tab closure, bounded retries, exact downloads and receipt observation. For a clean checkout, first run node scripts/generate-business-fixtures.mjs to create the synthetic isolation sources, then run scripts/generate-native-fixtures.py with a Python interpreter containing python-docx and reportlab. Only then run the browser acceptance runner. These optional tools are not installed by setup. Credentials are never printed.
