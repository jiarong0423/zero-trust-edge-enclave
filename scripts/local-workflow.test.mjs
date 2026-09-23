import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { sealFileBytes, openFileBytes } from '../public/file-envelope.js';
import { advanceDelivery, validateAdvice, safeMetadata } from '../access-control.js';
import { auditProjection } from '../audit-boundary.js';
import { createPrivateMapping } from '../private-mapping.js';
import './snapshot-lifecycle.test.mjs';
import './audit-outbox.test.mjs';
import './i18n.test.mjs';
import './business-fixtures.test.mjs';
import './recipient-directory.test.mjs';
import './private-mapping.test.mjs';
import './file-envelope.test.mjs';
import './local-key-vault.test.mjs';
import './file-worker.test.mjs';
import './file-routing.test.mjs';
import './file-adviser.test.mjs';
import './local-adviser-outlet.test.mjs';
import './model-negative.test.mjs';
import './local-array-store.test.mjs';
import './registry-schema.test.mjs';
import './directory-admin.test.mjs';
import './task-operations.test.mjs';
import './file-receipts.test.mjs';
import './delivery-followup.test.mjs';
import './delivery-followup-worker.test.mjs';
import './audit-retention.test.mjs';
import './download-policy.test.mjs';
import './retention-policy.test.mjs';
import './demo-gate.test.mjs';
import './nebius-budget.test.mjs';
import './hosted-lock.test.mjs';

test('audit boundary constructs only allowlisted fields and reason codes', () => {
  const event = auditProjection({ packageId: 'private@example.invalid', type: 'PRIVATE_CANARY',
    result: 'DENY', role: 'PRIVATE_CANARY', deliveryEndpoint: 'PRIVATE_CANARY',
    credential: 'PRIVATE_CANARY', reasons: ['invalid credential signature', 'PRIVATE_CANARY'],
    createdAt: 'PRIVATE_CANARY' });
  assert.deepEqual(event.reasons, ['INVALID_SIGNATURE', 'UNCLASSIFIED']);
  assert.equal(event.packageId, null);
  assert.ok(!JSON.stringify(event).includes('PRIVATE_CANARY'));
  assert.deepEqual(auditProjection(event), event);
});

test('bounded retry, unknown outcome and recommendation validation', () => {
  const grant = { channels: ['email'], maxAttempts: 2, simulatedOutcomes: ['transient', 'transient'] };
  let record = {};
  record.delivery = advanceDelivery(record, grant, { packageId: 'p', requestId: 'r1', channel: 'email' }, 1000);
  assert.equal(record.delivery.status, 'RETRY_WAIT');
  assert.throws(() => advanceDelivery(record, grant, { requestId: 'r2', channel: 'email' }, 1100));
  record.delivery = advanceDelivery(record, grant, { requestId: 'r2', channel: 'email' }, 3000);
  assert.equal(record.delivery.status, 'PAUSED');
  assert.equal(advanceDelivery(record, grant, { requestId: 'r3', channel: 'email' }, 9000).attempts, 2);
  const unknown = advanceDelivery({}, { ...grant, simulatedOutcomes: ['unknown'] }, { requestId: 'r1', channel: 'email' });
  assert.equal(unknown.status, 'OUTCOME_UNKNOWN');
  assert.equal(advanceDelivery({ delivery: unknown }, grant, { requestId: 'r2', channel: 'email' }).attempts, 1);
  assert.throws(() => validateAdvice({ action: 'DELIVER', channel: 'email', reasonCode: 'CAPABILITY_MATCH', recipient: 'new' }, { channels: ['email'] }));
  assert.throws(() => validateAdvice({ action: 'DELIVER', channel: 'external', reasonCode: 'CAPABILITY_MATCH' }, { channels: ['email'] }));
  const metadata = safeMetadata({ id: 'INTERNAL_PACKAGE_CANARY', ciphertext: 'CANARY', fileName: 'CANARY' }, { version: 1, channels: ['email'], maxAttempts: 2,
    privateMapping: createPrivateMapping('INTERNAL_TASK_CANARY', 1, { recipients: ['r'], channels: ['email'] }) });
  assert.ok(!JSON.stringify(metadata).includes('CANARY'));
});

