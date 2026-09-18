import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { validateAccess, authenticate, loadAccess } from '../access-control.js';
import { adminDirectory, changeDirectory } from '../directory-admin.js';
import { newTask, confirmFirst, confirmSecond, dispatchSnapshot } from '../snapshot-lifecycle.js';
import { saveRegistry } from '../registry-store.js';

function registry() {
  const tokens = {};
  const principals = [['admin', 'administrator', 'ops'], ['sender', 'operator', 'management'],
    ['recipient', 'recipient', 'sales'], ['coordinator', 'coordinator', 'ops']].map(([id, kind, department]) => {
    tokens[id] = crypto.randomBytes(32).toString('base64url');
    return { id, kind, department, tokenHash: crypto.createHash('sha256').update(tokens[id]).digest('hex') };
  });
  return { tokens, config: validateAccess({ schemaVersion: 2, revision: 1,
    departments: ['ops', 'management', 'sales', 'audit'].map(id => ({ id, displayName: id })), principals,
    grants: [{ id: 'grant', version: 1, operatorId: 'sender', coordinatorId: 'coordinator', recipients: ['recipient'],
      channels: ['email'], expiresAt: new Date(Date.now() + 60000).toISOString(), maxAttempts: 3, maxOpens: 2 }] }) };
}

test('admin mutations version affected grants without expanding frozen recipients or leaking hashes', () => {
  const { config } = registry();
  const admin = config.principals[0];
  const request = { expectedRevision: 1, operation: 'person.update', value: { id: 'recipient', department: 'audit' } };
  for (const actor of config.principals.slice(1)) {
    assert.throws(() => adminDirectory(config, actor), e => e.status === 403);
    assert.throws(() => changeDirectory(config, actor, request), e => e.status === 403);
  }
  assert.ok(!JSON.stringify(adminDirectory(config, admin)).includes('tokenHash'));
  const actor = config.principals[1], grant = config.grants[0];
  const draft = newTask(actor, grant, { documentHash: 'a'.repeat(64), recipients: ['recipient'], channels: ['email'], expiresAt: grant.expiresAt });
  const first = confirmFirst(draft, actor, grant, 1);
  const approved = confirmSecond(first.task, actor, grant, 1, first.token);
  const next = changeDirectory(config, admin, request).config;
  assert.equal(next.grants[0].version, 2);
  assert.deepEqual(next.grants[0].recipients, ['recipient']);
  assert.throws(() => dispatchSnapshot(approved, next.grants[0], 1));
  assert.throws(() => confirmSecond(first.task, actor, next.grants[0], 1, first.token));
  assert.equal(config.principals[2].department, 'sales');
  assert.throws(() => changeDirectory(next, admin, request), e => e.status === 409);
  const created = changeDirectory(config, admin, { expectedRevision: 1, operation: 'person.create',
    value: { id: 'new-person', kind: 'recipient', department: 'sales' } });
  assert.deepEqual(created.config.grants[0], grant);
  assert.equal(authenticate(created.config, 'Bearer ' + created.credential).id, 'new-person');
  assert.ok(!JSON.stringify(created.config.directoryEvents).includes('new-person'));
  assert.ok(!JSON.stringify(created.config).includes(created.credential));
  for (const value of [{ id: 'admin', disabled: true }, { id: 'recipient', kind: 'administrator' }, { id: 'recipient', department: 'missing' }]) {
    assert.throws(() => changeDirectory(config, admin, { ...request, value }));
  }
  assert.throws(() => changeDirectory(config, admin, { expectedRevision: 1, operation: 'department.update', value: { id: 'ops', disabled: true } }));
  const disabled = changeDirectory(config, admin, { expectedRevision: 1, operation: 'department.update', value: { id: 'sales', disabled: true } });
  assert.equal(disabled.config.grants[0].version, 2);
  const rotated = changeDirectory(config, admin, { expectedRevision: 1, operation: 'person.rotate', value: { id: 'recipient' } });
  assert.equal(rotated.config.grants[0].version, 2);
  assert.equal(authenticate(rotated.config, 'Bearer ' + rotated.credential).id, 'recipient');
  const changedGrant = changeDirectory(config, admin, { expectedRevision: 1, operation: 'grant.update', value: { id: 'grant', maxOpens: 1 } });
  assert.equal(changedGrant.config.grants[0].version, 2);
  assert.throws(() => dispatchSnapshot(approved, changedGrant.config.grants[0], 1));
});

