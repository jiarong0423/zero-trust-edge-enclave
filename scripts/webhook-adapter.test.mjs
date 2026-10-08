import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHmac } from 'node:crypto';
import { exportNotices, noticeRecord } from '../notice-outbox.js';
import {
  PAYLOAD_KEYS, LEDGER_FILE, addressAllowed, backoffDelay, buildPayload, createLedger, createWebhookAdapter,
  createWebhookFromEnv, readableRecord, signBody, webhookConfigFromEnv
} from '../webhook-adapter.js';

const run = promisify(execFile);
const posix = process.platform !== 'win32';
const SECRET = 'unit-test-signing-key-0123456789';
const CANARY = 'sales-a@example.com';
const ALIAS = '11111111-2222-4333-8444-555555555555';
const BASE = 'https://enclave.example.test';

function reminder(day) {
  return { kind: 'LOCAL_DRY_RUN', subjectCode: 'SEALED_DOCUMENT_REMINDER', taskAlias: ALIAS, version: 1,
    targets: ['B2', 'A1'], preparedAt: `2026-10-${String(day).padStart(2, '0')}T01:02:03.000Z`, sendsEmail: false };
}
function firstNotice() {
  return { kind: 'LOCAL_DRY_RUN', subjectCode: 'SEALED_DOCUMENT_AVAILABLE', taskAlias: ALIAS, version: 1,
    preparedAt: '2026-10-08T01:02:03.000Z', sendsEmail: false };
}
// A task full of real-looking identifiers, so a leak into the body is visible.
function fixtureTask(notice) {
  return { id: 'task-secret-id-0001', ownerId: CANARY, title: CANARY,
    file: { name: 'payroll-' + CANARY + '.pdf', sha256: 'f'.repeat(64) },
    snapshots: [{ version: 1, status: 'APPROVED', hash: 'a'.repeat(64),
      content: { recipients: [CANARY, 'sales-b@example.com'], channels: ['email'] },
      privateMapping: { taskId: 'task-secret-id-0001', version: 1, taskAlias: ALIAS,
        recipients: [{ alias: 'x', groupCode: 'B1', recipientId: 'sales-b@example.com', endpoints: [] },
          { alias: 'y', groupCode: 'A1', recipientId: CANARY, endpoints: [{ endpointId: 'dry-run:' + CANARY + ':email' }] }] } }],
    jobs: [{ version: 1, status: 'DRY_RUN_PREPARED', recipient: CANARY, notice }] };
}
function recordFor(notice) {
  const task = fixtureTask(notice);
  return noticeRecord(task, task.jobs[0], notice);
}

