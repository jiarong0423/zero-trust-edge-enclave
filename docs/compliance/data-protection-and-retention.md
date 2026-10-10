# Data Protection And Retention

Written 2026-10-08 against branch `improve/2026-10-08`. Re-verified against the code on 2026-10-08 (see `verification-log-2026-10-08.md`).

> **Disclaimer.** A factual inventory for a reviewer, not a certificate, a privacy assessment or legal
> advice. The project holds no certification. It is a hackathon prototype for synthetic documents.
> Where the code does not do something, this document says GAP. Evidence is cited by file plus symbol or
> test title; if a symbol moved, `grep -rn '<symbol>' *.js` finds it.

`DATA_DIR` below is the data directory (`DATA_DIR`, default `data/` next to `server.js`: `server.js` constant `dataDir`).
Paths are relative to it unless stated.

## 1. Inventory

"Reads via the app" means what a running server will return to an authenticated caller. Anyone with
operating-system read access to `DATA_DIR` can read every file below except plaintext (which the backend
never holds) and can read `private-keys/master.key`, so host access equals access to all keys.

| Data | Where it lives | Contents | Reads via the app | Notes |
| --- | --- | --- | --- | --- |
| Ciphertext packet | `tasks.json`, `task.file.packet` | `version`, `algorithm` (AES-256-GCM), `context` (UUID), `iv`, `ciphertext` (base64). File name, type and size are inside the encrypted frame (`public/file-envelope.js` `sealFileBytes()`, `validatePacket()`) | Recipients in the approved snapshot, during the download window (`routes/file-access.js` `handleFileAccess()` (route `POST /api/file-access/<id>/packet`)). Not returned to the sender | Maximum 5 MiB of file bytes (`public/file-envelope.js` `MAX_FILE_BYTES`); request body cap 7,100,000 bytes (`server.js` route `POST /api/file-tasks`, `readBody(req, 7_100_000)`) |
| Wrapped document key | `tasks.json`, `task.file.wrappedKey` | `version`, `iv`, `ciphertext`, `tag` (AES-256-GCM under the vault master key) (`local-key-vault.js` `wrap()`) | Never returned. Only the unwrapped key is released, once per ticket (`routes/file-access.js` `handleFileAccess()` (route `POST /api/file-access/<id>/key`)) | Test asserts no `wrappedKey` in the intake response (`scripts/local-workflow.test.mjs` test "isolated local authorization, coordinator and dry-run end to end") |
| Vault master key | `private-keys/master.key` (32 random bytes, mode `0600`, directory `0700`) | Key-encryption key | Never | Created on first use (`local-key-vault.js` `openLocalKeyVault()`); also re-created without warning if the file is missing (see `key-management.md`) |
| Snapshot content | `tasks.json`, `snapshots[].content` | `documentHash`, `recipients` (registry ids), `channels`, `expiresAt`, `deliveryDeadline`, `deliveryMode`, `downloadUntil` (`snapshot-lifecycle.js` `content()`) | Owning sender (`/api/tasks/<id>`) | Recipient ids are registry ids (pattern `[A-Za-z0-9_-]{1,64}`) |
| Private mapping | `tasks.json`, `snapshots[].privateMapping` | `taskAlias`, per-recipient `alias`, `groupCode`, `recipientId`, per-channel endpoint aliases and `endpointId` (`private-mapping.js` `createPrivateMapping()`); covered by the snapshot hash (`snapshot-lifecycle.js` `snapshotHash()`) | Owning sender through the evidence chain (`recipientId` with `groupCode`) (`task-evidence.js` `taskEvidence()`); coordinator and adviser get aliases only (`private-mapping.js` `mappingProjection()`) | A group code is a department letter plus a position. The position within a group is a fresh random permutation per snapshot; the letter is the department's rank among the departments present in that snapshot, so it is not reshuffled (`private-mapping.js` `groupCodes()` and `shuffledPositions()`) |
| Jobs and adviser evidence trail | `tasks.json`, `jobs[]` | Status, attempts, `reasonCode`, `routeAdvice`, `followups`, `adviceTrail` (the projection sent, the validated answer or a refusal code, the outlet label) (`file-worker.js` `recordAdvice()`) | Owning sender only (evidence chain) | A refused answer's content is never stored (`file-worker.js` `recordAdvice()`: only a fixed code and a pattern-checked detail) |
| Key tickets | `tasks.json`, `fileAccessTickets[]` | SHA-256 hash of the ticket, `subject`, `version`, `expiresAt`, `used` (`routes/file-access.js` `handleFileAccess()` (route `POST /api/file-access/<id>/credential`)) | Never; the plaintext ticket is returned once to the recipient | Used and expired tickets are dropped at the next issuance for that task |
| Key releases | `tasks.json`, `fileKeyReleases[]` | `subject` (recipient id), `version`, `at` (`routes/file-access.js` `handleFileAccess()` (route `POST /api/file-access/<id>/key`)) | Owning sender (evidence chain and receipt rows) | Counted against the grant's `maxOpens` |
| Receipts | `tasks.json`, `fileReceipts[]` | `subject`, `version`, `code` (`DOWNLOAD_REQUESTED`, `FILE_VERIFIED`, `ACKNOWLEDGED`), `reportedAt`, `evidence: "CLIENT_REPORTED"` (`file-receipts.js` `recordFileReceipt()`) | Sender (per recipient, `receiptSummary()` through `task-view.js` `senderTask()`); each recipient sees only their own status (`file-receipts.js` `recipientReceiptStatus()`) | Client assertions, not proof of reading |
| Audit events | `audit.json` (live window) and `audit-archive/<sha256>.json` (archived pages) | `id`, `taskId`, `packageId`, `snapshotVersion`, states, `attempts`, `type`, `result`, `reasons` (codes), `createdAt`, `previousHash`, `eventHash` (`audit-boundary.js` `auditProjection()`, `audit.js` `appendAudit()`) | The owning sender, filtered to own tasks (`server.js` route `GET /api/audit`); administrators see only the archive index (`server.js` route `GET /api/admin/audit-retention`) | No names, addresses, tokens or filenames by construction; tests assert this (`scripts/local-workflow.test.mjs` test "isolated local authorization, coordinator and dry-run end to end") |
| Audit outbox | `tasks.json` and `packages.json`, `auditOutbox[]` | Events awaiting append to `audit.json` (`audit-outbox.js` `queueAudit()`) | Not returned | Emptied by replay (`audit-outbox.js` `flushAuditOutbox()`) |
| Access registry | `access.json` | Per principal: `id`, `kind`, `role`, `department`, `displayName` (up to 128 characters), `email` (up to 254 characters, nullable), `disabled`, `tokenHash`; `departments[]`; `grants[]`; `directoryEvents[]` (`registry-schema.js` `normalizeDirectory()`) | Administrator: names, emails, departments, grants, events, never hashes (`directory-admin.js` `adminDirectory()`). Operator: `id`, `displayName`, `department`, `email` of recipients on their own active grants (`recipient-directory.js` `listRecipients()`). Recipients and coordinators: nothing | The only place names and emails are stored |
| Token hashes | `access.json`, `principals[].tokenHash` | SHA-256 of the 32-byte token | Never | Plaintext tokens are shown once at creation or rotation (`directory-admin.js` `changeDirectory()`) |
| Plaintext token files | `<id>.token` in the directory given to `scripts/setup-local.mjs` (`fs.writeFile(... mode: 0o600)` per identity), mode `0600` | Role tokens in clear | Never | Local setup only. If a hosted volume has no registry and `HOSTED_REGISTRY_B64` is unset, `scripts/start-hosted.mjs` runs setup and these files are written into the volume |
| Notice outbox | `outbox/notices.jsonl`, mode `0600` in a `0700` directory | Exactly these keys: `noticeId` (SHA-256 of task alias, snapshot version, kind, subject code and preparation time), `kind` (only `LOCAL_DRY_RUN`), `subjectCode`, `taskAlias`, `snapshotVersion`, `targets` (group codes), `preparedAt`, `sendsEmail: false` (`notice-outbox.js` `noticeRecord()`) | Not returned; for an operator's own gateway | Built from an allowlist, no ids or addresses. `subjectCode` is a fixed vocabulary of two words, `SEALED_DOCUMENT_AVAILABLE` for a first notice and `SEALED_DOCUMENT_REMINDER` for a reminder (`notice-outbox.js` `SUBJECT_CODES`); anything else produces no record |
| Legacy sealed packages | `packages.json` | `fileName` in clear, `packageHash`, `ciphertext`, `iv`, `salt`, `envelope` (includes `senderRole`), used credential ids, delivery receipts (last 20), dry-run email draft (`server.js` `createSealedPackageRecord()`) | Owning operator, recipients through the legacy credential flow | Compatibility path, not the file workflow. The file name is stored unencrypted here |
| Spend ledger | `nebius-spend.json` | `{"spentUsd": number}` (`nebius-budget.js` `createBudget()`, `save()`) | Summarised in `/api/health` as `nebiusBudget` | Hosted mode |
| Process lock | `server.lock` | Process id | Not returned | Prevents two servers on one directory |
| Demo gate session | Browser cookie `enclave_gate` | HMAC derived from the sign-in; `HttpOnly; SameSite=Lax; Max-Age=43200`, `Secure` over https (`demo-gate.js` `gateSignIn()`) | n/a | Hosted demo only; the password lives in the platform environment |
| In-memory only | Process memory | Failed-sign-in throttle state (`auth-throttle.js` `createAuthThrottle()`); evidence-view rate map (`server.js` `evidenceViews`); demo-gate failure counters (`demo-gate.js`) | n/a | Lost on restart |
| Server log lines | stdout/stderr | `adviser <kind> <outlet> <model> <ms> <action> <reason>` without alias or identity (`file-adviser-outlet.js` `createFileAdviser()`); `WARN auth throttle locked client <key> for <n>s` (`server.js` `throttleFromEnv()` callback) where `<key>` is the client IPv4 address, `v6:` plus the first four IPv6 groups and `/64`, or the literal `invalid` for an unparseable address (`auth-throttle.js` `addressKey()`); `ERROR outbox export failed: <code>` at most once a minute per cause (`notice-outbox.js` `exportNoticesSafe()`); fixed-code error lines | Not returned | The client address in the lock line is personal data in many jurisdictions. The application does not rotate or retain logs; that is left to the host |
| Webhook ledger | `<DATA_DIR>/outbox/webhook-sent.jsonl`, mode 0600 in a 0700 directory, only when `WEBHOOK_URL` is set | `noticeId`, status (`SENT`, `DEFERRED`, `FAILED`), code, HTTP status, attempts, `nextEligibleAt`; no alias, no identity | No route reads it | Append-only, no rotation, refused above 64 MiB (`webhook-adapter.js` `createLedger()`); see `docs/agent/webhook-notices.md` |

