import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import https from 'node:https';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import util, { promisify } from 'node:util';
import { createHmac } from 'node:crypto';
import { exportNotices, noticeRecord } from '../notice-outbox.js';
import {
  PAYLOAD_KEYS, LEDGER_FILE, MAX_DEFERRALS, addressAllowed, allowedAddressText, backoffDelay, buildPayload, createLedger, createWebhookAdapter,
  createWebhookFromEnv, deferDelay, readableRecord, signBody, webhookConfigFromEnv
} from '../webhook-adapter.js';

const run = promisify(execFile);
const posix = process.platform !== 'win32';
const SECRET = 'unit-test-signing-key-0123456789';
const CANARY = 'sales-a@example.com';
const ALIAS = '11111111-2222-4333-8444-555555555555';
const BASE = 'https://enclave.example.test';
const NOW = Date.now();

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
  assert.equal(hit.headers['x-enclave-signature'], expectedSignature(timestamp, hit.headers['x-enclave-notice-id'], hit.body));
  assert.equal(hit.headers['x-enclave-notice-id'], JSON.parse(hit.body).noticeId);
}
// The receiver side as documented: HMAC over timestamp.noticeId.body, header id must equal the body id.
function expectedSignature(timestamp, noticeId, body) {
  return 'sha256=' + createHmac('sha256', SECRET).update(`${timestamp}.${noticeId}.${body}`).digest('hex');
}
function receiverAccepts(headers, body) {
  if (!/^\d{10}$/.test(headers['x-enclave-timestamp'])) return false;
  if (headers['x-enclave-notice-id'] !== JSON.parse(body).noticeId) return false;
  return headers['x-enclave-signature'] === expectedSignature(headers['x-enclave-timestamp'], headers['x-enclave-notice-id'], body);
}

// ---- configuration ---------------------------------------------------------------------------

test('the feature is off unless WEBHOOK_URL is set, and the off adapter does nothing', async () => {
  for (const env of [{}, { WEBHOOK_URL: '' }, { WEBHOOK_SECRET: SECRET, WEBHOOK_ALLOWED_HOSTS: 'a.example.test' }]) {
    assert.deepEqual(webhookConfigFromEnv(env), { enabled: false });
  }
  const off = createWebhookFromEnv({}, { outboxDir: '/nonexistent-never-touched' });
  assert.equal(off.enabled, false);
  assert.deepEqual(await off.sendPending(), { sent: 0, failed: 0, deferred: 0, skipped: 0, invalid: 0 });
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
    ['attempts has a floor', { WEBHOOK_MAX_ATTEMPTS: '0' }],
    // a host the address policy can never deliver to is a startup error, not a stream of permanent failures
    ['a private IPv4 literal', { WEBHOOK_URL: 'https://10.0.0.1/in', WEBHOOK_ALLOWED_HOSTS: '10.0.0.1' }],
    ['the metadata address', { WEBHOOK_URL: 'https://169.254.169.254/latest', WEBHOOK_ALLOWED_HOSTS: '169.254.169.254' }],
    ['a decimal spelling of the metadata address', { WEBHOOK_URL: 'https://2852039166/latest', WEBHOOK_ALLOWED_HOSTS: '169.254.169.254' }],
    ['a hex-mapped loopback literal', { WEBHOOK_URL: 'https://[::ffff:7f00:1]/in', WEBHOOK_ALLOWED_HOSTS: '[::ffff:7f00:1]' }],
    ['a dotted-mapped loopback literal', { WEBHOOK_URL: 'https://[::ffff:127.0.0.1]/in', WEBHOOK_ALLOWED_HOSTS: '[::ffff:7f00:1]' }],
    ['a loopback literal without the flag', { WEBHOOK_URL: 'https://127.0.0.1/in', WEBHOOK_ALLOWED_HOSTS: '127.0.0.1' }],
    ['localhost without the flag', { WEBHOOK_URL: 'https://localhost/in', WEBHOOK_ALLOWED_HOSTS: 'localhost' }],
    ['a name under .localhost', { WEBHOOK_URL: 'https://hook.localhost/in', WEBHOOK_ALLOWED_HOSTS: 'hook.localhost' }],
    ['a .internal name', { WEBHOOK_URL: 'https://metadata.google.internal/in', WEBHOOK_ALLOWED_HOSTS: 'metadata.google.internal' }],
    ['a .local name', { WEBHOOK_URL: 'https://printer.local/in', WEBHOOK_ALLOWED_HOSTS: 'printer.local' }],
    ['another port without the flag', { WEBHOOK_URL: 'https://hooks.example.test:8443/in' }],
    ['a database port', { WEBHOOK_URL: 'https://hooks.example.test:6379/in' }],
    ['a tab inside the host', { WEBHOOK_URL: 'https://hooks.exa\tmple.test/in' }],
    ['a newline inside the URL', { WEBHOOK_URL: 'https://hooks.example.test/in\nHost: evil' }],
    ['a trailing newline', { WEBHOOK_URL: 'https://hooks.example.test/in\n' }],
    ['a space in the path', { WEBHOOK_URL: 'https://hooks.example.test/a b' }],
    ['a space in the base URL', { PUBLIC_BASE_URL: 'https://enclave.example.test/a b' }],
    ['a secret of one repeated character', { WEBHOOK_SECRET: 'a'.repeat(32) }],
    ['a secret of spaces', { WEBHOOK_SECRET: ' '.repeat(32) }],
    ['a secret with a trailing newline', { WEBHOOK_SECRET: `${SECRET}\n` }],
    ['a secret with a leading space', { WEBHOOK_SECRET: ` ${SECRET}` }],
    ['a secret with a trailing space', { WEBHOOK_SECRET: `${SECRET} ` }]
  ];
  for (const [label, change] of cases) {
    const env = { ...good, ...change };
    for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
    assert.throws(() => webhookConfigFromEnv(env), error => error.status === 503, label);
  }
  const loopback = webhookConfigFromEnv({ ...good, WEBHOOK_URL: 'http://[::1]:9/in', WEBHOOK_ALLOWED_HOSTS: '[::1]', WEBHOOK_ALLOW_LOOPBACK: 'true' });
  assert.equal(loopback.enabled, true);
  // What stays accepted: the default port spelled out, a public literal, and the test flag's loopback and port.
  assert.equal(webhookConfigFromEnv({ ...good, WEBHOOK_URL: 'https://hooks.example.test:443/in' }).enabled, true);
  assert.equal(webhookConfigFromEnv({ ...good, WEBHOOK_URL: 'https://93.184.216.34/in', WEBHOOK_ALLOWED_HOSTS: '93.184.216.34' }).enabled, true);
  assert.equal(webhookConfigFromEnv({ ...good, WEBHOOK_URL: 'https://[2606:4700:4700::1111]/in', WEBHOOK_ALLOWED_HOSTS: '[2606:4700:4700::1111]' }).enabled, true);
  assert.equal(webhookConfigFromEnv({ ...good, WEBHOOK_URL: 'https://hooks.example.test:8443/in', WEBHOOK_ALLOW_LOOPBACK: 'true' }).enabled, true);
  assert.equal(webhookConfigFromEnv({ ...good, WEBHOOK_URL: 'https://localhost:8443/in', WEBHOOK_ALLOWED_HOSTS: 'localhost', WEBHOOK_ALLOW_LOOPBACK: 'true' }).enabled, true);
  // Even with the flag, a private (non-loopback) literal is refused.
  assert.throws(() => webhookConfigFromEnv({ ...good, WEBHOOK_URL: 'https://10.0.0.1/in', WEBHOOK_ALLOWED_HOSTS: '10.0.0.1', WEBHOOK_ALLOW_LOOPBACK: 'true' }), error => error.status === 503);
});

