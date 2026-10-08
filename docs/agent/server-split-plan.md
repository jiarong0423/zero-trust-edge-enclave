# server.js split plan

Status 2026-10-08, branch `improve/2026-10-08`. Tranche 1 and steps 2 to 4 are executed (zero behaviour change, proven; see section 2b). Steps 5 to 7 are planned, not started. Line numbers in sections 1, 5 and 6 describe the tree after tranche 1 and are stale for the moved parts; section 2b has the current numbers.

Headline: `server.js` went from 1,768 to 1,297 lines (-471) by moving nine LEAF units into modules. The remaining weight is one 545-line `routeApi` plus the legacy sealed-package handlers, both of which depend on the per-request `requestContext` and the serial `apiQueue`. They need an explicit context object before they can move, so they are sequenced after the audit module.

## 1. Current map (server.js after tranche 1, 1,297 lines)

| Lines | Responsibility | Free variables / closures | Class |
|---|---|---|---|
| 1-47 | imports, `__dirname`, `loadLocalEnv` call | `__dirname` | root |
| 48-78 | configuration constants (paths, host, port, nebius*, localOnly, demoGate, nebiusBudget, authThrottle, networkPolicy) | `process.env`, `dataDir` | root (stays) |
| 80-91 | `ensureStore`, `readJson`, `writeJson` | `dataDir`, `packagesPath`, `auditsPath`, `tasksPath` | SHARED-STATE (thin wrappers over `local-array-store`) |
| 93-162 | `callNebiusPolicy` | `localOnly`, `demoFallbackEnabled`, `nebiusBudget`, `nebiusBaseUrl`, `nebiusModel`, `validatePolicy` | SHARED-STATE (config only, no request state) |
| 164-234 | `createTimedCredential`, `evaluateDecodeAttempt` | `requestContext`, `createSignedCredential` | ENTANGLED with request context |
| 236-264 | `findPackage`, `sanitizeAuditEvent`, `approvedPackage` | `packagesPath`, `tasksPath`, `requestContext` (writes `auditTarget`) | ENTANGLED |
| 265-342 | `createSealedPackageRecord` | `requestContext`, `tasksPath`, `packagesPath`, `appendAudit`, `validatePolicy`, `compileEnvelope` | ENTANGLED |
| 343-492 | `executeMcpTool` (7 tools) | `requestContext`, `findPackage`, `approvedPackage`, `appendAudit`, `performLocalDelivery`, `auditsPath` | ENTANGLED |
| 493-523 | `appendAudit`, `recoverAudit`, `auditRejection` | `auditsPath`, `requestContext` (`auditTarget`, `principal`, `rejectionRecorded`), `writeJson` | ENTANGLED (defines the audit ordering contract) |
| 524-548 | `performLocalDelivery` | `requestContext`, `packagesPath`, `queueAudit`, `recoverAudit`, `approvedPackage` | ENTANGLED |
| 549-606 | `coordinatorCall` | `requestContext`, `tasksPath`, `packagesPath`, `fileAdviser`, `nebiusBudget`, `localOnly` | ENTANGLED |
| 607-1150 | `routeApi` (see section 6 for the routes) | everything above plus `accessPath`, `dataDir`, `authThrottle`, `trustProxy`, `evidenceViews` | ENTANGLED |
| 1151-1189 | `apiQueue`, `evidenceViews`, `fileAdviser` | `nebiusBudget`, `localOnly`, `localModel*`, `nebius*` | SHARED-STATE (config only) except `apiQueue` |
| 1190-1220 | worker state, `workerIo`, `scheduleFileWork` | `apiQueue`, `tasksPath`, `accessPath`, `dataDir`, `recoverAudit`, `fileAdviser` | SHARED-STATE (needs `apiQueue` handle) |
| 1221-1270 | TLS options, `createServer`, request handler | `networkPolicy`, `demoGate`, `apiQueue`, `requestContext`, `routeApi`, `serveStatic`, `auditRejection` | root (stays) |
| 1271-1297 | `ensureStore`, lock file, signal handlers, `listen` | `lockPath`, `workerTimer`, `apiQueue` | root (stays) |