Browser side: tokens live in page memory and a password-type input; the pages use no `localStorage`,
`sessionStorage`, IndexedDB or service worker (a search of `public/` found none). A rotated token is offered as a
file download on the administrator page.

## 2. Retention (the real numbers)

There is no time-based purge anywhere in the code. The numbers below are limits and windows.

| Item | Rule | Source |
| --- | --- | --- |
| Tasks, ciphertext, wrapped keys, receipts, key releases | Kept indefinitely. The retention inventory is read-only: it lists cleanup candidates (at least one approved snapshot and none still draft or locked, every job prepared or revoked, each approved snapshot acknowledged by all its recipients, no un-revoked approved snapshot still inside its access deadline, no live key ticket, no pending audit event) and always sets `automaticDeletion: false`; task and receipt history is always `RETAIN` and the file with its wrapped key is at best `REVIEW_TOGETHER` | `retention-policy.js` `fileRetention()` and `retentionInventory()`; `scripts/retention-policy.test.mjs` test "retention candidates require completed delivery and closed access; expiry alone never purges"; reachable by administrators through `server.js` route `GET /api/admin/retention` |
| Staged file tasks | At most `FILE_TASK_LIMIT` (default 50, at most 1000); the next intake gets 507. Nothing frees a slot, so this is the number of deliveries the instance can ever take | `server.js` route `POST /api/file-tasks` (`Local file staging quota reached`) |
| Live audit window | When `audit.json` exceeds 500 events, all but the newest 400 move to an archive page; the file keeps 400 | `audit-retention.js` `retainAuditWindow()` (`limit` 500, `keep` 400) |
| Archived audit pages | Content-addressed, verified after writing, never deleted by the application (`deletesArchives: false`) | `audit-retention.js` `archivePage()` and `auditArchiveIndex()`; `scripts/audit-retention.test.mjs` test "audit retention preserves overflow, replays idempotently and fails closed on corrupt archive" |
| Adviser evidence trail | Last 20 entries per job, 10 per kind (routing, follow-up) | `file-worker.js` `TRAIL_LIMIT` and `recordAdvice()` |
| Directory events | Up to 1,000; beyond that administrator changes are refused with 507 | `directory-admin.js` `changeDirectory()` (`DIRECTORY_AUDIT_QUOTA`) |
| Key ticket | 5 minutes or the download deadline, whichever is sooner; single use; pending tickets capped at 50 per task | `routes/file-access.js` `handleFileAccess()` (route `POST /api/file-access/<id>/credential`) |
| Delivery receipts on legacy packages | Last 20 kept | `server.js` `executeMcpTool()`, tool `prepare_email_delivery` (`.slice(-20)`) |
| Notice outbox | Append-only; no rotation; once the file is larger than 64 MiB the export refuses with `OUTBOX_TOO_LARGE` (logged, retried on every pass, nothing lost: the notices stay in `tasks.json`) until the operator rotates the file | `notice-outbox.js` `MAX_OUTBOX_BYTES`, `exportLocked()`, `exportNoticesSafe()`; `scripts/notice-outbox.test.mjs` test "an unwritable outbox is logged once a minute per cause, not on every worker tick" |
| Demo gate cookie | 12 hours | `demo-gate.js` `gateSignIn()` (`Max-Age=43200`) |
| Throttle and evidence-view state | Process lifetime | see the inventory |
| Data at the model provider (hosted mode) | **GAP:** the provider's retention is not stated in this repository and was not checked | n/a |