test('the secret is not an enumerable property of the config, so it cannot leak by spreading, logging or serialising it', async t => {
  const config = webhookConfigFromEnv({ WEBHOOK_URL: 'https://hooks.example.test/in', WEBHOOK_ALLOWED_HOSTS: 'hooks.example.test',
    WEBHOOK_SECRET: SECRET, PUBLIC_BASE_URL: BASE });
  assert.equal(config.secret, SECRET, 'still readable by the adapter');
  assert.ok(!Object.keys(config).includes('secret'));
  assert.ok(!JSON.stringify(config).includes(SECRET));
  assert.ok(!util.inspect(config, { showHidden: false, depth: 5 }).includes(SECRET));
  assert.ok(!JSON.stringify({ ...config }).includes(SECRET));
  const dir = await tempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  // A copy of the config has no key, and the adapter says so at creation instead of failing on the first send.
  assert.throws(() => createWebhookAdapter({ config: { ...config }, outboxDir: dir, log: () => {} }), TypeError);
  const adapter = createWebhookAdapter({ config, outboxDir: dir, log: () => {} });
  assert.ok(!util.inspect(adapter, { showHidden: true, depth: 5 }).includes(SECRET));
});

// Every spelling the red team found, plus the ones that must keep working. No address is connected to here.
const REFUSED_SPELLINGS = [
  // IPv4: private, loopback, link-local, metadata, shared, reserved, multicast
  '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '127.0.0.1', '127.9.9.9', '169.254.169.254', '169.254.1.1',
  '0.0.0.0', '100.64.0.1', '100.100.100.200', '168.63.129.16', '192.0.0.192', '192.88.99.1', '198.19.255.255', '224.0.0.1',
  '255.255.255.255',
  // non-canonical IPv4 spellings are not addresses at all
  '0x7f.0.0.1', '2130706433', '0177.0.0.1', '127.1', ' 127.0.0.1', '127.0.0.1 ',
  // IPv6 special and local
  '::1', '::', 'fe80::1', 'fe80::1%eth0', 'fc00::1', 'fd00:ec2::254', 'ff02::1',
  // IPv4-mapped, dotted and hex, upper case, long form, brackets
  '::ffff:10.0.0.1', '::ffff:127.0.0.1', '::FFFF:127.0.0.1', '::ffff:169.254.169.254', '[::ffff:127.0.0.1]',
  '::ffff:7f00:1', '::ffff:7f00:0001', '0:0:0:0:0:ffff:7f00:1', '::ffff:a9fe:a9fe', '::ffff:0a00:0001', '::ffff:c0a8:101',
  // IPv4-compatible and the rest of ::/96
  '::127.0.0.1', '::7f00:1', '::a9fe:a9fe', '::0a00:1', '::8.8.8.8', '::808:808',
  // translation prefixes and SIIT
  '64:ff9b::7f00:1', '64:ff9b::a9fe:a9fe', '64:ff9b:1::7f00:1', '::ffff:0:127.0.0.1', '::ffff:0:7f00:1',
  // 6to4, Teredo, special-purpose and retired ranges
  '2002:7f00:1::', '2002:a9fe:a9fe::', '2001:0:7f00:1::', '2001::1', '2001:10::1', '2001:db8::1', '3fff::1', '3ffe::1',
  'fec0::1', 'fec0::254', '100::1', '5f00::1',
  // not addresses
  'localhost', 'not-an-address', '', '[::1', '1.2.3', '::ffff:1.2.3.256', ':::', '1::2::3', undefined, null, 123
];
const ALLOWED_SPELLINGS = ['93.184.216.34', '8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111', '2606:4700::1111',
  '2001:4860:4860::8888', '2a00:1450:4001:81b::200e', '::ffff:8.8.8.8', '::ffff:808:808', '[2606:4700:4700::1111]'];

test('the address policy refuses every spelling of a private, loopback, link-local, metadata or special-purpose address', () => {
  for (const address of REFUSED_SPELLINGS) assert.equal(addressAllowed(address), false, String(address));
  for (const address of ALLOWED_SPELLINGS) assert.equal(addressAllowed(address), true, address);
  // The loopback test flag opens loopback and nothing else, in every spelling of loopback.
  for (const address of ['127.0.0.1', '127.9.9.9', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '0:0:0:0:0:ffff:7f00:1']) {
    assert.equal(addressAllowed(address, true), true, `${address} with the flag`);
  }
  for (const address of ['10.0.0.1', '169.254.169.254', '192.168.0.1', 'fe80::1', '::ffff:a9fe:a9fe', '::ffff:0a00:0001', '::7f00:1',
    '::ffff:0:127.0.0.1', 'fec0::1', '64:ff9b:1::7f00:1', 'localhost']) {
    assert.equal(addressAllowed(address, true), false, `${address} with the flag`);
  }
});