test('explicit business setup supplies departmental grants and separate admin without overwriting credentials', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'enclave-business-setup-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const setup = () => spawn(process.execPath, ['scripts/setup-local.mjs', dir, '--business'], {
    cwd: path.resolve(import.meta.dirname, '..'), stdio: 'ignore' });
  assert.equal((await once(setup(), 'exit'))[0], 0);
  const config = await loadAccess(path.join(dir, 'access.json'));
  assert.equal(config.schemaVersion, 2);
  assert.equal(config.principals.length, 8);
  assert.equal(config.principals.find(person => person.id === 'admin').kind, 'administrator');
  assert.deepEqual(config.grants.find(grant => grant.id === 'procurement').recipients, ['sales-a', 'sales-b']);
  assert.deepEqual(config.grants.find(grant => grant.id === 'audit').recipients, ['auditor-a']);
  const before = await fs.readFile(path.join(dir, 'access.json'));
  assert.notEqual((await once(setup(), 'exit'))[0], 0);
  assert.deepEqual(await fs.readFile(path.join(dir, 'access.json')), before);
});

test('registry store uses expected revisions and leaves prior bytes unchanged on rejection', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'enclave-admin-store-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'access.json');
  const { config } = registry();
  await fs.writeFile(file, JSON.stringify(config), { mode: 0o600 });
  const next = changeDirectory(config, config.principals[0], { expectedRevision: 1, operation: 'department.create',
    value: { id: 'legal', displayName: 'Legal' } }).config;
  await saveRegistry(file, next, 1);
  const bytes = await fs.readFile(file);
  await assert.rejects(saveRegistry(file, next, 1), e => e.status === 409);
  assert.deepEqual(await fs.readFile(file), bytes);
});

test('isolated admin HTTP API enforces privilege separation and concurrent revision conflict', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'enclave-admin-http-'));
  const { config, tokens } = registry();
  await fs.writeFile(path.join(dir, 'access.json'), JSON.stringify(config), { mode: 0o600 });
  const child = spawn(process.execPath, ['server.js'], { cwd: path.resolve(import.meta.dirname, '..'),
    env: { PATH: process.env.PATH, HOME: dir, DATA_DIR: dir, SKIP_LOCAL_ENV: 'true', LOCAL_ONLY: 'true', PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { if (child.exitCode === null) { child.kill(); await once(child, 'exit'); } await fs.rm(dir, { recursive: true, force: true }); });
  const base = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('TEST_SERVER_TIMEOUT')), 10000);
    child.stdout.on('data', chunk => { output += chunk; const match = output.match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timer); resolve(match[0]); } });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('TEST_SERVER_EXITED')); });
  });
  const request = async (id, body, route = '/api/admin/directory') => {
    const response = await fetch(base + route, { method: body ? 'POST' : 'GET',
      headers: { authorization: 'Bearer ' + tokens[id], 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  };
  for (const id of ['sender', 'recipient', 'coordinator']) assert.equal((await request(id)).status, 403);
  assert.equal((await request('admin', undefined, '/api/authorizations')).status, 403);
  assert.equal((await request('admin')).status, 200);
  const tasksBefore = await fs.readFile(path.join(dir, 'tasks.json'));
  const retention = await request('admin', undefined, '/api/admin/retention');
  assert.equal(retention.status, 200);
  assert.equal(retention.body.automaticDeletion, false);
  assert.deepEqual(await fs.readFile(path.join(dir, 'tasks.json')), tasksBefore);
  assert.equal((await request('sender', undefined, '/api/admin/retention')).status, 403);
  assert.equal((await request('admin', {}, '/api/admin/retention')).status, 405);
  const mutation = { expectedRevision: 1, operation: 'person.update', value: { id: 'recipient', department: 'audit' } };
  const results = await Promise.all([request('admin', mutation), request('admin', mutation)]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  const view = (await request('admin')).body;
  assert.equal(view.revision, 2);
  assert.equal(view.grants[0].version, 2);
  assert.equal(view.events.length, 1);
  assert.ok(!JSON.stringify(view).includes('tokenHash'));
});
