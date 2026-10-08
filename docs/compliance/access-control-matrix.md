# Access Control Matrix

Written 2026-10-08 against branch `improve/2026-10-08`. Re-verified against the code on 2026-10-08 (see `verification-log-2026-10-08.md`).

> **Disclaimer.** A factual matrix of what the routes enforce, for a reviewer. It is not a certificate or
> an audit result. The project holds no certification. Roles are local bearer identities, not enterprise
> SSO (`SECURITY.md`). Evidence is cited by file plus symbol, route string or error string; if a symbol
> moved, `grep -rn '<symbol>' *.js` finds it.

Roles are the four principal kinds the registry accepts (`access-control.js` `validateAccess()`): **administrator**, **operator**
(the sender), **recipient**, **coordinator** (a routing role; the adviser and the stdio MCP adapter act
through it). `scripts/coordinator-mcp.mjs` is a client of `POST /api/coordinator/call` with the coordinator
token and has no extra authority.

## 1. How A Request Is Decided

Order of checks in the request handler and `routeApi` (both in `server.js` at the time of writing):

| Step | Check | Denial |
| --- | --- | --- |
| 1 | Client network allowlist, when `ALLOWED_CLIENT_CIDRS` is set (`server.js` request handler, `networkPolicy.allowsRequest()`; `network-policy.js` `createNetworkPolicy()`). The client address is matched, not the throttle key; loopback is not implicit | 403 `Client network not allowed` |
| 2 | Hosted demo gate, when `REQUIRE_DEMO_GATE=true`: every page and route except the open paths needs the session cookie (`server.js` request handler, `gateAllows()`; open paths in `demo-gate.js` `openPaths`) | 401 for `/api/*`, 302 to `/judge-login.html` for pages, 503 if the gate is on but not configured |
| 3 | Any `/api/*` request is queued and handled one at a time (`api-queue.js` `createApiQueue()`, used by the `server.js` request handler) | n/a |
| 4 | `GET /api/health` answers here, before authentication (`server.js` route `GET /api/health`) | n/a |
| 5 | Registry load (`access-control.js` `loadAccess()`, called at the top of `routeApi()` after the health route) | 503 if the registry is missing or invalid |
| 6 | Failed-sign-in lock (`authThrottle.check()`; `auth-throttle.js` `createAuthThrottle()`) | 429 with `Retry-After`, even for a valid token |
| 7 | Authentication (`access-control.js` `authenticate()`): `Bearer` plus 32 to 256 URL-safe characters, hash match, person and department enabled. Only a 43-character token that matches no registered identity is counted toward the lock (`auth-throttle.js` `countsAsGuess()`) | 401 `Authentication required` / `Authentication failed` |
| 8 | `GET /api/whoami`, `/api/admin/*` (`server.js` routes of those names) | see table 3 |
| 9 | Kind gate: administrators stop here (`Administrator endpoint only`); coordinators may only call `/api/coordinator/call` (`Coordinator endpoint only`); recipients may only call the file-access and legacy credential routes (`Recipient endpoint only`) | 403 |
| 10 | Route handler checks: ownership, grant, snapshot, membership, window, tickets | see table 3 |

Status codes used: 401 not authenticated; 403 authenticated but not permitted; 404 task or file not found
or not owned; 405 wrong method; 409 state conflict (snapshot rejected, not prepared, integrity,
revision); 413 body too large; 422 unsupported or malformed fields; 429 throttled or too many pending
tickets; 502 and 503 provider or store unavailable; 507 quota.

## 2. Reachability By Role

| Route family | Administrator | Operator | Recipient | Coordinator |
| --- | --- | --- | --- | --- |
| `/api/whoami` | yes | yes | yes | yes |
| `/api/admin/*` | yes | 403 | 403 | 403 |
| `/api/file-tasks`, `/api/tasks*`, `/api/authorizations`, `/api/directory`, `/api/audit`, legacy `/api/packages*` write routes, `/api/mcp/*`, `/api/delivery/*`, `/api/policy/*` | 403 | yes | 403 | 403 |
| `/api/file-access/<id>/*` | 403 | 403 (`Recipient required`) | yes | 403 |
| `/api/packages/<id>/credential`, `/verify` | 403 | reaches the handler (see table 3) | yes | 403 |
| `/api/coordinator/call` | 403 | yes (own tasks) | 403 | yes (own grant) |