test('the connect address is rebuilt from what was checked: mapped addresses are unwrapped, IPv6 is spelled out in full', () => {
  assert.equal(allowedAddressText('::ffff:808:808'), '8.8.8.8');
  assert.equal(allowedAddressText('::FFFF:8.8.8.8'), '8.8.8.8');
  assert.equal(allowedAddressText('2606:4700::1111'), '2606:4700:0:0:0:0:0:1111');
  assert.equal(allowedAddressText('[2606:4700::1111]'), '2606:4700:0:0:0:0:0:1111');
  assert.equal(allowedAddressText('::1', true), '::1');
  assert.equal(allowedAddressText('::ffff:7f00:1', true), '127.0.0.1');
  assert.equal(allowedAddressText('::ffff:7f00:1'), null);
});

test('a refused address spelling never opens a socket, whatever name or literal it arrives as', async t => {
  const connects = [];
  t.mock.method(net.Socket.prototype, 'connect', function spy(...args) {
    connects.push(args);
    throw new Error('SPY_NO_CONNECT');
  });
  const spellings = ['::ffff:7f00:1', '::ffff:a9fe:a9fe', '::ffff:0a00:0001', '0:0:0:0:0:ffff:7f00:1', '::7f00:1', '::127.0.0.1',
    '::ffff:0:127.0.0.1', 'fec0::1', '64:ff9b:1::7f00:1', '100::1', '2001::1', '3fff::1', '5f00::1', '169.254.169.254', '::ffff:10.0.0.1'];
  for (const address of spellings) {
    const dir = await tempDir();
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const adapter = createWebhookAdapter({
      config: webhookConfigFromEnv({ WEBHOOK_URL: 'https://hook.example.test/in', WEBHOOK_ALLOWED_HOSTS: 'hook.example.test',
        WEBHOOK_SECRET: SECRET, PUBLIC_BASE_URL: BASE }),
      outboxDir: dir, log: () => {}, sleep: async () => {}, resolver: async () => [{ address }]
    });
    await adapter.deliver([recordFor(reminder(9))]);
    const [entry] = await ledgerLines(dir);
    assert.equal(entry.code, 'TARGET_ADDRESS_REFUSED', address);
  }
  assert.equal(connects.length, 0, 'no socket was created for any refused spelling');
});

test('end to end: a hex-mapped loopback answer does not reach a loopback listener unless the test flag is set', async t => {
  const seen = [];
  const listener = net.createServer(socket => { seen.push(socket.remoteAddress); socket.on('error', () => {}); socket.destroy(); });
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => listener.close(resolve)));
  const { port } = listener.address();
  for (const address of ['::ffff:7f00:1', '0:0:0:0:0:ffff:7f00:1', '::7f00:1']) {
    const dir = await tempDir();
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const adapter = createWebhookAdapter({
      config: webhookConfigFromEnv({ WEBHOOK_URL: `https://hook.example.test:${port}/in`, WEBHOOK_ALLOWED_HOSTS: 'hook.example.test',
        WEBHOOK_SECRET: SECRET, PUBLIC_BASE_URL: BASE, WEBHOOK_ALLOW_LOOPBACK: 'true' }),
      outboxDir: dir, log: () => {}, sleep: async () => {}, resolver: async () => [{ address }]
    });
    await adapter.deliver([recordFor(reminder(9))]);
    const [entry] = await ledgerLines(dir);
    // With the flag, hex-mapped loopback is loopback and is allowed to connect; the compat spelling is not.
    if (address === '::7f00:1') assert.equal(entry.code, 'TARGET_ADDRESS_REFUSED');
  }
  assert.ok(seen.length >= 1, 'with the flag, mapped loopback is a loopback address');
  const before = seen.length;
  for (const address of ['::ffff:7f00:1', '0:0:0:0:0:ffff:7f00:1', '::7f00:1']) {
    const dir = await tempDir();
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const adapter = createWebhookAdapter({
      config: webhookConfigFromEnv({ WEBHOOK_URL: `https://hook.example.test/in`, WEBHOOK_ALLOWED_HOSTS: 'hook.example.test',
        WEBHOOK_SECRET: SECRET, PUBLIC_BASE_URL: BASE }),
      outboxDir: dir, log: () => {}, sleep: async () => {}, resolver: async () => [{ address }]
    });
    await adapter.deliver([recordFor(reminder(9))]);
    assert.equal((await ledgerLines(dir))[0].code, 'TARGET_ADDRESS_REFUSED', address);
  }
  assert.equal(seen.length, before, 'without the flag the listener saw nothing');
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
  assert.deepEqual(summary, { sent: 1, failed: 0, deferred: 0, skipped: 0, invalid: 0 });
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

test('signature helper matches the documented construction, and the notice id is part of what is signed', () => {
  const id = 'a'.repeat(64);
  const body = '{"a":1}';
  assert.equal(signBody('k'.repeat(16), '1700000000', id, body),
    createHmac('sha256', 'k'.repeat(16)).update(`1700000000.${id}.{"a":1}`).digest('hex'));
  assert.notEqual(signBody('k'.repeat(16), '1700000000', 'b'.repeat(64), body), signBody('k'.repeat(16), '1700000000', id, body));
});

