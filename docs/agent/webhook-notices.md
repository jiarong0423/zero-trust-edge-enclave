# Optional webhook notice adapter

Status: implemented as a standalone module, not yet wired into the server (see "Wiring for the lead").
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
3. Records the outcome in a local ledger so a restart or a repeated export never sends it twice.

## Configuration

| Variable | Meaning |
|---|---|
| `WEBHOOK_URL` | Receiver URL. `https` only. Feature is off when unset or empty. No credentials in the URL, no fragment. A query string is allowed and is never logged. |
| `WEBHOOK_ALLOWED_HOSTS` | Comma list, **required** when `WEBHOOK_URL` is set. Exact host match (case-insensitive); no wildcards, no suffixes, no ports. IPv6 as `[::1]`. The `WEBHOOK_URL` host must be in the list. |
| `WEBHOOK_SECRET` | HMAC-SHA256 signing key, at least 16 characters. Never logged, never in a payload or ledger line. |
| `PUBLIC_BASE_URL` | Base used to build the link. `https` (plain `http` only for `127.0.0.1`, `[::1]` or `localhost` with `WEBHOOK_ALLOW_LOOPBACK=true`); no credentials, query or fragment. |
| `WEBHOOK_TIMEOUT_MS` | Whole-attempt timeout (connect, send, response headers and body). Default 5000, range 100 to 60000. |
| `WEBHOOK_MAX_ATTEMPTS` | Attempts per notice before the failure is recorded as permanent. Default 5, range 1 to 10. |
| `WEBHOOK_ALLOW_LOOPBACK` | `true` allows `http://127.0.0.1` / `http://[::1]` receivers and loopback addresses. For tests and a receiver on the same host only; it opens nothing else (private, link-local and metadata ranges stay refused). |

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
X-Enclave-Timestamp: <unix seconds>
X-Enclave-Notice-Id: <noticeId>
X-Enclave-Signature: sha256=<hex HMAC-SHA256(WEBHOOK_SECRET, timestamp + "." + rawBody)>
```

The receiver should: recompute the HMAC over the raw bytes it received and compare in constant time;
reject a timestamp older than a few minutes (replay); and treat `X-Enclave-Notice-Id` as an
idempotency key, because delivery is at-least-once (see below). Each retry re-signs with a fresh
timestamp and keeps the same notice id and body.

## Network safety

- Only `https`, except the explicit loopback test mode.
- The host must be in `WEBHOOK_ALLOWED_HOSTS`.
- The name is resolved by the adapter. **Every** returned address must be a routable public unicast
  address, otherwise the notice fails at once as `TARGET_ADDRESS_REFUSED` (no retry). Refused ranges:
  `0/8`, `10/8`, `100.64/10`, `127/8`, `169.254/16` (includes the cloud metadata address),
  `172.16/12`, `192.0.0/24`, `192.0.2/24`, `192.168/16`, `198.18/15`, `198.51.100/24`, `203.0.113/24`,
  `224/4`, `240/4`, and for IPv6 `::`, `::1`, `fc00::/7` (includes `fd00:ec2::254`), `fe80::/10`,
  `ff00::/8`, `2001:db8::/32`, `64:ff9b::/96`, `2002::/16`; IPv4-mapped IPv6 is unwrapped first.
- The connection is made to the address that was just checked (the Host header and TLS server name
  stay the receiver's name, so the certificate is verified against the name, not the IP), and the
  socket's remote address is checked again once connected.
- Redirects are never followed: any 3xx is `REDIRECT_REFUSED`, recorded at once, not retried. The
  module uses `node:http`/`node:https` rather than `fetch` because `fetch` offers no way to pin the
  connection to a checked address without a dependency; the effect of `redirect: 'error'` is kept.
- The response body is never read as a value: it is counted, cut off after 4 KiB, and dropped. Only
  the status code is used.

## Durability and idempotency

The ledger is `<outboxDir>/webhook-sent.jsonl` (the same directory as the outbox by default, so
under `DATA_DIR`, which git ignores), mode `0600` in a `0700` directory, opened `O_APPEND|O_NOFOLLOW`,
one `write()` per line, `fsync` before the entry counts as recorded; at most 64 MiB. Each line:

```json
{"noticeId":"...","status":"SENT","code":"OK","httpStatus":200,"attempts":1,"sendsWebhook":true,"sendsEmail":false,"at":"2026-10-08T01:02:04.000Z"}
```

`sendsWebhook: true` exists only on a `SENT` line; a `FAILED` line has `sendsWebhook: false`.
`sendsEmail` is `false` on both: the webhook is a different statement from an email and never
changes that one.

- A notice id with a `SENT` or `FAILED` line is never sent again, by this process after a restart or
  by a second instance on the same ledger. A damaged line is not an identity; that notice is offered
  again (the receiver deduplicates on `X-Enclave-Notice-Id`).
- Retry: bounded by `WEBHOOK_MAX_ATTEMPTS`, delay `min(30 s, 1 s * 2^(attempt-1))` times a random factor
  between 0.5 and 1. Every non-2xx status and every network error is retried, except a redirect and
  a refused target address, which are recorded as failed on the first attempt.
- After the last attempt the failure is written as `FAILED` with a code (`HTTP_500`, `TIMEOUT`,
  `ECONNREFUSED`, `DNS_FAILED`, `REDIRECT_REFUSED`, `TARGET_ADDRESS_REFUSED`, `NETWORK_ERROR`, or another
  upper-case Node error code) and is not retried again. To resend one deliberately, stop the
  application and delete that one line from the ledger.
- If the ledger cannot be opened at the start of a run, nothing is sent (`WEBHOOK_LEDGER_UNAVAILABLE`).
  If the append fails after a send, the entry is kept in memory, the run throws
  `WEBHOOK_LEDGER_WRITE_FAILED`, the notice is not sent again by this process, and the entry is written
  first thing on the next run. A crash in that window (send done, ledger line not yet written) is the
  one case in which a restart sends the same notice a second time, with the same id: delivery is
  at-least-once and the receiver's idempotency key is what makes it exactly-once in effect.
- One run at a time per ledger directory inside a process. At most 50 notices are handled per run;
  the rest wait for the next `kick()`.

## Logging

One line per attempt, codes only: notice id prefix (8 hex), attempt number, HTTP status.

```
webhook sent notice=1a2b3c4d attempt=2/5 status=204
ERROR webhook retry notice=1a2b3c4d attempt=1/5 status=500 code=HTTP_500
ERROR webhook failed notice=1a2b3c4d attempt=5/5 status=- code=TIMEOUT
ERROR webhook ledger write failed: ENOSPC
ERROR webhook 2 record(s) refused: WEBHOOK_RECORD_INVALID
```

The URL, its query, the host, the secret, the signature and the body are never printed.

## Wiring for the lead

Nothing below is applied; `server.js`, `worker-schedule.js` and `env.sample` are not touched by this
change.

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
