# Key Management

Written 2026-10-08 against branch `improve/2026-10-08`.

> **Disclaimer.** A factual description of key handling for a reviewer. It is not a certificate or an
> assessment against any standard (for example FIPS 140 or any KMS requirement). The project holds no
> certification. The key service shares the application process and host: a compromised backend can reach
> cryptographic material (`SECURITY.md`, Key Custody).

## 1. Key Inventory

| Key or secret | Created by | Stored | Used for | Lifetime |
| --- | --- | --- | --- | --- |
| Document key (32 bytes) | Sender browser, `crypto.getRandomValues` (`public/file-envelope.js:35`) | Briefly in browser memory; sent once to the backend in `POST /api/file-tasks` as 64 hex characters (`server.js:752`, `server.js:756`); at rest only in wrapped form | AES-256-GCM encryption of the framed file; the same key decrypts in the recipient browser | One per file task |
| Wrapped document key | Key vault (`local-key-vault.js:43`) | `tasks.json`, `task.file.wrappedKey` | Holds the document key at rest | Until the task record is removed (no code does) |
| Vault master key (32 bytes) | Key vault on first use, `crypto.randomBytes(32)` (`local-key-vault.js:21`) | `private-keys/master.key`, mode `0600`, in a `0700` directory | AES-256-GCM key-encryption key | Until replaced by hand; no rotation tool |
| Key ticket (32 bytes, base64url) | Backend, per recipient request (`server.js:721`) | Hash only, in `tasks.json` (`server.js:725`) | Authorises exactly one key release | 5 minutes or the download deadline; single use |
| Role token (32 bytes, base64url) | `scripts/setup-local.mjs` (`scripts/setup-local.mjs:34`) or the administrator `person.create` / `person.rotate` (`directory-admin.js:55`) | Hash only, in `access.json` | Bearer authentication | No expiry; ends with disable, rotation or the grant |
| Snapshot confirmation token (32 bytes) | Backend, at first confirmation (`snapshot-lifecycle.js:85`) | Hash only, on the snapshot | Second confirmation of the same snapshot | Consumed at second confirmation |
| `TOKEN_SIGNING_SECRET` | Operator; random per boot if unset outside production (`credentials.js:9`) | Environment only | HMAC-SHA256 signature of legacy timed credentials | Process or deployment lifetime |
| `NEBIUS_API_KEY` | Operator | Environment only; sent in the `Authorization` header to the hosted outlet and never to the loopback outlet (`scripts/local-adviser-outlet.test.mjs` test "the server wires each outlet to its own endpoint and never lends the cloud key to loopback") | Hosted adviser calls | Rotated at the provider (`SECURITY.md`) |
| Demo gate user and password | Operator | Environment only; browsers hold an HMAC derived from them (`demo-gate.js:31`) | Hosted demo sign-in | Changing either value ends every session |

## 2. Document Key Life Cycle

1. **Generation and encryption (browser).** A random 32-byte key and a 12-byte IV encrypt a frame holding
   the file metadata and bytes with AES-256-GCM, with additional authenticated data
   `["edge-file-v1","AES-256-GCM", <context UUID>]` (`public/file-envelope.js:35`). The packet commitment is a SHA-256 over
   version, algorithm, context, IV and ciphertext (`public/file-envelope.js:58`). The backend recomputes it and refuses
   a mismatch (`server.js:710`).
2. **Intake (backend).** The key arrives in the intake body, is validated as 64 hex characters, converted
   to bytes, deleted from the request object, wrapped, and the byte buffer is zeroed
   (`server.js:756`, `server.js:765`, `server.js:769`, `server.js:771`). JavaScript strings cannot be zeroed, so the
   hex string may remain in process memory until garbage collection. **GAP:** this is a limit of the
   runtime and is not mitigated.
3. **Wrapping.** `wrap` uses AES-256-GCM with a random 12-byte IV under the master key. The additional
   authenticated data is `["local-key-wrap-v1", taskId, version, commitment]` (`local-key-vault.js:5`). A wrapped
   key therefore unwraps only for the same task, key version and packet. Test:
   `scripts/local-key-vault.test.mjs` test "local key wrapping survives reopen and rejects changed bindings and unsafe storage" (changed bindings and unsafe storage are
   rejected).
4. **Re-wrap on revision.** When the sender revises a file task, the server unwraps the key and wraps it
   again under the new snapshot version; the old wrapped key is replaced (`server.js:855`).
5. **Release.** A recipient on the approved snapshot first asks for a ticket, then redeems it (section 3).
   The server unwraps the key, marks the ticket used, records the release, sends `{ "key": "<hex>" }` and
   zeroes its buffer (`server.js:735`, `server.js:739`, `server.js:745`, `server.js:746`).
6. **Decryption (recipient browser).** The browser decrypts locally and reports client-side receipts. The
   report is a client assertion and does not prove reading (`file-receipts.js:44`).

