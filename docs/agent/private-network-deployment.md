# Private-Network Deployment

Written 2026-10-08, from the code at this revision. This describes what travels where in one delivery
and which settings make a deployment behave as a private-network service. It does not describe a
certified deployment: there is no independent KMS or TEE, and "private route" is a property of how the
host is deployed, not of the default configuration.

## What Travels Where

One delivery, from `POST /api/file-tasks` to the recipient's decryption, as implemented in `server.js`.

| Step | From | To | What crosses | Notes |
| --- | --- | --- | --- | --- |
| 1 | Sender browser | Backend (`POST /api/file-tasks`) | The ciphertext packet and the document key (`documentKey`, 64 hex characters) | Both travel over the network. The document is encrypted in the browser first; plaintext never leaves the two browsers. |
| 2 | Backend | Backend storage (`DATA_DIR`) | Ciphertext in `tasks.json`; the key wrapped by the local key vault in `DATA_DIR/private-keys` | Storage and vault share one host and one process. A compromised backend is outside the protection boundary. There is no independent KMS or TEE. The raw key is zeroed in memory after wrapping and is not stored in the clear. |
| 3 | Recipient browser | Backend (`POST /api/file-access/<task>/packet`) | Request names the snapshot version | Recipient token required; the recipient must be in the approved snapshot and the download window must be open. Backend returns the ciphertext packet. |
| 4 | Recipient browser | Backend (`POST .../credential`) | Request names the snapshot version | Backend returns a one-use key ticket. Only its hash is stored. It is bound to the recipient and the snapshot version, lasts 5 minutes (or until the download deadline, whichever is earlier), and is single use. At most 50 pending tickets per task. |
| 5 | Recipient browser | Backend (`POST .../key`) | The ticket | Backend unwraps the key and returns it in a JSON response (`{ "key": "<hex>" }`), marks the ticket used, and records the release. The grant's `maxOpens` limits releases per recipient and version. |
| 6 | Recipient browser | Itself | Decryption | Plaintext exists only here and in the sender's browser. |
| 7 | Backend | Adviser outlet (Nebius Token Factory, or a loopback local model) | Five pseudonymous fields per decision | Routing: `taskAlias`, `snapshotVersion`, `channels`, `state`, `attempts`. Follow-up: `taskAlias`, `snapshotVersion`, `timeCode`, `nudgeCount`, `pickupCode`. Nothing else is dispatched; the document, recipients, addresses and keys are not. With `COORDINATOR_PROVIDER=synthetic_fixture` (the default) no outlet is called. With the opt-in `COORDINATOR_PROVIDER=local_then_nebius` the loopback model is asked first and nothing leaves the host unless that call failed; only then are the same five fields sent to Token Factory, once. An edge-only deployment (`LOCAL_ONLY=true`) cannot use that mode: the server refuses to start. See [cascade outlet](cascade-outlet.md). |

Steps 1 and 5 carry the key in a request or response body. That is why transport security is not
optional beyond loopback (next section).

## Why TLS Is Mandatory Beyond Localhost

- The document key travels in a JSON body at steps 1 and 5. Over plain http on a network, any observer
  of that path can read the key and, with the ciphertext, the document.
- Browser encryption uses Web Crypto, which exists only in a secure context. Browsers treat loopback
  as secure; a page loaded from `http://<lan-ip>` connects and renders, then finds `crypto.subtle`
  undefined, so nothing can be encrypted or decrypted there. See the comment above the TLS options in
  `server.js`.
- Supplying `TLS_CERT_FILE` and `TLS_KEY_FILE` switches the listener to https. Alternatively terminate
  TLS at a reverse proxy and keep the proxy-to-backend hop on loopback or an equally private link.
  `scripts/local-tls-cert.mjs` makes a 30-day certificate for a LAN address; each device must trust it
  once. It is a demonstration aid, not a production certificate process.

## Recommended Private-Network Settings

| Setting | Recommendation | Behaviour in code |
| --- | --- | --- |
| `HOST` | Default `127.0.0.1` behind a same-host reverse proxy; the specific private interface address otherwise. `0.0.0.0` only if a firewall limits who can connect. | Default is `127.0.0.1`. |
| `TLS_CERT_FILE` / `TLS_KEY_FILE` | Set both when the backend itself faces the network. | Both must be set to enable https; otherwise plain http. |
| `TRUST_PROXY` | `true` only behind a proxy that overwrites `X-Forwarded-For`. Otherwise leave unset. | `true` takes the client address from the first `X-Forwarded-For` entry for both the throttle and `ALLOWED_CLIENT_CIDRS`. Without a proxy that overwrites the header, any client can forge it and bypass both. A malformed header falls back to the socket address. |
| `ALLOWED_CLIENT_CIDRS` | Comma separated IPv4/IPv6 CIDRs of the networks that may connect. | Unset or empty: no restriction. Set: a client outside every listed network gets 403 before anything else is parsed, pages and `/api/health` included. An invalid entry, or a value that is set but lists no network (`" "`, `","`), stops startup instead of silently turning the policy off. |
| `AUTH_MAX_FAILURES` / `AUTH_WINDOW_SECONDS` / `AUTH_LOCK_SECONDS` | Defaults 10 / 60 / 60 are a starting point; tighten for a smaller user base. | Positive integers; anything else stops startup. |

