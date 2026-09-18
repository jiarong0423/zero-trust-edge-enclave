# Security Scan Evidence

Review date: 2026-09-08. Current decision: NOT APPROVED FOR PUBLICATION.

Earlier S8 scan passes are historical; they do not cover the expanded workflow. The private development history preserves those results.

Current scoped code-security review uses ai-security-rules, release-boundary-safety-gate and localguard-dev-safety-gate, manual inspection and isolated functional tests. Heuristic scans are not comprehensive SAST or penetration testing. Syntax checks alone are not security tests.

Current counts and dispositions are maintained in docs/agent/security-gate-summary.md. A scanner exit code of zero does not override unresolved findings. Synthetic canaries remain; no scanner rules or runtime gates were weakened.
