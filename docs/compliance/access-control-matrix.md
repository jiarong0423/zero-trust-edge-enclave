# Access Control Matrix

Written 2026-10-08 against branch `improve/2026-10-08`.

> **Disclaimer.** A factual matrix of what the routes enforce, for a reviewer. It is not a certificate or
> an audit result. The project holds no certification. Roles are local bearer identities, not enterprise
> SSO (`SECURITY.md`).

Roles are the four principal kinds the registry accepts (`access-control.js:28`): **administrator**, **operator**
(the sender), **recipient**, **coordinator** (a routing role; the adviser and the stdio MCP adapter act
through it). `scripts/coordinator-mcp.mjs` is a client of `POST /api/coordinator/call` with the coordinator
token and has no extra authority.

## 1. How A Request Is Decided

Order of checks in the request handler and `routeApi`:

| Step | Check | Denial |
| --- | --- | --- |
| 1 | Client network allowlist, when `ALLOWED_CLIENT_CIDRS` is set (`server.js:1230`) | 403 `Client network not allowed` |
| 2 | Hosted demo gate, when `REQUIRE_DEMO_GATE=true`: every page and route except the open paths needs the session cookie (`server.js:1245`, `demo-gate.js:13`) | 401 for `/api/*`, 302 to `/judge-login.html` for pages, 503 if the gate is on but not configured |
| 3 | Any `/api/*` request is queued and handled one at a time (`server.js:1253`) | n/a |
| 4 | `GET /api/health` answers here, before authentication (`server.js:608`) | n/a |
| 5 | Registry load (`server.js:625`) | 503 if the registry is missing or invalid |
| 6 | Failed-sign-in lock (`server.js:627`) | 429 with `Retry-After`, even for a valid token |
| 7 | Authentication (`server.js:629`; `access-control.js:50`): `Bearer` plus 32 to 256 URL-safe characters, hash match, person and department enabled | 401 `Authentication required` / `Authentication failed` |
| 8 | `GET /api/whoami`, `/api/admin/*` (`server.js:639`, `server.js:656`) | see table 3 |
| 9 | Kind gate: administrators stop here (`server.js:670`); coordinators may only call `/api/coordinator/call` (`server.js:673`); recipients may only call the file-access and legacy credential routes (`server.js:675`) | 403 |
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
| `GET /api/whoami` | any registered kind | `server.js:639`: returns only `kind` | 401; 405 for other methods |
| `GET /api/admin/retention` | administrator | `server.js:645` `Administrator required`; read-only inventory (`retention-policy.js:22`) | 403; 405 |
| `GET /api/admin/audit-retention` | administrator | `server.js:651` `Administrator required`; archive index only (`audit-retention.js:80`) | 403; 405 |
| `GET /api/admin/directory` | administrator | `directory-admin.js:5` | 403 |
| `POST /api/admin/directory` | administrator | `directory-admin.js:5`; `expectedRevision` must match (`directory-admin.js:26`); operations are an allowlist (`directory-admin.js:78`); last or inactive administrator refused (`directory-admin.js:90`); bootstrap administrator protected from edit and rotation (`directory-admin.js:60`); event log capped (`directory-admin.js:92`) | 403; 409 revision conflict, last administrator; 422 unknown operation or field; 404 unknown person; 507 event quota |
| `POST /api/file-tasks` (intake) | operator, owner of the named grant | `server.js:750`; unknown fields refused (`server.js:752`); grant active (`server.js:757`); grant owned by the caller and recipients and channels inside the grant (`snapshot-lifecycle.js:30`, `snapshot-lifecycle.js:15`); key format (`server.js:756`); duplicate packet (`server.js:762`); staging quota (`server.js:763`) | 403 not operator or grant inactive; 409 rejected snapshot or duplicate; 413 over 7,100,000 bytes; 422 fields, packet or key; 507 quota |
| `GET /api/tasks` | operator | `server.js:779`; filtered to `ownerId` | 403 |
| `POST /api/tasks` | operator | `server.js:788`; `newTask` (`snapshot-lifecycle.js:11`); non-file snapshot | 403; 409; 422 |
| `GET /api/tasks/<id>` | owning operator | `server.js:804`; `server.js:807` | 403; 404 for another operator's task |
| `POST /api/tasks/<id>/revise` | owning operator | ownership as above; stale version refused (`server.js:845`); `reviseTask` (`snapshot-lifecycle.js:59`); file tasks keep the same packet commitment (`server.js:849`) | 404; 409 stale or file replaced; 403 grant inactive |
| `POST /api/tasks/<id>/confirm-first`, `confirm-second` | owning operator | `server.js:860`; `server.js:863`; each re-verifies the snapshot against the grant (`snapshot-lifecycle.js:42`); the second needs the one-use token from the first | 404; 409 `SNAPSHOT_REJECTED`; 422 |
| `POST /api/tasks/<id>/revoke`, `invalidate` | owning operator | `server.js:840`; `owner()` check (`snapshot-lifecycle.js:11`); an approved snapshot cannot be invalidated, only revoked | 404; 409 |
| `POST /api/tasks/<id>/resume` | owning operator | `task-operations.js:9`: enabled operator, revision match, resumable reason, grant and snapshot valid, recipients enabled, packet unchanged | 404; 409 `JOB_REVISION_CONFLICT`, `JOB_NOT_RESUMABLE`, `PACKET_CHANGED`; 403 `RECIPIENT_DISABLED` |
| `GET /api/tasks/<id>/evidence` | owning operator | `server.js:813`; viewing is audited at most once a minute per task (`server.js:819`, `server.js:821`) | 403 other kinds; 404; 405 for other methods |
| `POST /api/coordinator/call` | operator (own task), coordinator (own grant) | `server.js:881`; operator must own the task, coordinator must be the grant's coordinator (`server.js:561`); snapshot must be approved and current (`snapshot-lifecycle.js:129`); input restricted to alias plus version (`server.js:553`) | 403; 404 `File task unavailable`; 422; 502/503 provider |
| `GET /api/authorizations` | operator | kind gate; lists only the caller's own unrevoked, unexpired grants (`server.js:885`) | 403 |
| `POST /api/directory` | operator who owns the grant | `recipient-directory.js:5`; grant must be active and owned; result intersected with the grant's recipients (`recipient-directory.js:11`) | 403 `Directory access denied`; 422 |
| `POST /api/file-access/<id>/receipt-status` | recipient on the approved snapshot | `server.js:678`; `file-receipts.js:11` | 403 not a recipient, not on the snapshot, unknown version; 404 not a file task; 422 extra fields |
| `POST /api/file-access/<id>/receipt` | recipient on the approved snapshot who has taken the key | `server.js:694`; `file-receipts.js:35`; `ACKNOWLEDGED` needs `FILE_VERIFIED` first | 403 (no key release, not on the snapshot); 409 acknowledgement before verification; 422 unknown code |
| `POST /api/file-access/<id>/packet` | recipient on the approved snapshot | `server.js:678`; grant active (`server.js:705`); snapshot valid; window open (`server.js:706`); membership (`server.js:707`); job prepared (`server.js:708`); packet matches commitment (`server.js:710`) | 403 grant inactive, window closed (`DOWNLOAD_WINDOW_CLOSED`), not a member; 409 snapshot rejected (revoked, superseded, expired), not prepared, integrity |
| `POST /api/file-access/<id>/credential` | same as `packet` | all checks of `packet`, plus release cap (`server.js:719`) and pending-ticket cap (`server.js:724`) | as `packet`; 403 `File key release limit reached`; 429 too many pending tickets |
| `POST /api/file-access/<id>/key` | same as `packet` | all checks of `packet`, plus release cap, then the ticket must exist, be unused, belong to the caller and the snapshot version and be unexpired (`server.js:734`); the ticket is consumed (`server.js:739`) | as `credential`; 403 `File credential rejected` (replay, other recipient, other version, expired) |
| `GET /api/mcp/tools` | operator | kind gate only | 403 |
| `POST /api/mcp/call` | operator | each tool re-authorises through `authorizeRecord` and `approvedPackage` (`access-control.js:65`, `server.js:250`); credential issuance is refused on this surface (`server.js:344`) | 403; 404; 409; 422 |
| `POST /api/delivery/email/dry-run` | operator | runs the `prepare_email_delivery` tool: package authorisation and email channel must be in the snapshot (`server.js:368`) | 403; 404; 409 |
| `POST /api/policy/recommend` | operator (kind gate only) | `server.js:944`; closed vocabulary for `policyMetadata`; no per-grant check. In hosted mode it can trigger a provider call, bounded by the spending cap | 403; 422 |
| `POST /api/packages` (legacy) | operator, owner of the grant and task | `server.js:267`; grant owner (`server.js:269`); approved snapshot and matching document hash (`server.js:278`) | 403; 409; 422 |
| `GET /api/packages/<id>` (legacy) | operator, owner | `access-control.js:65` | 403; 404 |
| `POST /api/packages/<id>/credential` (legacy) | recipient on the grant | `server.js:166` after `approvedPackage` | 403 (operator gets 403 here); 409 revoked or superseded; 422 role or device claims supplied |
| `POST /api/packages/<id>/verify` (legacy) | recipient | one-use signed credential, subject, package, policy, revocation version, expiry and open count are all re-checked (`server.js:194`) | 200 with `result: DENY` and reasons for a failed check; 403 not authorised; 409 revoked |
| `POST /api/packages/<id>/revoke` (legacy) | operator, owner | `server.js:1121` | 403; 404 |
| `GET /api/audit` | operator | `server.js:1138`; events filtered to the caller's own packages and tasks (`server.js:1144`) | 403 for administrator, recipient, coordinator |
| `POST /api/judge-login` | anyone, only when the gate is on | `server.js:1234`; per-client limit 20 failures a minute, global 200 (`demo-gate.js:18`) | 401; 429 with `Retry-After`; 503 not configured; 405 |
| any other `/api/*` | authenticated caller who passed the kind gate | falls through | 404 `not found` |

