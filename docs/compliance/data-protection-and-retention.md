# Data Protection And Retention

Written 2026-10-08 against branch `improve/2026-10-08`.

> **Disclaimer.** A factual inventory for a reviewer, not a certificate, a privacy assessment or legal
> advice. The project holds no certification. It is a hackathon prototype for synthetic documents.
> Where the code does not do something, this document says GAP.

`DATA_DIR` below is the data directory (`DATA_DIR`, default `data/` next to `server.js`: `server.js:55`).
Paths are relative to it unless stated.

## 1. Inventory

"Reads via the app" means what a running server will return to an authenticated caller. Anyone with
operating-system read access to `DATA_DIR` can read every file below except plaintext (which the backend
never holds) and can read `private-keys/master.key`, so host access equals access to all keys.

| Data | Where it lives | Contents | Reads via the app | Notes |
| --- | --- | --- | --- | --- |
| Ciphertext packet | `tasks.json`, `task.file.packet` | `version`, `algorithm` (AES-256-GCM), `context` (UUID), `iv`, `ciphertext` (base64). File name, type and size are inside the encrypted frame (`public/file-envelope.js:35`) | Recipients in the approved snapshot, during the download window (`server.js:715`). Not returned to the sender | Maximum 5 MiB of file bytes (`public/file-envelope.js:3`); request body cap 7,100,000 bytes (`server.js:751`) |
| Wrapped document key | `tasks.json`, `task.file.wrappedKey` | `version`, `iv`, `ciphertext`, `tag` (AES-256-GCM under the vault master key) (`local-key-vault.js:43`) | Never returned. Only the unwrapped key is released, once per ticket (`server.js:745`) | Test asserts no `wrappedKey` in the intake response (`scripts/local-workflow.test.mjs` test "isolated local authorization, coordinator and dry-run end to end") |
| Vault master key | `private-keys/master.key` (32 random bytes, mode `0600`, directory `0700`) | Key-encryption key | Never | Created on first use (`local-key-vault.js:21`) |
| Snapshot content | `tasks.json`, `snapshots[].content` | `documentHash`, `recipients` (registry ids), `channels`, `expiresAt`, `deliveryDeadline`, `deliveryMode`, `downloadUntil` (`snapshot-lifecycle.js:15`) | Owning sender (`/api/tasks/<id>`) | Recipient ids are registry ids (pattern `[A-Za-z0-9_-]{1,64}`) |
| Private mapping | `tasks.json`, `snapshots[].privateMapping` | `taskAlias`, per-recipient `alias`, `groupCode`, `recipientId`, per-channel endpoint aliases and `endpointId` (`private-mapping.js:44`); covered by the snapshot hash (`snapshot-lifecycle.js:49`) | Owning sender through the evidence chain (`recipientId` with `groupCode`) (`task-evidence.js:34`); coordinator and adviser get aliases only (`mappingProjection`, `private-mapping.js:112`) | Group codes are reshuffled per snapshot (`private-mapping.js:12`) |
| Jobs and adviser evidence trail | `tasks.json`, `jobs[]` | Status, attempts, `reasonCode`, `routeAdvice`, `followups`, `adviceTrail` (the projection sent, the validated answer or a refusal code, the outlet label) (`file-worker.js:42`) | Owning sender only (evidence chain) | A refused answer's content is never stored (`file-worker.js:42`) |
| Key tickets | `tasks.json`, `fileAccessTickets[]` | SHA-256 hash of the ticket, `subject`, `version`, `expiresAt`, `used` (`server.js:725`) | Never; the plaintext ticket is returned once to the recipient (`server.js:721`) | Used and expired tickets are dropped at the next issuance for that task |
| Key releases | `tasks.json`, `fileKeyReleases[]` | `subject` (recipient id), `version`, `at` (`server.js:741`) | Owning sender (evidence chain and receipt rows) | Counted against the grant's `maxOpens` (`server.js:719`) |
| Receipts | `tasks.json`, `fileReceipts[]` | `subject`, `version`, `code` (`DOWNLOAD_REQUESTED`, `FILE_VERIFIED`, `ACKNOWLEDGED`), `reportedAt`, `evidence: "CLIENT_REPORTED"` (`file-receipts.js:44`) | Sender (per recipient); each recipient sees only their own status (`file-receipts.js:8`) | Client assertions, not proof of reading |
| Audit events | `audit.json` (live window) and `audit-archive/<sha256>.json` (archived pages) | `id`, `taskId`, `packageId`, `snapshotVersion`, states, `attempts`, `type`, `result`, `reasons` (codes), `createdAt`, `previousHash`, `eventHash` (`audit-boundary.js:36`) | The owning sender, filtered to own tasks (`server.js:1144`); administrators see only the archive index (`server.js:651`) | No names, addresses, tokens or filenames by construction; tests assert this (`scripts/local-workflow.test.mjs` test "isolated local authorization, coordinator and dry-run end to end") |
| Audit outbox | `tasks.json` and `packages.json`, `auditOutbox[]` | Events awaiting append to `audit.json` (`audit-outbox.js:4`) | Not returned | Emptied by replay (`audit-outbox.js:11`) |
| Access registry | `access.json` | Per principal: `id`, `kind`, `role`, `department`, `displayName` (up to 128 characters), `email` (up to 254 characters, nullable), `disabled`, `tokenHash`; `departments[]`; `grants[]`; `directoryEvents[]` (`registry-schema.js:9`) | Administrator: names, emails, departments, grants, events, never hashes (`directory-admin.js:10`). Operator: `id`, `displayName`, `department`, `email` of recipients on their own active grants (`recipient-directory.js:5`). Recipients and coordinators: nothing | The only place names and emails are stored |
| Token hashes | `access.json`, `principals[].tokenHash` | SHA-256 of the 32-byte token | Never | Plaintext tokens are shown once at creation or rotation (`directory-admin.js:55`) |
| Plaintext token files | `<id>.token` in the directory given to `scripts/setup-local.mjs` (`scripts/setup-local.mjs:34`), mode `0600` | Role tokens in clear | Never | Local setup only. If a hosted volume has no registry and `HOSTED_REGISTRY_B64` is unset, `scripts/start-hosted.mjs` runs setup and these files are written into the volume |
| Notice outbox | `outbox/notices.jsonl`, mode `0600` | `noticeId`, `kind`, `subjectCode`, `taskAlias`, `snapshotVersion`, `targets` (group codes), `preparedAt`, `sendsEmail: false` (`notice-outbox.js:47`) | Not returned; for an operator's own gateway | Built from an allowlist, no ids or addresses |
| Legacy sealed packages | `packages.json` | `fileName` in clear, `packageHash`, `ciphertext`, `iv`, `salt`, `envelope` (includes `senderRole`), used credential ids, delivery receipts (last 20), dry-run email draft (`server.js:312`) | Owning operator, recipients through the legacy credential flow | Compatibility path, not the file workflow. The file name is stored unencrypted here |
| Spend ledger | `nebius-spend.json` | `{"spentUsd": number}` (`nebius-budget.js:39`) | Summarised in `/api/health` as `nebiusBudget` | Hosted mode |
| Process lock | `server.lock` | Process id | Not returned | Prevents two servers on one directory |
| Demo gate session | Browser cookie `enclave_gate` | HMAC derived from the sign-in; `HttpOnly; SameSite=Strict; Max-Age=43200`, `Secure` over https (`demo-gate.js:69`) | n/a | Hosted demo only; the password lives in the platform environment |
| In-memory only | Process memory | Failed-sign-in throttle state (`auth-throttle.js:23`); evidence-view rate map (`server.js:819`) | n/a | Lost on restart |
| Server log lines | stdout/stderr | `adviser <kind> <outlet> <model> <ms> <action> <reason>` without alias or identity (`server.js:1175`); `WARN auth throttle locked client <key> for <n>s` where `<key>` is the client IPv4 address or the IPv6 /64 prefix (`server.js:64`); fixed-code error lines | Not returned | The client address in the lock line is personal data in many jurisdictions. The application does not rotate or retain logs; that is left to the host |