async function tempDir() { return fs.mkdtemp(path.join(os.tmpdir(), 'webhook-adapter-')); }
async function ledgerLines(dir) {
  try { return (await fs.readFile(path.join(dir, LEDGER_FILE), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

async function receiver(t, handler) {
  const hits = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const hit = { headers: req.headers, body: Buffer.concat(chunks).toString('utf8'), url: req.url };
      hits.push(hit);
      handler(hit, req, res, hits.length);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const { port } = server.address();
  return { hits, port, url: `http://127.0.0.1:${port}/hook/notice` };
}
const reply = status => (hit, req, res) => { res.statusCode = status; res.end('{"ignored":true}'); };

function envFor(url, extra = {}) {
  return { WEBHOOK_URL: url, WEBHOOK_ALLOWED_HOSTS: new URL(url).hostname, WEBHOOK_SECRET: SECRET, PUBLIC_BASE_URL: BASE,
    WEBHOOK_ALLOW_LOOPBACK: 'true', ...extra };
}

// One adapter over a fresh directory, with no real waiting between attempts.
async function harness(t, url, { env = {}, dir = null, ...deps } = {}) {
  const directory = dir || await tempDir();
  if (!dir) t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const logs = [];
  const sleeps = [];
  const adapter = createWebhookAdapter({
    config: webhookConfigFromEnv(envFor(url, env)),
    outboxDir: directory,
    log: line => logs.push(line),
    sleep: async ms => { sleeps.push(ms); },
    random: () => 1,
    ...deps
  });
  return { adapter, dir: directory, logs, sleeps };
}

function assertSigned(hit) {
  const timestamp = hit.headers['x-enclave-timestamp'];
  assert.match(timestamp, /^\d{10}$/);
  assert.ok(Math.abs(Number(timestamp) - Date.now() / 1000) < 30);
  const expected = 'sha256=' + createHmac('sha256', SECRET).update(`${timestamp}.${hit.body}`).digest('hex');
  assert.equal(hit.headers['x-enclave-signature'], expected);
  assert.equal(hit.headers['x-enclave-notice-id'], JSON.parse(hit.body).noticeId);
}

// ---- configuration ---------------------------------------------------------------------------

test('the feature is off unless WEBHOOK_URL is set, and the off adapter does nothing', async () => {
  for (const env of [{}, { WEBHOOK_URL: '' }, { WEBHOOK_SECRET: SECRET, WEBHOOK_ALLOWED_HOSTS: 'a.example.test' }]) {
    assert.deepEqual(webhookConfigFromEnv(env), { enabled: false });
  }
  const off = createWebhookFromEnv({}, { outboxDir: '/nonexistent-never-touched' });
  assert.equal(off.enabled, false);
  assert.deepEqual(await off.sendPending(), { sent: 0, failed: 0, skipped: 0, invalid: 0 });
});

test('misconfiguration fails closed with a 503 before anything is sent', () => {
  const good = { WEBHOOK_URL: 'https://hooks.example.test/in?token=abc', WEBHOOK_ALLOWED_HOSTS: 'hooks.example.test',
    WEBHOOK_SECRET: SECRET, PUBLIC_BASE_URL: BASE };
  const config = webhookConfigFromEnv(good);
  assert.equal(config.enabled, true);
  assert.equal(config.timeoutMs, 5000);
  assert.equal(config.maxAttempts, 5);
  const cases = [
    ['http is refused', { WEBHOOK_URL: 'http://hooks.example.test/in' }],
    ['http to a private address is refused even with the loopback flag', { WEBHOOK_URL: 'http://10.0.0.5/in', WEBHOOK_ALLOWED_HOSTS: '10.0.0.5', WEBHOOK_ALLOW_LOOPBACK: 'true' }],
    ['http loopback needs the flag', { WEBHOOK_URL: 'http://127.0.0.1:9/in', WEBHOOK_ALLOWED_HOSTS: '127.0.0.1' }],
    ['http localhost by name is refused', { WEBHOOK_URL: 'http://localhost:9/in', WEBHOOK_ALLOWED_HOSTS: 'localhost', WEBHOOK_ALLOW_LOOPBACK: 'true' }],
    ['the loopback flag must be a boolean word', { WEBHOOK_ALLOW_LOOPBACK: 'yes' }],
    ['the allowlist is required', { WEBHOOK_ALLOWED_HOSTS: undefined }],
    ['an empty allowlist is not a wildcard', { WEBHOOK_ALLOWED_HOSTS: ' , ' }],
    ['a host outside the allowlist is refused', { WEBHOOK_ALLOWED_HOSTS: 'other.example.test' }],
    ['matching is exact, not a suffix', { WEBHOOK_ALLOWED_HOSTS: 'example.test' }],
    ['a wildcard entry is invalid', { WEBHOOK_ALLOWED_HOSTS: '*.example.test' }],
    ['credentials in the URL are refused', { WEBHOOK_URL: 'https://user:pw@hooks.example.test/in' }],
    ['a fragment is refused', { WEBHOOK_URL: 'https://hooks.example.test/in#x' }],
    ['not a URL', { WEBHOOK_URL: 'hooks.example.test' }],
    ['whitespace only', { WEBHOOK_URL: '   ' }],
    ['the secret is required', { WEBHOOK_SECRET: undefined }],
    ['a short secret is refused', { WEBHOOK_SECRET: 'short' }],
    ['the base URL is required', { PUBLIC_BASE_URL: undefined }],
    ['the base URL must be https', { PUBLIC_BASE_URL: 'http://enclave.example.test' }],
    ['the base URL carries no credentials', { PUBLIC_BASE_URL: 'https://u:p@enclave.example.test' }],
    ['the base URL carries no query', { PUBLIC_BASE_URL: 'https://enclave.example.test/?a=1' }],
    ['timeout must be a number', { WEBHOOK_TIMEOUT_MS: 'fast' }],
    ['timeout has a floor', { WEBHOOK_TIMEOUT_MS: '5' }],
    ['attempts has a ceiling', { WEBHOOK_MAX_ATTEMPTS: '500' }],
    ['attempts has a floor', { WEBHOOK_MAX_ATTEMPTS: '0' }]
  ];
  for (const [label, change] of cases) {
    const env = { ...good, ...change };
    for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
    assert.throws(() => webhookConfigFromEnv(env), error => error.status === 503, label);
  }
  const loopback = webhookConfigFromEnv({ ...good, WEBHOOK_URL: 'http://[::1]:9/in', WEBHOOK_ALLOWED_HOSTS: '[::1]', WEBHOOK_ALLOW_LOOPBACK: 'true' });
  assert.equal(loopback.enabled, true);
});

test('the address policy refuses private, loopback, link-local and metadata ranges', () => {
  for (const address of ['10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '127.0.0.1', '127.9.9.9', '169.254.169.254',
    '169.254.1.1', '0.0.0.0', '100.64.0.1', '224.0.0.1', '255.255.255.255', '::1', '::', 'fe80::1', 'fc00::1', 'fd00:ec2::254',
    '::ffff:10.0.0.1', '::ffff:127.0.0.1', '::ffff:169.254.169.254', '64:ff9b::7f00:1', 'not-an-address', '', undefined]) {
    assert.equal(addressAllowed(address), false, String(address));
  }
  for (const address of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '2606:4700:4700::1111']) {
    assert.equal(addressAllowed(address), true, address);
  }
  assert.equal(addressAllowed('127.0.0.1', true), true);
  assert.equal(addressAllowed('::1', true), true);
  assert.equal(addressAllowed('::ffff:127.0.0.1', true), true);
  for (const address of ['10.0.0.1', '169.254.169.254', '192.168.0.1', 'fe80::1']) assert.equal(addressAllowed(address, true), false, address);
});

test('backoff doubles, is capped, and the jitter stays between half and all of it', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(n => backoffDelay(n, () => 1)), [1000, 2000, 4000, 8000, 16000, 30000]);
  assert.equal(backoffDelay(20, () => 1), 30000);
  assert.equal(backoffDelay(1, () => 0), 500);
  assert.equal(backoffDelay(3, () => 0), 2000);
  for (let i = 0; i < 200; i += 1) {
    const value = backoffDelay(4);
    assert.ok(value >= 4000 && value <= 8000);
  }
});

// ---- payload ---------------------------------------------------------------------------------

test('the payload is a fixed template with exactly these keys and no identifier from the task', () => {
  for (const notice of [firstNotice(), reminder(9)]) {
    const record = recordFor(notice);
    assert.ok(record.targets.length > 0, 'the fixture really does carry group codes');
    const payload = buildPayload(record, BASE);
    assert.deepEqual(Object.keys(payload), PAYLOAD_KEYS);
    assert.equal(payload.link, `${BASE}/#task=${ALIAS}`);
    const body = JSON.stringify(payload);
    for (const forbidden of [CANARY, 'sales-b', 'example.com', 'task-secret-id', 'payroll', 'f'.repeat(64), 'a'.repeat(64),
      'targets', 'groupCode', 'recipient', 'sendsEmail', 'A1', 'B1', 'B2', 'dry-run:', SECRET]) {
      assert.ok(!body.includes(forbidden), `payload must not contain ${forbidden}`);
    }
  }
});

test('extra fields on a record are never copied, and a record whose id does not match its fields is refused', () => {
  const record = { ...recordFor(reminder(9)), recipientId: CANARY, documentHash: 'f'.repeat(64), note: 'free text' };
  const payload = buildPayload(record, BASE);
  assert.deepEqual(Object.keys(payload), PAYLOAD_KEYS);
  assert.ok(!JSON.stringify(payload).includes(CANARY));
  assert.equal(readableRecord({ ...record, taskAlias: '99999999-2222-4333-8444-555555555555' }), null);
  assert.equal(readableRecord({ ...record, sendsEmail: true }), null);
  assert.equal(readableRecord({ ...record, sendsEmail: undefined }), null);
  assert.equal(readableRecord({ ...record, noticeId: 'x'.repeat(64) }), null);
  assert.equal(readableRecord(null), null);
  assert.throws(() => buildPayload({ ...record, subjectCode: 'Send it to bob@example.com' }, BASE), /WEBHOOK_RECORD_INVALID/);
});

// ---- delivery --------------------------------------------------------------------------------

test('happy path: one signed POST, verified by the receiver, then a SENT record that says sendsWebhook and not sendsEmail', async t => {
  const target = await receiver(t, reply(200));
  const { adapter, dir, logs } = await harness(t, target.url + '?token=query-secret-value');
  const record = recordFor(reminder(9));
  const summary = await adapter.deliver([record]);
  assert.deepEqual(summary, { sent: 1, failed: 0, skipped: 0, invalid: 0 });
  assert.equal(target.hits.length, 1);
  const hit = target.hits[0];
  assert.equal(hit.url, '/hook/notice?token=query-secret-value');
  assert.equal(hit.headers['content-type'], 'application/json');
  assert.equal(hit.headers.host, `127.0.0.1:${target.port}`);
  assertSigned(hit);
  assert.equal(hit.headers['x-enclave-notice-id'], record.noticeId);
  const payload = JSON.parse(hit.body);
  assert.deepEqual(Object.keys(payload), PAYLOAD_KEYS);
  assert.equal(payload.noticeId, record.noticeId);
  assert.equal(payload.link, `${BASE}/#task=${ALIAS}`);
  for (const forbidden of [CANARY, 'task-secret-id', 'payroll', 'A1', 'B2', 'targets']) assert.ok(!hit.body.includes(forbidden), forbidden);

  const entries = await ledgerLines(dir);
  assert.equal(entries.length, 1);
  assert.deepEqual(Object.keys(entries[0]).sort(), ['at', 'attempts', 'code', 'httpStatus', 'noticeId', 'sendsEmail', 'sendsWebhook', 'status']);
  assert.equal(entries[0].status, 'SENT');
  assert.equal(entries[0].sendsWebhook, true);
  assert.equal(entries[0].sendsEmail, false);
  assert.equal(entries[0].httpStatus, 200);

  assert.equal(logs.length, 1);
  assert.match(logs[0], new RegExp(`^webhook sent notice=${record.noticeId.slice(0, 8)} attempt=1/5 status=200$`));
  for (const line of logs) {
    assert.ok(!line.includes(SECRET) && !line.includes('query-secret-value') && !line.includes('127.0.0.1') && !line.includes(hit.body));
  }
  if (posix) {
    assert.equal((await fs.stat(dir)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(path.join(dir, LEDGER_FILE))).mode & 0o777, 0o600);
  }
});

test('signature helper matches the documented construction', () => {
  const body = '{"a":1}';
  assert.equal(signBody('k'.repeat(16), '1700000000', body),
    createHmac('sha256', 'k'.repeat(16)).update('1700000000.{"a":1}').digest('hex'));
});

test('a 500 is retried with backoff and the second attempt succeeds', async t => {
  const target = await receiver(t, (hit, req, res, count) => { res.statusCode = count === 1 ? 500 : 204; res.end(); });
  const { adapter, dir, logs, sleeps } = await harness(t, target.url);
  const summary = await adapter.deliver([recordFor(reminder(9))]);
  assert.equal(summary.sent, 1);
  assert.equal(target.hits.length, 2);
  assert.deepEqual(sleeps, [1000]);
  const entries = await ledgerLines(dir);
  assert.equal(entries[0].status, 'SENT');
  assert.equal(entries[0].attempts, 2);
  assert.equal(entries[0].httpStatus, 204);
  assert.equal(logs.length, 2);
  assert.match(logs[0], /^ERROR webhook retry notice=[0-9a-f]{8} attempt=1\/5 status=500 code=HTTP_500$/);
  assert.match(logs[1], /^webhook sent notice=[0-9a-f]{8} attempt=2\/5 status=204$/);
  // Both attempts carry a fresh valid signature for the same notice id.
  target.hits.forEach(assertSigned);
  assert.equal(target.hits[0].headers['x-enclave-notice-id'], target.hits[1].headers['x-enclave-notice-id']);
});

test('after the last attempt the failure is recorded as a code and never retried again', async t => {
  const target = await receiver(t, reply(503));
  const { adapter, dir, logs, sleeps } = await harness(t, target.url, { env: { WEBHOOK_MAX_ATTEMPTS: '3' } });
  const record = recordFor(reminder(9));
  const summary = await adapter.deliver([record]);
  assert.deepEqual(summary, { sent: 0, failed: 1, skipped: 0, invalid: 0 });
  assert.equal(target.hits.length, 3);
  assert.deepEqual(sleeps, [1000, 2000]);
  const entries = await ledgerLines(dir);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].status, 'FAILED');
  assert.equal(entries[0].code, 'HTTP_503');
  assert.equal(entries[0].attempts, 3);
  assert.equal(entries[0].sendsWebhook, false);
  assert.equal(entries[0].sendsEmail, false);
  assert.ok(logs.every(line => line.startsWith('ERROR webhook ')));
  assert.match(logs[2], /failed notice=[0-9a-f]{8} attempt=3\/3 status=503 code=HTTP_503/);

  // Offering it again, even from a fresh adapter, does not send: the failure is terminal.
  const again = await harness(t, target.url, { dir, env: { WEBHOOK_MAX_ATTEMPTS: '3' } });
  assert.deepEqual(await again.adapter.deliver([record]), { sent: 0, failed: 0, skipped: 1, invalid: 0 });
  assert.equal(target.hits.length, 3);
});

