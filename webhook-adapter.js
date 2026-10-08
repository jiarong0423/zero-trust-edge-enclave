import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import dns from 'node:dns';
import path from 'node:path';
import { promises as fs, constants } from 'node:fs';
import { createHmac } from 'node:crypto';
import { fail } from './access-control.js';
import { normalizeAddress } from './network-policy.js';
import { noticeId as computeNoticeId } from './notice-outbox.js';

/**
 * An optional adapter that tells an operator's own receiver "a prepared notice exists".
 *
 * Off unless WEBHOOK_URL is set. It reads the notices the outbox has already written
 * (`<outboxDir>/notices.jsonl`), builds a NEW fixed-template object per notice and POSTs it, signed.
 * The application still sends no email: every ledger record says `sendsEmail: false`, and a record of
 * a successful webhook call says `sendsWebhook: true`, which is a different statement.
 *
 * The payload is a template, not a projection. It carries the notice id, the two fixed vocabulary
 * words, the task alias, the snapshot version, the preparation time and a link to the sender page.
 * It never carries a recipient identifier, a group code, a document attribute or any free text; the
 * recipient list is not even read from the outbox record.
 *
 * Misconfiguration fails closed at startup with a 503-style error (the same `fail()` that
 * network-policy.js uses), so a typo cannot silently turn into "no allowlist" or "plain http".
 */

const HEX64 = /^[0-9a-f]{64}$/;
const TASK_ALIAS = /^[A-Za-z0-9-]{8,64}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const KINDS = new Set(['LOCAL_DRY_RUN']);
const SUBJECT_CODES = new Set(['SEALED_DOCUMENT_AVAILABLE', 'SEALED_DOCUMENT_REMINDER']);
const HOST_NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

export const PAYLOAD_KEYS = ['noticeId', 'kind', 'subjectCode', 'taskAlias', 'snapshotVersion', 'preparedAt', 'link'];
export const LEDGER_FILE = 'webhook-sent.jsonl';
export const OUTBOX_FILE = 'notices.jsonl';

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_ATTEMPTS = 5;
const MIN_SECRET_LENGTH = 16;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 30_000;
const RESPONSE_CAP_BYTES = 4096;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_PER_RUN = 50;

// ---------------------------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------------------------

function isLoopbackLiteral(hostname) {
  return hostname === '127.0.0.1' || hostname === '[::1]';
}

function parseHostEntry(entry) {
  const value = entry.trim().toLowerCase();
  if (value.startsWith('[') && value.endsWith(']') && net.isIPv6(value.slice(1, -1))) return value;
  if (net.isIPv4(value) || HOST_NAME.test(value)) return value;
  return null;
}

function parseIntegerSetting(name, value, fallback, min, max) {
  if (value === undefined || value === '') return fallback;
  if (!/^\d{1,6}$/.test(String(value).trim())) fail(`${name} must be a whole number`, 503);
  const number = Number(value);
  if (number < min || number > max) fail(`${name} must be between ${min} and ${max}`, 503);
  return number;
}

function parseBaseUrl(value, allowLoopback) {
  if (!value) fail('PUBLIC_BASE_URL is required when WEBHOOK_URL is set', 503);
  let url;
  try { url = new URL(value); } catch { fail('PUBLIC_BASE_URL is not a valid URL', 503); }
  const plainOk = allowLoopback && (isLoopbackLiteral(url.hostname) || url.hostname === 'localhost');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && plainOk)) fail('PUBLIC_BASE_URL must use https', 503);
  if (url.username || url.password) fail('PUBLIC_BASE_URL must not contain credentials', 503);
  if (url.search || url.hash) fail('PUBLIC_BASE_URL must not contain a query or fragment', 503);
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/**
 * Returns `{ enabled: false }` when WEBHOOK_URL is unset or empty, otherwise a validated config.
 * Throws a 503-style error for any setting that is present but unusable.
 */
