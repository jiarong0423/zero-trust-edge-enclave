# Submission Gap Check

Updated: 2026-09-19 Asia/Taipei

## Current Gate Status

Local self-checks against the tracked tree:

```text
export-gate:      pass, blocking 0, P0 0, P1 0, P2 0
release-boundary: PASS, findings 0
localguard:       73 findings, 3 CRITICAL / 15 HIGH / 50 MEDIUM / 5 LOW
npm test:         93 of 93, thirty consecutive runs
preflight:hosted: 7 of 8, 0 blocking, 1 advisory
fuzz:             40,000 projections, 2,400 worker ticks, 0 invariant violations
```

The CRITICAL and most HIGH findings are adjudicated false positives recorded in
`SECURITY_SCAN_EVIDENCE.md`: three deliberate canary strings in adviser tests, field names rather
than values for the privacy rule, and a model filename matched as a high-entropy literal.

## Devpost Required Items

| Requirement | Status | Evidence |
|---|---|---|
| Public code repository | Done | `https://github.com/jiarong0423/zero-trust-edge-enclave` |
| MIT license, visible at repository top | Done | `LICENSE` |
| README with setup instructions | Done | `README.md`, section Run Locally, verified from a fresh clone |
| README highlights NVIDIA model use | Done | `README.md`, section NVIDIA / Nebius |
| README states where Token Factory carried the work | Done | same section |
| README states other Nebius services used | Done | same section, states none are used |
| Architecture diagrams | Needs update | `docs/assets/`, three SVG and their PNG and JPG renders; see Documentation Drift below |
| Working demo or test build | Done | Repository is the test build; `npm run setup:local && npm test && npm run dev` |
| Track | Form-only | Best Apps and Agents |
| New or existing project | Form-only | New; first commit 2026-09-07, after the 2026-08-26 start |
| Platform feedback | Drafted | `logs/decisions/devpost_submission_20260918.md`, not published |
| Demo video URL | Still needed | Not recorded. Required to submit |
| Builders and Brews city | Form-only | Taipei, only if attendance is confirmed |
| Submitter type, country, declarations | Form-only | Fill directly in Devpost |

## Documentation Drift, 2026-09-19

A second adviser was added for delivery follow-up. The code is the ground truth: `ADVICE_KINDS` in
`file-adviser.js` holds `route` and `followup`, each with its own five-field projection and its own
validator, and `advanceFollowups` in `file-worker.js` re-enters `DRY_RUN_PREPARED`, which is
therefore no longer terminal.

An audit against that ground truth found statements elsewhere that no longer hold. They are split
by whether a reader would be misled or merely under-informed.

### Wrong: states something untrue

| Location | Statement | Why it is wrong |
|---|---|---|
| `public/index.html:13` | "AI suggests approved routes **only**" | The adviser also proposes WAIT, REMIND and ESCALATE, none of which is a route. Sender landing page, both languages. |
| `public/i18n.js:10` | 「只根據允許的代碼建議路由」 | Same claim, more emphatic in Chinese. |
| `public/app.js:97-102` | Early return on `DRY_RUN_PREPARED` | Suppresses the "Status tracking stopped; backend continues" line for exactly the state where follow-ups keep running. |
| `public/i18n.js:145` | `DRY_RUN_PREPARED: '模擬投遞完成（未寄信）'` | 「完成」 tells a Chinese-language sender the job is finished; for REQUIRED_ACK it is not. |
| `public/i18n.js:82` | `ADVISER_UNAVAILABLE: '路由建議服務無法使用'` | The same code is also the follow-up pass's rejection; the label names the wrong subsystem. |
| `docs/assets/architecture-sequence.svg:34` | Adviser lifeline ends at `y=318` | Asserts the model is never consulted after routing. |
| `docs/assets/architecture-sequence.svg:10,73-74` | "The adviser lifeline ends after step five" | Stated in the accessible description and the footnote. |
| `docs/assets/architecture-state-machine.svg:53-55` | `DRY_RUN_PREPARED` drawn with no outgoing edge | Drawn as an absorbing state; the follow-up pass re-enters it. |
| `docs/assets/architecture-state-machine.svg:10` | Transition list in the description | Enumerates every transition and omits the follow-up self-transition. |
| `docs/agent/approved-delivery-architecture.md:76` | 「五欄是 taskAlias、snapshotVersion、channels、state、attempts」 | Presented as the definition of the AI boundary; there are two such projections. |
| `docs/agent/approved-delivery-architecture.md:39` | Mermaid node for the five-field allowlist | Same defect drawn into the graph. |
| `docs/agent/approved-delivery-architecture.md:77` | "模型不可用或輸出無效時工作進入 PAUSED" | False for the follow-up pass, which records `followupPausedBy` and leaves the status unchanged. |
| `docs/agent/local-workflow.md:13` | "AI may recommend only approved routes" | Same exclusivity claim as the landing page. |
| `docs/agent/local-workflow.md:41` | "strict task/version/channel response validation" | `validateFollowupAdvice` forbids a `channel` key. |
| `docs/agent/zeabur-deployment.md:65,68` | Provider-quota bound | Counts the routing pass only; the follow-up pass issues calls on a separate schedule, so the stated worst case is arithmetically wrong. |
| `docs/agent/security-gate-summary.md:58,64` | "all 71 npm tests", "the manifest is now 89" | Now 93 tests and 105 manifest entries. |

### Incomplete: true but omits the second adviser

`docs/assets/architecture-trust-boundary.svg:61`, the header comment naming sources of truth in all
three SVGs, the reason-code panel in the state machine, `docs/agent/local-workflow.md:47-51,61`,
`docs/agent/official-rule-alignment.md:15,45,58`, `docs/agent/zeabur-deployment.md:23`,
`scripts/coordinator-mcp.mjs:16`, `MCP_SERVER_ALLOWLIST.md:53,58`, `SECURITY.md:9`, and the audit
event and reason-code label tables in `public/i18n.js:80-84,151-153`, which fall back to raw English
identifiers for the new `DELIVERY_FOLLOWUP` type and the four `FOLLOWUP_*` codes.

### Checked, no finding

`env.sample` has no comments and no follow-up variable to add. `public/audit.html` renders event
types generically. The remaining pages carry no copy describing the adviser, the state set or the
audit event types. `docs/assets/architecture-state-machine.svg:10` still correctly says all ten
states come from the audit allowlist; the follow-up work added event types and codes, not states.

## Corrected In This Pass

`README.md` and `THREAT_MODEL.md`, English and Traditional Chinese, now describe both advisers,
their separate projections, and that reminder targets are resolved by fixed code from receipts no
adviser sees.

## Not Yet Addressed

Everything in the two tables above except `README.md` and `THREAT_MODEL.md`. The user-facing copy in
`public/` is the highest priority of what remains, because it is what a judge reads first and one
of its claims is false rather than merely stale.