Evidence: `scripts/directory-admin.test.mjs` test "isolated admin HTTP API enforces privilege separation and concurrent revision conflict" (sender,
recipient, coordinator get 403 on admin routes; admin gets 403 on `/api/authorizations`);
`scripts/local-workflow.test.mjs` test "isolated local authorization, coordinator and dry-run end to end" (coordinator
403 on file intake, task read, evidence and audit; operator, coordinator and a recipient not on the
snapshot get 403 on `packet`, `credential` and `key`).

## 3. Routes

"yes" means the kind reaches the handler and is authorised by the check named. Checks that fire for every
caller of a route are named once in the last column.

| Route | Who | Enforcing check | Denials |
| --- | --- | --- | --- |
| `GET /api/whoami` | any registered kind | `server.js` route `/api/whoami`: returns only `kind` | 401; 405 for other methods |
| `GET /api/admin/retention` | administrator | `server.js` route `/api/admin/retention`, `Administrator required`; read-only inventory (`retention-policy.js` `retentionInventory()`) | 403; 405 |
| `GET /api/admin/audit-retention` | administrator | `server.js` route `/api/admin/audit-retention`, `Administrator required`; archive index only (`audit-retention.js` `auditArchiveIndex()`) | 403; 405 |
| `GET /api/admin/directory` | administrator | `directory-admin.js` `adminDirectory()` via `requireAdministrator()` | 403 |
| `POST /api/admin/directory` | administrator | `directory-admin.js` `changeDirectory()` via `requireAdministrator()`; `expectedRevision` must match (`DIRECTORY_REVISION_CONFLICT`, and `registry-store.js` `saveRegistry()`); operations are an allowlist (`ADMIN_OPERATION_REJECTED`); last or inactive administrator refused (`LAST_ADMIN_REQUIRED`, `ACTIVE_ADMIN_REQUIRED`); administrators protected from edit and rotation (`BOOTSTRAP_ADMIN_PROTECTED`); event log capped (`DIRECTORY_AUDIT_QUOTA`) | 403; 409 revision conflict, last administrator; 422 unknown operation or field; 404 unknown person; 507 event quota |
| `POST /api/file-tasks` (intake) | operator, owner of the named grant | `server.js` route `POST /api/file-tasks`: `Operator required`; unknown fields refused (`exact()`); grant active (`activeGrant()`); grant owned by the caller and recipients and channels inside the grant (`snapshot-lifecycle.js` `newTask()`, `validGrant()`, `content()`); key format (`Invalid document key`); duplicate packet (`File intake already exists`); staging quota (`Local file staging quota reached`) | 403 not operator or grant inactive; 409 rejected snapshot or duplicate; 413 over 7,100,000 bytes; 422 fields, packet or key; 507 quota |
| `GET /api/tasks` | operator | `server.js` route `GET /api/tasks`; filtered to `ownerId` | 403 |
| `POST /api/tasks` | operator | `server.js` route `POST /api/tasks`; `snapshot-lifecycle.js` `newTask()`; non-file snapshot | 403; 409; 422 |
| `GET /api/tasks/<id>` | owning operator | `server.js` task route (`taskRoute`): `Operator required`, then `ownerId` comparison (`Task unavailable`) | 403; 404 for another operator's task |
| `POST /api/tasks/<id>/revise` | owning operator | ownership as above; stale version refused (`Stale task revision`); `snapshot-lifecycle.js` `reviseTask()`; file tasks keep the same packet commitment (`Replace file through new intake`) | 404; 409 stale or file replaced; 403 grant inactive |
| `POST /api/tasks/<id>/confirm-first`, `confirm-second` | owning operator | `snapshot-lifecycle.js` `confirmFirst()` and `confirmSecond()`; each re-verifies the snapshot against the grant (`checked()`); the second needs the one-use token from the first | 404; 409 `SNAPSHOT_REJECTED`; 422 |
| `POST /api/tasks/<id>/revoke`, `invalidate` | owning operator | `snapshot-lifecycle.js` `revokeSnapshot()` and `invalidatePending()` (both start with `owner()`); an approved snapshot cannot be invalidated, only revoked | 404; 409 |
| `POST /api/tasks/<id>/resume` | owning operator | `task-operations.js` `resumeFileTask()`: enabled operator, revision match, resumable reason, grant and snapshot valid, recipients enabled, packet unchanged | 404; 409 `JOB_REVISION_CONFLICT`, `JOB_NOT_RESUMABLE`, `PACKET_CHANGED`; 403 `RECIPIENT_DISABLED` |
| `GET /api/tasks/<id>/evidence` | owning operator | `server.js` task route with `taskRoute[2] === 'evidence'`; `task-evidence.js` `taskEvidence()`; viewing is audited at most once a minute per task (`evidenceViews`, `EVIDENCE_VIEWED`) | 403 other kinds; 404; 405 for other methods |
| `POST /api/coordinator/call` | operator (own task), coordinator (own grant) | `server.js` route `/api/coordinator/call` and `coordinatorCall()`; operator must own the task, coordinator must be the grant's coordinator (`Task access denied`); snapshot must be approved and current (`dispatchSnapshot()`); input restricted to alias plus version (`exact()`) | 403; 404 `File task unavailable`; 422; 502/503 provider |
| `GET /api/authorizations` | operator | kind gate; lists only the caller's own unrevoked, unexpired grants (`server.js` route `GET /api/authorizations`) | 403 |
| `POST /api/directory` | operator who owns the grant | `recipient-directory.js` `listRecipients()`; grant must be active and owned; result intersected with the grant's recipients | 403 `Directory access denied`; 422 |
| `POST /api/file-access/<id>/receipt-status` | recipient on the approved snapshot | `routes/file-access.js` `handleFileAccess()` (route family `/api/file-access/<id>/...`); `file-receipts.js` `recipientReceiptStatus()` | 403 not a recipient, not on the snapshot, unknown version; 404 not a file task; 422 extra fields |
| `POST /api/file-access/<id>/receipt` | recipient on the approved snapshot who has taken the key | `file-receipts.js` `recordFileReceipt()`; `ACKNOWLEDGED` needs `FILE_VERIFIED` first | 403 (no key release, not on the snapshot); 409 acknowledgement before verification; 422 unknown code |
| `POST /api/file-access/<id>/packet` | recipient on the approved snapshot | `routes/file-access.js` `handleFileAccess()` (route family `/api/file-access/<id>/...`): grant active (`activeGrant()`); snapshot valid (`dispatchSnapshot()`); window open (`download-policy.js` `checkDownloadAccess()`); membership (`Recipient outside approved snapshot`); job prepared (`File delivery not prepared`); packet matches commitment (`File integrity rejected`) | 403 grant inactive, window closed (`DOWNLOAD_WINDOW_CLOSED`), not a member; 409 snapshot rejected (revoked, superseded, expired), not prepared, integrity |
| `POST /api/file-access/<id>/credential` | same as `packet` | all checks of `packet`, plus release cap (`File key release limit reached`) and pending-ticket cap (`Too many pending credentials`) | as `packet`; 403 `File key release limit reached`; 429 too many pending tickets |
| `POST /api/file-access/<id>/key` | same as `packet` | all checks of `packet`, plus release cap, then the ticket must exist, be unused, belong to the caller and the snapshot version and be unexpired (`File credential rejected`); the ticket is consumed (`ticket.used = true`) | as `credential`; 403 `File credential rejected` (replay, other recipient, other version, expired) |
| `GET /api/mcp/tools` | operator | kind gate only | 403 |
| `POST /api/mcp/call` | operator | each tool re-authorises through `authorizeRecord()` (`access-control.js`) and `approvedPackage()` (`server.js`) in `executeMcpTool()`; credential issuance is refused on this surface (`Credentials are available only through the recipient API`) | 403; 404; 409; 422 |
| `POST /api/delivery/email/dry-run` | operator | runs the `prepare_email_delivery` tool in `executeMcpTool()`: package authorisation and email channel must be in the snapshot (`Email outside approved snapshot`) | 403; 404; 409 |
| `POST /api/policy/recommend` | operator (kind gate only) | `server.js` route `POST /api/policy/recommend`; closed vocabulary for `policyMetadata` (`policy-envelope.js` `normalizePolicyMetadata()`); no per-grant check. In hosted mode it can trigger a provider call, bounded by the spending cap and switched off by `LEGACY_HOSTED_ADVICE=off` | 403; 422 |
| `POST /api/packages` (legacy) | operator, owner of the grant and task | `server.js` route `POST /api/packages`, `createSealedPackageRecord()`; grant owner (`Authorization owner mismatch`); approved snapshot and matching document hash (`Snapshot document mismatch`) | 403; 409; 422 |
| `GET /api/packages/<id>` (legacy) | operator, owner | `access-control.js` `authorizeRecord()` | 403; 404 |
| `POST /api/packages/<id>/credential` (legacy) | recipient on the grant | `server.js` `createTimedCredential()` after `approvedPackage()` | 403 (operator gets 403 here); 409 revoked or superseded; 422 role or device claims supplied |
| `POST /api/packages/<id>/verify` (legacy) | recipient | one-use signed credential, subject, package, policy, revocation version, expiry and open count are all re-checked (`server.js` `evaluateDecodeAttempt()`) | 200 with `result: DENY` and reasons for a failed check; 403 not authorised; 409 revoked |
| `POST /api/packages/<id>/revoke` (legacy) | operator, owner | `server.js` route `POST /api/packages/<id>/revoke` (`Operator required`, `authorizeRecord()`) | 403; 404 |
| `GET /api/audit` | operator | `server.js` route `GET /api/audit`; events filtered to the caller's own packages and tasks | 403 for administrator, recipient, coordinator |
| `POST /api/judge-login` | anyone, only when the gate is on | `server.js` request handler and `demo-gate.js` `gateSignIn()`; per-client limit 20 failures a minute, global 200 (`failureLimit`, `globalFailureLimit`) | 401; 429 with `Retry-After`; 503 not configured; 405 |
| any other `/api/*` | authenticated caller who passed the kind gate | falls through | 404 `not found` |