export function webhookConfigFromEnv(env = process.env) {
  const raw = env.WEBHOOK_URL;
  if (raw === undefined || raw === '') return { enabled: false };
  if (!raw.trim()) fail('WEBHOOK_URL is set but empty', 503);

  const loopbackFlag = env.WEBHOOK_ALLOW_LOOPBACK;
  if (loopbackFlag !== undefined && loopbackFlag !== '' && loopbackFlag !== 'true' && loopbackFlag !== 'false') {
    fail('WEBHOOK_ALLOW_LOOPBACK must be true or false', 503);
  }
  const allowLoopback = loopbackFlag === 'true';

  let url;
  try { url = new URL(raw.trim()); } catch { fail('WEBHOOK_URL is not a valid URL', 503); }
  if (url.username || url.password) fail('WEBHOOK_URL must not contain credentials', 503);
  if (url.hash) fail('WEBHOOK_URL must not contain a fragment', 503);
  const loopbackHttp = url.protocol === 'http:' && allowLoopback && isLoopbackLiteral(url.hostname);
  if (url.protocol !== 'https:' && !loopbackHttp) {
    fail('WEBHOOK_URL must use https (http is accepted only for 127.0.0.1 or [::1] with WEBHOOK_ALLOW_LOOPBACK=true)', 503);
  }

  const entries = String(env.WEBHOOK_ALLOWED_HOSTS ?? '').split(',').map(item => item.trim()).filter(Boolean);
  if (!entries.length) fail('WEBHOOK_ALLOWED_HOSTS is required when WEBHOOK_URL is set', 503);
  const allowedHosts = new Set();
  for (const entry of entries) {
    const parsed = parseHostEntry(entry);
    if (!parsed) fail(`WEBHOOK_ALLOWED_HOSTS has an invalid entry: ${entry.slice(0, 60)}`, 503);
    allowedHosts.add(parsed);
  }
  if (!allowedHosts.has(url.hostname.toLowerCase())) fail('WEBHOOK_URL host is not listed in WEBHOOK_ALLOWED_HOSTS', 503);

  const secret = env.WEBHOOK_SECRET;
  if (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH) {
    fail(`WEBHOOK_SECRET is required when WEBHOOK_URL is set and must be at least ${MIN_SECRET_LENGTH} characters`, 503);
  }

  return {
    enabled: true,
    url: url.href,
    allowedHosts: [...allowedHosts],
    secret,
    publicBaseUrl: parseBaseUrl(env.PUBLIC_BASE_URL, allowLoopback),
    timeoutMs: parseIntegerSetting('WEBHOOK_TIMEOUT_MS', env.WEBHOOK_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 100, 60_000),
    maxAttempts: parseIntegerSetting('WEBHOOK_MAX_ATTEMPTS', env.WEBHOOK_MAX_ATTEMPTS, DEFAULT_MAX_ATTEMPTS, 1, 10),
    allowLoopback
  };
}

// ---------------------------------------------------------------------------------------------
// Address policy
// ---------------------------------------------------------------------------------------------

function blockList(entries) {
  const list = new net.BlockList();
  for (const [address, prefix, family] of entries) list.addSubnet(address, prefix, family);
  return list;
}

// Everything that is not a routable public unicast address, including the cloud metadata address.
const REFUSED_V4 = blockList([
  ['0.0.0.0', 8, 'ipv4'], ['10.0.0.0', 8, 'ipv4'], ['100.64.0.0', 10, 'ipv4'], ['127.0.0.0', 8, 'ipv4'],
  ['169.254.0.0', 16, 'ipv4'], ['172.16.0.0', 12, 'ipv4'], ['192.0.0.0', 24, 'ipv4'], ['192.0.2.0', 24, 'ipv4'],
  ['192.168.0.0', 16, 'ipv4'], ['198.18.0.0', 15, 'ipv4'], ['198.51.100.0', 24, 'ipv4'], ['203.0.113.0', 24, 'ipv4'],
  ['224.0.0.0', 4, 'ipv4'], ['240.0.0.0', 4, 'ipv4']
]);
const REFUSED_V6 = blockList([
  ['::', 128, 'ipv6'], ['::1', 128, 'ipv6'], ['fc00::', 7, 'ipv6'], ['fe80::', 10, 'ipv6'], ['ff00::', 8, 'ipv6'],
  ['2001:db8::', 32, 'ipv6'], ['64:ff9b::', 96, 'ipv6'], ['2002::', 16, 'ipv6']
]);
const LOOPBACK_V4 = blockList([['127.0.0.0', 8, 'ipv4']]);
const LOOPBACK_V6 = blockList([['::1', 128, 'ipv6']]);

