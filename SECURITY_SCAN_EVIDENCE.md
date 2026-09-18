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

## Correction And Re-measurement Of The Local Outlet, 2026-09-18T19:57:17Z

An earlier entry in this file recorded that constrained decoding on the local runtime returns empty
content. That was wrong, and the correction changes the local outlet materially.

Environment: Apple M2 Pro, 16 GB. LM Studio serving
`NVIDIA-Nemotron3-Nano-4B-Q4_K_M.gguf`, context 4096, four parallel slots, measured decode about
27 tokens per second.

The model separates its deliberation from its answer: LM Studio returns the first in
`message.reasoning_content` and the second in `message.content`, and reports
`completion_tokens_details.reasoning_tokens` alongside the total.

| Request | finish | completion tokens | of which reasoning | content | reasoning_content | latency |
| --- | --- | --- | --- | --- | --- | --- |
| text, max_tokens 512 | length | 512 | 511 | 0 chars | 1940 chars, cut mid-sentence | 17.9 s |
| text, max_tokens 1536 | stop | 1089 | 1016 | 134 chars | 3879 chars | 35.7 s |
| json_schema, max_tokens 1536 | stop | 55 | 54 | **0 chars** | **118 chars, the complete correct answer** | 7.0 s |

Two separate findings were conflated in the earlier entry.

The first is a truncation. Unconstrained, the model spends 500 to 1000 tokens deliberating before
it answers. A budget sized for the answer alone is spent during that deliberation, and the reply is
HTTP 200 with `finish_reason` "length" and an empty `content`. Nothing was lost: 1940 characters of
partial reasoning are present in the other field.

The second is a field assignment. Under `json_schema` the constraint suppresses the deliberation
entirely and the model answers immediately and correctly, but that answer is assembled into
`reasoning_content` and `content` is left empty. A client reading only `content` records a failure
against a request that succeeded in seven seconds. This is reproducible across every case tried.

Six follow-up scenarios, local outlet, before and after reading both fields and constraining output:

| | plain text | json_schema |
| --- | --- | --- |
| Accepted | 5 of 6 | 6 of 6 |
| Latency | 8.4 to 35.7 s | 3.7 to 4.1 s |
| Completion tokens | 645 to 1089 | 64 to 73 |
| Reasoning tokens | 511 to 1016 | 0 |

The schema constraint, not `chat_template_kwargs`, is what turns reasoning off on this runtime; the
kwarg is accepted by the API and never reaches the chat template.

Reading `reasoning_content` when `content` is empty is safe here for one reason only: nothing
downstream trusts either field. The same validator runs on whatever arrives, so deliberation text
appearing in that slot fails it exactly as any other malformed answer would.

## Prompt Form, Measured, 2026-09-18

The follow-up prompt stated each field's ordering and each reason code's precondition in prose
spread across two paragraphs. Rewriting the same facts as two lookup tables, with no change to any
value, was measured against the hosted model over 60 calls each:

| Prompt form | Schema pass | Reason coherent | Logic pass | p95 latency |
| --- | --- | --- | --- | --- |
| prose | 100% | 88.3% | 88.3% | 1728 ms |
| lookup table | 100% | **100%** | **100%** | **1205 ms** |

A separate control measured the values themselves rather than the prompt, holding the table form
constant: an integer count, a coined enum, a digit-prefixed enum, ordinary words, and meaningless
symbols, 60 calls each on the hosted model.

| Value form | Schema pass | Logic pass |
| --- | --- | --- |
| `0 / 1 / 2` | 100% | 88.3% |
| `NUDGES_NONE / NUDGES_ONE / NUDGES_SPENT` | 100% | 88.3% |
| `0_NONE / 1_ONCE / 2_MAXED` | 100% | 88.3% |
| `none / once / spent` | 100% | 86.7% |
| `. / .. / ...` | 98.3% | **76.7%** |

The four labelled forms are indistinguishable. The symbol form, whose only difference is that its
values carry no meaning of their own and are defined solely by a sentence in the prompt, scores
twelve points lower. Taken with the prose-against-table result, the finding is consistent in both
directions: a model here uses a value it already understands and a rule it can look up, and largely
ignores an ordering asserted in prose.

The integer was kept. An earlier change had removed digits from `timeCode` and improved the hosted
model's judgement; repeating that on the nudge count produced no hosted improvement and cost the
local model two of six cases. The earlier gain came from two numbers in different units sitting
side by side and reading as one scale, which no longer applies once `timeCode` is words.

### Scanner Result At This Revision

| Scanner | Result |
| --- | --- |
| ai-security-rules `--mode export-gate` | pass; blocking 0, P0/P1/P2 0, critical 0 |
| release-boundary-safety-gate | PASS; findings 0 |
| localguard 2.0.0 | 73 findings: 3 CRITICAL, 15 HIGH, 50 MEDIUM, 5 LOW |

CRITICAL is unchanged: the same three deliberate canary strings in adviser tests. One HIGH is new,
`LG-SECRET-002` on this file, matching the model filename
`NVIDIA-Nemotron3-Nano-4B-Q4_K_M.gguf` as a high-entropy literal. It is a filename. The rule already
matches `COORDINATOR_PROVIDER=synthetic_fixture` in README.md on the same basis.
