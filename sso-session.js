import crypto from 'node:crypto';
import { fail } from './access-control.js';

/**
 * Bounded in-memory tables for the optional OIDC sign-in (see sso-routes.js).
 *
 * Nothing here persists: a restart signs everyone out and abandons every pending sign-in, which is
 * the safe direction. No table keeps a timer, so an idle process holds no handle open; expired
 * entries are dropped lazily on the next write or read.
 *
 * Keys are SHA-256 digests of random values, never the values themselves. The session token in
 * particular exists in the clear only in the one response that issues it.
 */
const TOKEN_FORMAT = /^[A-Za-z0-9_-]{43}$/;

export const randomToken = () => crypto.randomBytes(32).toString('base64url');
export const digest = value => crypto.createHash('sha256').update(String(value)).digest('hex');

export function safeEqualDigest(a, b) {
  const left = Buffer.from(String(a), 'hex');
  const right = Buffer.from(String(b), 'hex');
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

function positive(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${name}`);
  return value;
}

/**
 * Single-use entries with a short life. Used for the pending sign-in (state, nonce, PKCE verifier)
 * and for the one-minute hand-off that carries a finished sign-in to the page.
 *
 * `take` removes the entry whether or not it is still valid, so a replay finds nothing even when
 * the first use failed halfway. Capacity is enforced two ways: one owner (a client key) may hold
 * only `maxPerOwner` entries, and past `maxEntries` the oldest entry goes. Because every entry has
 * the same life, insertion order is expiry order and sweeping stops at the first live entry.
 */
export function createOneTimeTable({ maxEntries = 1000, maxPerOwner = 10, ttlMs, now = Date.now } = {}) {
  positive(maxEntries, 'maxEntries');
  positive(maxPerOwner, 'maxPerOwner');
  positive(ttlMs, 'ttlMs');
  const entries = new Map();

  function sweep(current) {
    for (const [key, entry] of entries) {
      if (entry.expiresAt > current) break;
      entries.delete(key);
    }
  }

  return {
    put(key, value, owner = 'shared') {
      const current = now();
      sweep(current);
      entries.delete(key);
      let held = 0;
      let oldestOfOwner = null;
      for (const [existing, entry] of entries) {
        if (entry.owner !== owner) continue;
        held += 1;
        if (oldestOfOwner === null) oldestOfOwner = existing;
      }
      if (held >= maxPerOwner) entries.delete(oldestOfOwner);
      while (entries.size >= maxEntries) entries.delete(entries.keys().next().value);
      entries.set(key, { value, owner, expiresAt: current + ttlMs });
    },
    take(key) {
      const entry = entries.get(key);
      entries.delete(key);
      if (!entry || entry.expiresAt <= now()) return undefined;
      return entry.value;
    },
    size() {
      sweep(now());
      return entries.size;
    }
  };
}

/**
 * Session tokens: 43-character base64url (32 random bytes), stored as a SHA-256 digest with the
 * principal id and an absolute expiry. There is no sliding renewal: a session ends `ttlMs` after it
 * was issued. A principal holds at most `maxPerPrincipal` sessions (the oldest is replaced). When
 * the table is full of live sessions a new sign-in is refused with 503 instead of silently signing
 * somebody else out.
 */
export function createSessionStore({ maxSessions = 1000, maxPerPrincipal = 5, ttlMs, now = Date.now } = {}) {
  positive(maxSessions, 'maxSessions');
  positive(maxPerPrincipal, 'maxPerPrincipal');
  positive(ttlMs, 'ttlMs');
  const sessions = new Map();

  function sweep(current) {
    for (const [key, entry] of sessions) {
      if (entry.expiresAt > current) break;
      sessions.delete(key);
    }
  }

  function lookup(token) {
    if (typeof token !== 'string' || !TOKEN_FORMAT.test(token)) return null;
    const key = digest(token);
    const entry = sessions.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= now()) {
      sessions.delete(key);
      return null;
    }
    return { key, entry };
  }

  return {
    issue(principalId) {
      if (typeof principalId !== 'string' || !principalId) throw new Error('Invalid principal id');
      const current = now();
      sweep(current);
      let held = 0;
      let oldest = null;
      for (const [key, entry] of sessions) {
        if (entry.principalId !== principalId) continue;
        held += 1;
        if (oldest === null) oldest = key;
      }
      if (held >= maxPerPrincipal) sessions.delete(oldest);
      if (sessions.size >= maxSessions) fail('SSO session capacity reached', 503);
      const token = randomToken();
      const expiresAt = current + ttlMs;
      sessions.set(digest(token), { principalId, expiresAt });
      return { token, expiresAt };
    },
    /** The principal id for a live session token, otherwise null. */
    resolve(token) {
      return lookup(token)?.entry.principalId ?? null;
    },
    /** True when the token is a live session, whatever its principal's state. */
    knows(token) {
      return lookup(token) !== null;
    },
    revoke(token) {
      const found = lookup(token);
      if (!found) return false;
      sessions.delete(found.key);
      return true;
    },
    revokePrincipal(principalId) {
      let removed = 0;
      for (const [key, entry] of sessions) {
        if (entry.principalId === principalId) { sessions.delete(key); removed += 1; }
      }
      return removed;
    },
    size() {
      sweep(now());
      return sessions.size;
    }
  };
}
