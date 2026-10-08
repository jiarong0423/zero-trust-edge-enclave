import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { sealFileBytes } from '../public/file-envelope.js';

// Route-table characterisation for server.js. It starts the real server in this process on an
// ephemeral loopback port with the synthetic adviser, then pins the status code and the response
// shape of every route family that the split plan moves out of routeApi (file tasks, admin,
// coordinator, legacy packages, MCP, audit). It must pass on both sides of every extraction step.
const root = path.resolve(import.meta.dirname, '..');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'enclave-routes-test-'));
const tokens = {};
let base;
let server;

before(async () => {
  const env = { PATH: process.env.PATH, HOME: dir, SKIP_LOCAL_ENV: 'true', DATA_DIR: dir, PORT: '0', COORDINATOR_PROVIDER: 'synthetic_fixture' };
  const setup = spawn(process.execPath, ['scripts/setup-local.mjs', dir], { cwd: root, env, stdio: 'ignore' });
  assert.equal((await once(setup, 'exit'))[0], 0);
  for (const id of ['operator', 'recipient-a', 'recipient-b', 'coordinator']) tokens[id] = (await fs.readFile(path.join(dir, `${id}.token`), 'utf8')).trim();
  tokens.admin = crypto.randomBytes(32).toString('base64url');
  const registry = JSON.parse(await fs.readFile(path.join(dir, 'access.json'), 'utf8'));
  registry.principals.push({ id: 'admin', kind: 'administrator', tokenHash: crypto.createHash('sha256').update(tokens.admin).digest('hex') });
  await fs.writeFile(path.join(dir, 'access.json'), JSON.stringify(registry, null, 2));
  Object.assign(process.env, env);
  const createServer = http.createServer;
  http.createServer = (...args) => {
    server = createServer(...args);
    return server;
  };
  const log = console.log;
  console.log = () => {};
  try { await import('../server.js'); } finally { console.log = log; http.createServer = createServer; }
  if (!server.listening) await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await fs.rm(dir, { recursive: true, force: true });
});