## 3. The One-Use Key Ticket

- Issue: `POST /api/file-access/<task>/credential` returns 32 random bytes as base64url. Preconditions:
  recipient on the approved snapshot, grant active, download window open, job prepared, fewer than the
  grant's `maxOpens` releases for this recipient and version, fewer than 50 pending tickets on the task
  (`server.js:719`, `server.js:724`).
- Storage: only `hashJson(ticket)` (SHA-256 of the JSON-encoded string) is stored, with the recipient id,
  snapshot version, expiry and a `used` flag (`server.js:725`). The plaintext appears in no state file;
  the test asserts it is absent from `tasks.json`.
- Expiry: the sooner of five minutes and the download deadline (`server.js:722`).
- Redemption: `POST .../key` with the ticket. The ticket must exist, be unused, belong to the caller and the
  snapshot version, and be unexpired (`server.js:734`). Concurrent redemption of one ticket yields one
  200 and one 403 because API requests are serialised (`scripts/local-workflow.test.mjs` test "isolated local authorization, coordinator and dry-run end to end").
- After redemption the ticket is spent, the release is counted, and a restart does not revive it (same test).
- Limits: the release cap counts completed key releases; packet downloads are not counted. Released keys
  and the plaintext they open cannot be recalled.

## 4. Role Token Rotation (`person.rotate`)

- An administrator calls `POST /api/admin/directory` with `operation: person.rotate` and a person id
  (`directory-admin.js:62`). The server generates a new 32-byte token, stores only its hash in place of the old one,
  and returns the new token once in the response; the admin page offers it as a file download.
- The old token stops working on the next request because the registry is re-read per request (`server.js:625`).
- Rotation, like any person edit, increments the `version` of every grant that names the person
  (`directory-admin.js:81`). Snapshots approved under the older grant version are then refused (`SNAPSHOT_REJECTED`,
  `snapshot-lifecycle.js:45`) and a new snapshot with two confirmations is required. Plan rotations accordingly.
- Disabling a person (`person.update` with `disabled: true`) stops authentication immediately
  (`registry-schema.js:46`).
- The bootstrap administrator cannot be rotated or edited through the API (`directory-admin.js:60`).
  **GAP:** replacing an administrator token needs a manual registry change or a fresh setup. Only
  administrators created by setup exist; the API cannot create administrators (`directory-admin.js:54`).
- Tests: `scripts/directory-admin.test.mjs` test "admin mutations version affected grants without expanding frozen recipients or leaking hashes";
  `scripts/directory-admin.test.mjs` test "registry store uses expected revisions and leaves prior bytes unchanged on rejection".

## 5. What Is Not Provided

- No KMS, HSM or TEE. The key service is the vault module in the same process as the web server and the
  same host as the ciphertext and wrapped keys (`SECURITY.md`; `THREAT_MODEL.md`, Compromised
  endpoint/backend).
- No separation of duties for key custody: whoever can read `DATA_DIR`, including `private-keys/master.key`,
  can unwrap every document key.
- No master-key rotation, re-wrap tool, key escrow, split knowledge or dual control.
- No key backup procedure. A missing `master.key` is replaced by a new random one at the next use
  (`local-key-vault.js:21`); wrapped keys made under the old master then fail authentication and no document can be
  opened. The vault checks mode and symlinks, not whether an existing key directory was restored from a
  different backup.
- No per-document key destruction. Revocation leaves the wrapped key in place.
- No hardware attestation of the recipient device; the key is released to any browser holding a valid
  token and ticket.
- No key-usage audit beyond `DECODE_ATTEMPT` events with result `ALLOW` and the `fileKeyReleases` ledger
  (`server.js:741`).

## 6. Recommendations (not features)

RECOMMENDATION items are advice for an operator and are not implemented by this code.

1. RECOMMENDATION: run the backend on a host where only the service account can read `DATA_DIR`, and keep
   `private-keys/` on encrypted storage whose key is held by a different administrator than the one who
   runs the application.
2. RECOMMENDATION: back up `private-keys/master.key` separately from `tasks.json` and test a restore; the
   two are useless apart.
3. RECOMMENDATION: terminate TLS in front of or inside the backend for any non-loopback deployment, since
   the document key travels in JSON bodies at intake and release.
4. RECOMMENDATION: rotate role tokens on a fixed schedule and after staff changes, with the grant
   re-approval cost in mind; there is no token expiry in the code.
5. RECOMMENDATION: before any production use, replace the local vault with an independently administered
   KMS or HSM behind the same `wrap`/`unwrap` interface and add master-key rotation with re-wrap.
6. RECOMMENDATION: record the audit chain head hash (`node scripts/verify-audit-chain.mjs <DATA_DIR>`)
   somewhere the backend cannot write, so tail truncation becomes detectable.
7. RECOMMENDATION: treat the hosted instance as a demonstration for synthetic documents only
   (`docs/agent/zeabur-deployment.md`).
