import net from 'node:net';
import crypto from 'node:crypto';
import { fail } from './access-control.js';
import { clientAddress, normalizeAddress } from './network-policy.js';

/**
 * A sliding-window throttle for failed sign-ins, keyed by client address.
 *
 * Tokens are 32 random bytes in base64url, 43 characters, so guessing one is not realistic; this
 * exists so a guessing attempt is visible and slow instead of free. What counts as a guess is
 * deliberately narrow (see countsAsGuess): the pages check a token as it is typed, so every prefix
 * of a real token is sent to the server on the way, and none of those, nor a token that belongs to
 * a registered but disabled identity, may lock the person typing their own credential.
 *
 * The key is the socket address unless TRUST_PROXY is set, in which case it is the first entry of
 * X-Forwarded-For. Trust that header only behind a proxy that overwrites it. Addresses are
 * normalised so that every spelling of one address is one key, and an IPv6 address is keyed by its
 * /64, because a single host controls a whole /64 and would otherwise rotate through it for free.
 */
const TOKEN_LENGTH = 43;
const BEARER_TOKEN = new RegExp(`^Bearer [A-Za-z0-9_-]{${TOKEN_LENGTH}}$`);

export function createAuthThrottle({ maxFailures = 10, windowMs = 60_000, lockMs = 60_000, maxKeys = 10_000, now = Date.now, onLock = null } = {}) {
  if (![maxFailures, windowMs, lockMs, maxKeys].every(value => Number.isSafeInteger(value) && value > 0)) {
    throw new Error('Invalid throttle configuration');
  }
  const entries = new Map();

  // Over capacity, forget stale keys first, then the oldest key that is NOT locked. A lock is the
  // one thing worth remembering, so flooding the table with throwaway keys must not release it; only
  // when every key is locked does the oldest lock go.
  function evict(current) {
    for (const [key, entry] of entries) {
      entry.failures = entry.failures.filter(at => current - at < windowMs);
      if (!entry.failures.length && entry.lockedUntil <= current) entries.delete(key);
    }
    while (entries.size > maxKeys) {
      let victim = null;
      for (const [key, entry] of entries) { if (entry.lockedUntil <= current) { victim = key; break; } }
      entries.delete(victim ?? entries.keys().next().value);
    }
  }

  return {
    /** Throws 429 while the key is locked. */
    check(key) {
      const entry = entries.get(key);
      if (!entry) return;
      const current = now();
      if (entry.lockedUntil > current) {
        const retryAfter = Math.max(1, Math.ceil((entry.lockedUntil - current) / 1000));
        throw Object.assign(new Error('Too many failed sign-ins; retry later'), { status: 429, retryAfter });
      }
    },
    /** Records one guess and locks the key once it reaches the limit inside the window. */
    fail(key) {
      const current = now();
      const entry = entries.get(key) ?? { failures: [], lockedUntil: 0 };
      entry.failures = entry.failures.filter(at => current - at < windowMs);
      entry.failures.push(current);
      if (entry.failures.length >= maxFailures) {
        entry.lockedUntil = current + lockMs;
        entry.failures = [];
        try { onLock?.(key, Math.ceil(lockMs / 1000)); } catch { /* logging must not break sign-in */ }
      }
      entries.delete(key);
      entries.set(key, entry);
      if (entries.size > maxKeys) evict(current);
    },
    size: () => entries.size,
  };
}

/**
 * True only for a request that looks like a real guess: a well-formed 43-character Bearer token
 * that is not the token of any registered identity, enabled or not.
 */
export function countsAsGuess(config, header) {
  if (typeof header !== 'string' || !BEARER_TOKEN.test(header)) return false;
  const digest = crypto.createHash('sha256').update(header.slice(7)).digest('hex');
  return !config.principals.some(principal => principal.tokenHash === digest);
}

function ipv6Groups(address) {
  let text = address;
  const dotted = text.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number);
    text = text.slice(0, dotted.index) + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16);
  }
  const [head, tail] = text.split('::');
  const first = head ? head.split(':') : [];
  const last = tail ? tail.split(':') : [];
  const groups = text.includes('::') ? [...first, ...Array(8 - first.length - last.length).fill('0'), ...last] : first;
  return groups.map(group => parseInt(group, 16));
}

/** One key per host: IPv4 as written, IPv6 reduced to its /64, anything else one shared bucket. */
export function addressKey(address) {
  const normalized = normalizeAddress(address);
  if (!normalized) return 'invalid';
  if (net.isIP(normalized) === 4) return normalized;
  const groups = ipv6Groups(normalized);
  if (groups.length !== 8 || groups.some(group => !Number.isInteger(group))) return 'invalid';
  return 'v6:' + groups.slice(0, 4).map(group => group.toString(16).padStart(4, '0')).join(':') + '/64';
}

export function clientKey(req, trustProxy = false) {
  return addressKey(clientAddress(req, trustProxy));
}

export function throttleFromEnv(env = process.env, onLock = null) {
  const number = (name, fallback) => {
    if (env[name] === undefined || env[name] === '') return fallback;
    const value = Number(env[name]);
    if (!Number.isSafeInteger(value) || value < 1) fail(`${name} must be a positive integer`, 503);
    return value;
  };
  return createAuthThrottle({ maxFailures: number('AUTH_MAX_FAILURES', 10),
    windowMs: number('AUTH_WINDOW_SECONDS', 60) * 1000, lockMs: number('AUTH_LOCK_SECONDS', 60) * 1000, onLock });
}