test('a receiver that never answers is cut off at the timeout and recorded as TIMEOUT', async t => {
  const target = await receiver(t, () => {});
  const { adapter, dir, logs } = await harness(t, target.url, { env: { WEBHOOK_TIMEOUT_MS: '150', WEBHOOK_MAX_ATTEMPTS: '2' } });
  const started = Date.now();
  const summary = await adapter.deliver([recordFor(reminder(9))]);
  assert.ok(Date.now() - started < 3000);
  assert.equal(summary.failed, 1);
  assert.equal(target.hits.length, 2);
  const [entry] = await ledgerLines(dir);
  assert.equal(entry.status, 'FAILED');
  assert.equal(entry.code, 'TIMEOUT');
  assert.equal(entry.attempts, 2);
  assert.ok(logs.every(line => line.startsWith('ERROR webhook ') && line.includes('code=TIMEOUT')));
});

test('a refused connection is a coded failure, not an exception', async t => {
  const probe = http.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise(resolve => probe.close(resolve));
  const { adapter, dir } = await harness(t, `http://127.0.0.1:${port}/hook`, { env: { WEBHOOK_MAX_ATTEMPTS: '2' } });
  const summary = await adapter.deliver([recordFor(reminder(9))]);
  assert.equal(summary.failed, 1);
  const [entry] = await ledgerLines(dir);
  assert.equal(entry.code, 'ECONNREFUSED');
  assert.equal(entry.attempts, 2);
});