### Original map (1,768 lines, for reference)
Env loader 75-107; security headers and `sendJson` 122-154; `senderTask` 156-167; `readBody` 169-196; hash and base64 helpers 198-208; credential signing 210-245; `normalize*` 247-255; policy 257-328 and 401-430; `callNebiusPolicy` 330-399; MCP tool data 504-604; email draft 616-688; `serveStatic` 1591-1620; the rest as in the table above.

## 2. Tranche 1 result (done)

| Module | Lines | Contents (verbatim) |
|---|---|---|
| `http-helpers.js` | 62 | `securityHeaders`, `sendJson`, `readBody` |
| `value-helpers.js` | 23 | `hashJson`, `base64UrlEncode`, `base64UrlDecode`, `normalizeString`, `normalizeArray` |
| `static-files.js` | 44 | `mimeTypes`, `serveStatic` behind `createStaticServer(publicDir)` |
| `mcp-tools.js` | 111 | `getMcpToolSchemas`, `fallbackMessageFromReasons` |
| `policy-envelope.js` | 106 | `normalizePolicyMetadata`, `buildFallbackPolicy`, `validatePolicy(policy, nebiusModel)`, `compileEnvelope` |
| `credentials.js` | 53 | `resolveTokenSigningSecret`, `createCredentialSigner(secret)` returning `createSignedCredential`, `readSignedCredential` |
| `local-env.js` | 25 | `loadLocalEnv` |
| `email-draft.js` | 65 | `hasForbiddenEmailMaterial`, `createEmailDraftBuilder(host, port)` returning `buildDryRunEmailDraft` |
| `task-view.js` | 15 | `senderTask` |

The only non-verbatim edits are the minimum needed to remove a closure: `export` prefixes; a factory wrapper (and two-space re-indent) for `serveStatic`, the signer and the email builder; and `validatePolicy` taking its default model as a parameter, with `server.js` binding it back to the old one-argument shape. Route handlers, ordering, error messages and response bodies are untouched: the diff of `server.js` adds only 11 import lines and 4 binding lines.

## 2b. Steps 2 to 4 result (done)

`server.js`: 1,297 (after tranche 1; 1,301 at the start of this run, the 4-line difference being a later lead edit) to 1,142 lines.

| Module | Lines | Contents | How it receives state |
|---|---|---|---|
| `request-context.js` | 15 | the single `AsyncLocalStorage` instance `requestContext`; `currentRequest()` returns the live store; `setAuditTarget(target)` writes `auditTarget` on it | exports the instance; no state of its own |
| `audit.js` | 46 | `appendAudit`, `recoverAudit`, `auditRejection` (bodies verbatim; only `requestContext.getStore()` became `currentRequest()`) | `createAudit({ auditsPath, readJson, writeJson })` |
| `api-queue.js` | 17 | the serial queue: `chain(task, absorb)` and `drain()` | `createApiQueue()`; server.js builds exactly one |
| `file-adviser-outlet.js` | 41 | `fileAdviser` and `ADVISER_PRE_REQUEST_FAILURES` (verbatim) | `createFileAdviser({ nebiusBudget, localOnly, localModelBaseUrl, localModelName, nebiusBaseUrl, nebiusModel })` |
| `worker-schedule.js` | 37 | `workerBusy`, `workerFailureReported`, `workerState`, `workerIo`, `scheduleFileWork` | `createFileWorker({ queue, readJson, writeJson, tasksPath, accessPath, dataDir, recoverAudit, fileAdviser })` |
| `routes/file-access.js` | 94 | the whole `/api/file-access/{id}/{credential,packet,key,receipt,receipt-status}` body (byte-identical to the old block apart from `setAuditTarget(...)`, checked by script) | `createFileAccessRoutes({ dataDir, tasksPath, readJson, writeJson, appendAudit, recoverAudit })` returning `handleFileAccess(req, res, route, { config, principal })` |

Tests added for moved units that had none: `scripts/audit.test.mjs` (4 tests: live-store accessors, hash chain and id dedupe, one REQUEST_REJECTED per request and the status-to-code mapping, outbox recovery) and `scripts/api-queue.test.mjs` (3 tests: strict order, rejection isolation, absorb/drain). The worker schedule, the adviser outlet and the file-access routes are covered by `local-workflow`, `worker-pass`, `local-adviser-outlet` and the browser E2E.