Loopback is not allowed implicitly by `ALLOWED_CLIENT_CIDRS`. Behind a reverse proxy on the same host
every request would arrive from `127.0.0.1`, so an implicit allowance would bypass the list. Without
`TRUST_PROXY`, such a deployment must list `127.0.0.1/32` (and `::1/128`), which admits every client
the proxy forwards; with `TRUST_PROXY=true`, list the real client networks instead.

Failed sign-in throttle (`auth-throttle.js`): only a real guess counts, meaning a 43-character Bearer
token (the length every issuer produces) that belongs to no registered identity. The pages check a token
as it is typed, so every prefix of a real token reaches the server on the way; prefixes, missing or
malformed headers, and the token of a registered but disabled identity do not count, and a valid
sign-in does not reset the counter. After `AUTH_MAX_FAILURES` guesses inside `AUTH_WINDOW_SECONDS`, the
client is locked for `AUTH_LOCK_SECONDS`: every request from it gets 429 with `Retry-After`, including
one that carries a valid token, and one `WARN auth throttle locked client ...` line is logged.
Addresses are normalised so every spelling of one address is one key, and an IPv6 client is keyed by its
/64. A lock is not forgotten when many throwaway keys arrive; only if every tracked key is locked is the
oldest lock released. State is in memory, so a restart clears it. The hosted judge sign-in
(`demo-gate.js`) is limited per client (20 failures a minute) with a higher global ceiling (200), so one
client cannot lock every judge out; its 429 carries `Retry-After`. Tokens are 32 random bytes, so the
throttle makes guessing visible and slow; it is not the primary defence.

Example, backend on a private interface with its own certificate:

```bash
HOST=10.0.0.5 TLS_CERT_FILE=/path/cert.pem TLS_KEY_FILE=/path/key.pem \
ALLOWED_CLIENT_CIDRS=10.0.0.0/24 npm start
```

Example, same-host reverse proxy that overwrites `X-Forwarded-For`:

```bash
HOST=127.0.0.1 TRUST_PROXY=true ALLOWED_CLIENT_CIDRS=10.0.0.0/24 npm start
```

## Credential Lifetimes

| Credential | Lifetime | Revoked or replaced by |
| --- | --- | --- |
| Role token (sender, recipient, coordinator, administrator) | Long-lived. There is no per-token expiry. What a token can do ends with the authorization grant it works under (`expiresAt`, `revoked`). | Rotation on the admin page (`person.rotate`; the bootstrap administrator is protected from it) replaces the stored token hash, so the old token stops working; the new one is returned once, as a file download on that page. Disabling the person also stops it. Only hashes are stored server side. |
| Key ticket | 5 minutes, or until the download deadline if sooner. Single use. Bound to recipient and snapshot version. Hash only. | Consumed on use. An expired ticket is refused, and is pruned the next time a ticket is issued for that task. |
| Timed decode credential (legacy package path) | Capped at 5 minutes and at the envelope expiry. | Not part of the file workflow. |

## Honest Limits

- No independent KMS or TEE. Ciphertext and wrapped keys live in the same host and process as the key
  vault. Anyone who controls the backend controls the keys.
- No SSO. Role tokens are local bearer identities; whoever holds one is that identity until it is
  rotated or its grant ends.
- Notices are dry-run. The workflow prepares simulated notices and reports `sendsEmail: false`; no
  email is sent, and the outbox file is only a hand-off for a gateway you operate.
- "Private route" is a deployment property. `ALLOWED_CLIENT_CIDRS` can make the code enforce it; the
  default does not, and a deployment without it relies on tokens and encryption alone.
- Released bytes, keys and plaintext cannot be recalled.
- The throttle and the allowlist are per process and in memory or startup-time configuration; they do
  not coordinate across hosts.

## Follow-Up Floor And Notice Outbox

- `FOLLOWUP_FLOOR=true` (off by default): when the follow-up adviser answers WAIT at `WINDOW_LAST`
  and the pickup is not `PICKUP_ALL` (nothing or only part collected), fixed code escalates to a
  person with reason `DEADLINE_NEAR`. The adviser's original answer stays in the evidence trail and
  the escalation is marked as made by the floor: the sender's evidence chain (step 5, `followups`) lists
  the decisions fixed code actually made, each with `floor: true/false`. Like any escalation, it means a
  person has already been asked, so no later `DELIVERY_OVERDUE` record is written for that version. Any
  value other than the string `true` leaves it off.
- Notice outbox (always written, not a setting): each worker pass appends prepared dry-run notices to
  `<DATA_DIR>/outbox/notices.jsonl`, deduplicated by notice id. Each line has exactly these keys:
  `noticeId` (sha256 of `taskAlias|snapshotVersion|kind|subjectCode|preparedAt`), `kind`, `subjectCode`
  (`SEALED_DOCUMENT_AVAILABLE` for the first notice, `SEALED_DOCUMENT_REMINDER` for a reminder),
  `taskAlias`, `snapshotVersion`, `targets` (group codes such as `A1`, never ids or addresses),
  `preparedAt` and `sendsEmail: false`. Records are built from an allowlist, never copied. The file is
  append-only and is not rotated by the application: past 64 MiB export stops with
  `ERROR outbox ... OUTBOX_TOO_LARGE` until the operator rotates it. The file is the integration point for
  an operator's own gateway; the application itself sends nothing (`sendsEmail` is false). The file
  is created with owner-only permissions, and an export that fails is logged without stopping the
  worker.

See also [Zeabur deployment](zeabur-deployment.md) for the hosted instance's variables and the spending
cap.