test('a redirect is refused, not followed, and not retried', async t => {
  const elsewhere = await receiver(t, reply(200));
  const target = await receiver(t, (hit, req, res) => { res.statusCode = 302; res.setHeader('Location', elsewhere.url); res.end(); });
  const { adapter, dir, sleeps } = await harness(t, target.url);
  const summary = await adapter.deliver([recordFor(reminder(9))]);
  assert.equal(summary.failed, 1);
  assert.equal(target.hits.length, 1);
  assert.equal(elsewhere.hits.length, 0);
  assert.deepEqual(sleeps, []);
  const [entry] = await ledgerLines(dir);
  assert.equal(entry.code, 'REDIRECT_REFUSED');
  assert.equal(entry.attempts, 1);
});

test('a name that resolves to a private, link-local or metadata address is refused without connecting', async t => {
  const answers = {
    private: [{ address: '10.0.0.5', family: 4 }],
    metadata: [{ address: '169.254.169.254', family: 4 }],
    mappedLoopback: [{ address: '::ffff:127.0.0.1', family: 6 }],
    mixed: [{ address: '93.184.216.34', family: 4 }, { address: '192.168.1.10', family: 4 }],
    loopbackWithoutFlag: [{ address: '127.0.0.1', family: 4 }]
  };
  for (const [label, addresses] of Object.entries(answers)) {
    const dir = await tempDir();
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const lookups = [];
    const logs = [];
    const adapter = createWebhookAdapter({
      config: webhookConfigFromEnv({ WEBHOOK_URL: 'https://hook.example.test/in', WEBHOOK_ALLOWED_HOSTS: 'hook.example.test',
        WEBHOOK_SECRET: SECRET, PUBLIC_BASE_URL: BASE }),
      outboxDir: dir, log: line => logs.push(line), sleep: async () => {},
      resolver: async host => { lookups.push(host); return addresses; }
    });
    const summary = await adapter.deliver([recordFor(reminder(9))]);
    assert.equal(summary.failed, 1, label);
    assert.deepEqual(lookups, ['hook.example.test'], label);
    const [entry] = await ledgerLines(dir);
    assert.equal(entry.code, 'TARGET_ADDRESS_REFUSED', label);
    assert.equal(entry.attempts, 1, label);
    assert.ok(logs.every(line => line.startsWith('ERROR webhook ')), label);
  }
});