/** True when this address may be connected to. Loopback is the only range a test flag can open. */
export function addressAllowed(address, allowLoopback = false) {
  const normalized = normalizeAddress(address);
  if (!normalized) return false;
  const v6 = net.isIP(normalized) === 6;
  if (allowLoopback && (v6 ? LOOPBACK_V6 : LOOPBACK_V4).check(normalized, v6 ? 'ipv6' : 'ipv4')) return true;
  return !(v6 ? REFUSED_V6 : REFUSED_V4).check(normalized, v6 ? 'ipv6' : 'ipv4');
}

// ---------------------------------------------------------------------------------------------
// Payload and signature
// ---------------------------------------------------------------------------------------------

/** The strict shape the adapter accepts from the outbox file; extra keys are ignored, never copied. */
export function readableRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { noticeId, kind, subjectCode, taskAlias, snapshotVersion, preparedAt } = value;
  if (value.sendsEmail !== false) return null;
  if (typeof noticeId !== 'string' || !HEX64.test(noticeId)) return null;
  if (typeof kind !== 'string' || !KINDS.has(kind)) return null;
  if (typeof subjectCode !== 'string' || !SUBJECT_CODES.has(subjectCode)) return null;
  if (typeof taskAlias !== 'string' || !TASK_ALIAS.test(taskAlias)) return null;
  if (!Number.isSafeInteger(snapshotVersion) || snapshotVersion < 1) return null;
  if (typeof preparedAt !== 'string' || !ISO_INSTANT.test(preparedAt) || !Number.isFinite(Date.parse(preparedAt))) return null;
  // The id binds the other fields; a line whose id does not match them was not written by the outbox.
  if (computeNoticeId(taskAlias, snapshotVersion, `${kind}|${subjectCode}`, preparedAt) !== noticeId) return null;
  return { noticeId, kind, subjectCode, taskAlias, snapshotVersion, preparedAt, sendsEmail: false };
}

/** The link points at the sender page and carries only the alias, in the fragment so no server log sees it. */
export function noticeLink(publicBaseUrl, taskAlias) {
  return `${publicBaseUrl}/#task=${taskAlias}`;
}

/** A fixed template with exactly PAYLOAD_KEYS, built field by field from a validated record. */
export function buildPayload(record, publicBaseUrl) {
  const valid = readableRecord(record);
  if (!valid) throw Object.assign(new Error('WEBHOOK_RECORD_INVALID'), { code: 'WEBHOOK_RECORD_INVALID' });
  return {
    noticeId: valid.noticeId,
    kind: valid.kind,
    subjectCode: valid.subjectCode,
    taskAlias: valid.taskAlias,
    snapshotVersion: valid.snapshotVersion,
    preparedAt: valid.preparedAt,
    link: noticeLink(publicBaseUrl, valid.taskAlias)
  };
}

export function signBody(secret, timestamp, body) {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

/** Exponential backoff, capped, with jitter between half and all of the delay. */
export function backoffDelay(attempt, random = Math.random) {
  const raw = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1));
  return Math.floor(raw * (0.5 + 0.5 * random()));
}

// ---------------------------------------------------------------------------------------------
// Ledger: the durable "already sent" list
// ---------------------------------------------------------------------------------------------

function codedError(code) {
  return Object.assign(new Error(code), { code });
}

/**
 * `<dir>/webhook-sent.jsonl`, mode 0600 in a 0700 directory, appended with O_APPEND and fsynced
 * before the caller treats the entry as recorded. It lives beside the outbox under the data
 * directory, which git ignores. A damaged line is not an identity; the notice behind it is simply
 * offered to the receiver again, which deduplicates on X-Enclave-Notice-Id.
 */