Deviations from the plan above, all deliberate:
- `readJson` / `writeJson` / `ensureStore` did NOT move with `audit.js`. They stay in `server.js` as the `ctx.store` the plan describes in section 4 and are passed to every factory as arguments. Moving three one-line wrappers would only add a file.
- The queue is not `{ run(fn), drain() }`. The request path and the worker path absorb a task's outcome differently (the worker also logs and clears `workerBusy` in `finally`), so a single `run(fn)` would change the promise structure. `chain(task, absorb)` keeps both tails exactly as they were: `tail = absorb(tail.then(task))`.
- No frozen `ctx` object yet. Factories take the named arguments they use; the frozen `ctx` becomes worthwhile when step 5 and 6 need more than six members each. Nothing is global: `requestContext` is the only shared instance and it is imported from one module.
- `workerTimer` stays in `server.js` (the `listen` callback and the signal handlers own it); `scheduleFileWork` is passed to `setInterval` unchanged.

Claims in the plan re-verified against the code before moving: 19 raw `requestContext.getStore()` sites (confirmed; 5 were `auditTarget` assignments, whose right-hand sides are side-effect-free object literals, so `setAuditTarget(x)` has the same effect and the same TypeError outside a request); `auditRejection` is called from three route catches plus the outer wrapper (confirmed, all still call the same function); `await apiQueue` at shutdown reads the tail at that moment (`drain()` does the same). Not found wrong.

Proof (each step, then final): `npm run check` ok; `node --test "scripts/*.test.mjs"` 330 of 330 (it was 320 at the start; the rest are the 7 tests added here and 3 from other work); browser E2E 4 PASS. Before/after probe (`PORT=0`, temp `DATA_DIR`, pristine copy of the pre-change tree vs this tree, four server instances: default, demo gate, network allowlist, second-instance lock): 137 records, each with status, all headers except Date, and a body SHA-256 (ids, timestamps, hashes and ciphertext normalised) were byte-identical, covering `/api/health`, static pages, 404, path traversal, 302 (gate), 403 (allowlist), 401 (anonymous, wrong, short token), the file-task flow with ticket, packet, key release and receipts, the legacy package flow, the coordinator and the MCP routes. The audit trail after the scripted flow (80 events, hash chain intact) had the identical sequence of `type|result|reasons|previousState>nextState`. A single full-suite failure was seen once mid-run while other agents were editing `worker-pass.js` and tests in the same tree; it did not reproduce in 8 consecutive runs and is not attributed to these modules.

## 3. Proposed module layout and dependency direction

```
server.js  (composition root: config, wiring, createServer, lock, signals)
   |
   +--> routes/*.js  (tranches 4-6; one `register(ctx)` per route family)
   |        |
   |        +--> services/*.js  (legacy-packages, file-adviser-outlet, coordinator)
   |        |        |
   |        |        +--> audit.js  (appendAudit, recoverAudit, auditRejection)
   |        |        |        |
   |        |        |        +--> request-context.js  (AsyncLocalStorage + typed accessors)
   |        |        |
   |        |        +--> leaf modules (tranche 1 + lead-extracted)
   |        |
   |        +--> http-helpers.js, value-helpers.js
   |
   +--> worker-schedule.js  (scheduleFileWork, takes ctx.apiQueue)
```
Rule: arrows point only downward. Leaf modules import nothing from `server.js`, `routes/` or `services/`. No module imports `server.js`.

## 4. Context object design

One frozen object built once in `server.js`, passed to each factory. It carries configuration and handles, never request data.

```js
const ctx = Object.freeze({
  paths: { data: dataDir, access: accessPath, packages: packagesPath, audits: auditsPath, tasks: tasksPath },
  config: { host, port, trustProxy, localOnly, demoFallbackEnabled, nebiusBaseUrl, nebiusModel, localModelBaseUrl, localModelName },
  store: { readJson, writeJson },          // the existing wrappers, unchanged
  requestContext,                           // the single AsyncLocalStorage instance
  nebiusBudget, authThrottle, demoGate,
  queue: { run(fn), drain() },              // wraps the serial apiQueue; see risks
  evidenceViews                             // the Map, owned here so routes share one instance
});
```
Request state stays in `requestContext.getStore()`: `config` (access registry), `principal`, `auditTarget`, `rejectionRecorded`. `request-context.js` exports `currentRequest()` returning that store, and `setAuditTarget(target)`, so the 19 raw `requestContext.getStore()` call sites become named calls with identical semantics. Do not copy the store into `ctx`: a mutated copy would silently break `auditRejection`.