test('a name that cannot be resolved is retried and recorded as DNS_FAILED', async t => {
  const dir = await tempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const adapter = createWebhookAdapter({
    config: webhookConfigFromEnv({ WEBHOOK_URL: 'https://hook.example.test/in', WEBHOOK_ALLOWED_HOSTS: 'hook.example.test',
      WEBHOOK_SECRET: SECRET, PUBLIC_BASE_URL: BASE, WEBHOOK_MAX_ATTEMPTS: '2' }),
    outboxDir: dir, log: () => {}, sleep: async () => {}, resolver: async () => { throw new Error('ENOTFOUND'); }
  });
  await adapter.deliver([recordFor(reminder(9))]);
  const [entry] = await ledgerLines(dir);
  assert.equal(entry.code, 'DNS_FAILED');
  assert.equal(entry.attempts, 2);
});

test('an endless response body is cut off and ignored; the status alone decides', async t => {
  const target = await receiver(t, (hit, req, res) => {
    res.statusCode = 200;
    const timer = setInterval(() => res.write('x'.repeat(2048)), 1);
    res.on('close', () => clearInterval(timer));
  });
  const { adapter, dir } = await harness(t, target.url);
  const summary = await adapter.deliver([recordFor(reminder(9))]);
  assert.equal(summary.sent, 1);
  assert.equal((await ledgerLines(dir))[0].status, 'SENT');
});

