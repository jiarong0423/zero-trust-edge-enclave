import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { once } from 'node:events';
import http from 'node:http';
import { normalizeDownloadPolicy, checkDownloadAccess, sendDeadlineJson } from '../download-policy.js';
import { advanceDelivery } from '../access-control.js';
import { newTask, confirmFirst, confirmSecond, dispatchSnapshot } from '../snapshot-lifecycle.js';

test('delivery modes bind approved cutoff and separate required receipt from time-limited access', () => {
  const now = Date.now();
  const expiresAt = new Date(now + 60000).toISOString();
  const downloadUntil = new Date(now + 1000).toISOString();
  const policy = { deliveryMode: 'TIME_LIMITED', expiresAt, downloadUntil };
  assert.equal(checkDownloadAccess(policy, now + 999), now + 1000);
  assert.throws(() => checkDownloadAccess(policy, now + 1000), /DOWNLOAD_WINDOW_CLOSED/);
  assert.throws(() => checkDownloadAccess(policy, now + 1001), /DOWNLOAD_WINDOW_CLOSED/);
  assert.equal(checkDownloadAccess({ deliveryMode: 'REQUIRED_ACK', expiresAt }, now + 1001), now + 60000);
  assert.throws(() => checkDownloadAccess({ deliveryMode: 'REQUIRED_ACK', expiresAt }, now + 60000));
  assert.deepEqual(normalizeDownloadPolicy({ expiresAt }), { deliveryMode: 'TIME_LIMITED', downloadUntil: expiresAt });
  assert.throws(() => normalizeDownloadPolicy({ ...policy, deliveryMode: 'UNKNOWN' }));
  assert.throws(() => normalizeDownloadPolicy({ ...policy, deliveryMode: 'REQUIRED_ACK' }));
  assert.throws(() => normalizeDownloadPolicy({ ...policy, downloadUntil: new Date(now + 60001).toISOString() }));
  const actor = { id: 'sender', kind: 'operator' };
  const grant = { id: 'grant', version: 1, operatorId: actor.id, recipients: ['recipient'], channels: ['email'], expiresAt };
  const task = newTask(actor, grant, { ...policy, documentHash: 'a'.repeat(64), recipients: grant.recipients, channels: grant.channels }, now);
  const first = confirmFirst(task, actor, grant, 1, now);
  const approved = confirmSecond(first.task, actor, grant, 1, first.token, now);
  for (const change of [{ deliveryMode: 'REQUIRED_ACK', downloadUntil: null }, { downloadUntil: expiresAt }]) {
    const changed = structuredClone(approved);
    Object.assign(changed.snapshots[0].content, change);
    assert.throws(() => dispatchSnapshot(changed, grant, 1, now));
  }
});

class Response extends Writable {
  constructor(blocked = false) { super({ highWaterMark: 1 }); this.blocked = blocked; this.chunks = []; }
  writeHead(status, headers) { this.status = status; this.headers = headers; }
  _write(chunk, encoding, callback) { this.chunks.push(Buffer.from(chunk)); if (!this.blocked) callback(); }
}

test('deadline response completes before cutoff and terminates backpressured transfer at cutoff', async () => {
  const payload = { packet: 'x'.repeat(200000) };
  const completed = new Response();
  const finish = once(completed, 'finish');
  sendDeadlineJson(completed, 200, payload, Date.now() + 10000);
  await finish;
  assert.deepEqual(JSON.parse(Buffer.concat(completed.chunks)), payload);
  const blocked = new Response(true);
  const closed = once(blocked, 'close');
  sendDeadlineJson(blocked, 200, payload, Date.now() + 30);
  await closed;
  assert.equal(blocked.destroyed, true);
  assert.equal(blocked.writableFinished, false);
  assert.ok(Buffer.concat(blocked.chunks).length < Number(blocked.headers['content-length']));
  const expired = new Response();
  assert.throws(() => sendDeadlineJson(expired, 200, payload, Date.now() - 1), /DOWNLOAD_WINDOW_CLOSED/);
  assert.equal(expired.chunks.length, 0);
});

test('real HTTP slow reader cannot keep a server transfer open beyond the cutoff', async t => {
  let client;
  let response;
  let resolveOutcome;
  const outcome = new Promise(resolve => { resolveOutcome = resolve; });
  const server = http.createServer((req, res) => {
    res.once('close', () => resolveOutcome({ finished: res.writableFinished, at: Date.now() }));
    response = res;
    sendDeadlineJson(res, 200, { packet: 'x'.repeat(7000000) }, Date.now() + 100);
  });
  t.after(async () => {
    client?.destroy();
    response?.destroy();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let received = 0;
  const began = Date.now();
  client = http.get(`http://127.0.0.1:${server.address().port}/`, res => {
    res.once('data', bytes => { received += bytes.length; res.pause(); });
    res.on('error', () => {});
  });
  client.on('error', () => {});
  let timer;
  try {
    const result = await Promise.race([outcome, new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(Error('TRANSFER_DID_NOT_STOP')), 2000);
    })]);
    assert.equal(result.finished, false);
    assert.ok(received > 0 && received < 7000000);
    assert.ok(result.at - began < 1500);
  } finally { clearTimeout(timer); }
});

