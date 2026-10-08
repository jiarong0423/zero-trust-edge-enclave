import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { packetCommitment } from '../public/file-envelope.js';
import { openLocalKeyVault } from '../local-key-vault.js';

const root = path.resolve(import.meta.dirname, '..');
const smoke = path.join(root, 'scripts', 'hosted-smoke.mjs');
const baseEnv = dir => ({ PATH: process.env.PATH, HOME: dir, SKIP_LOCAL_ENV: 'true', DATA_DIR: dir, PORT: '0',
  COORDINATOR_PROVIDER: 'synthetic_fixture', NEBIUS_API_KEY: 'unused-test-placeholder', NEBIUS_BASE_URL: 'disabled-protocol://no-network' });

async function run(command, args, env, cwd = root) {
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const [code] = await once(child, 'exit');
  return { code, stdout, stderr, all: stdout + stderr };
}

const runSmoke = env => run(process.execPath, [smoke], { PATH: process.env.PATH, ...env });

async function businessRegistry(prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await fs.chmod(dir, 0o700);
  const setup = await run(process.execPath, ['scripts/setup-local.mjs', dir, '--business'], baseEnv(dir));
  assert.equal(setup.code, 0, setup.all);
  const tokens = {};
  for (const id of ['manager-sender', 'sales-a', 'sales-b']) tokens[id] = (await fs.readFile(path.join(dir, `${id}.token`), 'utf8')).trim();
  return { dir, tokens };
}

async function startServer(dir) {
  const server = spawn(process.execPath, ['server.js'], { cwd: root, env: baseEnv(dir), stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = '';
  server.stderr.on('data', chunk => { errors += chunk; });
  const base = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Server startup timeout')), 8000);
    server.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
    server.once('exit', () => { clearTimeout(timer); reject(new Error(`Server exited: ${errors}`)); });
  });
  const stop = async () => { if (server.exitCode === null) { server.kill(); await once(server, 'exit'); } };
  return { base, stop };
}