test('rewriting X-Enclave-Notice-Id in transit breaks the signature', async t => {
  const target = await receiver(t, reply(200));
  const { adapter } = await harness(t, target.url);
  await adapter.deliver([recordFor(reminder(9))]);
  const { headers, body } = target.hits[0];
  assert.equal(receiverAccepts(headers, body), true);
  const forged = 'f'.repeat(64);
  // Header rewritten, body untouched: the documented id check and the signature both fail.
  assert.equal(receiverAccepts({ ...headers, 'x-enclave-notice-id': forged }, body), false);
  // Even a receiver that skipped the header/body comparison would fail on the signature.
  assert.notEqual(headers['x-enclave-signature'], expectedSignature(headers['x-enclave-timestamp'], forged, body));
  // Header and body rewritten together: the signature fails as well.
  const rewritten = JSON.stringify({ ...JSON.parse(body), noticeId: forged });
  assert.equal(receiverAccepts({ ...headers, 'x-enclave-notice-id': forged }, rewritten), false);
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

test('after the last in-run attempt a transient failure is DEFERRED, with a cumulative attempt count and a time to wait', async t => {
  const target = await receiver(t, reply(503));
  const { adapter, dir, logs, sleeps } = await harness(t, target.url, { env: { WEBHOOK_MAX_ATTEMPTS: '3' }, now: () => NOW });
  const record = recordFor(reminder(9));
  const summary = await adapter.deliver([record]);
  assert.deepEqual(summary, { sent: 0, failed: 0, deferred: 1, skipped: 0, invalid: 0 });
  assert.equal(target.hits.length, 3);
  assert.deepEqual(sleeps, [1000, 2000]);
  const entries = await ledgerLines(dir);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].status, 'DEFERRED');
  assert.equal(entries[0].code, 'HTTP_503');
  assert.equal(entries[0].attempts, 3);
  assert.equal(entries[0].nextEligibleAt, new Date(NOW + 60_000).toISOString());
  assert.equal(entries[0].sendsWebhook, false);
  assert.equal(entries[0].sendsEmail, false);
  assert.ok(logs.every(line => line.startsWith('ERROR webhook ')));
  assert.match(logs[2], /deferred notice=[0-9a-f]{8} attempt=3\/3 status=503 code=HTTP_503 deferral=1\/12 next=\d{4}-/);

  // Not yet due: offering it again, from a fresh adapter too, sends nothing.
  const again = await harness(t, target.url, { dir, env: { WEBHOOK_MAX_ATTEMPTS: '3' }, now: () => NOW + 59_000 });
  assert.deepEqual(await again.adapter.deliver([record]), { sent: 0, failed: 0, deferred: 0, skipped: 1, invalid: 0 });
  assert.equal(target.hits.length, 3);
});

test('a DEFERRED notice is offered again once its time has passed, and a late success ends the story', async t => {
  let healthy = false;
  const target = await receiver(t, (hit, req, res) => { res.statusCode = healthy ? 204 : 503; res.end(); });
  let clock = NOW;
  const { adapter, dir } = await harness(t, target.url, { env: { WEBHOOK_MAX_ATTEMPTS: '2' }, now: () => clock });
  const record = recordFor(reminder(9));
  assert.equal((await adapter.deliver([record])).deferred, 1);
  assert.equal(target.hits.length, 2);
  healthy = true;
  clock = NOW + 30_000;
  assert.equal((await adapter.deliver([record])).skipped, 1, 'too early');
  assert.equal(target.hits.length, 2);
  clock = NOW + 61_000;
  assert.deepEqual(await adapter.deliver([record]), { sent: 1, failed: 0, deferred: 0, skipped: 0, invalid: 0 });
  assert.equal(target.hits.length, 3);
  const entries = await ledgerLines(dir);
  assert.deepEqual(entries.map(entry => entry.status), ['DEFERRED', 'SENT']);
  assert.equal(entries[1].attempts, 3, 'attempts are cumulative across deferrals');
  clock = NOW + 10 * 3600_000;
  assert.equal((await adapter.deliver([record])).skipped, 1, 'SENT is final');
  assert.equal(target.hits.length, 3);
});

test('deferral waits double up to six hours, and after the twelfth deferral the notice is FAILED as RETRY_EXHAUSTED', async t => {
  assert.deepEqual([1, 2, 3, 4, 9, 10, 12, 30].map(n => deferDelay(n, () => 1)),
    [60_000, 120_000, 240_000, 480_000, 15_360_000, 21_600_000, 21_600_000, 21_600_000]);
  assert.equal(deferDelay(1, () => 0), 30_000);
  const target = await receiver(t, reply(500));
  let clock = NOW;
  const { adapter, dir } = await harness(t, target.url, { env: { WEBHOOK_MAX_ATTEMPTS: '1' }, now: () => clock });
  const record = recordFor(reminder(9));
  for (let round = 1; round <= MAX_DEFERRALS; round += 1) {
    assert.equal((await adapter.deliver([record])).deferred, 1, `deferral ${round}`);
    clock += 7 * 3600_000;
  }
  assert.deepEqual(await adapter.deliver([record]), { sent: 0, failed: 1, deferred: 0, skipped: 0, invalid: 0 });
  const entries = await ledgerLines(dir);
  assert.equal(entries.length, MAX_DEFERRALS + 1);
  assert.deepEqual(entries.slice(0, MAX_DEFERRALS).map(entry => entry.status), Array(MAX_DEFERRALS).fill('DEFERRED'));
  const last = entries.at(-1);
  assert.equal(last.status, 'FAILED');
  assert.equal(last.code, 'RETRY_EXHAUSTED');
  assert.equal(last.lastCode, 'HTTP_500');
  assert.equal(last.attempts, MAX_DEFERRALS + 1);
  assert.ok(entries.every(entry => !entry.nextEligibleAt || Date.parse(entry.nextEligibleAt) - Date.parse(entry.at) <= 6 * 3600_000));
  const hits = target.hits.length;
  clock += 100 * 3600_000;
  assert.equal((await adapter.deliver([record])).skipped, 1, 'FAILED is final');
  assert.equal(target.hits.length, hits);
});

