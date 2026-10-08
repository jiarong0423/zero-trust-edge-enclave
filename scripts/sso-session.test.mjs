import test from 'node:test';
import assert from 'node:assert/strict';
import { createOneTimeTable, createSessionStore, digest, randomToken, safeEqualDigest } from '../sso-session.js';

const clock = () => {
  const state = { t: 1_000_000 };
  return { state, now: () => state.t };
};

test('a session token is 43 base64url characters and the table keeps only its digest', () => {
  const { now } = clock();
  const store = createSessionStore({ ttlMs: 60_000, now });
  const { token, expiresAt } = store.issue('alice');
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(expiresAt, 1_000_000 + 60_000);
  assert.equal(store.resolve(token), 'alice');
  assert.equal(store.knows(token), true);
  assert.notEqual(store.issue('alice').token, token);
  assert.equal(digest(token).length, 64);
  assert.match(randomToken(), /^[A-Za-z0-9_-]{43}$/);
});

test('a token that has just expired or been revoked is still recognised, for ten minutes, and not after', () => {
  const { state, now } = clock();
  const store = createSessionStore({ ttlMs: 60_000, now });
  const expiring = store.issue('alice').token;
  const revoked = store.issue('alice').token;
  assert.equal(store.revoke(revoked), true);
  assert.equal(store.resolve(revoked), null);
  assert.equal(store.knows(revoked), true);
  state.t += 60_000;
  assert.equal(store.resolve(expiring), null);
  assert.equal(store.knows(expiring), true);
  state.t += 10 * 60_000 - 1;
  assert.equal(store.knows(expiring), true);
  state.t += 1;
  assert.equal(store.knows(expiring), false);
  assert.equal(store.knows(revoked), false);
  assert.equal(store.knows(randomToken()), false);
});

test('the table of ended sessions is bounded by the session limit', () => {
  const { state, now } = clock();
  const store = createSessionStore({ maxSessions: 3, maxPerPrincipal: 10, ttlMs: 1000, now });
  const tokens = [];
  for (let round = 0; round < 4; round += 1) {
    tokens.push(store.issue('alice').token);
    state.t += 1000;
    store.size();
  }
  assert.equal(store.knows(tokens[0]), false);
  assert.equal(store.knows(tokens[3]), true);
});

test('malformed, unknown and non-string tokens never resolve', () => {
  const { now } = clock();
  const store = createSessionStore({ ttlMs: 60_000, now });
  store.issue('alice');
  for (const value of [undefined, null, 42, {}, '', 'short', 'x'.repeat(42), 'x'.repeat(44), `${'a'.repeat(42)}!`, randomToken()]) {
    assert.equal(store.resolve(value), null, String(value));
    assert.equal(store.knows(value), false, String(value));
  }
});

test('a session expires exactly at its absolute expiry and is removed', () => {
  const { state, now } = clock();
  const store = createSessionStore({ ttlMs: 30 * 60_000, now });
  const { token } = store.issue('alice');
  state.t += 30 * 60_000 - 1;
  assert.equal(store.resolve(token), 'alice');
  state.t += 1;
  assert.equal(store.resolve(token), null);
  assert.equal(store.size(), 0);
});

test('revoke removes one session; revokePrincipal removes every session of that principal only', () => {
  const { now } = clock();
  const store = createSessionStore({ ttlMs: 60_000, now });
  const a1 = store.issue('alice').token;
  const a2 = store.issue('alice').token;
  const b1 = store.issue('bob').token;
  assert.equal(store.revoke(a1), true);
  assert.equal(store.revoke(a1), false);
  assert.equal(store.resolve(a1), null);
  assert.equal(store.revokePrincipal('alice'), 1);
  assert.equal(store.resolve(a2), null);
  assert.equal(store.resolve(b1), 'bob');
});

test('table bound: one principal keeps at most N sessions and the oldest is replaced', () => {
  const { now } = clock();
  const store = createSessionStore({ ttlMs: 60_000, maxPerPrincipal: 3, now });
  const tokens = [1, 2, 3, 4, 5].map(() => store.issue('alice').token);
  assert.equal(store.size(), 3);
  assert.equal(store.resolve(tokens[0]), null);
  assert.equal(store.resolve(tokens[1]), null);
  for (const token of tokens.slice(2)) assert.equal(store.resolve(token), 'alice');
});

test('table bound: a full table of live sessions refuses a new sign-in with 503 instead of evicting someone', () => {
  const { state, now } = clock();
  const store = createSessionStore({ ttlMs: 60_000, maxSessions: 3, maxPerPrincipal: 3, now });
  const kept = ['a', 'b', 'c'].map(id => store.issue(id).token);
  assert.throws(() => store.issue('d'), error => error.status === 503);
  for (const token of kept) assert.notEqual(store.resolve(token), null);
  state.t += 60_000;
  assert.doesNotThrow(() => store.issue('d'));
  assert.equal(store.size(), 1);
});

test('one-time table: take returns the value once, then nothing', () => {
  const { now } = clock();
  const table = createOneTimeTable({ ttlMs: 1000, now });
  table.put('k', { n: 1 });
  assert.deepEqual(table.take('k'), { n: 1 });
  assert.equal(table.take('k'), undefined);
  assert.equal(table.take('never'), undefined);
});

test('one-time table: an expired entry is gone and a failed use still consumes it', () => {
  const { state, now } = clock();
  const table = createOneTimeTable({ ttlMs: 1000, now });
  table.put('old', 1);
  state.t += 1000;
  assert.equal(table.take('old'), undefined);
  table.put('fresh', 2);
  assert.equal(table.size(), 1);
  state.t += 1000;
  assert.equal(table.size(), 0);
});

test('one-time table bounds: per-owner cap drops that owner oldest; global cap drops the oldest overall', () => {
  const { now } = clock();
  const table = createOneTimeTable({ maxEntries: 5, maxPerOwner: 2, ttlMs: 60_000, now });
  table.put('a1', 1, 'a');
  table.put('a2', 2, 'a');
  table.put('a3', 3, 'a');
  assert.equal(table.take('a1'), undefined);
  assert.equal(table.take('a2'), 2);
  assert.equal(table.take('a3'), 3);
  for (const id of ['b1', 'c1', 'd1', 'e1', 'f1', 'g1']) table.put(id, id, id);
  assert.equal(table.size(), 5);
  assert.equal(table.take('b1'), undefined);
  assert.equal(table.take('g1'), 'g1');
});

test('invalid bounds are refused at construction', () => {
  assert.throws(() => createSessionStore({ ttlMs: 0 }));
  assert.throws(() => createSessionStore({ ttlMs: 1000, maxSessions: 0 }));
  assert.throws(() => createOneTimeTable({ ttlMs: 1000, maxEntries: -1 }));
  assert.throws(() => createOneTimeTable({ ttlMs: 1.5 }));
});

test('safeEqualDigest compares hex digests and rejects mismatched or empty input', () => {
  assert.equal(safeEqualDigest(digest('x'), digest('x')), true);
  assert.equal(safeEqualDigest(digest('x'), digest('y')), false);
  assert.equal(safeEqualDigest('', ''), false);
  assert.equal(safeEqualDigest(digest('x'), 'zz'), false);
});