// A listener that only counts connections: a refused configuration must never reach it.
async function connectionCounter() {
  let connections = 0;
  const server = net.createServer(socket => { connections += 1; socket.destroy(); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { port: server.address().port, count: () => connections, close: () => new Promise(resolve => server.close(resolve)) };
}

async function privateTokenDir(prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await fs.chmod(dir, 0o700);
  for (const id of ['manager-sender', 'sales-a', 'sales-b']) {
    await fs.writeFile(path.join(dir, `${id}.token`), `${id.replace(/[^a-z]/g, '').padEnd(8, 'x')}${'A'.repeat(35)}`, { mode: 0o600 });
  }
  return dir;
}

test('refuses to start, with exit 2 and no request, on a bad configuration', async t => {
  const counter = await connectionCounter();
  const good = await privateTokenDir('smoke-good-');
  const loose = await privateTokenDir('smoke-loose-');
  const looseFile = await privateTokenDir('smoke-loosefile-');
  t.after(async () => {
    await counter.close();
    for (const dir of [good, loose, looseFile]) await fs.rm(dir, { recursive: true, force: true });
  });
  await fs.chmod(loose, 0o755);
  await fs.chmod(path.join(looseFile, 'sales-a.token'), 0o644);
  const local = `http://127.0.0.1:${counter.port}`;
  const cases = [
    ['missing base url', { SMOKE_TOKEN_DIR: good }],
    ['invalid base url', { SMOKE_BASE_URL: 'not a url', SMOKE_TOKEN_DIR: good }],
    ['non-loopback http (hostname)', { SMOKE_BASE_URL: `http://localhost:${counter.port}`, SMOKE_TOKEN_DIR: good }],
    ['non-loopback http (remote)', { SMOKE_BASE_URL: 'http://example.com', SMOKE_TOKEN_DIR: good }],
    ['base url with a path', { SMOKE_BASE_URL: `${local}/api`, SMOKE_TOKEN_DIR: good }],
    ['missing token directory', { SMOKE_BASE_URL: local }],
    ['group-readable token directory', { SMOKE_BASE_URL: local, SMOKE_TOKEN_DIR: loose }],
    ['group-readable token file', { SMOKE_BASE_URL: local, SMOKE_TOKEN_DIR: looseFile }],
    ['gate user without password', { SMOKE_BASE_URL: local, SMOKE_TOKEN_DIR: good, SMOKE_GATE_USER: 'judge' }],
    ['gate password without user', { SMOKE_BASE_URL: local, SMOKE_TOKEN_DIR: good, SMOKE_GATE_PASSWORD: 'unit-test-password' }],
    ['unknown provider expectation', { SMOKE_BASE_URL: local, SMOKE_TOKEN_DIR: good, SMOKE_EXPECT_PROVIDER: 'other' }]
  ];
  if (process.platform === 'win32') cases.splice(6, 2);
  for (const [name, env] of cases) {
    const result = await runSmoke(env);
    assert.equal(result.code, 2, `${name}: ${result.all}`);
    assert.match(result.stderr, /^CONFIG ERROR: /m, name);
    assert.ok(!/^(PASS|FAIL) /m.test(result.stdout), `${name}: no step may run`);
    assert.ok(!result.all.includes('unit-test-password'), name);
  }
  const argument = await run(process.execPath, [smoke, 'sales-a'], { PATH: process.env.PATH, SMOKE_BASE_URL: local, SMOKE_TOKEN_DIR: good });
  assert.equal(argument.code, 2);
  assert.equal(counter.count(), 0, 'a refused configuration must not open a single connection');
});

test('happy path and provider mismatch against a local business registry', async t => {
  const { dir, tokens } = await businessRegistry('smoke-registry-');
  const server = await startServer(dir);
  t.after(async () => { await server.stop(); await fs.rm(dir, { recursive: true, force: true }); });
  const env = { SMOKE_BASE_URL: server.base, SMOKE_TOKEN_DIR: dir, SMOKE_EXPECT_PROVIDER: 'synthetic_fixture' };

  const ok = await runSmoke(env);
  assert.equal(ok.code, 0, ok.all);
  for (const name of ['health', 'whoami-unauthenticated', 'whoami-identities', 'grant-select', 'stage-file-task', 'approve',
    'worker-prepared', 'evidence-provider', 'recipient-decrypt', 'non-recipient-denied', 'revoke']) {
    assert.match(ok.stdout, new RegExp(`^PASS ${name}\\b`, 'm'), `${name}\n${ok.all}`);
  }
  assert.ok(!/^FAIL /m.test(ok.stdout), ok.all);
  assert.match(ok.stdout, /routing advice answered by synthetic_fixture/);
  assert.match(ok.stdout, /grant procurement/);
  assert.match(ok.stdout, /^SUMMARY PASS .*failed=0 .*task_revoked=yes$/m);

  // The same server, now with an expectation it cannot meet: exit 1 and a FAIL line.
  const mismatch = await runSmoke({ ...env, SMOKE_EXPECT_PROVIDER: 'nebius_token_factory' });
  assert.equal(mismatch.code, 1, mismatch.all);
  assert.match(mismatch.stdout, /^FAIL health: .*demoFallbackEnabled is true/m);
  assert.match(mismatch.stdout, /^FAIL evidence-provider: provider mismatch: expected nebius_token_factory/m);
  assert.match(mismatch.stdout, /^SUMMARY FAIL /m);
  assert.match(mismatch.stdout, /task_revoked=yes/);

  // Recover the secrets from the server's own state, after it has stopped.
  await server.stop();
  const stored = JSON.parse(await fs.readFile(path.join(dir, 'tasks.json'), 'utf8')).filter(task => task.file);
  assert.equal(stored.length, 2, 'one task per run, nothing else staged');
  for (const task of stored) {
    assert.ok(task.snapshots.every(snapshot => snapshot.revokedAt), 'every smoke task is revoked at the end');
    const vault = await openLocalKeyVault(path.join(await fs.realpath(dir), 'private-keys'));
    const key = vault.unwrap(task.file.wrappedKey, { taskId: task.id, version: task.file.keyVersion,
      commitment: await packetCommitment(task.file.packet) });
    vault.close();
    const secrets = [...Object.values(tokens), 'SMOKE_TEST_SYNTHETIC', task.file.packet.ciphertext, task.file.packet.iv,
      key.toString('hex'), key.toString('base64')];
    key.fill(0);
    for (const output of [ok.all, mismatch.all]) {
      for (const secret of secrets) assert.ok(!output.includes(secret), 'a secret appeared in the smoke output');
    }
  }
});

test('a wrong sign-in value is never echoed and a stopped server fails cleanly', async t => {
  const { dir } = await businessRegistry('smoke-offline-');
  const counter = await connectionCounter();
  t.after(async () => { await counter.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const result = await runSmoke({ SMOKE_BASE_URL: `http://127.0.0.1:${counter.port}`, SMOKE_TOKEN_DIR: dir,
    SMOKE_GATE_USER: 'judge', SMOKE_GATE_PASSWORD: 'unit-test-password-value' });
  assert.equal(result.code, 1, result.all);
  assert.match(result.stdout, /^FAIL health: /m);
  assert.match(result.stdout, /^FAIL judge-signin: /m);
  assert.match(result.stdout, /task_revoked=n\/a/);
  assert.ok(!result.all.includes('unit-test-password-value'));
});
