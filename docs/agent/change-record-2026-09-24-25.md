# Change Record, 2026-09-24 to 2026-09-25

Every change made in these two days, in commit order, with what changed, why, and how it was
checked. Times are Taipei (UTC+8). Commit hashes are this repository's; `git show <hash>` gives the
exact lines. Numbers quoted here come from logged runs in the private decision log, not from memory.

## Summary

| Area | Commits | What a reader sees |
| --- | --- | --- |
| Hosted demo | 300fc5e, 6b91516, 797fafa, 0deba86, 3933ba0 | Judge sign-in, a $20 Token Factory cap, a restart that no longer crash-loops |
| Which outlet answered | dc8848e, e1ee492 | The audit page names Token Factory, the local outlet or the demo; a refused answer is ADVICE_INVALID |
| Evidence chain and badges | cf1a0ac, 0405e35 | The sender can open what each adviser call was given and answered; identity and access are shown apart |
| Local outlet speed | 0b05fee, 6477e0e | Nemotron Nano back to about 2.3 to 2.7 seconds per call |
| Adviser behaviour | b655193, 478e34e | An unreachable adviser is asked again before a delivery pauses; nobody is chased once all collected |
| Documentation | 478e34e, and the commit that adds this record | Two architecture diagrams redrawn and the state diagram given its retry loop; stage descriptions brought up to date |

## 2026-09-24

**300fc5e 01:13 — hosted demo behind a sign-in and a spending cap.** When `REQUIRE_DEMO_GATE=true`,
`demo-gate.js` puts a judge sign-in (HMAC session cookie) in front of every page and API route except
the sign-in page and its script, `styles.css`, `/api/judge-login` and `/api/health`.
`nebius-budget.js` keeps a ledger that reserves the worst-case cost of each Token Factory call before
it is sent and refuses a call that would pass the cap; a budget configured without prices counts as
spent rather than unlimited. When the budget is spent, decisions fall back to the synthetic adviser
rather than pausing every delivery. The hosted start script accepts a registry of token hashes only
(`HOSTED_REGISTRY_B64`), and `setup-local.mjs` gains `--until` to set grant expiry. New tests: `scripts/demo-gate.test.mjs`,
`scripts/nebius-budget.test.mjs`.

**6b91516 02:49 — documents describe the hosted instance as it runs.** README, deployment notes,
submission gap check and scan evidence updated; claims that predated the hosted instance retired.

**797fafa 04:50 — a refusal is recorded against its task.** A refused request that concerns a known
task now carries that task id in the audit record, still without the identity of whoever was
refused.

**0deba86 05:22 — a leftover lock no longer crash-loops a restart.** A restart on the hosted volume
found the previous container's `server.lock` and exited in a loop. `scripts/hosted-lock.mjs` clears a
lock only when the recorded process is not a live instance of this server (checked through `/proc`),
with tests in `scripts/hosted-lock.test.mjs`; the start wrapper also forwards SIGTERM and SIGINT to
the server so it can release the lock.

**3933ba0 05:27 — the hosted wrapper starts with exec.** `zbpack.json` starts the wrapper with
`exec`, so it is the container's first process and a stop signal reaches it.

**dc8848e 13:27 — name the outlet, classify a refused answer.** The server logs one line per adviser
call (kind, outlet, model, milliseconds, action, reason; no alias or identity), and a line beginning
`ERROR` when a call fails. Audit times follow the interface language. An answer the
validator refused is recorded as `ADVICE_INVALID`, apart from an adviser that never answered
(`ADVISER_UNAVAILABLE`).

**cf1a0ac 21:53 — evidence chain; identity and access shown apart.** Each job keeps an advice trail:
the projection sent, the validated answer or a refusal code (a refusal keeps only the validator's own
text), at most 20 entries, and the chain reports for each input how many real identifiers it
contains. `GET /api/tasks/:id/evidence` returns the chain to the task's owner only;
`GET /api/whoami` returns only `ok` and the identity kind (sender, recipient, coordinator or
administrator). The audit page gains a five-step
evidence panel (approved, private mapping, what the model received, what it answered, mapped back
by fixed code), built with `textContent` only. Pages show `IDENTITY VERIFIED` once a registered
token is entered and,
on the recipient page, `ACCESS APPROVED` or `ACCESS DENIED` after a download attempt, so a signed-in
person who is not on the snapshot is visibly verified and refused.

**e1ee492 22:20 — the runtime label and the evidence layout.** The audit page's runtime label had
said Token Factory whenever a key was present; it now follows the outlet actually configured.
Evidence blocks are shown whole instead of inside inner scroll boxes.