## 5. Ordered extraction sequence (safest first)

| # | Step | Class | Proof of no behaviour change |
|---|---|---|---|
| 1 | Done: nine LEAF modules | LEAF | `local-workflow.test.mjs`, full suite, browser E2E, byte-identical response headers and bodies for 20 probes |
| 2 | DONE. `request-context.js` plus `audit.js` as `createAudit({ auditsPath, readJson, writeJson })` returning `appendAudit`, `recoverAudit`, `auditRejection`; the `readJson`/`writeJson` wrappers stay in `server.js` and are passed in | SHARED-STATE | `audit-outbox`, `audit-retention`, `verify-audit-chain`, `local-workflow` (chain verification after real requests) |
| 3 | DONE. `api-queue.js`, `worker-schedule.js` (`workerIo`, `scheduleFileWork`) and `file-adviser-outlet.js` (`fileAdviser`, `ADVISER_PRE_REQUEST_FAILURES`) | SHARED-STATE | `worker-pass`, `file-worker`, `delivery-followup-worker`, `local-adviser-outlet`, `file-adviser`, `bench-adviser` |
| 4 | DONE. `routes/file-access.js` (ciphertext packet, one-use key ticket, key release, receipts) | ENTANGLED, but one cohesive block | `file-receipts`, `download-policy`, `local-key-vault`, `local-workflow`, browser E2E (download and key release) |
| 5 | DONE. `routes/file-tasks.js` (`/api/file-tasks`, `/api/tasks`, task sub-routes, evidence, plus `/api/authorizations`, `/api/directory` and `/api/audit`, the sender-facing reads; `evidenceViews` now lives inside the factory) | ENTANGLED | `task-operations`, `snapshot-lifecycle`, `task-evidence`, `retention-policy`, `local-workflow`, browser E2E |
| 6 | DONE. `routes/admin.js` (whoami, retention, audit-retention, admin directory) and `routes/coordinator.js` (`/api/coordinator/call`, `/api/policy/recommend`, `coordinatorCall`, `callNebiusPolicy`; both advice paths share the LEGACY_HOSTED_ADVICE and budget settings) | SHARED-STATE | `directory-admin`, `registry-schema`, `recipient-directory`, `retention-policy`, `model-negative` |
| 7 | `legacy-packages.js` (`findPackage`, `approvedPackage`, `createSealedPackageRecord`, `executeMcpTool`, `performLocalDelivery`, credential/verify/revoke routes; about 450 lines) | ENTANGLED | `local-workflow` (largest coverage), `private-mapping`, `smoke-test.mjs` |

Each step: copy verbatim, replace free variables with `ctx` members of the same name, run `node --check`, the targeted tests, then the full suite and the probe diff. Do not combine steps.

## 6. Route inventory (unchanged by tranche 1)

`GET /api/health`; `GET /api/whoami`; `GET /api/admin/retention`; `GET /api/admin/audit-retention`; `GET|POST /api/admin/directory`; `POST /api/file-access/{id}/{credential|packet|key|receipt|receipt-status}`; `POST /api/file-tasks`; `GET|POST /api/tasks`; `GET|POST /api/tasks/{id}[/revise|confirm-first|confirm-second|revoke|invalidate|resume|evidence]`; `POST /api/coordinator/call`; `GET /api/authorizations`; `POST /api/directory`; `GET /api/mcp/tools`; `POST /api/mcp/call`; `POST /api/delivery/email/dry-run`; `POST /api/policy/recommend`; `POST /api/packages`; `GET /api/packages/{id}`; `POST /api/packages/{id}/{credential|verify|revoke}`; `GET /api/audit`; `POST /api/judge-login` (gate only); static `/`, `/zh-TW`, `/zh-TW/*`.

## 7. Risks