## 4. Unauthenticated Surface

| Resource | Condition | What it exposes |
| --- | --- | --- |
| `GET /api/health` | Always reachable unless the network allowlist refuses the client. It is an open path of the demo gate (`demo-gate.js:13`) | `ok`, `project`, `localOnly`, `adviserProvider`, `nebiusConfigured`, `nebiusBaseUrl`, `nebiusModel`, `localOutletBaseUrl`, `localOutletModel`, `demoFallbackEnabled`, `nebiusBudget` (`limited`, `limitUsd`, `spentUsd`, `exhausted`) (`server.js:617`). No secrets. It does disclose the deployment's mode and the state of the spending cap to anyone who can reach it |
| Static pages and scripts (`/`, `/index.html`, `/decode.html`, `/audit.html`, `/admin.html`, `/judge-login.html`, `/styles.css`, `/*.js`, and the `/zh-TW/` aliases) | Served without a token. With the demo gate on, all but the open paths need the session cookie | UI code only. Data comes from authenticated API calls. An unknown path outside `/zh-TW/` returns `index.html` with status 200; an unknown `/zh-TW/` path returns 404 (`static-files.js:17`) |
| `/api/*` other than health | 401 without a valid token (503 if the registry is missing) | Nothing |
| `POST /api/judge-login` | Only when `REQUIRE_DEMO_GATE=true` | A session cookie on a correct sign-in |

Notes for reviewers:

- The static file handler checks the resolved path with a prefix test on the public directory
  (`static-files.js:20`); the URL parser removes dot segments before it, and no test targeting traversal
  was found in the suite. This index does not claim a traversal is reachable or unreachable. RECOMMENDATION:
  add a test and compare against the directory plus a path separator.
- **GAP:** there is no rate limit on authenticated routes; only failed sign-ins are throttled.
- **GAP:** the matrix is enforced by hand-written checks inside one handler, not by a declarative policy
  table, so a new route needs its own gate review. `docs/agent/server-split-plan.md` describes the ongoing
  split of `server.js`.