Browser side: tokens live in page memory and a password-type input; the pages use no `localStorage`,
`sessionStorage`, IndexedDB or service worker (searched `public/*.js`). A rotated token is offered as a
file download on the administrator page.

## 2. Retention (the real numbers)

There is no time-based purge anywhere in the code. The numbers below are limits and windows.

| Item | Rule | Source |
| --- | --- | --- |
| Tasks, ciphertext, wrapped keys, receipts, key releases | Kept indefinitely. The retention inventory is read-only: it lists cleanup candidates (completed delivery, access closed, nothing pending) and always sets `automaticDeletion: false`; task and receipt history is always `RETAIN` | `retention-policy.js:4`, `retention-policy.js:22`; `scripts/retention-policy.test.mjs` test "retention candidates require completed delivery and closed access; expiry alone never purges" |
| Staged file tasks | At most 50; the 51st intake gets 507 | `server.js:763` |
| Live audit window | When `audit.json` exceeds 500 events, all but the newest 400 move to an archive page; the file keeps 400 | `audit-retention.js:69` |
| Archived audit pages | Content-addressed, verified after writing, never deleted by the application (`deletesArchives: false`) | `audit-retention.js:68`, `audit-retention.js:80`; `scripts/audit-retention.test.mjs` test "audit retention preserves overflow, replays idempotently and fails closed on corrupt archive" |
| Adviser evidence trail | Last 20 entries per job, 10 per kind (routing, follow-up) | `file-worker.js:26` |
| Directory events | Up to 1,000; beyond that administrator changes are refused with 507 | `directory-admin.js:92` |
| Key ticket | 5 minutes or the download deadline, whichever is sooner; single use; pending tickets capped at 50 per task | `server.js:722`, `server.js:724` |
| Delivery receipts on legacy packages | Last 20 kept | `server.js:383` |
| Notice outbox | Append-only; no rotation; export stops at 64 MiB with `OUTBOX_TOO_LARGE` until the operator rotates the file | `notice-outbox.js:26` |
| Demo gate cookie | 12 hours | `demo-gate.js:69` |
| Throttle and evidence-view state | Process lifetime | see the inventory |
| Data at the model provider (hosted mode) | **GAP:** the provider's retention is not stated in this repository and was not checked | n/a |