## 3. Deletion Behaviour

- **GAP:** the code has no function, route or script that deletes a task, ciphertext, wrapped key,
  receipt, person or audit record. `SECURITY.md` says to revoke rather than delete.
- Revocation does not delete. `revokeSnapshot()` sets `revokedAt` and marks the job `REVOKED`
  (`snapshot-lifecycle.js`); ciphertext and the wrapped key stay in `tasks.json`. Further requests are refused
  with 409 (verified in `scripts/local-workflow.test.mjs` test "isolated local authorization, coordinator and dry-run end to end").
- A disabled person keeps their registry row; disabling stops authentication (`registry-schema.js` `principalEnabled()`).
- Removing ciphertext or a wrapped key by hand outside the application would leave the retention
  inventory reporting the record as retained and would break integrity checks (`File integrity rejected`,
  `routes/file-access.js` `handleFileAccess()`). No procedure for this is provided.
- The retention inventory states the intended pairing: file and wrapped key are reviewed together
  (`retention-policy.js` `fileRetention()`, `fileAndWrappedKey: 'REVIEW_TOGETHER'`).

## 4. What Leaves The Host

| Mode | Destination | What is sent | What is not |
| --- | --- | --- | --- |
| Default (`COORDINATOR_PROVIDER=synthetic_fixture`) | none from the file workflow | Nothing from the file workflow, and nothing at all while `LOCAL_ONLY` is on (its default). The legacy `/api/policy/recommend` path is not governed by `COORDINATOR_PROVIDER`: with `LOCAL_ONLY=false` and a key set it can call the hosted model even here (see the legacy row) | Everything else |
| Edge (`LOCAL_ONLY=true`, `COORDINATOR_PROVIDER=local_openai_compatible`) | Loopback runtime only (`127.0.0.1`, `::1`, `localhost`) (`file-adviser.js` `LOOPBACK_HOSTS`, `ADVISER_PROVIDERS.local_openai_compatible.accepts`) | The five-field projection goes to a process on the same machine. Nothing crosses the host boundary | The Token Factory outlet is blocked (`file-adviser.js` `requestFileAdvice()`: `FILE_EXTERNAL_INFERENCE_DISABLED`); the cloud key is never passed to the loopback outlet; both legacy paths answer locally while `LOCAL_ONLY` is on |
| Hosted (`LOCAL_ONLY=false`, `COORDINATOR_PROVIDER=nebius`, key set) | `https://api.tokenfactory.nebius.com/v1/chat/completions` (`file-adviser.js` `ADVISER_PROVIDERS.nebius.accepts`) | Per adviser call: routing `taskAlias`, `snapshotVersion`, `channels`, `state`, `attempts`; or follow-up `taskAlias`, `snapshotVersion`, `timeCode`, `nudgeCount`, `pickupCode`; plus the fixed system text, sampling parameters and the API key in the `Authorization` header. The provider also sees the host's network address and the timing of calls | Document, ciphertext, file name, recipient ids, names, emails, group codes, keys, tokens (`file-adviser.js` `requestFileAdvice()`, `exact(metadata, kind.keys)`) |
| Hosted, legacy endpoints | The configured `NEBIUS_BASE_URL` (default the same host; the legacy call sites do not apply the file-workflow outlet's host rule) | `POST /api/policy/recommend`: six enumerated policy values, sent when `LOCAL_ONLY=false`, a key is set, `LEGACY_HOSTED_ADVICE` is not `off` and the cap is not spent, whatever `COORDINATOR_PROVIDER` says (`server.js` `callNebiusPolicy()`). Legacy coordinator `recommend`: the full `safeMetadata` object with one opaque alias per recipient, when `COORDINATOR_PROVIDER=nebius` and the same conditions hold (`server.js` `coordinatorCall()`; **GAP**, control-mapping row 11b) | Document content, file name, names, addresses, keys |
| Hosted or edge, `LEGACY_HOSTED_ADVICE=off` | none | Neither legacy path calls the hosted model; each answers from local code (`demo_fallback` policy, fixture `DELIVER` advice). The policy path is covered by `scripts/legacy-hosted-advice.test.mjs` test "LEGACY_HOSTED_ADVICE=off keeps the legacy policy path entirely local"; the coordinator path is established by reading `coordinatorCall()` | n/a |
| Any mode | Recipient and sender browsers | The ciphertext packet and, through a one-use ticket, the document key, over http or https (`routes/file-access.js` `handleFileAccess()`, routes `POST /api/file-access/<id>/packet` and `/key`); the key also arrives from the sender in `POST /api/file-tasks` | Plaintext never reaches the backend |
| Any mode | `GET /api/health`, unauthenticated | `localOnly`, `adviserProvider`, `nebiusConfigured`, endpoint URLs, model names, `demoFallbackEnabled`, `legacyHostedAdviceOff`, spend-cap state (`server.js` route `GET /api/health`) | Secrets |
| Any mode | Mail | Nothing. Notices are dry-run (`sendsEmail: false`); the outbox file is a hand-off for a gateway the operator runs | n/a |
| Hosted cascade (`COORDINATOR_PROVIDER=local_then_nebius`, off by default) | Local runtime first; the hosted URL above only after a local failure | The identical five-field projection, at most one hosted call per decision and 10 s in all; refuses to start unless `LOCAL_ONLY=false`, `LEGACY_HOSTED_ADVICE=off` and a Token Factory budget are set | A local answer that validates is final and nothing is sent; no document, recipient, address or key (`docs/agent/cascade-outlet.md`) |
| Webhook (off unless `WEBHOOK_URL` is set) | One allowlisted https host on port 443, resolved and pinned to a checked public address, no redirects | One HMAC-signed POST per notice: `noticeId`, `kind`, `subjectCode`, `taskAlias`, `snapshotVersion`, `preparedAt`, `link` | Recipient identifiers, group codes, document attributes, free text, the secret (`docs/agent/webhook-notices.md`) |

## 5. What Cannot Be Recalled After Release

- A ciphertext packet and the document key returned to a recipient browser, and the plaintext that
  browser decrypts and saves. Revocation, grant expiry and the download deadline only stop later
  requests (`SECURITY.md`, Key Custody; `download-policy.js` `sendDeadlineJson()`: "already transmitted bytes cannot be
  recalled").
- A key ticket once redeemed, and a notice already picked up from the outbox by an operator's gateway.
- The five fields (hosted mode) already received by the model provider, subject to the provider's own
  terms, which this repository does not record.
- Receipts are client assertions: they do not prove that anyone read the file.

## 6. Personal-Data Considerations

Where personal data sits, exactly:

1. **Registry (`access.json`)**: `displayName` and `email` for each principal, plus `department` and `id`.
   This is the only place names and emails are stored. Readable through the administrator directory
   (`directory-admin.js` `adminDirectory()`) and, for recipients on their own grants, through the operator directory (`recipient-directory.js` `listRecipients()`),
   and by anyone with file access.
2. **Task records (`tasks.json`)**: recipient ids in `snapshots[].content.recipients`, in the private
   mapping, in `fileKeyReleases[].subject` and in `fileReceipts[].subject`, with timestamps; the sender id
   in `ownerId`. These ids are pseudonymous only as far as the registry is protected, because the registry
   maps them to names and emails.
3. **Legacy `packages.json`**: `fileName` is stored unencrypted, and a file name can itself be personal
   or confidential.
4. **Logs**: the client address in the throttle lock line.
5. **Audit events** carry no identities by construction, but `taskId` joins them to the owner and
   recipients through `tasks.json`.

Gaps relevant to data-protection reviews:

- **GAP:** no deletion or erasure path (section 3), so a deletion request cannot be fulfilled without
  manual file surgery that the project does not document or test.
- **GAP:** no data-subject access or export tool.
- **GAP:** no records of processing, consent or lawful basis; the project is meant for synthetic data
  only (`docs/agent/zeabur-deployment.md`, Security Posture Of A Hosted Instance).
- **GAP:** no encryption of the registry or task metadata at the application layer.
- Data residency is a deployment property: edge mode keeps adviser traffic on the host; hosted mode sends
  the fields above to Nebius. `README.md` states that the five fields do reach Nebius Token Factory.