test('a duplicate noticeId, inside one batch or across calls, is sent once', async t => {
  const target = await receiver(t, reply(200));
  const { adapter } = await harness(t, target.url);
  const record = recordFor(reminder(9));
  assert.equal((await adapter.deliver([record, { ...record }, record])).sent, 1);
  assert.deepEqual(await adapter.deliver([record]), { sent: 0, failed: 0, skipped: 1, invalid: 0 });
  assert.equal(target.hits.length, 1);
});

test('a restart (new adapter, same ledger) does not send again, and only new notices go out', async t => {
  const target = await receiver(t, reply(200));
  const first = await harness(t, target.url);
  const a = recordFor(reminder(9));
  const b = recordFor(reminder(10));
  await first.adapter.deliver([a]);
  const second = await harness(t, target.url, { dir: first.dir });
  assert.deepEqual(await second.adapter.deliver([a, b]), { sent: 1, failed: 0, skipped: 1, invalid: 0 });
  assert.deepEqual(target.hits.map(hit => hit.headers['x-enclave-notice-id']), [a.noticeId, b.noticeId]);
});

test('sendPending reads the real outbox file, repeated exports never resend, and a damaged line is skipped', async t => {
  const target = await receiver(t, reply(200));
  const { adapter, dir, logs } = await harness(t, target.url);
  const tasks = [fixtureTask(firstNotice())];
  await exportNotices(tasks, dir);
  assert.equal((await adapter.sendPending()).sent, 1);
  await exportNotices(tasks, dir);
  assert.deepEqual(await adapter.sendPending(), { sent: 0, failed: 0, skipped: 1, invalid: 0 });
  // A second notice, a half-written line and a forged line next to it.
  const second = recordFor(reminder(9));
  const forged = { ...recordFor(reminder(10)), taskAlias: '99999999-2222-4333-8444-555555555555' };
  await fs.appendFile(path.join(dir, 'notices.jsonl'), `${JSON.stringify(second)}\n{"noticeId":"abc\n${JSON.stringify(forged)}\n`);
  const summary = await adapter.sendPending();
  assert.equal(summary.sent, 1);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.invalid, 2);
  assert.equal(target.hits.length, 2);
  assert.ok(logs.some(line => line.startsWith('ERROR webhook ') && line.includes('WEBHOOK_RECORD_INVALID')));
  for (const hit of target.hits) assert.ok(!hit.body.includes('A1') && !hit.body.includes('targets') && !hit.body.includes(CANARY));
  // With no outbox file at all there is simply nothing to do.
  const empty = await harness(t, target.url);
  assert.deepEqual(await empty.adapter.sendPending(), { sent: 0, failed: 0, skipped: 0, invalid: 0 });
});