## 3. Deletion Behaviour

- **GAP:** the code has no function, route or script that deletes a task, ciphertext, wrapped key,
  receipt, person or audit record. `SECURITY.md` says to revoke rather than delete.
- Revocation does not delete. `revokeSnapshot` sets `revokedAt` and marks the job `REVOKED`
  (`snapshot-lifecycle.js:111`); ciphertext and the wrapped key stay in `tasks.json`. Further requests are refused
  with 409 (verified in `scripts/local-workflow.test.mjs` test "isolated local authorization, coordinator and dry-run end to end").
- A disabled person keeps their registry row; disabling stops authentication (`registry-schema.js:46`).
- Removing ciphertext or a wrapped key by hand outside the application would leave `fileRetention`
  reporting the record as retained and would break integrity checks (`File integrity rejected`,
  `server.js:710`). No procedure for this is provided.
- The retention inventory states the intended pairing: file and wrapped key are reviewed together
  (`retention-policy.js:4`).

## 4. What Leaves The Host

| Mode | Destination | What is sent | What is not |
| --- | --- | --- | --- |
| Default (`COORDINATOR_PROVIDER=synthetic_fixture`) | none | Nothing | Everything |
| Edge (`LOCAL_ONLY=true`, `COORDINATOR_PROVIDER=local_openai_compatible`) | Loopback runtime only (`127.0.0.1`, `::1`, `localhost`) (`file-adviser.js:55`) | The five-field projection goes to a process on the same machine. Nothing crosses the host boundary | The Token Factory outlet is blocked (`file-adviser.js:181`); the cloud key is never passed to the loopback outlet |
| Hosted (`LOCAL_ONLY=false`, `COORDINATOR_PROVIDER=nebius`, key set) | `https://api.tokenfactory.nebius.com/v1/chat/completions` (`file-adviser.js:69`) | Per adviser call: routing `taskAlias`, `snapshotVersion`, `channels`, `state`, `attempts`; or follow-up `taskAlias`, `snapshotVersion`, `timeCode`, `nudgeCount`, `pickupCode`; plus the fixed system text, sampling parameters and the API key in the `Authorization` header. The provider also sees the host's network address and the timing of calls | Document, ciphertext, file name, recipient ids, names, emails, group codes, keys, tokens (`file-adviser.js:170`) |
| Hosted, legacy endpoints | same host | `/api/policy/recommend`: six enumerated policy values. Legacy coordinator `recommend`: the full `safeMetadata` object with one opaque alias per recipient (**GAP**, control-mapping row 11b) | Document content |
| Any mode | Recipient and sender browsers | The ciphertext packet and, through a one-use ticket, the document key, over http or https (`server.js:715`, `server.js:745`); the key also arrives from the sender in `POST /api/file-tasks` (`server.js:752`) | Plaintext never reaches the backend |
| Any mode | `GET /api/health`, unauthenticated | `localOnly`, `adviserProvider`, `nebiusConfigured`, endpoint URLs, model names, `demoFallbackEnabled`, spend-cap state (`server.js:617`) | Secrets |
| Any mode | Mail | Nothing. Notices are dry-run (`sendsEmail: false`); the outbox file is a hand-off for a gateway the operator runs | n/a |

## 5. What Cannot Be Recalled After Release

- A ciphertext packet and the document key returned to a recipient browser, and the plaintext that
  browser decrypts and saves. Revocation, grant expiry and the download deadline only stop later
  requests (`SECURITY.md`, Key Custody; `download-policy.js`: "already transmitted bytes cannot be
  recalled", `download-policy.js:29`).
- A key ticket once redeemed, and a notice already picked up from the outbox by an operator's gateway.
- The five fields (hosted mode) already received by the model provider, subject to the provider's own
  terms, which this repository does not record.
- Receipts are client assertions: they do not prove that anyone read the file.

## 6. Personal-Data Considerations

Where personal data sits, exactly:

1. **Registry (`access.json`)**: `displayName` and `email` for each principal, plus `department` and `id`.
   This is the only place names and emails are stored. Readable through the administrator directory
   (`directory-admin.js:10`) and, for recipients on their own grants, through the operator directory (`recipient-directory.js:5`),
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