test('a receiver that is down costs one notice\'s attempts per run, not one per notice; later runs move on only when due', async t => {
  const target = await receiver(t, reply(503));
  let clock = NOW;
  const { adapter, dir } = await harness(t, target.url, { env: { WEBHOOK_MAX_ATTEMPTS: '2' }, now: () => clock });
  const records = [9, 10, 11, 12, 13, 14, 15, 16].map(day => recordFor(reminder(day)));
  assert.deepEqual(await adapter.deliver(records), { sent: 0, failed: 0, deferred: 1, skipped: 0, invalid: 0 });
  assert.equal(target.hits.length, 2, 'one notice, its two in-run attempts, then the run stops');
  assert.equal((await ledgerLines(dir)).length, 1);
  // The next run skips the one that is waiting and tries the next notice, once more stopping at the first deferral.
  assert.deepEqual(await adapter.deliver(records), { sent: 0, failed: 0, deferred: 1, skipped: 1, invalid: 0 });
  assert.equal(target.hits.length, 4);
  // Recovery: everything that is due goes out in one run, nothing is lost.
  target.hits.length = 0;
  const healthy = await receiver(t, reply(204));
  clock += 24 * 3600_000;
  const recovered = await harness(t, healthy.url, { dir, now: () => clock });
  assert.deepEqual(await recovered.adapter.deliver(records), { sent: 8, failed: 0, deferred: 0, skipped: 0, invalid: 0 });
  assert.equal(healthy.hits.length, 8);
});

test('a 404 from a wrong URL, a transient DNS answer and a connection error are DEFERRED, never a permanent FAILED', async t => {
  const target = await receiver(t, reply(404));
  const first = await harness(t, target.url, { env: { WEBHOOK_MAX_ATTEMPTS: '1' } });
  assert.equal((await first.adapter.deliver([recordFor(reminder(9))])).deferred, 1);
  assert.deepEqual((await ledgerLines(first.dir)).map(entry => [entry.status, entry.code]), [['DEFERRED', 'HTTP_404']]);

  const dnsDir = await tempDir();
  t.after(() => fs.rm(dnsDir, { recursive: true, force: true }));
  const config = webhookConfigFromEnv({ WEBHOOK_URL: 'https://hook.example.test/in', WEBHOOK_ALLOWED_HOSTS: 'hook.example.test',
    WEBHOOK_SECRET: SECRET, PUBLIC_BASE_URL: BASE, WEBHOOK_MAX_ATTEMPTS: '1' });
  const lookups = createWebhookAdapter({ config, outboxDir: dnsDir, log: () => {}, sleep: async () => {},
    resolver: async () => { throw Object.assign(new Error('EAI_AGAIN'), { code: 'EAI_AGAIN' }); } });
  assert.equal((await lookups.deliver([recordFor(reminder(9))])).deferred, 1);
  assert.deepEqual((await ledgerLines(dnsDir)).map(entry => [entry.status, entry.code]), [['DEFERRED', 'DNS_FAILED']]);
});

test('a receiver that never answers is cut off at the timeout and DEFERRED as TIMEOUT', async t => {
  const target = await receiver(t, () => {});
  const { adapter, dir, logs } = await harness(t, target.url, { env: { WEBHOOK_TIMEOUT_MS: '150', WEBHOOK_MAX_ATTEMPTS: '2' } });
  const started = Date.now();
  const summary = await adapter.deliver([recordFor(reminder(9))]);
  assert.ok(Date.now() - started < 3000);
  assert.equal(summary.deferred, 1);
  assert.equal(target.hits.length, 2);
  const [entry] = await ledgerLines(dir);
  assert.equal(entry.status, 'DEFERRED');
  assert.equal(entry.code, 'TIMEOUT');
  assert.equal(entry.attempts, 2);
  assert.ok(logs.every(line => line.startsWith('ERROR webhook ') && line.includes('code=TIMEOUT')));
});