**0b05fee 22:47 — local reasoning turned off per request.** Nemotron Nano through LM Studio had gone
from 3.7–4.1 seconds (measured 2026-09-18) to 7–27 seconds. The request and prompt were unchanged;
LM Studio had begun applying the JSON schema only after the model's reasoning, so the schema no
longer suppressed it. The local outlet now sends `reasoning_effort: "none"` and `temperature: 0`.
Measured on the shipped path: follow-up 30 of 30 and route 10 of 10 accepted, 0 reasoning tokens,
2.3 to 2.7 seconds per call. `chat_template_kwargs` and a `reasoning: "off"` field left reasoning on;
without `temperature: 0`, 3 of 18 answers chose a reason the lookup table rules out, and the
validator refused each. The Token Factory request is unchanged.

## 2026-09-25

**6477e0e 00:59 — wording.** The README says the schema stopped reasoning on the earlier runtime,
not on the current one.

**0405e35 01:40 — review fixes (architect, mid-level and senior reviews).**
- Each advice-trail entry names the outlet that answered, from a fixed list; a call refused before
  any request left is not attributed to an outlet.
- The sender page's model panel follows the outlet actually configured.
- The mapped-back step follows the delivery fixed code actually prepared, not the adviser's answer,
  so a ROUTE later stopped by a reloaded grant is not shown as delivered, and tasks stored before
  the trail existed still map back.
- Opening an evidence chain is audited as `EVIDENCE_VIEWED`, at most once per task per minute.
- A slow response cannot redraw a previous viewer's chain or audit list after the token changes.
- The real-identifier check ignores case, also covers the owner and grant ids, and finds identifiers
  of six or more characters embedded in longer strings; approved channel names are compared whole.
- The runtime label reads "Demo (Token Factory budget spent)" when the cap is reached.
- The local outlet times out at 10 seconds instead of 30.
- Selects are sized to their options, so macOS no longer opens a menu across the whole page.
- Every audit code shown on screen has a Chinese label; duplicate dictionary keys removed.
- The hosted preflight checks routes that exist.

**b655193 02:03 — adviser behaviour.**
- A first routing check that never reached the adviser no longer pauses the delivery at once: the job stays
  `PENDING_CHECK` (the only state for which the routing policy proposes a route) and asks again up
  to three times, 30 seconds apart, then pauses with `ADVISER_UNAVAILABLE`. A refused answer still
  pauses at once, and a delivery already in `RETRY_WAIT` still pauses at once. Resume clears the
  retry count.
- A delivery everyone has collected is no longer put to the follow-up adviser, whose only permitted
  answer there was WAIT.
- Checked end to end on an isolated copy: an unreachable outlet gave three spaced retries and a
  pause; a resume on Nemotron Nano routed in 3.2 seconds; a fully collected delivery past its
  follow-up time made no model call, and the same delivery with its receipts removed was asked.

**478e34e 02:30 — second review pass.**
- Follow-up failures retry three times a minute apart, then move to half of what is left, instead of
  once a minute until the deadline.
- Routing and follow-up keep separate halves of the advice trail, so reminders cannot push the
  routing evidence out.
- A failure raised before any request left (outlet disabled or misconfigured) is not retried (it was
  already not attributed to an outlet since 0405e35). Revoking a delivery clears a pending retry.
- The sender sees "Adviser not answering; asking again n/3" while a retry is pending.
- A recipient not on the delivery sees no receipt error when signing in, only the refusal at
  download.
- A lapsed hosted sign-in is labelled as such rather than as an unverified identity.
- The hosted preflight checks that each page serves its own script. The state diagram gains the
  retry loop.

**Documentation (the commit that adds this record).** The sequence and trust-boundary diagrams are
redrawn from the code: answer validation, bounded retries, the evidence trail and chain, the audit
log, the per-party token, the judge sign-in and the spending cap. The README's architecture text,
the threat model (English and Chinese), the approved-delivery architecture, the local workflow
states and the deployment call bounds are brought up to date, as are the scan evidence, the
submission gap check, the security gate summary and the export manifest (now 117 entries, adding
this record).

## Verification At The End Of 2026-09-25

- `npm test`: 115 of 115, thirty consecutive runs (`logs/experiments/runs30_final_20260925.log`,
  private); `node --test scripts/*.test.mjs`: 227 of 227.
- Release candidate of 117 files: export-gate pass with no blocking finding, release-boundary 0,
  localguard CRITICAL and HIGH at the baseline (89 findings: 3 CRITICAL, 15 HIGH, 62 MEDIUM, 9 LOW).
  The MEDIUM and LOW findings added in
  this period are heuristic matches — keywords, route maps, cache and shell wording in interface
  text, diagrams, tests and deployment notes — each recorded in `SECURITY_SCAN_EVIDENCE.md`.
- English and Chinese pages scanned from the rendered HTML after the last interface change: no
  untranslated interface text.
- The recording data was compared by SHA-256 against its baseline after the isolated runs and did
  not change.