test('isolated local authorization, coordinator and dry-run end to end', async t => {
  const root = path.resolve(import.meta.dirname, '..');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'enclave-local-test-'));
  const env = { PATH: process.env.PATH, HOME: dir, SKIP_LOCAL_ENV: 'true', DATA_DIR: dir, PORT: '0', COORDINATOR_PROVIDER: 'synthetic_fixture',
    NEBIUS_API_KEY: 'unused-test-placeholder', NEBIUS_BASE_URL: 'disabled-protocol://no-network' };
  const setup = spawn(process.execPath, ['scripts/setup-local.mjs', dir], { cwd: root, env, stdio: 'ignore' });
  assert.equal((await once(setup, 'exit'))[0], 0);
  let server;
  async function startServer() {
    server = spawn(process.execPath, ['server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let errors = '';
    server.stderr.on('data', chunk => { errors += chunk; });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Server startup timeout')), 5000);
      server.stdout.on('data', chunk => {
        output += chunk;
        const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/);
        if (match) { clearTimeout(timer); resolve(match[0]); }
      });
      server.once('exit', () => { clearTimeout(timer); reject(new Error(`Server exited: ${errors}`)); });
    });
  }
  t.after(async () => {
    if (server.exitCode === null) { server.kill(); await once(server, 'exit'); }
    await fs.rm(dir, { recursive: true, force: true });
  });
  let base = await startServer();
  assert.equal((await (await fetch(base + '/api/health')).json()).localOnly, true);
  for (const route of ['/zh-TW/', '/zh-TW/decode.html', '/zh-TW/audit.html']) {
    const page = await fetch(base + route);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /type="module"/);
  }
  assert.equal((await fetch(base + '/zh-TW/missing.html')).status, 404);
  const tokens = {};
  for (const id of ['operator', 'recipient-a', 'recipient-b', 'coordinator']) tokens[id] = await fs.readFile(path.join(dir, `${id}.token`), 'utf8');
  async function request(url, body, id = 'operator') {
    const response = await fetch(base + url, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...(id ? { authorization: `Bearer ${tokens[id]}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  assert.equal((await request('/api/audit', undefined, null)).status, 401);
  const localPolicy = await request('/api/policy/recommend', { policyMetadata: {} });
  assert.equal(localPolicy.status, 200);
  assert.equal(localPolicy.body.policy.provider, 'demo_fallback');
  const directory = await request('/api/directory', { authorizationId: 'local-review' });
  assert.equal(directory.status, 200);
  assert.deepEqual(directory.body.recipients.map(person => person.id), ['recipient-a']);
  assert.ok(!JSON.stringify(directory.body).includes('tokenHash'));
  assert.equal((await request('/api/directory', { authorizationId: 'local-review' }, 'coordinator')).status, 403);
  assert.equal((await request('/api/directory', { authorizationId: 'local-review' }, 'recipient-a')).status, 403);
  assert.equal((await request('/api/directory', { authorizationId: 'local-review', role: 'manager' })).status, 422);
  assert.deepEqual((await request('/api/directory', { authorizationId: 'local-review', query: 'recipient-b' })).body.recipients, []);
  const content = { documentHash: 'a'.repeat(64), recipients: ['recipient-a'], channels: ['email'],
    expiresAt: new Date(Date.now() + 60000).toISOString() };
  const draft = await request('/api/tasks', { authorizationId: 'local-review', content });
  assert.equal(draft.status, 201);
  const taskUrl = `/api/tasks/${draft.body.task.id}`;
  assert.equal((await request(taskUrl + '/confirm-second', { version: 1, token: 'a'.repeat(43) })).status, 409);
  const first = await request(taskUrl + '/confirm-first', { version: 1 });
  assert.equal(first.status, 200);
  assert.equal((await request(taskUrl + '/invalidate', { version: 1 })).status, 200);
  assert.equal((await request(taskUrl + '/confirm-second', { version: 1, token: first.body.token })).status, 409);
  const revised = await request(taskUrl + '/revise', { version: 1, content: { ...content, documentHash: 'b'.repeat(64) } });
  assert.equal(revised.status, 200);
  assert.equal(revised.body.task.snapshots[0].status, 'INVALIDATED');
  assert.equal((await request(taskUrl + '/confirm-second', { version: 1, token: first.body.token })).status, 409);
  assert.equal((await request(taskUrl + '/revise', { version: 1, content })).status, 409);
  const secondFirst = await request(taskUrl + '/confirm-first', { version: 2 });
  const approvals = await Promise.all(Array.from({ length: 4 }, () => request(taskUrl + '/confirm-second', { version: 2, token: secondFirst.body.token })));
  for (const approval of approvals) {
    assert.equal(approval.status, 200);
    assert.equal(approval.body.task.jobs.length, 1);
    assert.ok(!JSON.stringify(approval.body.task).includes('SubmissionHash'));
  }
  const persisted = JSON.parse(await fs.readFile(path.join(dir, 'tasks.json'), 'utf8'));
  assert.equal(persisted[0].jobs.length, 1);
  assert.equal(persisted[0].snapshots[1].status, 'APPROVED');
  assert.equal((await request(taskUrl, undefined, 'coordinator')).status, 403);
  assert.equal((await request(taskUrl + '/revise', { version: 2, content })).status, 200);
  const current = await request(taskUrl);
  assert.equal(current.body.task.snapshots[1].status, 'APPROVED');
  assert.equal((await request(taskUrl + '/invalidate', { version: 2 })).status, 409);
  assert.equal((await request(taskUrl + '/revoke', { version: 2 })).status, 200);
  assert.equal((await request(taskUrl + '/confirm-second', { version: 2, token: secondFirst.body.token })).status, 409);
  const binary = await sealFileBytes(new TextEncoder().encode('MOCK_ONLY,amount\r\nrow,100\r\n'), 'PRIVATE_FILE_CANARY.csv');
  const binaryInput = { authorizationId: 'local-review', recipients: ['recipient-a'], channels: ['email'],
    expiresAt: content.expiresAt, packet: binary.packet, documentKey: Buffer.from(binary.key).toString('hex') };
  assert.equal((await request('/api/file-tasks', binaryInput, 'coordinator')).status, 403);
  assert.equal((await request('/api/file-tasks', { ...binaryInput, recipients: ['recipient-b'] })).status, 409);
  const staged = await request('/api/file-tasks', binaryInput);
  assert.equal(staged.status, 201);
  assert.equal(staged.body.task.snapshots[0].status, 'DRAFT');
  assert.equal(staged.body.task.jobs.length, 0);
  assert.ok(!JSON.stringify(staged.body).includes('wrappedKey'));
  assert.ok(!JSON.stringify(staged.body).includes(binary.packet.ciphertext));
  assert.equal((await request('/api/file-tasks', binaryInput)).status, 409);
  const stagedDisk = await fs.readFile(path.join(dir, 'tasks.json'), 'utf8');
  assert.ok(!stagedDisk.includes(binaryInput.documentKey));
  assert.ok(!stagedDisk.includes('PRIVATE_FILE_CANARY'));
  assert.ok(!stagedDisk.includes('MOCK_ONLY'));
  const stagedRecord = JSON.parse(stagedDisk).find(item => item.id === staged.body.task.id);
  assert.equal(stagedRecord.file.packet.ciphertext, binary.packet.ciphertext);
  const fileTaskUrl = '/api/tasks/' + staged.body.task.id;
  const accessUrl = '/api/file-access/' + staged.body.task.id;
  assert.equal((await request(accessUrl + '/credential', { version: 1 }, 'recipient-a')).status, 409);
  const fileFirst = await request(fileTaskUrl + '/confirm-first', { version: 1 });
  assert.equal(fileFirst.status, 200);
  const fileRevision = await request(fileTaskUrl + '/revise', { version: 1,
    content: { ...content, documentHash: binary.commitment } });
  assert.equal(fileRevision.status, 200);
  assert.equal((await request(fileTaskUrl + '/confirm-second', { version: 1, token: fileFirst.body.token })).status, 409);
  const fileSecond = await request(fileTaskUrl + '/confirm-first', { version: 2 });
  assert.equal((await request(fileTaskUrl + '/confirm-second', { version: 2, token: fileSecond.body.token })).status, 200);
  let workerView;
  for (let attempt = 0; attempt < 40; attempt++) {
    workerView = await request(fileTaskUrl);
    if (workerView.body.task.jobs[0].status === 'DRY_RUN_PREPARED') break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(workerView.body.task.jobs[0].status, 'DRY_RUN_PREPARED');
  assert.equal(workerView.body.task.jobs[0].attempts, 1);
  const routedDisk = JSON.parse(await fs.readFile(path.join(dir, 'tasks.json'), 'utf8'));
  const fileAlias = routedDisk.find(item => item.id === staged.body.task.id).snapshots[1].privateMapping.taskAlias;
  for (const tool of ['file_status', 'file_recommend']) {
    const response = await request('/api/coordinator/call', { tool,
      arguments: { taskAlias: fileAlias, snapshotVersion: 2 } }, 'coordinator');
    assert.equal(response.status, 200);
    for (const value of ['PRIVATE_FILE_CANARY', binary.packet.ciphertext, binaryInput.documentKey, 'recipient-a', staged.body.task.id]) {
      assert.ok(!JSON.stringify(response.body).includes(value));
    }
    assert.equal((await request('/api/coordinator/call', { tool,
      arguments: { taskAlias: fileAlias, snapshotVersion: 2, channel: 'external' } }, 'coordinator')).status, 422);
  }
  for (const actor of ['operator', 'coordinator', 'recipient-b']) {
    for (const action of ['packet', 'credential', 'key']) {
      assert.equal((await request(accessUrl + '/' + action,
        { version: 2, ...(action === 'key' ? { credential: 'a'.repeat(43) } : {}) }, actor)).status, 403);
    }
  }
  // A registered recipient refused on a resolved task is recorded against that task, with the
  // generic code and no identity, so the sender can see the refusal without learning who it was.
  const refusals = JSON.parse(await fs.readFile(path.join(dir, 'audit.json'), 'utf8'))
    .filter(event => event.taskId === staged.body.task.id && event.type === 'REQUEST_REJECTED' &&
      event.reasons.includes('ACCESS_DENIED'));
  assert.equal(refusals.length, 3);
  for (const event of refusals) {
    assert.equal(event.result, 'DENY');
    assert.deepEqual(event.reasons, ['ACCESS_DENIED']);
    assert.equal(event.snapshotVersion, null);
    assert.ok(!JSON.stringify(event).includes('recipient-b'));
  }
  assert.equal((await request(accessUrl + '/credential', { version: 1 }, 'recipient-a')).status, 409);
  const ticket = await request(accessUrl + '/credential', { version: 2 }, 'recipient-a');
  assert.equal((await request(accessUrl + '/receipt', { version: 2, code: 'DOWNLOAD_REQUESTED' }, 'recipient-a')).status, 403);
  assert.equal(ticket.status, 201);
  assert.ok(Date.parse(ticket.body.expiresAt) <= Date.parse(content.expiresAt));
  const ticketDisk = await fs.readFile(path.join(dir, 'tasks.json'), 'utf8');
  assert.ok(!ticketDisk.includes(ticket.body.credential));
  const expiring = await request(accessUrl + '/credential', { version: 2 }, 'recipient-a');
  assert.equal(expiring.status, 201);
  // Age only this isolated ticket while its test server is stopped.
  server.kill();
  await once(server, 'exit');
  const lifecycleTasks = JSON.parse(await fs.readFile(path.join(dir, 'tasks.json'), 'utf8'));
  const lifecycleTask = lifecycleTasks.find(item => item.id === staged.body.task.id);
  const expiringHash = createHash('sha256').update(JSON.stringify(expiring.body.credential)).digest('hex');
  const expiredTicket = lifecycleTask.fileAccessTickets.find(item => item.hash === expiringHash);
  assert.ok(expiredTicket);
  expiredTicket.expiresAt = Date.now() - 1;
  await fs.writeFile(path.join(dir, 'tasks.json'), JSON.stringify(lifecycleTasks));
  base = await startServer();
  assert.equal((await request(accessUrl + '/key', { version: 2, credential: expiring.body.credential }, 'recipient-a')).status, 403);
  const packet = await request(accessUrl + '/packet', { version: 2 }, 'recipient-a');
  assert.equal(packet.status, 200);
  assert.equal((await request(accessUrl + '/key', { version: 2, credential: 'a'.repeat(43) }, 'recipient-a')).status, 403);
  const keyRequest = { version: 2, credential: ticket.body.credential };
  const releases = await Promise.all([request(accessUrl + '/key', keyRequest, 'recipient-a'),
    request(accessUrl + '/key', keyRequest, 'recipient-a')]);
  assert.deepEqual(releases.map(result => result.status).sort(), [200, 403]);
  const releasedKey = Buffer.from(releases.find(result => result.status === 200).body.key, 'hex');
  const recovered = await openFileBytes(packet.body.packet, releasedKey);
  assert.equal(recovered.name, 'PRIVATE_FILE_CANARY.csv');
  assert.equal(Buffer.from(recovered.bytes).toString(), 'MOCK_ONLY,amount\r\nrow,100\r\n');
  releasedKey.fill(0);
  const receipt = await request(accessUrl + '/receipt', { version: 2, code: 'DOWNLOAD_REQUESTED' }, 'recipient-a');
  assert.equal(receipt.status, 200);
  assert.equal(receipt.body.evidence, 'CLIENT_REPORTED');
  const duplicateReceipt = await request(accessUrl + '/receipt', { version: 2, code: 'DOWNLOAD_REQUESTED' }, 'recipient-a');
  assert.deepEqual(duplicateReceipt.body, receipt.body);
  const receiptStatus = (await request(fileTaskUrl)).body.task.jobs[0].receiptSummary;
  assert.deepEqual(receiptStatus.recipients, [{ recipientId: 'recipient-a', groupCode: 'A1', keyReleased: true,
    downloadReported: true, fileVerified: false, acknowledged: false, lastReportedAt: receipt.body.reportedAt }]);
  assert.deepEqual({ ...receiptStatus, recipients: undefined }, { recipients: undefined, recipientCount: 1, keyRecipientCount: 1, downloadReportCount: 1,
    verifiedReportCount: 0, acknowledgedCount: 0, deliveryDeadline: content.expiresAt,
    deliveryMode: 'TIME_LIMITED', downloadUntil: content.expiresAt, downloadWindowState: 'WINDOW_OPEN', receiptState: 'AWAITING_ACKNOWLEDGEMENT',
    deliveryState: 'AWAITING_ACKNOWLEDGEMENT',
    lastReportedAt: receipt.body.reportedAt, evidence: 'CLIENT_REPORTED', provesReading: false });
  assert.equal((await request(accessUrl + '/receipt', { version: 2, code: 'ACKNOWLEDGED' }, 'recipient-a')).status, 409);
  assert.equal((await request(accessUrl + '/receipt', { version: 2, code: 'FILE_VERIFIED' }, 'recipient-a')).status, 200);
  const acknowledged = await request(accessUrl + '/receipt', { version: 2, code: 'ACKNOWLEDGED' }, 'recipient-a');
  assert.equal(acknowledged.status, 200);
  assert.deepEqual((await request(accessUrl + '/receipt', { version: 2, code: 'ACKNOWLEDGED' }, 'recipient-a')).body, acknowledged.body);
  const completedReceipt = (await request(fileTaskUrl)).body.task.jobs[0].receiptSummary;
  assert.equal(completedReceipt.deliveryState, 'ACKNOWLEDGED');
  assert.equal(completedReceipt.acknowledgedCount, 1);
  assert.equal(completedReceipt.provesReading, false);
  const ownReceipt = await request(accessUrl + '/receipt-status', { version: 2 }, 'recipient-a');
  assert.equal(ownReceipt.status, 200);
  assert.deepEqual(ownReceipt.body, { version: 2, fileVerified: true, downloadReported: true,
    acknowledged: true, evidence: 'CLIENT_REPORTED', provesReading: false });
  assert.equal((await request(accessUrl + '/receipt-status', { version: 2 }, 'recipient-b')).status, 403);
  assert.equal((await request(accessUrl + '/receipt-status', { version: 99 }, 'recipient-a')).status, 403);
  assert.equal((await request(accessUrl + '/receipt-status', { version: 2, subject: 'recipient-a' }, 'recipient-b')).status, 422);
  assert.equal((await request(accessUrl + '/receipt', { version: 2, code: 'READ_CONFIRMED' }, 'recipient-a')).status, 422);
  assert.equal((await request(accessUrl + '/receipt', { version: 2, code: 'DOWNLOAD_REQUESTED' }, 'recipient-b')).status, 403);
  assert.equal((await request(accessUrl + '/receipt', { version: 2, code: 'DOWNLOAD_REQUESTED', filename: 'PRIVATE_CANARY' }, 'recipient-a')).status, 422);
  server.kill();
  await once(server, 'exit');
  base = await startServer();
  assert.equal((await request(accessUrl + '/key', keyRequest, 'recipient-a')).status, 403);
  const finalTicket = await request(accessUrl + '/credential', { version: 2 }, 'recipient-a');
  assert.equal(finalTicket.status, 201);
  const finalRelease = await request(accessUrl + '/key', { version: 2, credential: finalTicket.body.credential }, 'recipient-a');
  assert.equal(finalRelease.status, 200);
  assert.equal(finalRelease.body.key, binaryInput.documentKey);
  assert.equal((await request(accessUrl + '/credential', { version: 2 }, 'recipient-a')).status, 403);
  const releaseLedger = JSON.parse(await fs.readFile(path.join(dir, 'tasks.json'), 'utf8'))
    .find(item => item.id === staged.body.task.id).fileKeyReleases;
  assert.equal(releaseLedger.length, 2);
  assert.equal((await request(fileTaskUrl + '/revoke', { version: 2 })).status, 200);
  assert.deepEqual((await request(accessUrl + '/receipt-status', { version: 2 }, 'recipient-a')).body, ownReceipt.body);
  for (const action of ['packet', 'credential', 'key']) {
    assert.equal((await request(accessUrl + '/' + action,
      { version: 2, ...(action === 'key' ? { credential: ticket.body.credential } : {}) }, 'recipient-a')).status, 409);
  }
  const tooLarge = await fetch(base + '/api/file-tasks', { method: 'POST',
    headers: { authorization: `Bearer ${tokens.operator}`, 'content-type': 'application/json' }, body: ' '.repeat(7_100_001) });
  assert.equal(tooLarge.status, 413);
  binary.key.fill(0);
  assert.equal((await request('/api/policy/recommend', { policyMetadata: { businessPurpose: 'PRIVATE_TEXT_CANARY' } })).status, 422);
  const material = { ciphertext: 'SECRET_CIPHERTEXT_CANARY', iv: 'iv', salt: 'salt' };
  material.packageHash = createHash('sha256').update(`${material.ciphertext}.${material.iv}.${material.salt}`).digest('hex');
  const sealedDraft = await request('/api/tasks', { authorizationId: 'local-review', content: { ...content, documentHash: material.packageHash } });
  const sealedTaskUrl = `/api/tasks/${sealedDraft.body.task.id}`;
  const lock = await request(sealedTaskUrl + '/confirm-first', { version: 1 });
  const packageInput = { authorizationId: 'local-review', taskId: sealedDraft.body.task.id, snapshotVersion: 1,
    fileName: 'SECRET_FILENAME_CANARY', policy: { allowedRoles: ['attacker'], ttlMinutes: 999999 }, ...material };
  assert.equal((await request('/api/packages', packageInput)).status, 409);
  await request(sealedTaskUrl + '/confirm-second', { version: 1, token: lock.body.token });
  assert.equal((await request('/api/packages', { ...packageInput, salt: 'tampered' })).status, 409);
  const created = await request('/api/packages', packageInput);
  assert.equal(created.status, 201);
  assert.deepEqual(created.body.envelope.allowedRoles, ['cfo']);
  const id = created.body.packageId;
  const url = `/api/packages/${id}`;
  await request(url + '/verify', { credential: 'bad', role: 'AUDIT_PRIVATE_CANARY', deviceClaim: 'AUDIT_PRIVATE_CANARY' }, 'recipient-a');
  const auditDisk = await fs.readFile(path.join(dir, 'audit.json'), 'utf8');
  assert.ok(!auditDisk.includes('AUDIT_PRIVATE_CANARY'));
  assert.ok(!auditDisk.includes('invalid credential format'));
  assert.ok(!auditDisk.includes('credentialId'));
  const auditView = await request('/api/audit');
  assert.ok(!JSON.stringify(auditView.body).includes('AUDIT_PRIVATE_CANARY'));
  assert.equal((await request(url + '/credential', { role: 'cfo' }, 'recipient-b')).status, 403);
  assert.equal((await request(url + '/credential', { role: 'cfo' }, 'recipient-a')).status, 422);
  assert.equal((await request(url + '/credential', {}, 'coordinator')).status, 403);
  assert.equal((await request('/api/mcp/call', { tool: 'issue_timed_credential', arguments: { packageId: id } })).status, 403);
  assert.equal((await request('/api/audit', undefined, 'coordinator')).status, 403);
  const routingReference = { taskAlias: (await request(sealedTaskUrl)).body.task.snapshots[0].taskAlias, snapshotVersion: 1 };
  async function coordinate(tool, args) { return request('/api/coordinator/call', { tool, arguments: { ...routingReference, ...args } }, 'coordinator'); }
  assert.equal((await coordinate('status', { packageId: id })).status, 422);
  const advice = await coordinate('recommend');
  assert.equal(advice.status, 200);
  assert.equal(advice.body.provider, 'synthetic_fixture');
  assert.equal(advice.body.recommendation.reasonCode, 'CAPABILITY_MATCH');
  assert.equal(advice.body.metadata.routing.snapshotVersion, packageInput.snapshotVersion);
  assert.ok(!JSON.stringify(advice.body.metadata.routing).includes('recipient-a'));
  assert.ok(!JSON.stringify(advice.body.metadata.routing).includes('endpointId'));
  assert.ok(!JSON.stringify(advice.body).includes('SECRET_'));
  assert.ok(!JSON.stringify(advice.body).includes(id));
  assert.ok(!JSON.stringify(advice.body).includes(sealedDraft.body.task.id));
  assert.equal((await coordinate('recommend', { plaintext: 'CANARY' })).status, 422);
  assert.equal((await coordinate('deliver', { requestId: 'r1', channel: 'external' })).status, 422);
  const deliveries = await Promise.all(Array.from({ length: 4 }, () => coordinate('deliver', { requestId: 'r1', channel: 'email' })));
  for (const d of deliveries) { assert.equal(d.status, 200); assert.equal(d.body.attempts, 1); assert.equal(d.body.sendsEmail, false); assert.equal(d.body.status, 'DRY_RUN_PREPARED'); }
  const saved = JSON.parse(await fs.readFile(path.join(dir, 'packages.json'), 'utf8'))[0];
  assert.equal(saved.delivery.events.length, 1);
  const events = JSON.parse(await fs.readFile(path.join(dir, 'audit.json'), 'utf8'));
  const changed = events.find(event => event.taskId === draft.body.task.id && event.nextState === 'INVALIDATED');
  assert.equal(changed.snapshotVersion, 1);
  assert.equal(changed.previousState, 'LOCKED');
  const rejected = events.find(event => event.taskId === draft.body.task.id && event.type === 'REQUEST_REJECTED');
  assert.deepEqual(rejected.reasons, ['STATE_CONFLICT']);
  const terminal = events.filter(event => event.packageId === id && event.type === 'DELIVERY_TRANSITION');
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0].previousState, 'PENDING_CHECK');
  assert.equal(terminal[0].nextState, 'DRY_RUN_PREPARED');
  assert.equal(terminal[0].attempts, 1);
  assert.equal(terminal[0].snapshotVersion, 1);
  assert.equal(terminal[0].taskId, sealedDraft.body.task.id);
  assert.ok(!JSON.stringify(events).includes('SECRET_'));
  for (const event of events) {
    assert.ok(!Object.hasOwn(event, 'role'));
    assert.ok(!Object.hasOwn(event, 'credentialId'));
    assert.ok(!Object.hasOwn(event, 'deliveryEndpoint'));
  }
  assert.equal(saved.emailDraft.safetyChecks.sendsEmail, false);
  assert.ok(!JSON.stringify(saved.emailDraft).includes('SECRET_'));
  const bridge = spawn(process.execPath, ['scripts/coordinator-mcp.mjs'], { cwd: root, env: { ...env, COORDINATOR_BASE_URL: base, COORDINATOR_TOKEN_FILE: path.join(dir, 'coordinator.token') }, stdio: ['pipe', 'pipe', 'pipe'] });
  let bridgeOutput = '';
  bridge.stdout.on('data', chunk => { bridgeOutput += chunk; });
  // 2026-07-28: no initialize handshake and no session. server/discover is mandatory, every request
  // declares its own version in _meta, and a mismatch is refused on that request alone.
  const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' };
  bridge.stdin.end([
    { jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: meta } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: meta } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'recommend', arguments: routingReference, _meta: meta } },
    { jsonrpc: '2.0', id: 4, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2024-11-05' } } },
    { jsonrpc: '2.0', id: 5, method: 'initialize', params: { _meta: meta } }
  ].map(v => JSON.stringify(v)).join('\n') + '\n');
  assert.equal((await once(bridge, 'exit'))[0], 0);
  const messages = bridgeOutput.trim().split('\n').map(v => JSON.parse(v));
  assert.deepEqual(messages[0].result.protocolVersions, ['2026-07-28']);
  assert.equal(messages[0].result.resultType, 'complete');
  assert.equal(messages[0].result._meta['io.modelcontextprotocol/serverInfo'].name, 'edge-enclave-local-coordinator');
  assert.deepEqual(messages[1].result.tools.map(v => v.name), ['status', 'recommend', 'deliver', 'file_status', 'file_recommend']);
  assert.equal(messages[1].result.cacheScope, 'private');
  assert.ok(Number.isSafeInteger(messages[1].result.ttlMs));
  assert.equal(messages[2].result.isError, false);
  assert.equal(messages[2].result.resultType, 'complete');
  // A superseded version is refused per request, not per connection.
  assert.equal(messages[3].error.code, -32022);
  assert.deepEqual(messages[3].error.data.supported, ['2026-07-28']);
  // The retired handshake is simply not a method any more.
  assert.equal(messages[4].error.code, -32600);
  assert.ok(!bridgeOutput.includes(tokens.coordinator));
  assert.ok(!bridgeOutput.includes('SECRET_'));
  server.kill();
  await once(server, 'exit');
  base = await startServer();
  assert.equal((await request(taskUrl + '/confirm-second', { version: 1, token: first.body.token })).status, 409);
  const recoveredTask = await request(sealedTaskUrl);
  assert.equal(recoveredTask.body.task.jobs.length, 1);
  assert.equal(recoveredTask.body.task.snapshots[0].status, 'APPROVED');
  assert.equal((await coordinate('deliver', { requestId: 'after-restart', channel: 'email' })).body.attempts, 1);
  const issue = await request(url + '/credential', {}, 'recipient-a');
  assert.equal(issue.status, 201);
  const credential = issue.body.credential.token;
  const opened = await Promise.all([request(url + '/verify', { credential }, 'recipient-a'), request(url + '/verify', { credential }, 'recipient-a')]);
  assert.equal(opened.filter(r => r.body.result === 'ALLOW').length, 1);
  assert.equal(opened.filter(r => r.body.result === 'DENY').length, 1);
  const next = await request(url + '/credential', {}, 'recipient-a');
  await request(sealedTaskUrl + '/revoke', { version: 1 });
  assert.equal((await request(url + '/credential', {}, 'recipient-a')).status, 409);
  assert.equal((await coordinate('deliver', { requestId: 'revoked-retry', channel: 'email' })).status, 409);
  assert.equal((await request(url + '/verify', { credential: next.body.credential.token }, 'recipient-a')).status, 409);
  const cutoff = new Date(Date.now() + 2500).toISOString();
  const modeTasks = {};
  for (const mode of ['TIME_LIMITED', 'REQUIRED_ACK']) {
    const envelope = await sealFileBytes(new Uint8Array([4, 5, 6]), 'mode-test.csv');
    const intake = await request('/api/file-tasks', { authorizationId: 'local-review', recipients: ['recipient-a'], channels: ['email'],
      expiresAt: content.expiresAt, deliveryMode: mode, downloadUntil: mode === 'TIME_LIMITED' ? cutoff : null,
      packet: envelope.packet, documentKey: Buffer.from(envelope.key).toString('hex') });
    envelope.key.fill(0);
    assert.equal(intake.status, 201);
    const ownerRoute = '/api/tasks/' + intake.body.task.id;
    const lock = await request(ownerRoute + '/confirm-first', { version: 1 });
    assert.equal((await request(ownerRoute + '/confirm-second', { version: 1, token: lock.body.token })).status, 200);
    for (let attempt = 0; attempt < 20; attempt++) {
      if ((await request(ownerRoute)).body.task.jobs[0].status === 'DRY_RUN_PREPARED') break;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    const access = '/api/file-access/' + intake.body.task.id;
    assert.equal((await request(access + '/packet', { version: 1 }, 'recipient-a')).status, 200);
    const ticket = await request(access + '/credential', { version: 1 }, 'recipient-a');
    assert.equal(ticket.status, 201);
    if (mode === 'TIME_LIMITED') assert.equal(ticket.body.expiresAt, cutoff);
    assert.equal((await request(access + '/key', { version: 1, credential: ticket.body.credential }, 'recipient-a')).status, 200);
    const unused = await request(access + '/credential', { version: 1 }, 'recipient-a');
    assert.equal(unused.status, 201);
    modeTasks[mode] = { ownerRoute, access, credential: unused.body.credential };
  }
  await new Promise(resolve => setTimeout(resolve, Math.max(0, Date.parse(cutoff) - Date.now() + 20)));
  const timed = modeTasks.TIME_LIMITED;
  for (const action of ['packet', 'credential', 'key']) {
    const result = await request(timed.access + '/' + action,
      { version: 1, ...(action === 'key' ? { credential: timed.credential } : {}) }, 'recipient-a');
    assert.equal(result.status, 403);
    assert.equal(result.body.error, 'DOWNLOAD_WINDOW_CLOSED');
  }
  const timedSummary = (await request(timed.ownerRoute)).body.task.jobs[0].receiptSummary;
  assert.equal(timedSummary.downloadWindowState, 'WINDOW_CLOSED');
  assert.equal(timedSummary.receiptState, 'AWAITING_ACKNOWLEDGEMENT');
  const required = modeTasks.REQUIRED_ACK;
  assert.equal((await request(required.access + '/packet', { version: 1 }, 'recipient-a')).status, 200);
  assert.equal((await request(required.access + '/key', { version: 1, credential: required.credential }, 'recipient-a')).status, 200);
  assert.equal((await request(required.ownerRoute)).body.task.jobs[0].receiptSummary.downloadWindowState, 'NO_DOWNLOAD_CUTOFF');
  const config = JSON.parse(await fs.readFile(path.join(dir, 'access.json'), 'utf8'));
  for (const [outcomes, expected, maxAttempts] of [[['transient'], 'PAUSED', 1], [['unknown'], 'OUTCOME_UNKNOWN', 3]]) {
    config.grants[0].simulatedOutcomes = outcomes;
    config.grants[0].maxAttempts = maxAttempts;
    await fs.writeFile(path.join(dir, 'access.json'), JSON.stringify(config));
    const terminalDraft = await request('/api/tasks', { authorizationId: 'local-review', content: { ...content, documentHash: material.packageHash } });
    const terminalTask = `/api/tasks/${terminalDraft.body.task.id}`;
    const terminalLock = await request(terminalTask + '/confirm-first', { version: 1 });
    await request(terminalTask + '/confirm-second', { version: 1, token: terminalLock.body.token });
    const terminalPackage = await request('/api/packages', { ...packageInput, taskId: terminalDraft.body.task.id });
    const terminalId = terminalPackage.body.packageId;
    const terminalReference = { taskAlias: (await request(terminalTask)).body.task.snapshots[0].taskAlias, snapshotVersion: 1 };
    const terminalCall = requestId => request('/api/coordinator/call', { tool: 'deliver', arguments: { ...terminalReference, requestId, channel: 'email' } }, 'coordinator');
    const destination = config.principals.find(person => person.id === 'recipient-a');
    destination.disabled = true;
    await fs.writeFile(path.join(dir, 'access.json'), JSON.stringify(config));
    assert.equal((await terminalCall('disabled-recipient')).status, 403);
    destination.disabled = false;
    await fs.writeFile(path.join(dir, 'access.json'), JSON.stringify(config));
    assert.equal((await terminalCall('first')).body.status, expected);
    assert.equal((await terminalCall('second')).body.attempts, 1);
    const terminalEvents = JSON.parse(await fs.readFile(path.join(dir, 'audit.json'), 'utf8'))
      .filter(event => event.packageId === terminalId && event.type === 'DELIVERY_TRANSITION');
    assert.equal(terminalEvents.length, 1);
    assert.equal(terminalEvents[0].nextState, expected);
    assert.equal(terminalEvents[0].attempts, 1);
  }
  config.grants[0].version += 1;
  await fs.writeFile(path.join(dir, 'access.json'), JSON.stringify(config));
  assert.equal((await request(url + '/verify', { credential: next.body.credential.token }, 'recipient-a')).status, 403);
  assert.equal((await coordinate('deliver', { requestId: 'r2', channel: 'email' })).status, 403);
  config.grants[0].revoked = true;
  await fs.writeFile(path.join(dir, 'access.json'), JSON.stringify(config));
  assert.equal((await request('/api/packages', { authorizationId: 'local-review', policy: {}, ciphertext: 'x', iv: 'i', packageHash: 'h' })).status, 403);
  console.log('Synthetic authorization, replay, parallel idempotency, metadata boundaries and revocation verified; no provider calls or mail.');
});
