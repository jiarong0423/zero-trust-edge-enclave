// Tests for scripts/verify-audit-chain.mjs.
// The chain under test is produced by the project's own code path: a real server.js started on
// PORT=0 against a temporary DATA_DIR (synthetic identities, no network), whose appendAudit writes
// previousHash/eventHash. Archive rotation uses the project's own retainAuditWindow.
//
// Limitations proven here rather than hidden: truncating the tail verifies as OK (only the head
// hash changes), and a writer who recomputes every later hash produces a chain that verifies.
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { validateAccess } from '../access-control.js';
import { retainAuditWindow } from '../audit-retention.js';
import { verifyChain, verifyPath, main, ChainError } from './verify-audit-chain.mjs';

const root = path.resolve(import.meta.dirname, '..');
const script = path.join(import.meta.dirname, 'verify-audit-chain.mjs');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const clone = value => structuredClone(value);

// Mirror of server.js hashJson over the stored key order, used only to model an informed attacker.
function rehash(records) {
  let previous = records[0].previousHash;
  for (const record of records) {
    record.previousHash = previous;
    delete record.eventHash;
    record.eventHash = sha(JSON.stringify(record));
    previous = record.eventHash;
  }
  return records;
}

async function realChain() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'audit-chain-test-'));
  await fs.chmod(dir, 0o700);
  const tokens = {};
  const principals = [['operator', 'operator', 'sender'], ['recipient-a', 'recipient', 'cfo'],
    ['recipient-b', 'recipient', 'employee'], ['coordinator', 'coordinator', 'coordinator']].map(([id, kind, role]) => {
    tokens[id] = crypto.randomBytes(32).toString('base64url');
    return { id, kind, role, tokenHash: sha(tokens[id]) };
  });
  const expiresAt = new Date(Date.now() + 86400000).toISOString();
  const access = validateAccess({ principals, grants: [{ id: 'local-review', version: 1, operatorId: 'operator',
    coordinatorId: 'coordinator', recipients: ['recipient-a'], channels: ['email'], expiresAt, maxAttempts: 3,
    maxOpens: 2, simulatedOutcomes: ['prepared'] }] });
  await fs.writeFile(path.join(dir, 'access.json'), JSON.stringify(access, null, 2), { mode: 0o600 });
  const env = { PATH: process.env.PATH, HOME: dir, SKIP_LOCAL_ENV: 'true', DATA_DIR: dir, PORT: '0',
    COORDINATOR_PROVIDER: 'synthetic_fixture', NEBIUS_API_KEY: 'unused-test-placeholder', NEBIUS_BASE_URL: 'disabled-protocol://no-network' };
  const server = spawn(process.execPath, ['server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = '';
  server.stderr.on('data', chunk => { errors += chunk; });
  try {
    const base = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Server startup timeout')), 8000);
      let output = '';
      server.stdout.on('data', chunk => {
        output += chunk;
        const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/);
        if (match) { clearTimeout(timer); resolve(match[0]); }
      });
      server.once('exit', () => { clearTimeout(timer); reject(new Error('Server exited: ' + errors)); });
    });
    const request = async (url, body, id = 'operator') => {
      const response = await fetch(base + url, { method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens[id]}` },
        body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    };
    const content = { documentHash: 'a'.repeat(64), recipients: ['recipient-a'], channels: ['email'], expiresAt };
    const draft = await request('/api/tasks', { authorizationId: 'local-review', content });
    assert.equal(draft.status, 201);
    const taskUrl = `/api/tasks/${draft.body.task.id}`;
    assert.equal((await request(taskUrl + '/confirm-first', { version: 1 })).status, 200);
    assert.equal((await request(taskUrl + '/invalidate', { version: 1 })).status, 200);
    for (let index = 0; index < 6; index += 1) assert.equal((await request(taskUrl + '/revoke', { version: 9 }, 'recipient-b')).status, 403);
  } finally {
    if (server.exitCode === null) { server.kill(); await once(server, 'exit'); }
  }
  const records = JSON.parse(await fs.readFile(path.join(dir, 'audit.json'), 'utf8'));
  return { dir, records };
}

let fixture;
test.before(async () => { fixture = await realChain(); });
test.after(async () => { if (fixture) await fs.rm(fixture.dir, { recursive: true, force: true }); });

const brokenAt = (records, index, pattern) => {
  assert.throws(() => verifyChain(clone(records)), error => {
    assert.ok(error instanceof ChainError);
    assert.equal(error.index, index);
    assert.match(error.reason, pattern);
    return true;
  });
};

test('the real server really writes a chain: first previousHash null, every link and hash verifies', () => {
  const { records } = fixture;
  assert.ok(records.length >= 9);
  assert.equal(records[0].previousHash, null);
  for (let index = 1; index < records.length; index += 1) assert.equal(records[index].previousHash, records[index - 1].eventHash);
  const result = verifyChain(clone(records));
  assert.deepEqual(result, { count: records.length, head: records.at(-1).eventHash });
});

test('detects an edited field', () => {
  const records = clone(fixture.records);
  records[3].result = records[3].result === 'DENY' ? 'ALLOW' : 'DENY';
  brokenAt(records, 3, /does not match its eventHash/);
});

test('detects an edited first record and an edited last record', () => {
  const first = clone(fixture.records);
  first[0].reasons = ['ACCESS_DENIED', 'REVOKED'];
  brokenAt(first, 0, /does not match its eventHash/);
  const last = clone(fixture.records);
  last.at(-1).createdAt = '2020-01-01T00:00:00.000Z';
  brokenAt(last, last.length - 1, /does not match its eventHash/);
});

test('detects a deleted middle record', () => {
  const records = clone(fixture.records);
  records.splice(4, 1);
  brokenAt(records, 4, /does not match the preceding record/);
});

test('detects reordered records', () => {
  const records = clone(fixture.records);
  [records[2], records[3]] = [records[3], records[2]];
  brokenAt(records, 2, /does not match the preceding record/);
});

test('detects an inserted forged record, with or without a valid self-hash', () => {
  const crude = clone(fixture.records);
  crude.splice(3, 0, { ...clone(crude[2]), type: 'PACKAGE_REVOKED', id: crypto.randomUUID() });
  brokenAt(crude, 3, /does not match its eventHash/);

  const careful = clone(fixture.records);
  const forged = { ...clone(careful[2]), id: crypto.randomUUID(), previousHash: careful[2].eventHash };
  delete forged.eventHash;
  forged.eventHash = sha(JSON.stringify(forged));
  careful.splice(3, 0, forged);
  // The forged record is internally valid; the record after it still points at the old predecessor.
  brokenAt(careful, 4, /does not match the preceding record/);
});

test('rejects legacy or stripped records and malformed hashes', () => {
  const stripped = clone(fixture.records);
  delete stripped[5].eventHash;
  brokenAt(stripped, 5, /missing or malformed eventHash/);
  const bad = clone(fixture.records);
  bad[1].previousHash = 'zz';
  brokenAt(bad, 1, /missing or malformed previousHash/);
  const notObject = clone(fixture.records);
  notObject[2] = 'x';
  brokenAt(notObject, 2, /not an object/);
});

test('LIMITATION: truncating the tail is NOT detected; only the head hash changes', () => {
  const { records } = fixture;
  const cut = clone(records).slice(0, -3);
  const result = verifyChain(cut);
  assert.equal(result.count, records.length - 3);
  assert.notEqual(result.head, records.at(-1).eventHash);
  assert.equal(result.head, records[records.length - 4].eventHash);
});

test('LIMITATION: an unkeyed chain recomputed end to end by a writer still verifies', () => {
  const records = clone(fixture.records);
  records[2].result = records[2].result === 'DENY' ? 'ALLOW' : 'DENY';
  rehash(records);
  const result = verifyChain(records);
  assert.equal(result.count, records.length);
  assert.notEqual(result.head, fixture.records.at(-1).eventHash);
});

test('retention rotation: archive pages link the live window back to genesis', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'audit-chain-rotate-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'audit.json');
  await fs.writeFile(file, '[]\n', { mode: 0o600 });
  const records = clone(fixture.records);
  await retainAuditWindow(file, records, { limit: 5, keep: 3 });
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).length, 3);
  const result = await verifyPath(dir);
  assert.deepEqual(result, { count: records.length, head: records.at(-1).eventHash });

  const pageDir = path.join(dir, 'audit-archive');
  const [name] = await fs.readdir(pageDir);
  // An edited archive page no longer matches its content-addressed name.
  const pagePath = path.join(pageDir, name);
  const original = await fs.readFile(pagePath);
  const page = JSON.parse(original);
  page[0].result = page[0].result === 'DENY' ? 'ALLOW' : 'DENY';
  await fs.writeFile(pagePath, JSON.stringify(page) + '\n');
  await assert.rejects(verifyPath(dir), error => error instanceof ChainError && /digest does not match/.test(error.reason));
  await fs.writeFile(pagePath, original);
  assert.equal((await verifyPath(dir)).count, records.length);

  // Removing the archive leaves a window whose predecessor cannot be found.
  await fs.rm(pageDir, { recursive: true });
  await assert.rejects(verifyPath(dir), error => error instanceof ChainError && /not found in audit-archive/.test(error.reason));
  // --window-only verifies the window alone and says so by counting only the window.
  const windowOnly = await verifyPath(dir, { windowOnly: true });
  assert.equal(windowOnly.count, 3);
  assert.equal(windowOnly.head, records.at(-1).eventHash);
});

test('CLI exit codes and output never carry event contents', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'audit-chain-cli-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const run = async args => {
    const child = spawn(process.execPath, [script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const [code] = await once(child, 'exit');
    return { code, stdout, stderr };
  };
  const good = path.join(dir, 'audit.json');
  await fs.writeFile(good, JSON.stringify(fixture.records));
  const ok = await run([dir]);
  assert.equal(ok.code, 0);
  assert.equal(ok.stdout.trim(), `OK ${fixture.records.length} records, head ${fixture.records.at(-1).eventHash.slice(0, 12)}`);
  assert.equal((await run([good])).code, 0);

  const tampered = clone(fixture.records);
  tampered[3].reasons = ['PRIVATE_CANARY'];
  tampered[3].type = 'private canary type';
  await fs.writeFile(good, JSON.stringify(tampered));
  const bad = await run([dir]);
  assert.equal(bad.code, 1);
  assert.match(bad.stdout, /^ERROR chain broken at record 3: /);
  assert.ok(!bad.stdout.includes('PRIVATE_CANARY') && !bad.stdout.includes('private canary'));
  assert.ok(!bad.stdout.includes(tampered[3].id));

  const typed = clone(fixture.records);
  typed[4].result = typed[4].result === 'DENY' ? 'ALLOW' : 'DENY';
  await fs.writeFile(good, JSON.stringify(typed));
  assert.match((await run([dir])).stdout.trim(), /^ERROR chain broken at record 4: .*\(type [A-Z_]+\)$/);

  assert.equal((await run([])).code, 2);
  assert.equal((await run([dir, dir])).code, 2);
  assert.equal((await run([path.join(dir, 'missing')])).code, 2);
  await fs.writeFile(good, '{not json');
  assert.equal((await run([dir])).code, 2);
  await fs.writeFile(good, '{}');
  assert.equal((await run([dir])).code, 2);
  await fs.writeFile(good, '[]');
  const empty = await run([dir]);
  assert.equal(empty.code, 0);
  assert.equal(empty.stdout.trim(), 'OK 0 records, head none');
  const lines = [];
  assert.equal(await main([dir], line => lines.push(line), () => {}), 0);
  assert.equal(lines.length, 1);
});

test('a wiped audit.json beside real archive pages is an error, not "OK 0 records"', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'audit-chain-wiped-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'audit.json');
  await fs.writeFile(file, '[]\n', { mode: 0o600 });
  await retainAuditWindow(file, clone(fixture.records), { limit: 5, keep: 3 });
  assert.ok((await fs.readdir(path.join(dir, 'audit-archive'))).length > 0);
  await fs.writeFile(file, '[]\n');
  await assert.rejects(verifyPath(dir), error => error instanceof ChainError && /empty but audit-archive pages exist/.test(error.reason));
  // A genuinely new, empty data directory is still fine, and --window-only is the explicit opt-out.
  const fresh = await fs.mkdtemp(path.join(os.tmpdir(), 'audit-chain-fresh-'));
  t.after(() => fs.rm(fresh, { recursive: true, force: true }));
  await fs.writeFile(path.join(fresh, 'audit.json'), '[]\n');
  assert.deepEqual(await verifyPath(fresh), { count: 0, head: null });
  assert.deepEqual(await verifyPath(dir, { windowOnly: true }), { count: 0, head: null });
});