test('a refused connection is a coded deferral, not an exception', async t => {
  const probe = http.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise(resolve => probe.close(resolve));
  const { adapter, dir } = await harness(t, `http://127.0.0.1:${port}/hook`, { env: { WEBHOOK_MAX_ATTEMPTS: '2' } });
  const summary = await adapter.deliver([recordFor(reminder(9)), recordFor(reminder(10)), recordFor(reminder(11))]);
  assert.equal(summary.deferred, 1);
  const entries = await ledgerLines(dir);
  assert.equal(entries.length, 1, 'the run stopped after the first notice');
  assert.equal(entries[0].status, 'DEFERRED');
  assert.equal(entries[0].code, 'ECONNREFUSED');
  assert.equal(entries[0].attempts, 2);
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

test('a name that resolves to a private, link-local or metadata address is refused without connecting, and deferred because the next lookup may differ', async t => {
  const answers = {
    private: [{ address: '10.0.0.5', family: 4 }],
    metadata: [{ address: '169.254.169.254', family: 4 }],
    mappedLoopback: [{ address: '::ffff:127.0.0.1', family: 6 }],
    hexMappedMetadata: [{ address: '::ffff:a9fe:a9fe', family: 6 }],
    mixed: [{ address: '93.184.216.34', family: 4 }, { address: '192.168.1.10', family: 4 }],
    loopbackWithoutFlag: [{ address: '127.0.0.1', family: 4 }]
  };
  const connects = [];
  t.mock.method(net.Socket.prototype, 'connect', function spy(...args) { connects.push(args); throw new Error('SPY_NO_CONNECT'); });
  for (const [label, addresses] of Object.entries(answers)) {
    const dir = await tempDir();
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const lookups = [];
    const logs = [];
    const sleeps = [];
    const adapter = createWebhookAdapter({
      config: webhookConfigFromEnv({ WEBHOOK_URL: 'https://hook.example.test/in', WEBHOOK_ALLOWED_HOSTS: 'hook.example.test',
        WEBHOOK_SECRET: SECRET, PUBLIC_BASE_URL: BASE }),
      outboxDir: dir, log: line => logs.push(line), sleep: async ms => { sleeps.push(ms); },
      resolver: async host => { lookups.push(host); return addresses; }
    });
    const summary = await adapter.deliver([recordFor(reminder(9))]);
    assert.equal(summary.deferred, 1, label);
    assert.deepEqual(lookups, ['hook.example.test'], label);
    assert.deepEqual(sleeps, [], `${label}: no point retrying a refused answer within the same run`);
    const [entry] = await ledgerLines(dir);
    assert.equal(entry.status, 'DEFERRED', label);
    assert.equal(entry.code, 'TARGET_ADDRESS_REFUSED', label);
    assert.equal(entry.attempts, 1, label);
    assert.ok(logs.every(line => line.startsWith('ERROR webhook ')), label);
  }
  assert.equal(connects.length, 0);
});

test('an address LITERAL that the policy refuses is a permanent FAILED: the answer cannot change', async t => {
  const connects = [];
  t.mock.method(net.Socket.prototype, 'connect', function spy(...args) { connects.push(args); throw new Error('SPY_NO_CONNECT'); });
  const dir = await tempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  // Built by hand: webhookConfigFromEnv would refuse this URL at startup (see the configuration test).
  const config = webhookConfigFromEnv({ WEBHOOK_URL: 'https://hook.example.test/in', WEBHOOK_ALLOWED_HOSTS: 'hook.example.test',
    WEBHOOK_SECRET: SECRET, PUBLIC_BASE_URL: BASE });
  const literal = Object.create(config, { url: { value: 'https://10.0.0.1/in' }, enabled: { value: true }, secret: { value: config.secret } });
  const adapter = createWebhookAdapter({ config: literal, outboxDir: dir, log: () => {}, sleep: async () => {} });
  const summary = await adapter.deliver([recordFor(reminder(9))]);
  assert.equal(summary.failed, 1);
  const [entry] = await ledgerLines(dir);
  assert.deepEqual([entry.status, entry.code, entry.attempts], ['FAILED', 'TARGET_ADDRESS_REFUSED', 1]);
  assert.equal(connects.length, 0);
});

test('a name that cannot be resolved is retried within the run and then DEFERRED as DNS_FAILED', async t => {
  const dir = await tempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const adapter = createWebhookAdapter({
    config: webhookConfigFromEnv({ WEBHOOK_URL: 'https://hook.example.test/in', WEBHOOK_ALLOWED_HOSTS: 'hook.example.test',
      WEBHOOK_SECRET: SECRET, PUBLIC_BASE_URL: BASE, WEBHOOK_MAX_ATTEMPTS: '2' }),
    outboxDir: dir, log: () => {}, sleep: async () => {}, resolver: async () => { throw new Error('ENOTFOUND'); }
  });
  await adapter.deliver([recordFor(reminder(9))]);
  const [entry] = await ledgerLines(dir);
  assert.equal(entry.status, 'DEFERRED');
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
  assert.deepEqual(await adapter.deliver([record]), { sent: 0, failed: 0, deferred: 0, skipped: 1, invalid: 0 });
  assert.equal(target.hits.length, 1);
});

test('a restart (new adapter, same ledger) does not send again, and only new notices go out', async t => {
  const target = await receiver(t, reply(200));
  const first = await harness(t, target.url);
  const a = recordFor(reminder(9));
  const b = recordFor(reminder(10));
  await first.adapter.deliver([a]);
  const second = await harness(t, target.url, { dir: first.dir });
  assert.deepEqual(await second.adapter.deliver([a, b]), { sent: 1, failed: 0, deferred: 0, skipped: 1, invalid: 0 });
  assert.deepEqual(target.hits.map(hit => hit.headers['x-enclave-notice-id']), [a.noticeId, b.noticeId]);
});

test('sendPending reads the real outbox file, repeated exports never resend, and a damaged line is skipped', async t => {
  const target = await receiver(t, reply(200));
  const { adapter, dir, logs } = await harness(t, target.url);
  const tasks = [fixtureTask(firstNotice())];
  await exportNotices(tasks, dir);
  assert.equal((await adapter.sendPending()).sent, 1);
  await exportNotices(tasks, dir);
  assert.deepEqual(await adapter.sendPending(), { sent: 0, failed: 0, deferred: 0, skipped: 1, invalid: 0 });
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
  assert.deepEqual(await empty.adapter.sendPending(), { sent: 0, failed: 0, deferred: 0, skipped: 0, invalid: 0 });
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
  assert.deepEqual([...(await ledger.load()).keys()], ['b'.repeat(64)]);
  await ledger.append({ noticeId: id, status: 'FAILED' });
  assert.deepEqual([...(await ledger.load()).keys()].sort(), [id, 'b'.repeat(64)]);
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
  assert.equal(summary.deferred, 1);
  assert.equal(hits.length, 1);
});

test('https: NODE_TLS_REJECT_UNAUTHORIZED=0 in the environment does not switch certificate verification off', async t => {
  const dir = await tempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  try {
    await run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'),
      '-days', '1', '-subj', '/CN=other.example.test', '-addext', 'subjectAltName=DNS:other.example.test']);
  } catch { t.skip('openssl with -addext is not available'); return; }
  const key = await fs.readFile(path.join(dir, 'k.pem'));
  const cert = await fs.readFile(path.join(dir, 'c.pem'));
  const hits = [];
  const server = https.createServer({ key, cert }, (req, res) => { hits.push(req.headers); req.resume(); res.end('ok'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const { port } = server.address();
  const env = { WEBHOOK_URL: `https://hook.example.test:${port}/in`, WEBHOOK_ALLOWED_HOSTS: 'hook.example.test', WEBHOOK_SECRET: SECRET,
    PUBLIC_BASE_URL: BASE, WEBHOOK_ALLOW_LOOPBACK: 'true', WEBHOOK_MAX_ATTEMPTS: '1' };
  const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  try {
    // Self-signed, issued for another name, and not trusted: it must be refused with verification "off" in the environment.
    const adapter = createWebhookAdapter({ config: webhookConfigFromEnv(env), outboxDir: dir, log: () => {},
      resolver: async () => [{ address: '127.0.0.1', family: 4 }] });
    const summary = await adapter.deliver([recordFor(reminder(9))]);
    assert.equal(summary.sent, 0);
    assert.equal(hits.length, 0, 'nothing was delivered over an unverified connection');
    const [entry] = await ledgerLines(dir);
    assert.notEqual(entry.status, 'SENT');
    assert.match(entry.code, /CERT|SELF_SIGNED|ALTNAME|VERIFY/);
  } finally {
    if (previous === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED; else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous;
  }
});

// ---- the first status line decides ------------------------------------------------------------

// A receiver that speaks raw HTTP, so it can answer and then misbehave.
async function rawReceiver(t, onRequest) {
  const seen = { requests: 0, closed: 0 };
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => { sockets.delete(socket); seen.closed += 1; });
    let buffer = '';
    let answered = false;
    socket.on('data', chunk => {
      buffer += chunk.toString('latin1');
      const split = buffer.indexOf('\r\n\r\n');
      if (answered || split < 0) return;
      const length = Number(/content-length: (\d+)/i.exec(buffer)?.[1] ?? 0);
      if (buffer.length - split - 4 < length) return;
      answered = true;
      seen.requests += 1;
      onRequest(socket);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { for (const socket of sockets) socket.destroy(); server.close(resolve); }));
  return { seen, url: `http://127.0.0.1:${server.address().port}/hook` };
}

test('a 2xx status line is SENT even if the body hangs, and the socket is closed rather than waited on', async t => {
  const target = await rawReceiver(t, socket => socket.write('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n'));
  const { adapter, dir } = await harness(t, target.url, { env: { WEBHOOK_TIMEOUT_MS: '200', WEBHOOK_MAX_ATTEMPTS: '5' } });
  const started = Date.now();
  assert.equal((await adapter.deliver([recordFor(reminder(9))])).sent, 1);
  assert.ok(Date.now() - started < 150, 'did not wait for the body or the timer');
  assert.equal(target.seen.requests, 1, 'no retry of a delivery the receiver acknowledged');
  const [entry] = await ledgerLines(dir);
  assert.deepEqual([entry.status, entry.code, entry.attempts, entry.sendsWebhook], ['SENT', 'OK', 1, true]);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(target.seen.closed, 1, 'the connection was destroyed');
});

test('a 2xx status line followed by a reset connection is still SENT', async t => {
  const target = await rawReceiver(t, socket => {
    socket.write('HTTP/1.1 204 No Content\r\nConnection: keep-alive\r\n\r\n');
    setTimeout(() => socket.resetAndDestroy?.() ?? socket.destroy(), 5);
  });
  const { adapter, dir } = await harness(t, target.url, { env: { WEBHOOK_MAX_ATTEMPTS: '5' } });
  assert.equal((await adapter.deliver([recordFor(reminder(9))])).sent, 1);
  assert.equal(target.seen.requests, 1);
  assert.equal((await ledgerLines(dir))[0].status, 'SENT');
});

test('a non-2xx status line is not turned into TIMEOUT by a hanging body', async t => {
  const target = await rawReceiver(t, socket => socket.write('HTTP/1.1 503 Service Unavailable\r\nTransfer-Encoding: chunked\r\n\r\n'));
  const { adapter, dir } = await harness(t, target.url, { env: { WEBHOOK_TIMEOUT_MS: '200', WEBHOOK_MAX_ATTEMPTS: '1' } });
  assert.equal((await adapter.deliver([recordFor(reminder(9))])).deferred, 1);
  assert.equal((await ledgerLines(dir))[0].code, 'HTTP_503');
});

// ---- name resolution is bounded -----------------------------------------------------------------

test('a resolver that never answers is cut off at the attempt timeout and does not hold the queue', async t => {
  const dir = await tempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const adapter = createWebhookAdapter({
    config: webhookConfigFromEnv({ WEBHOOK_URL: 'https://hook.example.test/in', WEBHOOK_ALLOWED_HOSTS: 'hook.example.test',
      WEBHOOK_SECRET: SECRET, PUBLIC_BASE_URL: BASE, WEBHOOK_TIMEOUT_MS: '150', WEBHOOK_MAX_ATTEMPTS: '1' }),
    outboxDir: dir, log: () => {}, sleep: async () => {}, resolver: () => new Promise(() => {})
  });
  const guard = (promise, label) => Promise.race([promise, new Promise((resolve, reject) => setTimeout(() => reject(new Error(`${label} is stuck`)), 3000))]);
  const started = Date.now();
  const first = await guard(adapter.deliver([recordFor(reminder(9))]), 'first deliver');
  assert.equal(first.deferred, 1);
  assert.ok(Date.now() - started < 2000);
  // The next call is not queued behind a stuck lookup (the first notice is deferred, so this one is the one tried).
  const second = await guard(adapter.deliver([recordFor(reminder(9)), recordFor(reminder(10))]), 'second deliver');
  assert.equal(second.deferred, 1);
  const entries = await ledgerLines(dir);
  assert.deepEqual(entries.map(entry => [entry.status, entry.code]), [['DEFERRED', 'DNS_TIMEOUT'], ['DEFERRED', 'DNS_TIMEOUT']]);
});

// ---- the serial queue is keyed by the real directory ------------------------------------------

test('two spellings of one ledger directory (a symlinked parent) share one queue, so a notice is sent once', async t => {
  const base = await tempDir();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.mkdir(path.join(base, 'real'));
  await fs.symlink(path.join(base, 'real'), path.join(base, 'link'));
  const target = await receiver(t, (hit, req, res) => { setTimeout(() => { res.statusCode = 200; res.end(); }, 80); });
  const make = dir => createWebhookAdapter({ config: webhookConfigFromEnv(envFor(target.url)), outboxDir: dir, log: () => {}, sleep: async () => {} });
  const record = recordFor(reminder(9));
  const a = make(path.join(base, 'real', 'outbox'));
  const b = make(path.join(base, 'link', 'outbox'));
  const [x, y] = await Promise.all([a.deliver([record]), b.deliver([record])]);
  assert.equal(target.hits.length, 1);
  assert.equal(x.sent + y.sent, 1);
  assert.equal(x.skipped + y.skipped, 1);
});

// ---- close() ------------------------------------------------------------------------------------

test('close() aborts an in-flight request, records nothing for it, and makes kick() a no-op', async t => {
  const target = await receiver(t, () => {});
  const { adapter, dir } = await harness(t, target.url, { env: { WEBHOOK_TIMEOUT_MS: '30000' } });
  const running = adapter.deliver([recordFor(reminder(9))]);
  while (!target.hits.length) await new Promise(resolve => setTimeout(resolve, 5));
  const started = Date.now();
  await adapter.close();
  assert.ok(Date.now() - started < 1000);
  assert.deepEqual(await running, { sent: 0, failed: 0, deferred: 0, skipped: 0, invalid: 0 });
  assert.deepEqual(await ledgerLines(dir), []);
  assert.deepEqual(await adapter.kick(), { sent: 0, failed: 0, deferred: 0, skipped: 0, invalid: 0 });
  assert.deepEqual(await adapter.deliver([recordFor(reminder(10))]), { sent: 0, failed: 0, deferred: 0, skipped: 0, invalid: 0 });
  assert.equal(target.hits.length, 1);
  await adapter.close();
});

test('close() ends a backoff sleep and a lookup that is waiting, and writes nothing', async t => {
  const target = await receiver(t, reply(503));
  const { adapter, dir } = await harness(t, target.url, { sleep: () => new Promise(() => {}), env: { WEBHOOK_MAX_ATTEMPTS: '3' } });
  const running = adapter.deliver([recordFor(reminder(9))]);
  while (!target.hits.length) await new Promise(resolve => setTimeout(resolve, 5));
  await new Promise(resolve => setTimeout(resolve, 30));
  await Promise.race([adapter.close(), new Promise((resolve, reject) => setTimeout(() => reject(new Error('close() is stuck')), 2000))]);
  assert.equal((await running).deferred, 0);
  assert.deepEqual(await ledgerLines(dir), []);
  assert.equal(target.hits.length, 1);

  const hung = await harness(t, 'http://127.0.0.1:9/h', { resolver: () => new Promise(() => {}), env: { WEBHOOK_TIMEOUT_MS: '30000' } });
  const config = webhookConfigFromEnv({ WEBHOOK_URL: 'https://hook.example.test/in', WEBHOOK_ALLOWED_HOSTS: 'hook.example.test',
    WEBHOOK_SECRET: SECRET, PUBLIC_BASE_URL: BASE, WEBHOOK_TIMEOUT_MS: '60000' });
  const lookup = createWebhookAdapter({ config, outboxDir: hung.dir, log: () => {}, resolver: () => new Promise(() => {}) });
  const waiting = lookup.deliver([recordFor(reminder(9))]);
  await new Promise(resolve => setTimeout(resolve, 30));
  await lookup.close();
  assert.equal((await waiting).deferred, 0);
  assert.deepEqual(await ledgerLines(hung.dir), []);
});

test('a pending retry never keeps the process alive: the backoff timer is unref-ed', async t => {
  const dir = await tempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const probe = http.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise(resolve => probe.close(resolve));
  const root = new URL('../', import.meta.url).href;
  const script = `
    import { createWebhookAdapter, webhookConfigFromEnv } from ${JSON.stringify(root + 'webhook-adapter.js')};
    import { noticeRecord } from ${JSON.stringify(root + 'notice-outbox.js')};
    const notice = { kind: 'LOCAL_DRY_RUN', subjectCode: 'SEALED_DOCUMENT_REMINDER', taskAlias: ${JSON.stringify(ALIAS)}, version: 1,
      targets: ['A1'], preparedAt: '2026-10-09T01:02:03.000Z', sendsEmail: false };
    const record = noticeRecord({ snapshots: [] }, { version: 1 }, notice);
    const config = webhookConfigFromEnv({ WEBHOOK_URL: 'http://127.0.0.1:${port}/h', WEBHOOK_ALLOWED_HOSTS: '127.0.0.1',
      WEBHOOK_SECRET: ${JSON.stringify(SECRET)}, PUBLIC_BASE_URL: ${JSON.stringify(BASE)}, WEBHOOK_ALLOW_LOOPBACK: 'true', WEBHOOK_MAX_ATTEMPTS: '4' });
    const adapter = createWebhookAdapter({ config, outboxDir: ${JSON.stringify(dir)}, random: () => 1, log: line => console.log(line) });
    void adapter.deliver([record]);
  `;
  const started = Date.now();
  const { stdout } = await run(process.execPath, ['--input-type=module', '-e', script], { timeout: 20_000 });
  assert.ok(Date.now() - started < 3000, 'the process exited while a 1 s, 2 s, 4 s backoff was pending');
  assert.match(stdout, /retry notice=/);
  assert.ok(!stdout.includes('deferred notice='), 'the run did not carry on to the end');
});

// ---- file tricks -----------------------------------------------------------------------------------

test('a FIFO planted as the outbox file cannot hang kick()', { skip: !posix }, async t => {
  const dir = await tempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  try { await run('mkfifo', [path.join(dir, 'notices.jsonl')]); } catch { t.skip('mkfifo is not available'); return; }
  const target = await receiver(t, reply(200));
  const { adapter, logs } = await harness(t, target.url, { dir });
  const result = await Promise.race([adapter.kick(), new Promise(resolve => setTimeout(() => resolve('HUNG'), 3000))]);
  assert.notEqual(result, 'HUNG');
  assert.equal(result.error, true);
  assert.ok(logs.some(line => line.startsWith('ERROR webhook outbox unreadable: OUTBOX_NOT_A_FILE')));
  assert.equal(target.hits.length, 0);
});

test('a symlinked ledger directory is refused, not followed, and the directory behind it is not chmod-ed', { skip: !posix }, async t => {
  const base = await tempDir();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const real = path.join(base, 'elsewhere');
  await fs.mkdir(real, { mode: 0o755 });
  await fs.chmod(real, 0o755);
  const link = path.join(base, 'ledger');
  await fs.symlink(real, link);
  const target = await receiver(t, reply(200));
  const logs = [];
  const adapter = createWebhookAdapter({ config: webhookConfigFromEnv(envFor(target.url)), outboxDir: base, ledgerDir: link,
    log: line => logs.push(line), sleep: async () => {} });
  await assert.rejects(adapter.deliver([recordFor(reminder(9))]), /WEBHOOK_LEDGER_UNAVAILABLE/);
  assert.ok(logs.some(line => line === 'ERROR webhook ledger unavailable: LEDGER_DIR_IS_SYMLINK'));
  assert.equal((await fs.stat(real)).mode & 0o777, 0o755);
  assert.deepEqual(await fs.readdir(real), []);
  assert.equal(target.hits.length, 0);
});

test('the off adapter has a close() that does nothing', async () => {
  const off = createWebhookFromEnv({}, { outboxDir: '/nonexistent-never-touched' });
  await off.close();
});
