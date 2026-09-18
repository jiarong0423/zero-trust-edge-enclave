# Security Scan Evidence

Review date: 2026-09-08. Current decision: NOT APPROVED FOR PUBLICATION.

Earlier S8 scan passes are historical; they do not cover the expanded workflow. The private development history preserves those results.

Current scoped code-security review uses ai-security-rules, release-boundary-safety-gate and localguard-dev-safety-gate, manual inspection and isolated functional tests. Heuristic scans are not comprehensive SAST or penetration testing. Syntax checks alone are not security tests.

Current counts and dispositions are maintained in docs/agent/security-gate-summary.md. A scanner exit code of zero does not override unresolved findings. Synthetic canaries remain; no scanner rules or runtime gates were weakened.

## Delivery Follow-Up Addition, 2026-09-18

Scanned candidate: 102 files, the tracked tree plus the delivery follow-up module, its two test
files and the hosted preflight.

| Scanner | Result |
| --- | --- |
| ai-security-rules `--mode export-gate` | pass; blocking 0, P0/P1/P2 0, critical 0, high 6 |
| release-boundary-safety-gate 0.1.0 | PASS; findings 0 |
| localguard 2.0.0 | 70 findings: 3 CRITICAL, 14 HIGH, 48 MEDIUM, 5 LOW |

CRITICAL and HIGH are unchanged from the 2026-09-08 adjudication: the same three deliberate canary
strings in adviser tests. Four MEDIUM findings are new and all four are false positives in Node
scripts that never reach a browser:

- `LG-IP-002` (confidence LOW) on `scripts/delivery-followup.test.mjs:13` matches the local name
  `content`, which is in the rule's keyword list. The object is a synthetic test snapshot.
- `LG-AGILE-003` on `scripts/hosted-preflight.mjs:14` matches a comment stating that the script
  never prints a token value.
- `LG-API-001` (confidence HIGH) on `scripts/hosted-preflight.mjs:97` matches the array
  `['/api/tasks', '/api/audits', '/api/directory']`, which is the assertion that those routes answer
  401 without a bearer token, not a route map served to a browser.
- `LG-CACHE-001` on `scripts/hosted-preflight.mjs:48` matches a `fetch` call in a Node script. There
  is no service worker and no Cache Storage in that file.

Test evidence at the same commit: 91/91, thirty consecutive runs with no variation. A separate fuzz
run built 40,000 projections and drove 2,400 worker ticks against advisers returning hostile and
malformed advice, with zero invariant violations: no identity, group code, count or clock value ever
reached a projection, no accepted advice left the action or reason allowlists, the reminder budget
was never exceeded, and a fully collected delivery was never chased.

## Live Adviser Comparison On The Follow-Up Contract, 2026-09-18

Six synthetic follow-up scenarios, identical projections, identical system boundary, run against
both outlets. No document, identity, count or clock value is present in any projection. Recipient
names in the fixtures are synthetic.

| Scenario (timeCode · nudges · pickupCode) | Nebius Super 120B | Local Nano 4B |
| --- | --- | --- |
| WINDOW_FULL · 0 · PICKUP_NONE | WAIT (NO_PICKUP_YET) | WAIT (NO_PICKUP_YET) |
| WINDOW_LITTLE · 0 · PICKUP_NONE | REMIND (NO_PICKUP_YET) | WAIT (NO_PICKUP_YET) |
| WINDOW_LITTLE · 2 · PICKUP_NONE | ESCALATE (NUDGES_EXHAUSTED) | WAIT (NUDGES_EXHAUSTED) |
| WINDOW_LAST · 1 · PICKUP_SOME | REMIND (PARTIAL_PICKUP) | WAIT (DEADLINE_NEAR) |
| WINDOW_LAST · 2 · PICKUP_NONE | ESCALATE (DEADLINE_NEAR) | ESCALATE (DEADLINE_NEAR) |
| WINDOW_LITTLE · 1 · PICKUP_ALL | refused: FOLLOWUP_REASON_INCOHERENT | WAIT (INSUFFICIENT_INFORMATION) |

Accepted: 5 of 6 hosted, 6 of 6 local. Latency: 1.10-1.80 s hosted, 8.3-28.0 s local. The small
local model is an order of magnitude slower than the hosted large one on the same task.

### The refusal is the control working, not a regression

The hosted refusal is the reason-coherence check. Asked five times with the identical
PICKUP_ALL input, the hosted model answered WAIT every time and gave a reason contradicting that
input in three of the five: NO_PICKUP_YET against a fully collected delivery. Before the check was
added, that contradiction was accepted and written to the audit trail, where an operator reading it
would have been misled rather than merely uninformed. The action was never wrong; the stated reason
was wrong about half the time, and the same input produced two different reasons across repeats.

### Two label changes, measured

An earlier run of the same six scenarios used numbered time codes (TIME_1..TIME_4) and no coherence
rule. With numbered labels the hosted model proposed REMIND at the very start of the window, and
proposed REMIND with reason PARTIAL_PICKUP against a PICKUP_NONE input. After replacing the numbers
with words that count down what is left (WINDOW_FULL, WINDOW_MOST, WINDOW_LITTLE, WINDOW_LAST), the
same scenario returned WAIT, and the two-reminders-ignored scenario returned ESCALATE. Published
work on prompt framing reports that models anchor on a salient number and under-adjust; a numbered
label sitting beside the numeric nudge count is two quantities in different units reading as one
scale.

### An empty response that was a truncation

The local outlet initially failed two of six with FILE_PROVIDER_RESPONSE_REJECTED. Diagnostics
showed HTTP 200, finish_reason "length", and a content string of length zero. LM Studio's
OpenAI-compatible surface does not pass chat_template_kwargs to the chat template, so the
enable_thinking setting used for the hosted outlet has no effect locally, and the model spent its
entire answer budget reasoning. Measured on nemotron-3-nano-4b with this prompt: 512 tokens returns
nothing at all, 1024 returns a valid answer. The token budget is now set per outlet, 512 hosted and
1536 local, and the local outlet returns 6 of 6.

This failure mode is worth naming: a truncation that presents as a successful request with empty
content is indistinguishable from a transport fault at the call site.