test('a ledger write that fails after the send is an error, is not sent twice, and is written on the next run', async t => {
  const target = await receiver(t, reply(200));
  const dir = await tempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const real = createLedger(dir);
  let failures = 1;
  const ledger = {
    ensure: () => real.ensure(),
    load: () => real.load(),
    append: async entry => { if (failures-- > 0) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); return real.append(entry); }
  };
  const { adapter, logs } = await harness(t, target.url, { dir, ledger });
  const record = recordFor(reminder(9));
  await assert.rejects(adapter.deliver([record]), /WEBHOOK_LEDGER_WRITE_FAILED/);
  assert.equal(target.hits.length, 1);
  assert.equal((await ledgerLines(dir)).length, 0);
  assert.ok(logs.some(line => line === 'ERROR webhook ledger write failed: ENOSPC'));

  const summary = await adapter.deliver([record]);
  assert.equal(target.hits.length, 1, 'the notice that was already sent is not sent again');
  assert.equal(summary.sent, 0);
  const entries = await ledgerLines(dir);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].noticeId, record.noticeId);
  assert.equal(entries[0].status, 'SENT');
});

test('an unwritable ledger stops the run before anything is sent', { skip: !posix || process.getuid?.() === 0 }, async t => {
  const target = await receiver(t, reply(200));
  const dir = await tempDir();
  t.after(async () => { await fs.chmod(path.join(dir, LEDGER_FILE), 0o600).catch(() => {}); await fs.rm(dir, { recursive: true, force: true }); });
  await fs.writeFile(path.join(dir, LEDGER_FILE), '', { mode: 0o400 });
  const { adapter, logs } = await harness(t, target.url, { dir });
  await assert.rejects(adapter.deliver([recordFor(reminder(9))]), /WEBHOOK_LEDGER_UNAVAILABLE/);
  assert.equal(target.hits.length, 0);
  assert.ok(logs.some(line => line.startsWith('ERROR webhook ledger unavailable: ')));
});