async function request(url, body, id = 'operator', method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(base + url, { method,
    headers: { 'content-type': 'application/json', ...(id ? { authorization: `Bearer ${tokens[id]}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

const keys = value => Object.keys(value).sort();
const content = () => ({ documentHash: 'a'.repeat(64), recipients: ['recipient-a'], channels: ['email'],
  expiresAt: new Date(Date.now() + 60000).toISOString() });

test('health is unauthenticated and reports the configured outlet', async () => {
  const health = await request('/api/health', undefined, null);
  assert.equal(health.status, 200);
  assert.deepEqual(keys(health.body), ['adviserProvider', 'demoFallbackEnabled', 'legacyHostedAdviceOff', 'localOnly',
    'localOutletBaseUrl', 'localOutletModel', 'nebiusBaseUrl', 'nebiusBudget', 'nebiusConfigured', 'nebiusModel', 'ok', 'project']);
  assert.equal(health.body.ok, true);
  assert.equal(health.body.project, 'zero-trust-edge-enclave');
  assert.equal(health.body.localOnly, true);
  assert.equal(health.body.adviserProvider, 'synthetic_fixture');
  assert.equal(health.body.nebiusConfigured, false);
  assert.equal(typeof health.body.nebiusBudget, 'object');
});

test('authentication comes first: no token, malformed token and unknown path', async () => {
  for (const [method, url] of [['GET', '/api/audit'], ['GET', '/api/tasks'], ['POST', '/api/health'], ['GET', '/api/no-such-route']]) {
    const refused = await request(url, undefined, null, method);
    assert.equal(refused.status, 401, url);
    assert.deepEqual(refused.body, { ok: false, error: 'Authentication required' });
  }
  const malformed = await fetch(base + '/api/audit', { headers: { authorization: 'Bearer short' } });
  assert.equal(malformed.status, 401);
  const unknown = await request('/api/no-such-route');
  assert.equal(unknown.status, 404);
  assert.deepEqual(unknown.body, { ok: false, error: 'not found' });
  assert.equal((await request('/api/health', {}, 'operator')).status, 404);
  const page = await fetch(base + '/zh-TW/missing.html');
  assert.equal(page.status, 404);
  assert.equal(await page.text(), 'Not found');
});

test('whoami names the kind of a registered token and nothing else', async () => {
  for (const [id, kind] of [['operator', 'operator'], ['recipient-a', 'recipient'], ['coordinator', 'coordinator'], ['admin', 'administrator']]) {
    assert.deepEqual((await request('/api/whoami', undefined, id)).body, { ok: true, kind });
  }
  const post = await request('/api/whoami', {});
  assert.equal(post.status, 405);
  assert.deepEqual(post.body, { ok: false, error: 'Method not allowed' });
});

test('kind gates: administrator, coordinator and recipient are kept to their own endpoints', async () => {
  assert.deepEqual((await request('/api/audit', undefined, 'admin')).body, { ok: false, error: 'Administrator endpoint only' });
  assert.equal((await request('/api/audit', undefined, 'admin')).status, 403);
  assert.deepEqual((await request('/api/audit', undefined, 'coordinator')).body, { ok: false, error: 'Coordinator endpoint only' });
  assert.deepEqual((await request('/api/audit', undefined, 'recipient-a')).body, { ok: false, error: 'Recipient endpoint only' });
  assert.deepEqual((await request('/api/tasks', undefined, 'coordinator')).body, { ok: false, error: 'Coordinator endpoint only' });
  assert.deepEqual((await request('/api/tasks', undefined, 'recipient-a')).body, { ok: false, error: 'Recipient endpoint only' });
  assert.deepEqual((await request('/api/authorizations', undefined, 'admin')).body, { ok: false, error: 'Administrator endpoint only' });
});

test('admin routes: retention, audit retention and the directory', async () => {
  const retention = await request('/api/admin/retention', undefined, 'admin');
  assert.equal(retention.status, 200);
  assert.deepEqual(keys(retention.body), ['asOf', 'auditHistory', 'automaticDeletion', 'candidateCount', 'directoryHistory', 'items', 'retainedCount']);
  assert.equal(retention.body.automaticDeletion, false);
  const archive = await request('/api/admin/audit-retention', undefined, 'admin');
  assert.equal(archive.status, 200);
  assert.deepEqual(keys(archive.body), ['deletesArchives', 'pages', 'policy']);
  assert.equal(archive.body.deletesArchives, false);
  for (const url of ['/api/admin/retention', '/api/admin/audit-retention']) {
    const denied = await request(url, undefined, 'operator');
    assert.equal(denied.status, 403);
    assert.deepEqual(denied.body, { ok: false, error: 'Administrator required' });
    const method = await request(url, {}, 'admin');
    assert.equal(method.status, 405);
    assert.deepEqual(method.body, { ok: false, error: 'Method not allowed' });
  }
  const directory = await request('/api/admin/directory', undefined, 'admin');
  assert.equal(directory.status, 200);
  assert.deepEqual(keys(directory.body), ['departments', 'events', 'grants', 'principals', 'revision']);
  assert.ok(!JSON.stringify(directory.body).includes('tokenHash'));
  assert.equal((await request('/api/admin/directory', undefined, 'operator')).status, 403);
  assert.equal((await request('/api/admin/directory', {}, 'admin', 'PUT')).status, 405);
  assert.equal((await request('/api/admin/directory', { action: 'no-such-action' }, 'admin')).status, 422);
});

test('file tasks: intake, listing, owner view, lifecycle, worker and evidence', async () => {
  const sealed = await sealFileBytes(new TextEncoder().encode('MOCK_ONLY,amount\r\nrow,100\r\n'), 'ROUTES_CANARY.csv');
  const intake = { authorizationId: 'local-review', recipients: ['recipient-a'], channels: ['email'],
    expiresAt: content().expiresAt, packet: sealed.packet, documentKey: Buffer.from(sealed.key).toString('hex') };
  assert.equal((await request('/api/file-tasks', intake, 'coordinator')).status, 403);
  assert.equal((await request('/api/file-tasks', intake, 'recipient-a')).status, 403);
  assert.equal((await request('/api/file-tasks', { ...intake, extra: 1 })).status, 422);
  assert.equal((await request('/api/file-tasks', { ...intake, packet: { context: 'x' } })).status, 422);
  assert.equal((await request('/api/file-tasks', { ...intake, documentKey: 'zz' })).status, 422);
  assert.equal((await request('/api/file-tasks', { ...intake, recipients: ['recipient-b'] })).status, 409);
  const staged = await request('/api/file-tasks', intake);
  assert.equal(staged.status, 201);
  assert.deepEqual(keys(staged.body), ['mode', 'sendsEmail', 'task']);
  assert.equal(staged.body.mode, 'local_encrypted_staging');
  assert.equal(staged.body.sendsEmail, false);
  assert.equal(staged.body.task.snapshots[0].status, 'DRAFT');
  assert.deepEqual(staged.body.task.jobs, []);
  assert.ok(!JSON.stringify(staged.body).includes('wrappedKey'));
  assert.equal((await request('/api/file-tasks', intake)).status, 409);
  const taskUrl = `/api/tasks/${staged.body.task.id}`;

  const listing = await request('/api/tasks');
  assert.equal(listing.status, 200);
  assert.deepEqual(keys(listing.body), ['tasks']);
  const entry = listing.body.tasks.find(item => item.id === staged.body.task.id);
  assert.deepEqual(keys(entry), ['authorizationId', 'hasFile', 'id', 'jobs', 'snapshots', 'stagedAt']);
  assert.equal(entry.hasFile, true);
  assert.equal(entry.authorizationId, 'local-review');
  assert.deepEqual(keys(entry.snapshots[0]), ['revokedAt', 'status', 'version']);
  assert.equal((await request('/api/tasks', undefined, 'recipient-a')).status, 403);

  const draft = await request('/api/tasks', { authorizationId: 'local-review', content: content() });
  assert.equal(draft.status, 201);
  assert.deepEqual(keys(draft.body), ['task']);
  assert.equal((await request('/api/tasks', { authorizationId: 'local-review', content: content(), extra: 1 })).status, 422);
  assert.equal((await request('/api/tasks', { authorizationId: 'no-such-grant', content: content() })).status, 403);
  assert.equal((await request('/api/tasks', { authorizationId: 'local-review', content: content() }, 'coordinator')).status, 403);
  assert.equal((await request('/api/tasks', { authorizationId: 'local-review', content: content() }, 'recipient-a')).status, 403);

  const owner = await request(taskUrl);
  assert.equal(owner.status, 200);
  assert.deepEqual(keys(owner.body), ['task']);
  assert.equal(owner.body.task.id, staged.body.task.id);
  assert.equal((await request(taskUrl, undefined, 'coordinator')).status, 403);
  assert.equal((await request(taskUrl, undefined, 'recipient-b')).status, 403);
  const missing = await request(`/api/tasks/${crypto.randomUUID()}`);
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.body, { ok: false, error: 'Task unavailable' });
  assert.equal((await request(`/api/tasks/${staged.body.task.id}`, { version: 1 }, 'operator', 'POST')).status, 405);
  assert.equal((await request(taskUrl + '/confirm-first')).status, 405);
  assert.equal((await request(taskUrl + '/evidence')).status, 404);
  assert.deepEqual((await request(taskUrl + '/evidence')).body, { ok: false, error: 'Evidence unavailable' });
  assert.equal((await request(taskUrl + '/evidence', { version: 1 })).status, 405);
  assert.equal((await request(taskUrl + '/confirm-first', { version: 1, extra: 1 })).status, 422);

  const revision = await request(taskUrl + '/revise', { version: 1, content: { ...content(), documentHash: sealed.commitment } });
  assert.equal(revision.status, 200);
  assert.equal((await request(taskUrl + '/revise', { version: 1, content: content() })).status, 409);
  const first = await request(taskUrl + '/confirm-first', { version: 2 });
  assert.equal(first.status, 200);
  assert.deepEqual(keys(first.body), ['task', 'token']);
  assert.equal(first.body.token.length, 43);
  assert.equal((await request(taskUrl + '/confirm-second', { version: 2, token: 'b'.repeat(43) })).status, 409);
  const second = await request(taskUrl + '/confirm-second', { version: 2, token: first.body.token });
  assert.equal(second.status, 200);
  assert.deepEqual(keys(second.body), ['task']);
  assert.equal(second.body.task.snapshots[1].status, 'APPROVED');
  assert.equal(second.body.task.jobs.length, 1);

  let view;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    view = await request(taskUrl);
    if (view.body.task.jobs[0].status === 'DRY_RUN_PREPARED') break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(view.body.task.jobs[0].status, 'DRY_RUN_PREPARED');

  const evidence = await request(taskUrl + '/evidence');
  assert.equal(evidence.status, 200);
  assert.deepEqual(keys(evidence.body), ['evidence']);
  assert.ok(evidence.body.evidence.trail.length >= 1);
  assert.equal((await request(taskUrl + '/evidence')).status, 200);
  assert.equal((await request(taskUrl + '/evidence', undefined, 'recipient-b')).status, 403);
  const viewed = JSON.parse(await fs.readFile(path.join(dir, 'audit.json'), 'utf8'))
    .filter(event => event.type === 'EVIDENCE_VIEWED' && event.taskId === staged.body.task.id);
  assert.equal(viewed.length, 1, 'two reads inside a minute leave one EVIDENCE_VIEWED record');

  assert.equal((await request(taskUrl + '/invalidate', { version: 2 })).status, 409);
  const resumed = await request(taskUrl + '/resume', { version: 2, expectedRevision: 0 });
  assert.equal(resumed.status, 409);
  const revoked = await request(taskUrl + '/revoke', { version: 2 });
  assert.equal(revoked.status, 200);
  assert.ok(revoked.body.task.snapshots[1].revokedAt);
  const refused = JSON.parse(await fs.readFile(path.join(dir, 'audit.json'), 'utf8'))
    .filter(event => event.taskId === staged.body.task.id && event.type === 'REQUEST_REJECTED');
  assert.ok(refused.length >= 1);
  sealed.key.fill(0);

  const oversize = await fetch(base + '/api/file-tasks', { method: 'POST',
    headers: { authorization: `Bearer ${tokens.operator}`, 'content-type': 'application/json' }, body: ' '.repeat(7_100_001) });
  assert.equal(oversize.status, 413);
});

test('file access routes stay behind the recipient kind', async () => {
  const id = crypto.randomUUID();
  for (const action of ['credential', 'packet', 'key', 'receipt', 'receipt-status']) {
    assert.equal((await request(`/api/file-access/${id}/${action}`, { version: 1 }, 'operator')).status, 403, action);
    assert.equal((await request(`/api/file-access/${id}/${action}`, { version: 1 }, 'recipient-a')).status, 404, action);
  }
  assert.deepEqual((await request(`/api/file-access/${id}/credential`, undefined, 'recipient-a')).body, { ok: false, error: 'not found' });
});

test('authorizations, directory and MCP tool list', async () => {
  const grants = await request('/api/authorizations');
  assert.equal(grants.status, 200);
  assert.deepEqual(keys(grants.body), ['grants']);
  assert.deepEqual(keys(grants.body.grants[0]), ['channels', 'expiresAt', 'id', 'recipients', 'version']);
  assert.deepEqual((await request('/api/authorizations', undefined, 'coordinator')).body, { ok: false, error: 'Coordinator endpoint only' });
  const directory = await request('/api/directory', { authorizationId: 'local-review' });
  assert.equal(directory.status, 200);
  assert.deepEqual(directory.body.recipients.map(person => person.id), ['recipient-a']);
  assert.ok(!JSON.stringify(directory.body).includes('tokenHash'));
  assert.equal((await request('/api/directory', { authorizationId: 'local-review', role: 'manager' })).status, 422);
  assert.equal((await request('/api/directory', { authorizationId: 'local-review' }, 'recipient-a')).status, 403);
  const tools = await request('/api/mcp/tools');
  assert.equal(tools.status, 200);
  assert.deepEqual(keys(tools.body), ['contentBoundary', 'description', 'name', 'ok', 'tools']);
  assert.equal(tools.body.name, 'zero-trust-edge-enclave-transport-shell');
  assert.ok(tools.body.tools.length > 0);
  assert.ok(!tools.body.tools.some(tool => tool.name === 'issue_timed_credential'));
  assert.equal((await request('/api/mcp/tools', {})).status, 404);
});

test('policy recommendation answers from the local fixture', async () => {
  const policy = await request('/api/policy/recommend', { policyMetadata: {} });
  assert.equal(policy.status, 200);
  assert.deepEqual(keys(policy.body), ['envelopePreview', 'policy']);
  assert.equal(policy.body.policy.provider, 'demo_fallback');
  assert.ok(policy.body.envelopePreview.signature);
  assert.equal((await request('/api/policy/recommend', { policyMetadata: { businessPurpose: 'PRIVATE_TEXT_CANARY' } })).status, 422);
  assert.equal((await request('/api/policy/recommend', { policyMetadata: {}, extra: 1 })).status, 422);
});

test('legacy packages, coordinator and MCP over one approved snapshot', async () => {
  const material = { ciphertext: 'ROUTES_CIPHERTEXT_CANARY', iv: 'iv', salt: 'salt' };
  material.packageHash = crypto.createHash('sha256').update(`${material.ciphertext}.${material.iv}.${material.salt}`).digest('hex');
  const draft = await request('/api/tasks', { authorizationId: 'local-review', content: { ...content(), documentHash: material.packageHash } });
  const taskUrl = `/api/tasks/${draft.body.task.id}`;
  const packageInput = { authorizationId: 'local-review', taskId: draft.body.task.id, snapshotVersion: 1,
    fileName: 'ROUTES_FILENAME_CANARY', policy: { allowedRoles: ['attacker'], ttlMinutes: 999999 }, ...material };
  assert.deepEqual((await request('/api/packages', { ...packageInput, ciphertext: '' })).body,
    { ok: false, error: 'ciphertext, iv, packageHash, and policy are required' });
  assert.equal((await request('/api/packages', { ...packageInput, ciphertext: '' })).status, 422);
  assert.equal((await request('/api/packages', packageInput)).status, 409);
  assert.equal((await request('/api/packages', packageInput, 'recipient-a')).status, 403);
  const lock = await request(taskUrl + '/confirm-first', { version: 1 });
  assert.equal((await request(taskUrl + '/confirm-second', { version: 1, token: lock.body.token })).status, 200);
  assert.equal((await request('/api/packages', { ...packageInput, salt: 'tampered' })).status, 409);
  assert.equal((await request('/api/packages', { ...packageInput, plaintext: 'x' })).status, 422);
  const created = await request('/api/packages', packageInput);
  assert.equal(created.status, 201);
  assert.deepEqual(keys(created.body), ['envelope', 'ok', 'packageId', 'sealedLink']);
  assert.deepEqual(created.body.envelope.allowedRoles, ['cfo']);
  assert.equal(created.body.sealedLink, `/decode.html?id=${created.body.packageId}`);
  const again = await request('/api/packages', packageInput);
  assert.equal(again.status, 201);
  assert.equal(again.body.packageId, created.body.packageId);
  const id = created.body.packageId;
  const url = `/api/packages/${id}`;

  const record = await request(url);
  assert.equal(record.status, 200);
  assert.deepEqual(keys(record.body), ['envelope', 'fileName', 'id', 'openCount', 'packageHash', 'revocationVersion', 'revoked']);
  assert.ok(!JSON.stringify(record.body).includes(material.ciphertext));
  const unknown = await request('/api/packages/no-such-package');
  assert.equal(unknown.status, 404);
  assert.deepEqual(unknown.body, { ok: false, error: 'package not found' });
  assert.equal((await request(url, undefined, 'recipient-a')).status, 403);

  assert.equal((await request(url + '/credential', {}, 'recipient-b')).status, 403);
  assert.equal((await request(url + '/credential', { role: 'cfo' }, 'recipient-a')).status, 422);
  assert.equal((await request(url + '/credential', {}, 'operator')).status, 403);
  assert.equal((await request('/api/packages/no-such-package/credential', {}, 'recipient-a')).status, 404);
  const issued = await request(url + '/credential', {}, 'recipient-a');
  assert.equal(issued.status, 201);
  assert.deepEqual(keys(issued.body), ['audit', 'credential', 'ok']);
  assert.deepEqual(keys(issued.body.credential), ['claims', 'token']);
  assert.equal(issued.body.audit.type, 'TIMED_CREDENTIAL_ISSUED');
  const credential = issued.body.credential.token;

  const denied = await request(url + '/verify', { credential: 'bad' }, 'recipient-a');
  assert.equal(denied.status, 200);
  assert.equal(denied.body.result, 'DENY');
  assert.deepEqual(keys(denied.body), ['audit', 'ok', 'package', 'reasons', 'result']);
  assert.equal(denied.body.package.ciphertext, null);
  assert.equal((await request('/api/packages/no-such-package/verify', { credential }, 'recipient-a')).status, 404);
  const allowed = await request(url + '/verify', { credential }, 'recipient-a');
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body.ok, true);
  assert.equal(allowed.body.result, 'ALLOW');
  assert.equal(allowed.body.package.ciphertext, material.ciphertext);
  const replay = await request(url + '/verify', { credential }, 'recipient-a');
  assert.equal(replay.body.result, 'DENY');
  assert.ok(replay.body.reasons.includes('credential already used'));

  const reference = { taskAlias: (await request(taskUrl)).body.task.snapshots[0].taskAlias, snapshotVersion: 1 };
  const coordinate = (tool, args, who = 'coordinator') => request('/api/coordinator/call', { tool, arguments: { ...reference, ...args } }, who);
  assert.equal((await coordinate('status', {}, 'recipient-a')).status, 403);
  assert.equal((await coordinate('status', {}, 'admin')).status, 403);
  assert.equal((await request('/api/coordinator/call', { tool: 'status', arguments: reference, extra: 1 }, 'coordinator')).status, 422);
  const status = await coordinate('status');
  assert.equal(status.status, 200);
  assert.deepEqual(keys(status.body), ['metadata', 'ok']);
  const advice = await coordinate('recommend');
  assert.equal(advice.status, 200);
  assert.deepEqual(keys(advice.body), ['metadata', 'ok', 'provider', 'recommendation']);
  assert.equal(advice.body.provider, 'synthetic_fixture');
  assert.equal(advice.body.recommendation.reasonCode, 'CAPABILITY_MATCH');
  assert.equal((await coordinate('recommend', { plaintext: 'CANARY' })).status, 422);
  assert.equal((await coordinate('deliver', { requestId: 'r1', channel: 'external' })).status, 422);
  assert.equal((await coordinate('nonsense')).status, 422);
  assert.equal((await request('/api/coordinator/call', { tool: 'status', arguments: { taskAlias: 'nope', snapshotVersion: 1 } }, 'coordinator')).status, 404);
  const delivered = await coordinate('deliver', { requestId: 'r1', channel: 'email' });
  assert.equal(delivered.status, 200);
  assert.equal(delivered.body.mode, 'dry_run_only');
  assert.equal(delivered.body.sendsEmail, false);
  assert.equal(delivered.body.status, 'DRY_RUN_PREPARED');
  assert.equal(delivered.body.attempts, 1);
  assert.equal((await coordinate('deliver', { requestId: 'r1', channel: 'email' })).body.attempts, 1);

  const call = (tool, args, who = 'operator') => request('/api/mcp/call', { tool, arguments: args }, who);
  const receipt = await call('check_endpoint_receipt', { packageId: id });
  assert.equal(receipt.status, 200);
  assert.deepEqual(keys(receipt.body), ['ok', 'result', 'tool']);
  assert.deepEqual(keys(receipt.body.result), ['latestReceipt', 'ok', 'packageId', 'receiptCount']);
  const fallback = await call('read_fallback_status', { packageId: id });
  assert.equal(fallback.body.result.fallback.status, 'DENIED');
  const log = await call('read_audit_log', { packageId: id, limit: 5 });
  assert.equal(log.status, 200);
  assert.ok(log.body.result.events.length >= 1 && log.body.result.events.length <= 5);
  const prepared = await call('prepare_email_delivery', { packageId: id });
  assert.equal(prepared.status, 200);
  assert.deepEqual(keys(prepared.body.result), ['draft', 'ok', 'packageId', 'receipt']);
  assert.equal(prepared.body.result.receipt.status, 'DRY_RUN_READY');
  assert.equal(prepared.body.result.draft.safetyChecks.sendsEmail, false);
  const routed = await call('route_package', { packageId: id, requestId: 'r2', channel: 'email' });
  assert.equal(routed.status, 200);
  assert.equal(routed.body.result.mode, 'dry_run_only');
  const secondMaterial = { ciphertext: 'ROUTES_SECOND_CANARY', iv: 'iv', salt: 'salt' };
  secondMaterial.packageHash = crypto.createHash('sha256').update(`${secondMaterial.ciphertext}.${secondMaterial.iv}.${secondMaterial.salt}`).digest('hex');
  const secondDraft = await request('/api/tasks', { authorizationId: 'local-review', content: { ...content(), documentHash: secondMaterial.packageHash } });
  const secondUrl = `/api/tasks/${secondDraft.body.task.id}`;
  const secondLock = await request(secondUrl + '/confirm-first', { version: 1 });
  assert.equal((await request(secondUrl + '/confirm-second', { version: 1, token: secondLock.body.token })).status, 200);
  const viaMcp = await call('create_sealed_package', { ...packageInput, taskId: secondDraft.body.task.id, ...secondMaterial });
  assert.equal(viaMcp.status, 200);
  assert.deepEqual(keys(viaMcp.body.result), ['envelope', 'ok', 'packageId', 'sealedLink']);
  const created2 = JSON.parse(await fs.readFile(path.join(dir, 'audit.json'), 'utf8')).filter(event => event.packageId === viaMcp.body.result.packageId);
  assert.equal(created2.length, 1);
  assert.equal(created2[0].type, 'PACKAGE_CREATED');
  const unknownTool = await call('no_such_tool', { packageId: id });
  assert.equal(unknownTool.status, 404);
  assert.deepEqual(unknownTool.body, { ok: false, tool: 'no_such_tool', error: 'unknown MCP transport tool' });
  const refused = await call('issue_timed_credential', { packageId: id });
  assert.equal(refused.status, 403);
  assert.deepEqual(refused.body, { ok: false, tool: 'issue_timed_credential', error: 'Credentials are available only through the recipient API' });
  assert.equal((await call('read_audit_log', { packageId: 'no-such-package' })).status, 404);
  const unknownPackage = await call('check_endpoint_receipt', { packageId: 'no-such-package' });
  assert.equal(unknownPackage.status, 404);
  assert.deepEqual(unknownPackage.body, { ok: false, tool: 'check_endpoint_receipt', error: 'Package not found' });
  assert.equal((await call('no_such_tool', { packageId: id })).status, 404);
  assert.equal((await call('check_endpoint_receipt', { packageId: id }, 'recipient-a')).status, 403);

  const dryRun = await request('/api/delivery/email/dry-run', { packageId: id });
  assert.equal(dryRun.status, 200);
  assert.deepEqual(keys(dryRun.body), ['draft', 'ok', 'packageId', 'receipt']);
  const dryRunMissing = await request('/api/delivery/email/dry-run', { packageId: 'no-such-package' });
  assert.equal(dryRunMissing.status, 404);
  assert.deepEqual(dryRunMissing.body, { ok: false, error: 'Package not found' });
  assert.equal((await request('/api/delivery/email/dry-run', { packageId: id, extra: 1 })).status, 422);

  const audit = await request('/api/audit');
  assert.equal(audit.status, 200);
  assert.deepEqual(keys(audit.body), ['events']);
  assert.ok(audit.body.events.some(event => event.packageId === id && event.type === 'DECODE_ATTEMPT'));
  assert.ok(!JSON.stringify(audit.body).includes('ROUTES_'));
  assert.equal((await request('/api/audit', undefined, 'recipient-b')).status, 403);

  assert.equal((await request(url + '/revoke', {}, 'recipient-a')).status, 403);
  assert.equal((await request('/api/packages/no-such-package/revoke', {})).status, 404);
  const revoked = await request(url + '/revoke', {});
  assert.equal(revoked.status, 200);
  assert.deepEqual(keys(revoked.body), ['audit', 'ok']);
  assert.equal(revoked.body.audit.type, 'PACKAGE_REVOKED');
  assert.deepEqual((await request(url)).body, { ok: false, error: 'Package access denied' });
  const stored = JSON.parse(await fs.readFile(path.join(dir, 'packages.json'), 'utf8')).find(item => item.id === id);
  assert.equal(stored.revoked, true);
  assert.equal(stored.revocationVersion, 1);

  const chain = JSON.parse(await fs.readFile(path.join(dir, 'audit.json'), 'utf8'));
  for (let index = 1; index < chain.length; index += 1) assert.equal(chain[index].previousHash, chain[index - 1].eventHash);
});
