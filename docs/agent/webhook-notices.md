# Optional webhook notice adapter

Status: implemented and wired (`server.js` creates it with `createWebhookFromEnv`, `worker-schedule.js` kicks it after each export). `env.sample` does not list the variables yet (see "Wiring").
Code: `webhook-adapter.js`. Tests: `scripts/webhook-adapter.test.mjs`.

## What it is

The application still sends no email. Every prepared notice is a dry-run record appended to
`<DATA_DIR>/outbox/notices.jsonl` (`notice-outbox.js`). This adapter is an opt-in way to tell an
operator's own receiver "a notice exists" without the operator polling that file. It is **off unless
`WEBHOOK_URL` is set**. With it unset, `createWebhookFromEnv()` returns an inert object and the file
worker behaves exactly as before.

What the adapter does, in order, for each outbox line it has not handled:

1. Re-validates the line with an allowlist (`readableRecord()`): fixed `kind`, fixed `subjectCode`
   vocabulary, alias pattern, integer version, ISO instant, `sendsEmail === false`, and that
   `noticeId` is the documented hash of those fields. A line that fails any of these is counted and
   skipped, never sent. The `targets` (group codes) of the line are not read into anything.
2. Builds a NEW fixed-template object (`buildPayload()`), serialises it, signs it and POSTs it.
3. Records the outcome in a local ledger so a restart or a repeated export never sends it twice. A notice that could not be delivered *yet* is recorded as `DEFERRED` and offered again later (see "Delivery states").

## Configuration

| Variable | Meaning |
|---|---|
| `WEBHOOK_URL` | Receiver URL. `https` only, port 443 (an explicit `:443` is fine). Feature is off when unset or empty. No credentials in the URL, no fragment, no whitespace or control character anywhere in it (the URL parser would silently strip a tab or newline, so such a value is refused instead). A query string is allowed and is never logged. An IP literal must pass the address policy below, and `localhost`, `*.localhost`, `*.local`, `*.internal`, `*.localdomain`, `*.home.arpa` are refused, unless `WEBHOOK_ALLOW_LOOPBACK=true`. |
| `WEBHOOK_ALLOWED_HOSTS` | Comma list, **required** when `WEBHOOK_URL` is set. Exact host match (case-insensitive); no wildcards, no suffixes, no ports. IPv6 as `[::1]`. The `WEBHOOK_URL` host must be in the list. |
| `WEBHOOK_SECRET` | HMAC-SHA256 signing key, at least 16 characters, not one repeated character, no leading or trailing whitespace (a trailing newline from a pasted value is refused). Never logged, never in a payload or ledger line; it is a non-enumerable property of the config object, so spreading, logging or serialising the config does not carry it. |
| `PUBLIC_BASE_URL` | Base used to build the link. `https` (plain `http` only for `127.0.0.1`, `[::1]` or `localhost` with `WEBHOOK_ALLOW_LOOPBACK=true`); no credentials, query or fragment. |
| `WEBHOOK_TIMEOUT_MS` | Whole-attempt timeout: name lookup, connect, send and the response status line. Default 5000, range 100 to 60000. |
| `WEBHOOK_MAX_ATTEMPTS` | Requests per notice **within one run** (short backoff between them) before the notice is DEFERRED. Not a lifetime limit; see "Delivery states". Default 5, range 1 to 10. |
| `WEBHOOK_ALLOW_LOOPBACK` | `true` allows `http://127.0.0.1` / `http://[::1]` receivers, loopback addresses, `localhost`-style names and a port other than 443. For tests and a receiver on the same host only; it opens nothing else (private, link-local and metadata ranges stay refused). It is process-wide, not per receiver. |

Any setting that is present but unusable throws a 503-style error from `webhookConfigFromEnv()`
(same `fail()` as `network-policy.js`), so the server must not start rather than run with the
allowlist, the secret or https silently missing.

## Payload

Exactly these keys, in this order (`PAYLOAD_KEYS`):

```json
{"noticeId":"<64 hex>","kind":"LOCAL_DRY_RUN","subjectCode":"SEALED_DOCUMENT_AVAILABLE","taskAlias":"<alias>","snapshotVersion":1,"preparedAt":"2026-10-08T01:02:03.000Z","link":"https://enclave.example/#task=<alias>"}
```