export function createLedger(ledgerDir) {
  const dir = path.resolve(ledgerDir);
  const file = path.join(dir, LEDGER_FILE);

  async function ensure() {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') await fs.chmod(dir, 0o700);
    const handle = await fs.open(file, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw codedError('LEDGER_NOT_A_FILE');
      if (stat.size > MAX_FILE_BYTES) throw codedError('LEDGER_TOO_LARGE');
      if (process.platform !== 'win32') await handle.chmod(0o600);
    } finally { await handle.close(); }
  }

  async function load() {
    let handle;
    try { handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) {
      if (error?.code === 'ENOENT') return new Set();
      throw error;
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw codedError('LEDGER_NOT_A_FILE');
      if (stat.size > MAX_FILE_BYTES) throw codedError('LEDGER_TOO_LARGE');
      const text = (await handle.readFile({ encoding: 'utf8' }));
      const ids = new Set();
      for (const line of text.split('\n')) {
        if (!line) continue;
        try {
          const value = JSON.parse(line);
          if (value && typeof value.noticeId === 'string' && HEX64.test(value.noticeId) &&
              (value.status === 'SENT' || value.status === 'FAILED')) ids.add(value.noticeId);
        } catch { /* a truncated line is not an identity */ }
      }
      return ids;
    } finally { await handle.close(); }
  }

  async function append(entry) {
    const handle = await fs.open(file, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw codedError('LEDGER_NOT_A_FILE');
      const tail = Buffer.alloc(1);
      const needsLead = stat.size > 0 && (await handle.read(tail, 0, 1, stat.size - 1)).bytesRead === 1 && tail[0] !== 0x0a;
      await handle.write((needsLead ? '\n' : '') + JSON.stringify(entry) + '\n');
      await handle.sync();
    } finally { await handle.close(); }
  }

  return { file, ensure, load, append };
}

async function readOutbox(outboxDir) {
  const file = path.join(path.resolve(outboxDir), OUTBOX_FILE);
  let handle;
  try { handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) {
    if (error?.code === 'ENOENT') return { records: [], rejected: 0 };
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw codedError('OUTBOX_NOT_A_FILE');
    if (stat.size > MAX_FILE_BYTES) throw codedError('OUTBOX_TOO_LARGE');
    const text = await handle.readFile({ encoding: 'utf8' });
    const records = [];
    let rejected = 0;
    for (const line of text.split('\n')) {
      if (!line) continue;
      let parsed = null;
      try { parsed = JSON.parse(line); } catch { rejected += 1; continue; }
      const record = readableRecord(parsed);
      if (record) records.push(record); else rejected += 1;
    }
    return { records, rejected };
  } finally { await handle.close(); }
}

// ---------------------------------------------------------------------------------------------
// One HTTP attempt
// ---------------------------------------------------------------------------------------------

function safeCode(error) {
  const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,31}$/.test(error.code) ? error.code : 'NETWORK_ERROR';
  return code;
}

async function resolveTarget(url, resolver, allowLoopback) {
  const literal = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  let addresses;
  if (net.isIP(literal)) addresses = [{ address: literal }];
  else {
    try { addresses = await resolver(url.hostname); }
    catch { throw codedError('DNS_FAILED'); }
    if (!Array.isArray(addresses) || !addresses.length) throw codedError('DNS_FAILED');
  }
  // Every answer must be acceptable: a name that also points somewhere private is refused, not
  // "the first public one", because the next lookup may order them differently.
  for (const entry of addresses) {
    if (!addressAllowed(entry?.address, allowLoopback)) throw codedError('TARGET_ADDRESS_REFUSED');
  }
  return normalizeAddress(addresses[0].address);
}

function postOnce({ url, address, body, headers, timeoutMs, allowLoopback, tls }) {
  return new Promise((resolve, reject) => {
    const secure = url.protocol === 'https:';
    const literalHost = net.isIP(url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname) !== 0;
    const options = {
      method: 'POST',
      // Connect to the address that was just checked, not to the name: a second lookup could answer differently.
      host: address,
      port: url.port || (secure ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      headers: { ...headers, Host: url.host },
      agent: false
    };
    if (secure) {
      if (!literalHost) options.servername = url.hostname;
      if (tls?.ca) options.ca = tls.ca;
    }
    let settled = false;
    let status = null;
    let request = null;
    const timer = setTimeout(() => finish(codedError('TIMEOUT')), timeoutMs);
    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (request) request.destroy();
      if (error) reject(error); else resolve(value);
    }
    request = (secure ? https : http).request(options, response => {
      status = response.statusCode;
      let received = 0;
      // The body is never read as a value. It is counted so that an endless one is cut off, and dropped.
      response.on('data', chunk => {
        received += chunk.length;
        if (received > RESPONSE_CAP_BYTES) finish(null, { status });
      });
      response.on('end', () => finish(null, { status }));
      response.on('error', () => finish(null, { status }));
      response.on('close', () => finish(null, { status }));
    });
    // The connection is checked a second time against the address it really reached.
    request.on('socket', socket => {
      const check = () => {
        if (!addressAllowed(socket.remoteAddress, allowLoopback)) finish(codedError('TARGET_ADDRESS_REFUSED'));
      };
      if (socket.connecting) socket.once('connect', check); else check();
    });
    request.on('error', error => finish(codedError(safeCode(error))));
    request.end(body);
  });
}

