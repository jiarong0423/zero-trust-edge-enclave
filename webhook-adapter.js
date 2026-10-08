import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import dns from 'node:dns';
import path from 'node:path';
import { promises as fs, constants, realpathSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { fail } from './access-control.js';
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
// A notice that could not be delivered in a run is DEFERRED, not failed: it waits DEFER_BASE_MS * 2^(n-1)
// (capped, jittered) before a later kick() offers it again, and after MAX_DEFERRALS deferrals it is FAILED.
const DEFER_BASE_MS = 60_000;
const DEFER_CAP_MS = 6 * 60 * 60 * 1000;
export const MAX_DEFERRALS = 12;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_PER_RUN = 50;
const NONBLOCK = constants.O_NONBLOCK ?? 0;
const RESERVED_NAME_SUFFIXES = ['.localhost', '.local', '.internal', '.localdomain', '.home.arpa'];

// ---------------------------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------------------------

function isLoopbackLiteral(hostname) {
  return hostname === '127.0.0.1' || hostname === '[::1]';
}

function hostLiteral(hostname) {
  return hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;
}

function reservedName(hostname) {
  const name = hostname.toLowerCase().replace(/\.$/, '');
  return name === 'localhost' || name === 'ip6-localhost' || name === 'ip6-loopback' || RESERVED_NAME_SUFFIXES.some(suffix => name.endsWith(suffix));
}

// A URL is judged as written: the WHATWG parser silently drops tab and newline, so a value that has any
// whitespace or control character is refused instead of being quietly turned into a different host or path.
function hasWhitespaceOrControl(value) {
  return /[\s\u0000-\u001f\u007f]/u.test(value);
}

function weakSecret(secret) {
  if (secret !== secret.trim()) return true;
  const characters = [...secret];
  return characters.every(character => character === characters[0]);
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
  if (hasWhitespaceOrControl(value)) fail('PUBLIC_BASE_URL must not contain whitespace or control characters', 503);
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

  if (hasWhitespaceOrControl(raw)) fail('WEBHOOK_URL must not contain whitespace or control characters', 503);
  let url;
  try { url = new URL(raw); } catch { fail('WEBHOOK_URL is not a valid URL', 503); }
  if (url.username || url.password) fail('WEBHOOK_URL must not contain credentials', 503);
  if (url.hash) fail('WEBHOOK_URL must not contain a fragment', 503);
  const loopbackHttp = url.protocol === 'http:' && allowLoopback && isLoopbackLiteral(url.hostname);
  if (url.protocol !== 'https:' && !loopbackHttp) {
    fail('WEBHOOK_URL must use https (http is accepted only for 127.0.0.1 or [::1] with WEBHOOK_ALLOW_LOOPBACK=true)', 503);
  }

  // The URL's own host is judged by the same rules the connection will apply, so an address or name that
  // could never be delivered to is a startup error and not a stream of permanent failures.
  if (!allowLoopback && url.port !== '') fail('WEBHOOK_URL must use the default https port 443 (another port needs WEBHOOK_ALLOW_LOOPBACK=true, for tests)', 503);
  const literal = hostLiteral(url.hostname);
  if (net.isIP(literal)) {
    if (!addressAllowed(literal, allowLoopback)) fail('WEBHOOK_URL host is an address the adapter refuses to connect to', 503);
  } else if (!allowLoopback && reservedName(url.hostname)) {
    fail('WEBHOOK_URL host is a local or reserved name', 503);
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
  if (weakSecret(secret)) fail('WEBHOOK_SECRET must not be one repeated character or start or end with whitespace', 503);

  const config = {
    enabled: true,
    url: url.href,
    allowedHosts: [...allowedHosts],
    publicBaseUrl: parseBaseUrl(env.PUBLIC_BASE_URL, allowLoopback),
    timeoutMs: parseIntegerSetting('WEBHOOK_TIMEOUT_MS', env.WEBHOOK_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 100, 60_000),
    maxAttempts: parseIntegerSetting('WEBHOOK_MAX_ATTEMPTS', env.WEBHOOK_MAX_ATTEMPTS, DEFAULT_MAX_ATTEMPTS, 1, 10),
    allowLoopback
  };
  // Not enumerable: spreading, logging, inspecting or JSON-serialising the config cannot carry the key along.
  Object.defineProperty(config, 'secret', { value: secret, enumerable: false });
  return config;
}

// ---------------------------------------------------------------------------------------------
// Address policy
// ---------------------------------------------------------------------------------------------

function blockList(entries) {
  const list = new net.BlockList();
  for (const [address, prefix, family] of entries) list.addSubnet(address, prefix, family);
  return list;
}

// IPv4: everything that is not a routable public unicast address, including the cloud metadata addresses
// (169.254.169.254 by range, 168.63.129.16 by host because it is a "public" address used as a wire server).
const REFUSED_V4 = blockList([
  ['0.0.0.0', 8, 'ipv4'], ['10.0.0.0', 8, 'ipv4'], ['100.64.0.0', 10, 'ipv4'], ['127.0.0.0', 8, 'ipv4'],
  ['168.63.129.16', 32, 'ipv4'], ['169.254.0.0', 16, 'ipv4'], ['172.16.0.0', 12, 'ipv4'], ['192.0.0.0', 24, 'ipv4'],
  ['192.0.2.0', 24, 'ipv4'], ['192.31.196.0', 24, 'ipv4'], ['192.52.193.0', 24, 'ipv4'], ['192.88.99.0', 24, 'ipv4'],
  ['192.168.0.0', 16, 'ipv4'], ['192.175.48.0', 24, 'ipv4'], ['198.18.0.0', 15, 'ipv4'], ['198.51.100.0', 24, 'ipv4'],
  ['203.0.113.0', 24, 'ipv4'], ['224.0.0.0', 4, 'ipv4'], ['240.0.0.0', 4, 'ipv4']
]);

function parseIPv4(text) {
  if (!net.isIPv4(text)) return null;
  const parts = text.split('.').map(Number);
  return parts.length === 4 && parts.every(part => Number.isInteger(part) && part >= 0 && part <= 255) ? parts : null;
}

/** Sixteen bytes for an IPv6 literal, parsed here so that no spelling (hex mapped, compat, long form) is trusted to a library. */
function parseIPv6(text) {
  if (typeof text !== 'string' || text.includes('%') || !net.isIPv6(text)) return null;
  let value = text;
  if (value.includes('.')) {
    const cut = value.lastIndexOf(':');
    const tail = parseIPv4(value.slice(cut + 1));
    if (!tail) return null;
    value = `${value.slice(0, cut + 1)}${((tail[0] << 8) | tail[1]).toString(16)}:${((tail[2] << 8) | tail[3]).toString(16)}`;
  }
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  let groups = left;
  if (halves.length === 2) {
    const fill = 8 - left.length - right.length;
    if (fill < 0) return null;
    groups = [...left, ...Array(fill).fill('0'), ...right];
  }
  if (groups.length !== 8) return null;
  const bytes = new Uint8Array(16);
  for (let index = 0; index < 8; index += 1) {
    if (!/^[0-9a-f]{1,4}$/i.test(groups[index])) return null;
    const word = parseInt(groups[index], 16);
    bytes[index * 2] = word >> 8;
    bytes[index * 2 + 1] = word & 0xff;
  }
  return bytes;
}

function hasPrefix(bytes, prefix) {
  const whole = prefix.bits >> 3;
  for (let index = 0; index < whole; index += 1) if (bytes[index] !== prefix.bytes[index]) return false;
  const rest = prefix.bits & 7;
  if (!rest) return true;
  const mask = (0xff << (8 - rest)) & 0xff;
  return (bytes[whole] & mask) === (prefix.bytes[whole] & mask);
}

// IPv6 is an allowlist: only global unicast 2000::/3 may be connected to, minus the special-purpose ranges
// inside it (2001::/23 includes Teredo and ORCHID, 2002::/16 embeds an IPv4 address, 3fff::/20 is documentation).
// Everything outside 2000::/3 (::/8, 64:ff9b::/96, 64:ff9b:1::/48, 100::/64, fc00::/7, fe80::/10, fec0::/10,
// ff00::/8, 5f00::/16 and the rest) is refused by not being on the list.
const V6_SPECIAL_INSIDE_GLOBAL = [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3ffe::', 16], ['3fff::', 20]]
  .map(([address, bits]) => ({ bytes: parseIPv6(address), bits }));

function v4Allowed(octets, allowLoopback) {
  if (allowLoopback && octets[0] === 127) return true;
  return !REFUSED_V4.check(octets.join('.'), 'ipv4');
}

function v6Text(bytes) {
  const words = [];
  for (let index = 0; index < 16; index += 2) words.push(((bytes[index] << 8) | bytes[index + 1]).toString(16));
  return words.join(':');
}

/**
 * The address text to connect to, or null when the policy refuses it. The text is rebuilt from the parsed
 * bytes, so what is checked is exactly what is connected to. IPv4-mapped (::ffff:0:0/96) is unwrapped and
 * judged by the IPv4 rules; the rest of ::/96 (unspecified, loopback, IPv4-compatible) is refused outright,
 * with ::1 opened only by the loopback test flag.
 */
export function allowedAddressText(address, allowLoopback = false) {
  if (typeof address !== 'string') return null;
  const text = address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address;
  const v4 = parseIPv4(text);
  if (v4) return v4Allowed(v4, allowLoopback) ? v4.join('.') : null;
  const bytes = parseIPv6(text);
  if (!bytes) return null;
  if (bytes.slice(0, 10).every(byte => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
    const embedded = [...bytes.slice(12)];
    return v4Allowed(embedded, allowLoopback) ? embedded.join('.') : null;
  }
  if (allowLoopback && bytes.slice(0, 15).every(byte => byte === 0) && bytes[15] === 1) return '::1';
  if ((bytes[0] & 0xe0) !== 0x20) return null;
  if (V6_SPECIAL_INSIDE_GLOBAL.some(prefix => hasPrefix(bytes, prefix))) return null;
  return v6Text(bytes);
}

/** True when this address may be connected to. Loopback is the only range a test flag can open. */
export function addressAllowed(address, allowLoopback = false) {
  return allowedAddressText(address, allowLoopback) !== null;
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

/**
 * HMAC-SHA256 over `timestamp + '.' + noticeId + '.' + body`. The notice id is in the signed string so
 * that the X-Enclave-Notice-Id header (the receiver's idempotency key) cannot be rewritten in transit
 * without breaking the signature. Timestamp (digits) and id (64 hex) contain no '.', so the split is unambiguous.
 */
export function signBody(secret, timestamp, noticeId, body) {
  return createHmac('sha256', secret).update(`${timestamp}.${noticeId}.${body}`).digest('hex');
}

/** Exponential backoff, capped, with jitter between half and all of the delay. */
export function backoffDelay(attempt, random = Math.random) {
  const raw = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1));
  return Math.floor(raw * (0.5 + 0.5 * random()));
}

/** Delay before a DEFERRED notice becomes eligible again: 1 min, 2, 4 ... capped at 6 hours, jittered between half and all of it. */
export function deferDelay(deferrals, random = Math.random) {
  const raw = Math.min(DEFER_CAP_MS, DEFER_BASE_MS * 2 ** Math.max(0, deferrals - 1));
  return Math.floor(raw * (0.5 + 0.5 * random()));
}

// ---------------------------------------------------------------------------------------------
// Ledger: the durable "already sent" list
// ---------------------------------------------------------------------------------------------

function codedError(code) {
  return Object.assign(new Error(code), { code });
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/**
 * `<dir>/webhook-sent.jsonl`, mode 0600 in a 0700 directory, appended with O_APPEND and fsynced
 * before the caller treats the entry as recorded. It lives beside the outbox under the data
 * directory, which git ignores. A damaged line is not an identity; the notice behind it is simply
 * offered to the receiver again, which deduplicates on X-Enclave-Notice-Id.
 *
 * `load()` returns the state per notice id: SENT and FAILED are final (the first one wins), DEFERRED lines
 * accumulate (`deferrals` is how many there are, `attempts` the cumulative count, `nextEligibleAt` the latest).
 */
export function createLedger(ledgerDir) {
  const dir = path.resolve(ledgerDir);
  const file = path.join(dir, LEDGER_FILE);

  async function ensure() {
    // A symlinked ledger directory is refused, not followed, and never chmod-ed through.
    try {
      const existing = await fs.lstat(dir);
      if (existing.isSymbolicLink()) throw codedError('LEDGER_DIR_IS_SYMLINK');
      if (!existing.isDirectory()) throw codedError('LEDGER_DIR_NOT_A_DIRECTORY');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') {
      let handle;
      try { handle = await fs.open(dir, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | constants.O_NOFOLLOW); }
      catch (error) { throw error?.code === 'ELOOP' || error?.code === 'ENOTDIR' ? codedError('LEDGER_DIR_IS_SYMLINK') : error; }
      try {
        if (!(await handle.stat()).isDirectory()) throw codedError('LEDGER_DIR_NOT_A_DIRECTORY');
        await handle.chmod(0o700);
      } finally { await handle.close(); }
    }
    const handle = await fs.open(file, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | NONBLOCK, 0o600);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw codedError('LEDGER_NOT_A_FILE');
      if (stat.size > MAX_FILE_BYTES) throw codedError('LEDGER_TOO_LARGE');
      if (process.platform !== 'win32') await handle.chmod(0o600);
    } finally { await handle.close(); }
  }

  async function load() {
    let handle;
    try { handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | NONBLOCK); }
    catch (error) {
      if (error?.code === 'ENOENT') return new Map();
      throw error;
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw codedError('LEDGER_NOT_A_FILE');
      if (stat.size > MAX_FILE_BYTES) throw codedError('LEDGER_TOO_LARGE');
      const text = (await handle.readFile({ encoding: 'utf8' }));
      const states = new Map();
      for (const line of text.split('\n')) {
        if (!line) continue;
        let value;
        try { value = JSON.parse(line); } catch { continue; /* a truncated line is not an identity */ }
        if (!value || typeof value.noticeId !== 'string' || !HEX64.test(value.noticeId)) continue;
        const previous = states.get(value.noticeId);
        if (previous && previous.status !== 'DEFERRED') continue;
        if (value.status === 'SENT' || value.status === 'FAILED') {
          states.set(value.noticeId, { status: value.status, code: String(value.code ?? ''), attempts: count(value.attempts),
            deferrals: previous?.deferrals ?? 0, nextEligibleAt: 0 });
        } else if (value.status === 'DEFERRED') {
          const next = Date.parse(value.nextEligibleAt);
          states.set(value.noticeId, { status: 'DEFERRED', code: String(value.code ?? ''),
            attempts: Math.max(previous?.attempts ?? 0, count(value.attempts)), deferrals: (previous?.deferrals ?? 0) + 1,
            nextEligibleAt: Number.isFinite(next) ? next : 0 });
        }
      }
      return states;
    } finally { await handle.close(); }
  }

  async function append(entry) {
    const handle = await fs.open(file, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | NONBLOCK, 0o600);
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
  // O_NONBLOCK: opening a FIFO planted at this name must fail the "is it a file" check, not hang the run.
  try { handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | NONBLOCK); }
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

// The resolver is raced against the attempt timeout and the adapter's abort signal, so a resolver that
// never answers cannot hold the serial queue.
async function lookup(resolver, hostname, timeoutMs, signal) {
  let timer;
  let onAbort;
  const guard = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(codedError('DNS_TIMEOUT')), timeoutMs);
    onAbort = () => reject(codedError('ABORTED'));
    if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([Promise.resolve().then(() => resolver(hostname)), guard]); }
  finally { clearTimeout(timer); signal.removeEventListener('abort', onAbort); }
}

async function resolveTarget(url, resolver, allowLoopback, timeoutMs, signal) {
  const literal = hostLiteral(url.hostname);
  let addresses;
  if (net.isIP(literal)) addresses = [{ address: literal }];
  else {
    try { addresses = await lookup(resolver, url.hostname, timeoutMs, signal); }
    catch (error) { throw codedError(error?.code === 'DNS_TIMEOUT' || error?.code === 'ABORTED' ? error.code : 'DNS_FAILED'); }
    if (!Array.isArray(addresses) || !addresses.length) throw codedError('DNS_FAILED');
  }
  // Every answer must be acceptable: a name that also points somewhere private is refused, not
  // "the first public one", because the next lookup may order them differently.
  for (const entry of addresses) {
    if (!addressAllowed(entry?.address, allowLoopback)) throw codedError('TARGET_ADDRESS_REFUSED');
  }
  return allowedAddressText(addresses[0].address, allowLoopback);
}

function postOnce({ url, address, body, headers, timeoutMs, allowLoopback, tls, signal }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(codedError('ABORTED')); return; }
    const secure = url.protocol === 'https:';
    const literalHost = net.isIP(hostLiteral(url.hostname)) !== 0;
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
      // Stated, not inherited: NODE_TLS_REJECT_UNAUTHORIZED=0 in the environment must not switch verification off.
      options.rejectUnauthorized = true;
      if (!literalHost) options.servername = url.hostname;
      if (tls?.ca) options.ca = tls.ca;
    }
    let settled = false;
    let request = null;
    const timer = setTimeout(() => finish(codedError('TIMEOUT')), timeoutMs);
    const onAbort = () => finish(codedError('ABORTED'));
    signal?.addEventListener('abort', onAbort, { once: true });
    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (request) request.destroy();
      if (error) reject(error); else resolve(value);
    }
    request = (secure ? https : http).request(options, response => {
      // The first status line is the answer. Nothing after it can change it: a body that hangs, is endless
      // or is reset is not read, the socket is closed, and the timer and later errors find the attempt settled.
      response.on('error', () => {});
      finish(null, { status: response.statusCode });
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

// The serial queue is keyed by the real directory, so two spellings of one path (a symlinked parent, a
// relative path) share one chain. When the directory does not exist yet, the nearest existing ancestor is resolved.
function directoryKey(dirPath) {
  const resolved = path.resolve(String(dirPath));
  const missing = [];
  let current = resolved;
  for (;;) {
    try { return path.join(realpathSync(current), ...missing); }
    catch {
      const parent = path.dirname(current);
      if (parent === current) return resolved;
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

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

// Waits for `promise`, or returns early when the signal aborts (the promise is then left to settle on its own).
function untilAborted(promise, signal) {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(); return; }
    const done = () => { signal.removeEventListener('abort', done); resolve(); };
    signal.addEventListener('abort', done, { once: true });
    Promise.resolve(promise).then(done, done);
  });
}

// An unref'd timer: a pending retry never keeps the process alive.
function defaultSleep(ms, signal) {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

const PERMANENT_CODES = new Set(['WEBHOOK_RECORD_INVALID', 'REDIRECT_REFUSED']);
const idleSummary = () => ({ sent: 0, failed: 0, deferred: 0, skipped: 0, invalid: 0 });

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
  sleep = defaultSleep,
  random = Math.random,
  now = Date.now,
  resolver = host => dns.promises.lookup(host, { all: true, verbatim: true }),
  tls = null,
  maxPerRun = MAX_PER_RUN
}) {
  if (!config?.enabled) throw new TypeError('createWebhookAdapter needs an enabled config');
  const secret = config.secret;
  if (typeof secret !== 'string' || !secret) throw new TypeError('createWebhookAdapter needs a config from webhookConfigFromEnv (its secret is not enumerable, so a copy of the config has none)');
  const target = new URL(config.url);
  const literalTarget = net.isIP(hostLiteral(target.hostname)) !== 0;
  const controller = new AbortController();
  const { signal } = controller;
  const pending = new Set();
  // Entries whose send happened but whose ledger line could not be written. They are written first on
  // the next run and count as done, so a ledger fault never turns into a second send.
  const unrecorded = new Map();

  async function attempt(record) {
    const started = performance.now();
    const payload = buildPayload(record, config.publicBaseUrl);
    const body = JSON.stringify(payload);
    const timestamp = String(Math.floor(now() / 1000));
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'User-Agent': 'zero-trust-edge-enclave-webhook/1',
      'X-Enclave-Timestamp': timestamp,
      'X-Enclave-Notice-Id': record.noticeId,
      'X-Enclave-Signature': `sha256=${signBody(secret, timestamp, record.noticeId, body)}`
    };
    const address = await resolveTarget(target, resolver, config.allowLoopback, config.timeoutMs, signal);
    // The timeout is for the whole attempt, name lookup included.
    const remaining = Math.max(50, Math.ceil(config.timeoutMs - (performance.now() - started)));
    return postOnce({ url: target, address, body, headers, timeoutMs: remaining, allowLoopback: config.allowLoopback, tls, signal });
  }

  /**
   * One run's worth of delivery for one notice. Returns the ledger outcome: SENT; FAILED for a permanent
   * cause (or when the deferral cap is spent); DEFERRED for anything that may pass. Returns null when the
   * adapter was closed in the middle, in which case nothing is recorded. Never throws.
   */
  async function deliverWithRetry(record, state) {
    const short = record.noticeId.slice(0, 8);
    const priorAttempts = state?.attempts ?? 0;
    const priorDeferrals = state?.deferrals ?? 0;
    let lastCode = 'UNKNOWN';
    let lastStatus = null;
    for (let number = 1; number <= config.maxAttempts; number += 1) {
      let permanent = false;
      let immediate = false;
      try {
        const { status } = await attempt(record);
        lastStatus = status;
        if (status >= 200 && status < 300) {
          safeLog(log, `webhook sent notice=${short} attempt=${number}/${config.maxAttempts} status=${status}`);
          return { status: 'SENT', attempts: priorAttempts + number, httpStatus: status, code: 'OK', sendsWebhook: true };
        }
        if (status >= 300 && status < 400) { lastCode = 'REDIRECT_REFUSED'; permanent = true; }
        else lastCode = `HTTP_${status}`;
      } catch (error) {
        lastStatus = null;
        lastCode = typeof error?.code === 'string' ? error.code : 'NETWORK_ERROR';
        if (lastCode === 'ABORTED' || signal.aborted) return null;
        if (PERMANENT_CODES.has(lastCode)) permanent = true;
        // A refused literal is a configuration fact; a refused answer for a NAME may change with the next lookup.
        if (lastCode === 'TARGET_ADDRESS_REFUSED') { permanent = literalTarget; immediate = !literalTarget; }
      }
      const attempts = priorAttempts + number;
      if (permanent) {
        safeLog(log, `ERROR webhook failed notice=${short} attempt=${number}/${config.maxAttempts} status=${lastStatus ?? '-'} code=${lastCode}`);
        return { status: 'FAILED', attempts, httpStatus: lastStatus, code: lastCode, sendsWebhook: false };
      }
      if (immediate || number === config.maxAttempts) {
        if (priorDeferrals >= MAX_DEFERRALS) {
          safeLog(log, `ERROR webhook failed notice=${short} attempt=${number}/${config.maxAttempts} status=${lastStatus ?? '-'} code=RETRY_EXHAUSTED last=${lastCode}`);
          return { status: 'FAILED', attempts, httpStatus: lastStatus, code: 'RETRY_EXHAUSTED', lastCode, sendsWebhook: false };
        }
        const nextEligibleAt = new Date(now() + deferDelay(priorDeferrals + 1, random)).toISOString();
        safeLog(log, `ERROR webhook deferred notice=${short} attempt=${number}/${config.maxAttempts} status=${lastStatus ?? '-'} code=${lastCode} deferral=${priorDeferrals + 1}/${MAX_DEFERRALS} next=${nextEligibleAt}`);
        return { status: 'DEFERRED', attempts, httpStatus: lastStatus, code: lastCode, nextEligibleAt, sendsWebhook: false };
      }
      safeLog(log, `ERROR webhook retry notice=${short} attempt=${number}/${config.maxAttempts} status=${lastStatus ?? '-'} code=${lastCode}`);
      await untilAborted(sleep(backoffDelay(number, random), signal), signal);
      if (signal.aborted) return null;
    }
    return null;
  }

  function ledgerEntry(record, outcome) {
    const entry = {
      noticeId: record.noticeId,
      status: outcome.status,
      code: outcome.code,
      httpStatus: outcome.httpStatus,
      attempts: outcome.attempts,
      sendsWebhook: outcome.sendsWebhook,
      sendsEmail: false,
      at: new Date(now()).toISOString()
    };
    if (outcome.nextEligibleAt) entry.nextEligibleAt = outcome.nextEligibleAt;
    if (outcome.lastCode) entry.lastCode = outcome.lastCode;
    return entry;
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
    const summary = idleSummary();
    summary.invalid = refusedOnRead;
    if (signal.aborted) return summary;
    try { await ledger.ensure(); }
    catch (error) {
      safeLog(log, `ERROR webhook ledger unavailable: ${safeCode(error)}`);
      throw codedError('WEBHOOK_LEDGER_UNAVAILABLE');
    }
    for (const entry of [...unrecorded.values()]) {
      await writeEntry(entry);
      unrecorded.delete(entry.noticeId);
    }
    let states;
    try { states = await ledger.load(); }
    catch (error) {
      safeLog(log, `ERROR webhook ledger unreadable: ${safeCode(error)}`);
      throw codedError('WEBHOOK_LEDGER_UNAVAILABLE');
    }
    const seen = new Set();
    let handled = 0;
    for (const raw of records) {
      if (signal.aborted) break;
      const record = readableRecord(raw);
      if (!record) { summary.invalid += 1; continue; }
      if (seen.has(record.noticeId)) continue;
      seen.add(record.noticeId);
      const state = states.get(record.noticeId);
      // SENT and FAILED are final. DEFERRED waits for its time. Neither is offered again here.
      if (state && state.status !== 'DEFERRED') { summary.skipped += 1; continue; }
      if (state && state.nextEligibleAt > now()) { summary.skipped += 1; continue; }
      if (unrecorded.has(record.noticeId)) { summary.skipped += 1; continue; }
      if (handled >= maxPerRun) break;
      handled += 1;
      const outcome = await deliverWithRetry(record, state);
      if (!outcome) break;
      await writeEntry(ledgerEntry(record, outcome));
      if (outcome.status === 'SENT') summary.sent += 1;
      else if (outcome.status === 'FAILED') summary.failed += 1;
      else {
        summary.deferred += 1;
        // The next notice would meet the same receiver. A receiver that is down costs one notice's attempts per
        // run, not one per notice; the rest are simply still waiting for the next kick.
        break;
      }
    }
    if (summary.invalid) safeLog(log, `ERROR webhook ${summary.invalid} record(s) refused: WEBHOOK_RECORD_INVALID`);
    return summary;
  }

  function queued(task) {
    const run = enqueue(directoryKey(ledgerDir), task);
    const tracked = run.finally(() => pending.delete(tracked));
    tracked.catch(() => {});
    pending.add(tracked);
    return run;
  }

  /** Deliver the given outbox-shaped records that the ledger does not already hold. */
  function deliver(records) {
    if (signal.aborted) return Promise.resolve(idleSummary());
    return queued(() => runLocked(Array.isArray(records) ? records : []));
  }

  /** Read the outbox file and deliver whatever is not yet in the ledger or is DEFERRED and due. */
  function sendPending() {
    if (signal.aborted) return Promise.resolve(idleSummary());
    return queued(async () => {
      if (signal.aborted) return idleSummary();
      let read;
      try { read = await readOutbox(outboxDir); }
      catch (error) {
        safeLog(log, `ERROR webhook outbox unreadable: ${safeCode(error)}`);
        throw codedError('WEBHOOK_OUTBOX_UNAVAILABLE');
      }
      return runLocked(read.records, read.rejected);
    });
  }

  /** For the worker: never throws, never blocks the caller, returns the promise for tests. A no-op after close(). */
  function kick() {
    if (signal.aborted) return Promise.resolve(idleSummary());
    return sendPending().catch(() => ({ ...idleSummary(), error: true }));
  }

  /**
   * Stops the adapter: in-flight requests and name lookups are aborted, backoff sleeps end, nothing is
   * recorded for an attempt that was cut off, and later kick()/deliver()/sendPending() calls do nothing.
   * Resolves once the run that was in progress has stopped.
   */
  async function close() {
    controller.abort();
    await Promise.allSettled([...pending]);
  }

  return { enabled: true, deliver, sendPending, kick, close };
}

/**
 * The one call the server makes at startup. With WEBHOOK_URL unset it returns an inert adapter, so
 * the call site needs no condition; with a bad configuration it throws before the server listens.
 */
export function createWebhookFromEnv(env, options) {
  const config = webhookConfigFromEnv(env);
  if (!config.enabled) {
    const idle = idleSummary();
    return { enabled: false, deliver: async () => idle, sendPending: async () => idle, kick: async () => idle, close: async () => {} };
  }
  return createWebhookAdapter({ ...options, config });
}