No recipient identifier, no group code, no document attribute, no free text. The link is
`PUBLIC_BASE_URL` plus `/#task=<alias>`. The alias is in the fragment so the receiving side's web
server and any proxy in between never see it in a request line; a mail client that opens the link
sends it to the enclave page only. **The sender page does not read `#task=` yet** (nothing in
`public/` consumes it); until it does, the link opens the sender page and the sender picks the task.
The test "the payload is a fixed template ..." serialises a fixture task full of addresses, file
names, hashes and group codes and asserts none of them appears in the body.

## Request and signature

```
POST <WEBHOOK_URL>
Content-Type: application/json
X-Enclave-Timestamp: <unix seconds, digits only>
X-Enclave-Notice-Id: <noticeId>
X-Enclave-Signature: sha256=<hex HMAC-SHA256(WEBHOOK_SECRET, timestamp + "." + noticeId + "." + rawBody)>
```

The signed string is `timestamp + "." + noticeId + "." + rawBody`. The notice id is part of it so that the
header, which is the receiver's idempotency key, cannot be rewritten in transit without breaking the
signature. (This replaces the earlier `timestamp + "." + rawBody`; nothing consumed that format.)

The receiver should:

1. require the timestamp to be digits only, and reject one older than a few minutes (replay);
2. recompute the HMAC over the raw bytes it received with the header's timestamp and notice id, and
   compare in constant time;
3. compare `X-Enclave-Notice-Id` with `noticeId` in the JSON body and **reject on mismatch**;
4. treat the notice id as an idempotency key, because delivery is at-least-once (see below). Each retry
   re-signs with a fresh timestamp and keeps the same notice id and body.

A reference check, as exercised by the test "rewriting X-Enclave-Notice-Id in transit breaks the signature":

```js
const ok = /^\d{10}$/.test(ts) && headerId === JSON.parse(rawBody).noticeId &&
  timingSafeEqual(Buffer.from(sig), Buffer.from('sha256=' + createHmac('sha256', secret).update(`${ts}.${headerId}.${rawBody}`).digest('hex')));
```

## Network safety

- Only `https`, except the explicit loopback test mode. Certificate verification is requested explicitly
  (`rejectUnauthorized: true`) and the TLS server name is the receiver's host name, so
  `NODE_TLS_REJECT_UNAUTHORIZED=0` in the environment does not turn verification off (Node still prints
  its own warning when that variable is set).
- The host must be in `WEBHOOK_ALLOWED_HOSTS`. Its port must be 443 unless the loopback test flag is set.
- The name is resolved by the adapter, and the lookup is raced against the attempt timeout (a resolver that
  never answers costs one timeout, `DNS_TIMEOUT`, and does not hold the queue). **Every** returned address
  must pass the address policy before any socket is opened; the check happens before `connect`, and the
  socket's remote address is checked again once connected as a second line.
- The address policy parses every IPv6 literal to 16 bytes itself, so no spelling is trusted to a library:
  - IPv4: refused ranges are `0/8`, `10/8`, `100.64/10`, `127/8`, `168.63.129.16`, `169.254/16` (includes the cloud
    metadata address), `172.16/12`, `192.0.0/24`, `192.0.2/24`, `192.31.196/24`, `192.52.193/24`, `192.88.99/24`,
    `192.168/16`, `192.175.48/24`, `198.18/15`, `198.51.100/24`, `203.0.113/24`, `224/4`, `240/4`. Anything that is
    not a canonical dotted quad (`2130706433`, `0x7f.1`, `127.1`, leading zeros, surrounding space) is not an address.
  - IPv4-mapped IPv6 (`::ffff:0:0/96`) is unwrapped, in dotted or hex form, in any case or long form, and judged by
    the IPv4 rules; the connection then goes to the IPv4 address.
  - The rest of `::/96` (unspecified, loopback, IPv4-compatible such as `::7f00:1`) is refused outright. `::1` is
    opened only by the loopback test flag.
  - Other IPv6 is an **allowlist**: only global unicast `2000::/3`, minus the special-purpose ranges inside it
    (`2001::/23` with Teredo and ORCHID, `2001:db8::/32`, `2002::/16`, `3ffe::/16`, `3fff::/20`). Everything outside
    `2000::/3` is refused by not being on the list, including `64:ff9b::/96`, `64:ff9b:1::/48`, `::ffff:0:0:0/96`,
    `100::/64`, `fc00::/7` (includes `fd00:ec2::254`), `fe80::/10`, `fec0::/10`, `ff00::/8`, `5f00::/16`.
  - A zone id (`%eth0`) is refused.