// ---------------------------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------------------------

const chains = new Map();

function enqueue(key, task) {
  const previous = chains.get(key) || Promise.resolve();
  const run = previous.catch(() => {}).then(task);
  const tail = run.catch(() => {});
  chains.set(key, tail);
  tail.then(() => { if (chains.get(key) === tail) chains.delete(key); });
  return run;
}

function safeLog(log, line) {
  try { log(line); } catch { /* logging must not throw either */ }
}

/**
 * `deps` exists so tests can substitute time, randomness, DNS and the ledger; production passes only
 * `config`, `outboxDir` (and optionally `ledgerDir`) and `log`.
 */
export function createWebhookAdapter({
  config,
  outboxDir,
  ledgerDir = outboxDir,
  log = line => console.error(line),
  ledger = createLedger(ledgerDir),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  random = Math.random,
  now = Date.now,
  resolver = host => dns.promises.lookup(host, { all: true, verbatim: true }),
  tls = null,
  maxPerRun = MAX_PER_RUN
}) {
  if (!config?.enabled) throw new TypeError('createWebhookAdapter needs an enabled config');
  const target = new URL(config.url);
  const chainKey = path.resolve(String(ledgerDir));
  // Entries whose send happened but whose ledger line could not be written. They are written first on
  // the next run and count as done, so a ledger fault never turns into a second send.
  const unrecorded = new Map();

  async function attempt(record) {
    const payload = buildPayload(record, config.publicBaseUrl);
    const body = JSON.stringify(payload);
    const timestamp = String(Math.floor(now() / 1000));
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'User-Agent': 'zero-trust-edge-enclave-webhook/1',
      'X-Enclave-Timestamp': timestamp,
      'X-Enclave-Notice-Id': record.noticeId,
      'X-Enclave-Signature': `sha256=${signBody(config.secret, timestamp, body)}`
    };
    const address = await resolveTarget(target, resolver, config.allowLoopback);
    return postOnce({ url: target, address, body, headers, timeoutMs: config.timeoutMs, allowLoopback: config.allowLoopback, tls });
  }

  // Returns the ledger entry for one notice: SENT, or FAILED with a code. Never throws.
  async function deliverWithRetry(record) {
    const short = record.noticeId.slice(0, 8);
    let lastCode = 'UNKNOWN';
    let lastStatus = null;
    for (let number = 1; number <= config.maxAttempts; number += 1) {
      let permanent = false;
      try {
        const { status } = await attempt(record);
        lastStatus = status;
        if (status >= 200 && status < 300) {
          safeLog(log, `webhook sent notice=${short} attempt=${number}/${config.maxAttempts} status=${status}`);
          return { status: 'SENT', attempts: number, httpStatus: status, code: 'OK', sendsWebhook: true };
        }
        if (status >= 300 && status < 400) { lastCode = 'REDIRECT_REFUSED'; permanent = true; }
        else lastCode = `HTTP_${status}`;
      } catch (error) {
        lastStatus = null;
        lastCode = typeof error?.code === 'string' ? error.code : 'NETWORK_ERROR';
        if (lastCode === 'TARGET_ADDRESS_REFUSED' || lastCode === 'WEBHOOK_RECORD_INVALID') permanent = true;
      }
      const final = permanent || number === config.maxAttempts;
      safeLog(log, `ERROR webhook ${final ? 'failed' : 'retry'} notice=${short} attempt=${number}/${config.maxAttempts} status=${lastStatus ?? '-'} code=${lastCode}`);
      if (final) return { status: 'FAILED', attempts: number, httpStatus: lastStatus, code: lastCode, sendsWebhook: false };
      await sleep(backoffDelay(number, random));
    }
    return { status: 'FAILED', attempts: config.maxAttempts, httpStatus: lastStatus, code: lastCode, sendsWebhook: false };
  }

  function ledgerEntry(record, outcome) {
    return {
      noticeId: record.noticeId,
      status: outcome.status,
      code: outcome.code,
      httpStatus: outcome.httpStatus,
      attempts: outcome.attempts,
      sendsWebhook: outcome.sendsWebhook,
      sendsEmail: false,
      at: new Date(now()).toISOString()
    };
  }

  async function writeEntry(entry) {
    try { await ledger.append(entry); }
    catch (error) {
      unrecorded.set(entry.noticeId, entry);
      safeLog(log, `ERROR webhook ledger write failed: ${safeCode(error)}`);
      throw codedError('WEBHOOK_LEDGER_WRITE_FAILED');
    }
  }

  async function runLocked(records, refusedOnRead = 0) {
    const summary = { sent: 0, failed: 0, skipped: 0, invalid: refusedOnRead };
    try { await ledger.ensure(); }
    catch (error) {
      safeLog(log, `ERROR webhook ledger unavailable: ${safeCode(error)}`);
      throw codedError('WEBHOOK_LEDGER_UNAVAILABLE');
    }
    for (const entry of [...unrecorded.values()]) {
      await writeEntry(entry);
      unrecorded.delete(entry.noticeId);
    }
    let done;
    try { done = await ledger.load(); }
    catch (error) {
      safeLog(log, `ERROR webhook ledger unreadable: ${safeCode(error)}`);
      throw codedError('WEBHOOK_LEDGER_UNAVAILABLE');
    }
    const seen = new Set();
    let handled = 0;
    for (const raw of records) {
      const record = readableRecord(raw);
      if (!record) { summary.invalid += 1; continue; }
      if (seen.has(record.noticeId)) continue;
      seen.add(record.noticeId);
      if (done.has(record.noticeId) || unrecorded.has(record.noticeId)) { summary.skipped += 1; continue; }
      if (handled >= maxPerRun) break;
      handled += 1;
      const outcome = await deliverWithRetry(record);
      await writeEntry(ledgerEntry(record, outcome));
      if (outcome.status === 'SENT') summary.sent += 1; else summary.failed += 1;
    }
    if (summary.invalid) safeLog(log, `ERROR webhook ${summary.invalid} record(s) refused: WEBHOOK_RECORD_INVALID`);
    return summary;
  }

  /** Deliver the given outbox-shaped records that the ledger does not already hold. */
  function deliver(records) {
    return enqueue(chainKey, () => runLocked(Array.isArray(records) ? records : []));
  }

  /** Read the outbox file and deliver whatever is not yet in the ledger. */
  function sendPending() {
    return enqueue(chainKey, async () => {
      let read;
      try { read = await readOutbox(outboxDir); }
      catch (error) {
        safeLog(log, `ERROR webhook outbox unreadable: ${safeCode(error)}`);
        throw codedError('WEBHOOK_OUTBOX_UNAVAILABLE');
      }
      return runLocked(read.records, read.rejected);
    });
  }

  /** For the worker: never throws, never blocks the caller, returns the promise for tests. */
  function kick() {
    return sendPending().catch(() => ({ sent: 0, failed: 0, skipped: 0, invalid: 0, error: true }));
  }

  return { enabled: true, deliver, sendPending, kick };
}

/**
 * The one call the server makes at startup. With WEBHOOK_URL unset it returns an inert adapter, so
 * the call site needs no condition; with a bad configuration it throws before the server listens.
 */
export function createWebhookFromEnv(env, options) {
  const config = webhookConfigFromEnv(env);
  if (!config.enabled) {
    const idle = { sent: 0, failed: 0, skipped: 0, invalid: 0 };
    return { enabled: false, deliver: async () => idle, sendPending: async () => idle, kick: async () => idle };
  }
  return createWebhookAdapter({ ...options, config });
}
