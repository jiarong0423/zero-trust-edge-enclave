import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createAuthThrottle, clientKey, throttleFromEnv, countsAsGuess, addressKey } from '../auth-throttle.js';

const clock = start => { let value = start; return { now: () => value, advance: ms => { value += ms; } }; };

test('a key locks only after the configured number of failures inside the window', () => {
  const time = clock(1_000_000);
  const throttle = createAuthThrottle({ maxFailures: 3, windowMs: 60_000, lockMs: 120_000, now: time.now });
  for (let i = 0; i < 2; i += 1) { throttle.check('a'); throttle.fail('a'); }
  throttle.check('a');
  throttle.fail('a');
  assert.throws(() => throttle.check('a'), error => error.status === 429 && error.retryAfter === 120);
  throttle.check('b');
});

test('failures outside the window do not accumulate', () => {
  const time = clock(0);
  const throttle = createAuthThrottle({ maxFailures: 3, windowMs: 10_000, lockMs: 60_000, now: time.now });
  throttle.fail('a'); throttle.fail('a');
  time.advance(10_001);
  throttle.fail('a');
  throttle.check('a');
});

test('the lock expires and the retry-after counts down', () => {
  const time = clock(0);
  const throttle = createAuthThrottle({ maxFailures: 1, lockMs: 30_000, now: time.now });
  throttle.fail('a');
  assert.throws(() => throttle.check('a'), error => error.retryAfter === 30);
  time.advance(29_001);
  assert.throws(() => throttle.check('a'), error => error.retryAfter === 1);
  time.advance(1_000);
  throttle.check('a');
});

test('memory is bounded: the oldest keys are forgotten past the cap', () => {
  const throttle = createAuthThrottle({ maxFailures: 5, maxKeys: 100 });
  for (let i = 0; i < 1000; i += 1) throttle.fail(`ip-${i}`);
  assert.ok(throttle.size() <= 100);
});

test('configuration must be positive integers', () => {
  for (const bad of [{ maxFailures: 0 }, { windowMs: -1 }, { lockMs: 1.5 }, { maxKeys: NaN }]) {
    assert.throws(() => createAuthThrottle(bad), /Invalid throttle configuration/);
  }
  assert.throws(() => throttleFromEnv({ AUTH_MAX_FAILURES: 'x' }), error => error.status === 503);
  assert.ok(throttleFromEnv({ AUTH_MAX_FAILURES: '3', AUTH_LOCK_SECONDS: '5' }));
});

test('forwarded addresses are used only when the proxy is trusted, and only if they are addresses', () => {
  const req = { headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' }, socket: { remoteAddress: '10.0.0.1' } };
  assert.equal(clientKey(req, false), '10.0.0.1');
  assert.equal(clientKey(req, true), '203.0.113.9');
  for (const junk of ['not an address; drop table', 'dead', '1.1', '::::', '']) {
    assert.equal(clientKey({ headers: { 'x-forwarded-for': junk }, socket: { remoteAddress: '10.0.0.1' } }, true), '10.0.0.1', junk);
  }
  assert.equal(clientKey({ headers: {}, socket: {} }, false), 'invalid');
});

test('every spelling of one address is one key, and an IPv6 host is keyed by its /64', () => {
  const loopback = ['::1', '0:0:0:0:0:0:0:1', '::0001', '[::1]', '0000:0000:0000:0000:0000:0000:0000:0001'].map(addressKey);
  assert.equal(new Set(loopback).size, 1);
  assert.equal(addressKey('::ffff:1.2.3.4'), '1.2.3.4');
  assert.equal(addressKey('::FFFF:1.2.3.4'), '1.2.3.4');
  assert.equal(addressKey('2001:db8:aaaa:bbbb::1'), addressKey('2001:db8:aaaa:bbbb:ffff:ffff:ffff:ffff'));
  assert.notEqual(addressKey('2001:db8:aaaa:bbbb::1'), addressKey('2001:db8:aaaa:cccc::1'));
  assert.equal(addressKey('fe80::1%en0'), addressKey('fe80::1'));
  assert.equal(addressKey('banana'), 'invalid');
  assert.equal(addressKey(undefined), 'invalid');
});

test('only a real guess counts: not a prefix of a token, not a registered (even disabled) identity', () => {
  const token = crypto.randomBytes(32).toString('base64url');
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const config = { principals: [{ id: 'gone', tokenHash: hash, disabled: true }] };
  assert.equal(token.length, 43);
  // The pages check a token as it is typed, so each prefix of a real token is sent to the server.
  for (let length = 0; length <= 42; length += 1) assert.equal(countsAsGuess(config, `Bearer ${token.slice(0, length)}`), false, `prefix ${length}`);
  assert.equal(countsAsGuess(config, `Bearer ${token}`), false, 'a disabled principal is not a guesser');
  assert.equal(countsAsGuess(config, `Bearer ${crypto.randomBytes(32).toString('base64url')}`), true);
  for (const header of [undefined, '', 'Basic abc', `Bearer ${token}x`, `bearer ${token}`]) assert.equal(countsAsGuess(config, header), false, String(header));
});

test('a lock survives a flood of throwaway keys; only when every key is locked does the oldest lock go', () => {
  const throttle = createAuthThrottle({ maxFailures: 2, maxKeys: 100, lockMs: 600_000 });
  throttle.fail('victim'); throttle.fail('victim');
  assert.throws(() => throttle.check('victim'), error => error.status === 429);
  // Each throwaway key fails once, so none of them is locked: they are what gets forgotten.
  for (let i = 0; i < 150; i += 1) throttle.fail(`spray-${i}`);
  assert.throws(() => throttle.check('victim'), error => error.status === 429);
  assert.ok(throttle.size() <= 100);
  // Documented limit: with every key locked the table cannot grow, so the oldest lock is released.
  const full = createAuthThrottle({ maxFailures: 1, maxKeys: 10, lockMs: 600_000 });
  for (let i = 0; i < 25; i += 1) full.fail(`k-${i}`);
  assert.ok(full.size() <= 10);
});

test('every lock is reported once through onLock', () => {
  const locked = [];
  const throttle = createAuthThrottle({ maxFailures: 2, lockMs: 45_000, onLock: (key, seconds) => locked.push([key, seconds]) });
  throttle.fail('a'); throttle.fail('a'); throttle.fail('b');
  assert.deepEqual(locked, [['a', 45]]);
  assert.doesNotThrow(() => createAuthThrottle({ maxFailures: 1, onLock: () => { throw new Error('logger down'); } }).fail('x'));
});