test('retry scheduling stays inside the download window and never queues a doomed attempt', () => {
  const now = Date.now();
  const grant = { maxAttempts: 5, simulatedOutcomes: ['transient', 'transient', 'transient', 'transient'] };
  const input = { packageId: 'p', requestId: 'r1', channel: 'email' };
  const g = { ...grant, channels: ['email'] };

  // Far deadline: full jitter stays within the capped exponential window.
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const previous = { delivery: { status: 'RETRY_WAIT', attempts: attempt - 1, requests: [], events: [] } };
    const out = advanceDelivery(previous, g, { ...input, requestId: 'r' + attempt }, now, now + 3600000);
    assert.equal(out.status, 'RETRY_WAIT');
    const delay = Date.parse(out.nextAttemptAt) - now;
    assert.ok(delay >= 0 && delay <= Math.min(60000, 1000 * 2 ** (attempt - 1)), `attempt ${attempt} delay ${delay}`);
  }

  // Near deadline: the wait is clamped strictly inside the remaining window.
  for (let round = 0; round < 50; round += 1) {
    const previous = { delivery: { status: 'RETRY_WAIT', attempts: 3, requests: [], events: [] } };
    const out = advanceDelivery(previous, g, { ...input, requestId: 'near' + round }, now, now + 500);
    assert.equal(out.status, 'RETRY_WAIT');
    assert.ok(Date.parse(out.nextAttemptAt) < now + 500, 'retry must fire before the cutoff');
  }

  // Closed or one-millisecond window: pause instead of queueing an attempt that cannot land.
  for (const deadline of [now - 1, now, now + 1]) {
    const previous = { delivery: { status: 'RETRY_WAIT', attempts: 1, requests: [], events: [] } };
    const out = advanceDelivery(previous, g, { ...input, requestId: 'dead' + deadline }, now, deadline);
    assert.equal(out.status, 'PAUSED');
    assert.equal(out.nextAttemptAt, null);
  }

  // No deadline supplied keeps the previous unbounded behaviour.
  const legacy = advanceDelivery({ delivery: { status: 'RETRY_WAIT', attempts: 1, requests: [], events: [] } },
    g, { ...input, requestId: 'legacy' }, now);
  assert.equal(legacy.status, 'RETRY_WAIT');
  assert.ok(Date.parse(legacy.nextAttemptAt) - now <= 2000);
});

test('a pause caused by the closed window is not reported as exhausted retries', () => {
  const now = Date.now();
  const g = { maxAttempts: 5, channels: ['email'], simulatedOutcomes: ['transient', 'transient'] };
  const input = { packageId: 'p', requestId: 'w1', channel: 'email' };
  const previous = { delivery: { status: 'RETRY_WAIT', attempts: 0, requests: [], events: [] } };

  const closed = advanceDelivery(previous, g, input, now, now + 1);
  assert.equal(closed.status, 'PAUSED');
  assert.equal(closed.pausedBy, 'DELIVERY_WINDOW_CLOSED');
  assert.equal(closed.attempts, 1, 'the attempt budget is untouched, so it is not exhaustion');

  const open = advanceDelivery(previous, g, { ...input, requestId: 'w2' }, now, now + 3600000);
  assert.equal(open.status, 'RETRY_WAIT');
  assert.equal(open.pausedBy, undefined);

  // A broken deadline must fail closed rather than schedule an unbounded retry. `undefined` is not
  // in this list: it is indistinguishable from omitting the argument, which means "no cutoff".
  for (const broken of [NaN, 'soon', null, -Infinity, {}, []]) {
    assert.throws(() => advanceDelivery(previous, g, { ...input, requestId: 'b' }, now, broken),
      /Invalid download deadline/);
  }
  // Infinity still means "no cutoff applies" and keeps the equal-jitter floor.
  const unbounded = advanceDelivery(previous, g, { ...input, requestId: 'inf' }, now, Infinity);
  assert.equal(unbounded.status, 'RETRY_WAIT');
  assert.ok(Date.parse(unbounded.nextAttemptAt) - now >= 500, 'equal jitter keeps half the backoff');
});
