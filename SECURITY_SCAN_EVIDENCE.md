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