1. Serial `apiQueue`. Every `/api/*` request and every worker pass is chained on one promise, and shutdown awaits it. Any module that builds its own queue, or awaits outside the chain, would create interleaved reads and writes of `tasks.json` and `packages.json`. Keep exactly one queue, owned by `ctx.queue`; `scheduleFileWork` and the request handler must both go through it.
2. Audit ordering. `appendAudit` reads, hashes against `previousHash`, then writes; `recoverAudit` flushes the outbox after `writeJson`. The hash chain depends on the sequence `writeJson` then `recoverAudit` inside one queued turn. Moving routes must not insert an `await` between a state write and its `recoverAudit`.
3. `auditRejection` guard (`rejectionRecorded`) prevents a double REQUEST_REJECTED when a route catches and rethrows. Both the per-route `catch` and the outer `requestContext.run` wrapper call it. Preserve both call sites.
4. `requestContext` is mutated by reference (`Object.assign(getStore(), ...)`, `auditTarget =`). Accessors must return the live store, never a copy.
5. Top-level await order: `loadLocalEnv` must run before the constants that read `process.env`; `resolveTokenSigningSecret` throws in production when the secret is missing, at startup, not per request. Tranche 1 preserved both positions.
6. `public-export-manifest.md` lists the shipped files and does not yet list the new modules (nor `worker-pass.js`, `auth-throttle.js`, `network-policy.js`, `notice-outbox.js`, `followup-floor.js`). Without them the exported candidate fails to start. Update the manifest and re-run the release-candidate build and scanners before any export. This file is outside this module's scope.
7. `scripts/check-syntax.mjs` now syntax-checks every tracked or new `.js`/`.mjs` file, so new modules (including `routes/`) are covered. A typo in an import name still surfaces only when the module loads; the suite and the probe cover that.
8. New root files and `routes/file-access.js` must be listed in `public-export-manifest.md` (the lead owns it): `request-context.js`, `audit.js`, `api-queue.js`, `file-adviser-outlet.js`, `worker-schedule.js`, `routes/file-access.js`. The release-candidate build copies by that list; a missing entry means the export does not start.

## 8. Estimated line counts

| After | server.js | New code (modules) |
|---|---|---|
| Today (tranche 1) | 1,297 | 504 |
| Step 2 (audit, context), actual | 1,272 | +61 |
| Step 3 (queue, worker, adviser outlet), actual | 1,210 | +95 |
| Step 4 (file-access routes), actual | 1,142 | +94 |
| Step 5 (file-task routes) | about 960 | +135 |
| Step 6 (admin, coordinator, policy) | about 760 | +260 |
| Step 7 (legacy packages) | about 330 | +480 |

Target: `server.js` of 300 to 350 lines (config, ctx, wiring, server, lock, signals), with no module above about 500 lines.

## 9. Not moved in tranche 1, and why (items 'readJson', 'appendAudit', 'fileAdviser' and the worker were moved in steps 2 to 4; see 2b)

- `readJson` / `writeJson` / `ensureStore`: close over path constants and are imported by audit and routes; they move with `audit.js` (step 2), not alone.
- `callNebiusPolicy`: depends on seven config values and the budget object. Config-only, so it is safe in step 6 with `ctx`, but moving it now would add a factory for no line saving over the risk.
- `createTimedCredential`, `evaluateDecodeAttempt`, `findPackage`, `approvedPackage`, `createSealedPackageRecord`, `executeMcpTool`, `performLocalDelivery`, `coordinatorCall`: all read or write `requestContext.getStore()` (principal, access config, `auditTarget`). Moving them before the context accessors exist would copy that coupling into a new file.
- `appendAudit`, `recoverAudit`, `auditRejection`: define the audit ordering contract (risk 2 and 3).
- `routeApi`: single 545-line function; splitting needs steps 2 to 3 first.
- `fileAdviser`, `workerIo`, `scheduleFileWork`, `apiQueue`: bound to the serial queue and shutdown (risk 1).
- Request handler, TLS, lock file, signal handlers, `listen`: the composition root.
- `sanitizeAuditEvent`: a one-line alias of `auditProjection`; left in place to keep the diff minimal.
- No test was added: every moved unit is exercised through the existing end-to-end tests (`local-workflow`, `auth-throttle-server`, `network-policy`, browser E2E), and the pure ones are covered by those flows.