## 4. Unauthenticated Surface

| Resource | Condition | What it exposes |
| --- | --- | --- |
| `GET /api/health` | Always reachable unless the network allowlist refuses the client. It is an open path of the demo gate (`demo-gate.js` `openPaths`) | `ok`, `project`, `localOnly`, `adviserProvider`, `nebiusConfigured`, `nebiusBaseUrl`, `nebiusModel`, `localOutletBaseUrl`, `localOutletModel`, `demoFallbackEnabled`, `legacyHostedAdviceOff`, `nebiusBudget` (`limited`, `limitUsd`, `spentUsd`, `exhausted`) (`server.js` route `GET /api/health`). No secrets. It does disclose the deployment's mode and the state of the spending cap to anyone who can reach it |
| Static pages and scripts (`/`, `/index.html`, `/decode.html`, `/audit.html`, `/admin.html`, `/judge-login.html`, `/styles.css`, `/*.js`, and the `/zh-TW/` aliases) | Served without a token. With the demo gate on, all but the open paths need the session cookie | UI code only. Data comes from authenticated API calls. An unknown path outside `/zh-TW/` returns `index.html` with status 200; an unknown `/zh-TW/` path returns 404 (`static-files.js` `createStaticServer()`, `localizedPages`) |
| `/api/*` other than health | 401 without a valid token (503 if the registry is missing) | Nothing |
| `POST /api/judge-login` | Only when `REQUIRE_DEMO_GATE=true` | A session cookie on a correct sign-in |

Notes for reviewers:

- The static file handler checks the resolved path against the public directory plus a path separator
  (`static-files.js` `createStaticServer()`, the `filePath.startsWith(...)` test with `path.sep`), so a sibling directory whose name merely starts with the public
  directory's name is refused; the test is `scripts/static-files.test.mjs` test "a sibling directory that merely starts with the public directory name is never served". An earlier version of the handler used a bare prefix test
  and no test covered it (see `verification-log-2026-10-08.md`). This index still does not claim that every traversal form is unreachable; `scripts/model-negative.test.mjs` TC-12 is a traversal-style adviser input, not a static-file test.
- **GAP:** there is no rate limit on authenticated routes; only failed sign-ins are throttled.
- **GAP:** the matrix is enforced by hand-written checks inside one handler, not by a declarative policy
  table, so a new route needs its own gate review. `docs/agent/server-split-plan.md` describes the ongoing
  split of `server.js`.