- The connection is made to the address text rebuilt from the checked bytes (the Host header and TLS server
  name stay the receiver's name, so the certificate is verified against the name, not the IP).
- Redirects are never followed: any 3xx is `REDIRECT_REFUSED`, recorded at once as `FAILED`, not retried. The
  module uses `node:http`/`node:https` rather than `fetch` because `fetch` offers no way to pin the
  connection to a checked address without a dependency; the effect of `redirect: 'error'` is kept.
- **The first status line is the answer.** The response body is never read: once the status line has arrived the
  attempt is settled and the socket is destroyed, so a body that hangs, is endless or is reset can neither delay
  the result nor turn a 2xx into `TIMEOUT` or `ECONNRESET` (which would have re-sent an acknowledged notice).

## Durability and idempotency

The ledger is `<outboxDir>/webhook-sent.jsonl` (the same directory as the outbox by default, so
under `DATA_DIR`, which git ignores), mode `0600` in a `0700` directory, opened `O_APPEND|O_NOFOLLOW|O_NONBLOCK`,
one `write()` per line, `fsync` before the entry counts as recorded; at most 64 MiB. A ledger directory that
is a symlink is refused (`LEDGER_DIR_IS_SYMLINK`), never followed and never `chmod`-ed through. Each line:

```json
{"noticeId":"...","status":"SENT","code":"OK","httpStatus":200,"attempts":1,"sendsWebhook":true,"sendsEmail":false,"at":"2026-10-08T01:02:04.000Z"}
{"noticeId":"...","status":"DEFERRED","code":"HTTP_503","httpStatus":503,"attempts":5,"sendsWebhook":false,"sendsEmail":false,"at":"...","nextEligibleAt":"2026-10-08T01:03:04.000Z"}
```

`sendsWebhook: true` exists only on a `SENT` line; every other line has `sendsWebhook: false`.
`sendsEmail` is `false` everywhere: the webhook is a different statement from an email and never
changes that one. `attempts` is cumulative over all runs.

### Delivery states

| Status | Meaning | Offered again? |
|---|---|---|
| `SENT` | A 2xx status line was received. | Never. |
| `FAILED` | A permanent cause, or the deferral cap was spent. | Never. |
| `DEFERRED` | A cause that may pass. | By a later `kick()` once `nextEligibleAt` has passed. |

Permanent (`FAILED` on the first occurrence): the record is invalid (`WEBHOOK_RECORD_INVALID`), the
policy refuses a **literal** target address (`TARGET_ADDRESS_REFUSED`; the answer cannot change), or the
receiver answers with a redirect (`REDIRECT_REFUSED`). Configuration-level refusals never reach this point: they stop the server at startup.

Everything else is transient and becomes `DEFERRED`: any 5xx and any other non-2xx status (including a
404 or 401 from a misconfigured URL or secret, which the operator can fix), `TIMEOUT`, `DNS_TIMEOUT`,
`DNS_FAILED`, `ECONNREFUSED`, `ECONNRESET`, TLS certificate errors, and `TARGET_ADDRESS_REFUSED` for a
**name** (the next lookup may answer differently).

- Within one run a notice gets up to `WEBHOOK_MAX_ATTEMPTS` requests with backoff `min(30 s, 1 s * 2^(attempt-1))`
  times a random factor between 0.5 and 1 (a refused DNS answer is not retried within the run). Then it is
  written as `DEFERRED` with `nextEligibleAt = now + min(6 h, 1 min * 2^(deferrals-1))` times a random factor
  between 0.5 and 1: about 1, 2, 4, 8, 16, 32, 64, 128, 256 minutes, then 6 hours.
- After `MAX_DEFERRALS` (12) deferrals the next failed run writes `FAILED` with `code: "RETRY_EXHAUSTED"` and
  `lastCode`, which is terminal. Roughly a day of outage is tolerated.
- A run **stops after the first deferral**. A receiver that is down costs one notice's attempts per run, not
  one request per notice (the earlier design made up to 250 requests and wrote 50 permanent failures per run).
  The notices after it are untouched and are tried by the next run. At most 50 notices are handled per run.
- `kick()` re-reads the whole outbox and the ledger; it offers a notice only if it has no line, or its latest
  state is `DEFERRED` and `nextEligibleAt` has passed. `SENT` and `FAILED` are never offered again.
  **Something has to call `kick()` again** for a deferred notice to be retried: the worker kicks after each
  export, which happens at startup and after a change. For retries independent of that, add
  `setInterval(() => void webhook.kick(), 60_000).unref()` next to the worker timer.
- To resend a `FAILED` notice deliberately, stop the application and edit the ledger by hand (an append-only
  file; remove only that notice's lines). There is no API for it.

### At-least-once

Delivery is **at-least-once**. The receiver's idempotency key (`X-Enclave-Notice-Id`) is what makes it
exactly-once in effect. A notice can reach the receiver more than once when: a request was cut off after the
receiver processed it (timeout or connection loss before the status line); `close()` aborted a request in
flight (nothing is recorded for it); the process crashed between the send and the ledger line; or a damaged
ledger line made the id unreadable. A notice whose status line was 2xx is `SENT` and is not sent again.

- If the ledger cannot be opened at the start of a run, nothing is sent (`WEBHOOK_LEDGER_UNAVAILABLE`).
  If the append fails after a send, the entry is kept in memory, the run throws
  `WEBHOOK_LEDGER_WRITE_FAILED`, the notice is not sent again by this process, and the entry is written
  first thing on the next run.
- One run at a time per ledger directory inside a process; the queue is keyed by the **real path** of the
  directory (symlinked parents and relative spellings share one queue). Two processes on one ledger are
  not supported: the application holds `server.lock` for the data directory.
- A FIFO planted as `notices.jsonl` cannot hang a run (opened `O_NONBLOCK`, then refused as not a file).

### Stopping

`close()` aborts in-flight requests and name lookups, ends backoff sleeps, records nothing for an attempt
that was cut off, and returns once the run in progress has stopped. After `close()`, `kick()`, `deliver()`
and `sendPending()` do nothing. Backoff timers are unref-ed, so a pending retry never keeps the process alive
(it also means a run that is mid-backoff when the process exits is simply not finished; the notice stays
offerable).

## Logging

One line per attempt outcome, codes only: notice id prefix (8 hex), attempt number within the run, HTTP status.

```
webhook sent notice=1a2b3c4d attempt=2/5 status=204
ERROR webhook retry notice=1a2b3c4d attempt=1/5 status=500 code=HTTP_500
ERROR webhook deferred notice=1a2b3c4d attempt=5/5 status=- code=TIMEOUT deferral=1/12 next=2026-10-08T01:03:04.000Z
ERROR webhook failed notice=1a2b3c4d attempt=1/5 status=- code=REDIRECT_REFUSED
ERROR webhook failed notice=1a2b3c4d attempt=5/5 status=503 code=RETRY_EXHAUSTED last=HTTP_503
ERROR webhook ledger write failed: ENOSPC
ERROR webhook 2 record(s) refused: WEBHOOK_RECORD_INVALID
```

The URL, its query, the host, the secret, the signature and the body are never printed.

## Wiring

`server.js` and `worker-schedule.js` already contain the code below. `env.sample` does not yet list the
variables (the lines are given for whoever owns that file).

### `env.sample` lines to add

```
# Off unless WEBHOOK_URL is set. Tells your own receiver that a prepared notice exists (signed, link only, no recipients). The application still sends no email.
# WEBHOOK_URL=https://hooks.example.com/enclave-notice
# Required with WEBHOOK_URL: comma separated host names, exact match, no wildcards.
# WEBHOOK_ALLOWED_HOSTS=hooks.example.com
# Required with WEBHOOK_URL: at least 16 characters; the receiver verifies X-Enclave-Signature with it. Never commit a real value.
# WEBHOOK_SECRET=
# Required with WEBHOOK_URL: the public https address of this application, used to build the link.
# PUBLIC_BASE_URL=https://enclave.example.com
# WEBHOOK_TIMEOUT_MS=5000
# WEBHOOK_MAX_ATTEMPTS=5
# Tests and a same-host receiver only: allows http://127.0.0.1 and http://[::1].
# WEBHOOK_ALLOW_LOOPBACK=false
```

### Code

`worker-schedule.js` already owns the export call (`exportNotices: tasks => exportNoticesSafe(...)`).
The adapter needs to be created once at startup, so a bad configuration stops the server before it
listens, and kicked after each export.

In `server.js`, next to `createNetworkPolicy(process.env.ALLOWED_CLIENT_CIDRS)`:

```js
import { createWebhookFromEnv } from './webhook-adapter.js';

const webhook = createWebhookFromEnv(process.env, { outboxDir: path.join(dataDir, 'outbox') });
```

and pass it into the worker: `createFileWorker({ ..., dataDir, webhook })`. In `worker-schedule.js`:

```js
export function createFileWorker({ queue, readJson, writeJson, tasksPath, accessPath, dataDir, recoverAudit, fileAdviser, webhook }) {
  const outboxDir = path.join(dataDir, 'outbox');
  // ...
    exportNotices: async tasks => {
      const result = await exportNoticesSafe(tasks, outboxDir);
      if (webhook && !result?.failed) void webhook.kick();
      return result;
    },
```

`kick()` never throws and is not awaited, so retries and backoff never hold the serial queue or a
worker tick. `worker-pass.js` only exports when it is dirty (at startup, and after a change), so a
notice that is still waiting after an unavailable ledger or a run capped at 50 is picked up by the
next export or restart; if you want a periodic retry independent of that, add
`setInterval(() => void webhook.kick(), 60_000)` next to the worker timer (the timer should be
`unref()`ed like the existing one, if it is).

### Documentation rows for the owner of `docs/compliance/`

- Data inventory: webhook ledger `outbox/webhook-sent.jsonl`, mode `0600` in `0700`; keys `noticeId`,
  `status`, `code`, `httpStatus`, `attempts`, `sendsWebhook`, `sendsEmail`, `at`; no alias, no identity
  (`webhook-adapter.js` `createLedger()`, `ledgerEntry` in `createWebhookAdapter()`). Append-only, no rotation;
  refuses above 64 MiB (`LEDGER_TOO_LARGE`).
- Outbound flow: when enabled, one HTTPS POST per notice to the single allowlisted host, body
  `PAYLOAD_KEYS`, which includes the task alias and a link. The alias is a pseudonym for the sender's
  own task, not a recipient identifier; the receiver is a third party chosen by the operator and
  receives it.
- Server log lines: the `webhook ...` and `ERROR webhook ...` forms listed above.
- Threat model: SSRF through a configured URL (allowlist, address policy, pinned connection,
  no redirects); forged notices (HMAC over timestamp and body); replay (timestamp plus notice id at the receiver).
- `public-export-manifest.md` must list `webhook-adapter.js` before any export.

## Not covered by tests

- A real public DNS name, a real public receiver and a real certificate chain: the test suite uses a
  loopback receiver, injected DNS answers, and a generated self-signed certificate for the https path
  (skipped if `openssl` with `-addext` is missing).
- IPv6 end to end (`[::1]` is accepted by the configuration and the address policy is unit-tested;
  no IPv6 receiver is started).
- DNS rebinding between the check and the connect is prevented by connecting to the checked address,
  not exercised against a rebinding resolver.
- Windows: file modes and `O_NOFOLLOW` are not enforced there.
- Two processes sharing one ledger directory (the in-process serialisation does not cover it; the
  application already holds `server.lock` for the data directory).
- The deferral and cap behaviour is tested with an injected clock and a loopback receiver; a real multi-day
  outage is not.

## Known limits

Accepted for now, not fixed:

- Every `kick()` re-parses the whole outbox file and the whole ledger. The ledger is append-only with no
  rotation and refuses to run above 64 MiB (`LEDGER_TOO_LARGE`), as does the outbox.
- The outbox and the adapter can disagree about a corrupt identity line: the outbox treats a parseable line
  that carries a `noticeId` as already exported even if the adapter's strict check would refuse it, so such a
  notice is neither re-exported nor delivered. The adapter counts it as `invalid` and logs it.
- A 304 is labelled `REDIRECT_REFUSED` (every 3xx is), and that is permanent. A receiver URL that redirects
  (for example http to https, or a missing trailing path) permanently fails each notice offered to it, up to the
  50-per-run cap; fix the URL before the first export.
- `WEBHOOK_ALLOW_LOOPBACK` is process-wide: it relaxes the address policy for the one receiver but also for any
  name that resolves to loopback. Do not set it in production.
- Retries need a caller: see "Delivery states". There is no internal scheduler.
- Two processes on one ledger are unsupported (the in-process queue does not cover them).