test('kick never throws and reports the failure as a value', async t => {
  const target = await receiver(t, reply(200));
  const dir = await tempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, LEDGER_FILE));
  const { adapter, logs } = await harness(t, target.url, { dir });
  const result = await adapter.kick();
  assert.equal(result.error, true);
  assert.equal(target.hits.length, 0);
  assert.ok(logs.some(line => line.startsWith('ERROR webhook ledger unavailable')));
});

test('a damaged ledger line is not an identity and a torn tail does not fuse with the next record', async t => {
  const dir = await tempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const ledger = createLedger(dir);
  await ledger.ensure();
  const id = 'a'.repeat(64);
  await fs.appendFile(ledger.file, `{"noticeId":"${'b'.repeat(64)}","status":"SENT"}\n{"noticeId":"${id}","sta`);
  assert.deepEqual([...await ledger.load()], ['b'.repeat(64)]);
  await ledger.append({ noticeId: id, status: 'FAILED' });
  assert.deepEqual([...await ledger.load()].sort(), [id, 'b'.repeat(64)]);
});

test('https: the connection is pinned to the checked address and the certificate is verified against the name', async t => {
  const dir = await tempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  try {
    await run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'),
      '-days', '1', '-subj', '/CN=hook.example.test', '-addext', 'subjectAltName=DNS:hook.example.test']);
  } catch { t.skip('openssl with -addext is not available'); return; }
  const key = await fs.readFile(path.join(dir, 'k.pem'));
  const cert = await fs.readFile(path.join(dir, 'c.pem'));
  const hits = [];
  const server = https.createServer({ key, cert }, (req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => { hits.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') }); res.end('ok'); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const { port } = server.address();
  const env = { WEBHOOK_URL: `https://hook.example.test:${port}/in`, WEBHOOK_ALLOWED_HOSTS: 'hook.example.test', WEBHOOK_SECRET: SECRET,
    PUBLIC_BASE_URL: BASE, WEBHOOK_ALLOW_LOOPBACK: 'true', WEBHOOK_MAX_ATTEMPTS: '1' };
  const resolver = async () => [{ address: '127.0.0.1', family: 4 }];

  const trusted = createWebhookAdapter({ config: webhookConfigFromEnv(env), outboxDir: dir, log: () => {}, resolver, tls: { ca: cert } });
  assert.equal((await trusted.deliver([recordFor(reminder(9))])).sent, 1);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].headers.host, `hook.example.test:${port}`);
  assertSigned(hits[0]);

  // Without trusting that certificate the handshake fails and nothing is delivered.
  const untrusted = createWebhookAdapter({ config: webhookConfigFromEnv(env), outboxDir: dir, log: () => {}, resolver });
  const summary = await untrusted.deliver([recordFor(reminder(10))]);
  assert.equal(summary.failed, 1);
  assert.equal(hits.length, 1);
});
