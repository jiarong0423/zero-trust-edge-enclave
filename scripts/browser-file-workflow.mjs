import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes, createHash } from 'node:crypto';
import { businessFixtures } from './business-fixtures.mjs';
import { checkPrivateMapping, mappingProjection, resolvePrivateRoute } from '../private-mapping.js';

const library = process.env.PLAYWRIGHT_MODULE;
if (!library) throw new Error('PLAYWRIGHT_MODULE must identify an installed playwright index.mjs');
const { chromium } = await import(pathToFileURL(path.resolve(library)).href);
const root = path.resolve(import.meta.dirname, '..');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'enclave-browser-file-'));
const env = { PATH: process.env.PATH, HOME: dir, SKIP_LOCAL_ENV: 'true', LOCAL_ONLY: 'true',
  DATA_DIR: dir, PORT: '0', COORDINATOR_PROVIDER: 'synthetic_fixture' };
let server;
let browser;
async function importCredential(page, filePath) {
  const expected = (await fs.readFile(filePath, 'utf8')).trim();
  const chooseButton = page.getByRole('button', { name: '選擇身分憑據檔', exact: true });
  await chooseButton.waitFor({ state: 'visible' });
  const chooser = page.waitForEvent('filechooser');
  await chooseButton.click();
  await (await chooser).setFiles(filePath);
  await page.waitForFunction(value => document.querySelector('#accessToken').value === value &&
    [...document.querySelectorAll('[role="status"]')].some(node => node.textContent === '身分憑據已載入'), expected);
  assert.equal(await page.locator('#accessToken').getAttribute('type'), 'password');
  assert.ok(await page.locator('#accessToken').evaluate(node => node.value.length >= 32));
  assert.equal(await page.locator('input[type=file][accept=".token"]').inputValue(), '');
}
try {
  const setup = spawn(process.execPath, ['scripts/setup-local.mjs', dir], { cwd: root, env, stdio: 'ignore' });
  assert.equal((await once(setup, 'exit'))[0], 0);
  const bundle = businessFixtures();
  const registryPath = path.join(dir, 'access.json');
  const registry = JSON.parse(await fs.readFile(registryPath, 'utf8'));
  const businessTokens = {};
  businessTokens.admin = randomBytes(32).toString('base64url');
  registry.principals.push({ id: 'admin', kind: 'administrator', department: 'unassigned',
    tokenHash: createHash('sha256').update(businessTokens.admin).digest('hex') });
  for (const person of bundle.directory.filter(person => person.id !== 'coordinator')) {
    const token = randomBytes(32).toString('base64url');
    businessTokens[person.id] = token;
    await fs.writeFile(path.join(dir, person.id + '.token'), token, { mode: 0o600 });
    registry.principals.push({ ...person, tokenHash: createHash('sha256').update(token).digest('hex') });
  }
  for (const scenario of bundle.scenarios) {
    registry.grants.push({ id: scenario.id, version: 1, operatorId: scenario.senderId,
      coordinatorId: 'coordinator', recipients: scenario.selectableRecipients, channels: scenario.channels,
      expiresAt: new Date(Date.now() + scenario.ttlHours * 3600000).toISOString(),
      maxAttempts: scenario.maxAttempts, maxOpens: 2, simulatedOutcomes: ['transient', 'prepared'] });
  }
  registry.departments = [...new Set(registry.principals.map(person => person.department || 'unassigned'))]
    .map(id => ({ id, displayName: id, disabled: false }));
  await fs.writeFile(registryPath, JSON.stringify(registry), { mode: 0o600 });
  server = spawn(process.execPath, ['server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const base = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Local server startup timeout')), 10000);
    server.once('exit', () => { clearTimeout(timer); reject(new Error('Local server exited')); });
    server.stdout.on('data', bytes => {
      output += bytes;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
  });
  browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE
    ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
  await context.route('**/*', route => route.request().url().startsWith(base + '/')
    ? route.continue() : route.abort());
  let page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const bytes = Buffer.from('MOCK_ONLY,amount\r\naudit,100\r\n');
  await page.goto(base + '/zh-TW/');
  await page.locator('#accessToken').fill(await fs.readFile(path.join(dir, 'operator.token'), 'utf8'));
  await page.locator('#documentFile').setInputFiles({ name: 'synthetic-audit.csv', mimeType: 'text/csv', buffer: bytes });
  await page.locator('#recipientReview').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('#authorizationId').value === 'local-review');
  assert.ok(!(await page.locator('body').innerText()).includes('MOCK_ONLY'));
  await page.locator('#loadRecipients').click();
  const row = page.locator('#recipientList label');
  await row.locator('span').click();
  assert.equal(await row.locator('input').isChecked(), true);
  await row.locator('span').click();
  assert.equal(await row.locator('input').isChecked(), false);
  await row.locator('input').click();
  assert.equal(await row.locator('input').isChecked(), true);
  const initialLockResponse = page.waitForResponse(response => response.url().endsWith('/confirm-first'));
  await page.locator('#sealBtn').click();
  const initialLock = await (await initialLockResponse).json();
  await page.waitForFunction(() => !document.querySelector('#approveBtn').disabled);
  const adminView = await (await fetch(base + '/api/admin/directory', { headers: { authorization: 'Bearer ' + businessTokens.admin } })).json();
  const mutation = await fetch(base + '/api/admin/directory', { method: 'POST',
    headers: { authorization: 'Bearer ' + businessTokens.admin, 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: adminView.revision, operation: 'grant.update', value: { id: 'local-review', maxOpens: 3 } }) });
  assert.equal(mutation.status, 200);
  await page.reload();
  const senderToken = await fs.readFile(path.join(dir, 'operator.token'), 'utf8');
  await page.locator('#accessToken').fill(senderToken);
  await page.locator('#refreshTasks').click();
  await page.waitForFunction(() => !document.querySelector('#restoreDraft').disabled);
  await page.locator('#restoreDraft').click();
  await page.waitForFunction(() => document.querySelector('#fileStatus').textContent.includes('已接回密件'));
  assert.equal(await page.locator('#approveBtn').isDisabled(), true);
  const oldApproval = await fetch(base + '/api/tasks/' + initialLock.task.id + '/confirm-second', { method: 'POST',
    headers: { authorization: 'Bearer ' + senderToken, 'content-type': 'application/json' },
    body: JSON.stringify({ version: 1, token: initialLock.token }) });
  assert.equal(oldApproval.status, 409);
  await page.locator('#loadRecipients').click();
  await page.locator('#recipientList input').first().waitFor();
  assert.equal(await page.locator('#recipientList input').first().isChecked(), false);
  await page.locator('#recipientList input').first().check();
  await page.locator('#sealBtn').click();
  await page.waitForFunction(() => !document.querySelector('#approveBtn').disabled);
  await page.locator('#approveBtn').click();
  await page.locator('#recipientLink').waitFor({ state: 'visible' });
  const link = await page.locator('#recipientLink').getAttribute('href');
  assert.match(link, /^\/zh-TW\/decode\.html\?id=[a-f0-9-]{36}&version=2$/);
  const senderPage = page;
  page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + link);
  assert.equal(await page.locator('#passphrase').count(), 0);
  await page.locator('#accessToken').fill(await fs.readFile(path.join(dir, 'recipient-a.token'), 'utf8'));
  let verificationFailures = 0;
  let acknowledgementResponseLost = false;
  let keyRequests = 0;
  page.on('request', request => { if (request.url().endsWith('/key')) keyRequests++; });
  await page.route('**/api/file-access/*/receipt', async route => {
    const code = route.request().postDataJSON().code;
    if (code === 'FILE_VERIFIED' && verificationFailures < 3) { verificationFailures++; await route.abort(); return; }
    if (code === 'ACKNOWLEDGED' && !acknowledgementResponseLost) {
      acknowledgementResponseLost = true;
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      await route.abort();
      return;
    }
    await route.continue();
  });
  const downloaded = page.waitForEvent('download');
  const firstReceipt = page.waitForResponse(response => response.url().endsWith('/receipt') && response.request().postDataJSON()?.code === 'DOWNLOAD_REQUESTED');
  await page.locator('#decodeBtn').click();
  const file = await downloaded;
  assert.equal(file.suggestedFilename(), 'synthetic-audit.csv');
  assert.deepEqual(await fs.readFile(await file.path()), bytes);
  await page.waitForFunction(() => !document.querySelector('#retryReceipt').disabled);
  assert.equal(verificationFailures, 3);
  await page.locator('#retryReceipt').click();
  assert.equal((await firstReceipt).status(), 200);
  await page.reload();
  await page.locator('#accessToken').fill(await fs.readFile(path.join(dir, 'recipient-a.token'), 'utf8'));
  await page.waitForFunction(() => !document.querySelector('#acknowledgeFile').disabled);
  await page.locator('#acknowledgeFile').click();
  await page.waitForFunction(() => document.querySelector('#decodeStatus').textContent.includes('已回報完整收件確認'));
  assert.equal(acknowledgementResponseLost, true);
  await page.reload();
  await page.locator('#accessToken').fill(await fs.readFile(path.join(dir, 'recipient-a.token'), 'utf8'));
  await page.waitForFunction(() => document.querySelector('#decodeStatus').textContent.includes('已回報完整收件確認'));
  assert.equal(await page.locator('#acknowledgeFile').isDisabled(), true);
  assert.equal(keyRequests, 1);
  const receiptTask = JSON.parse(await fs.readFile(path.join(dir, 'tasks.json'), 'utf8'))[0];
  assert.equal(receiptTask.fileReceipts.filter(entry => entry.code === 'ACKNOWLEDGED').length, 1);
  await page.unroute('**/api/file-access/*/receipt');
  await senderPage.locator('#refreshDelivery').click();
  await senderPage.waitForFunction(() => document.querySelector('#receiptSummary').textContent.includes('下載回報數: 1'));
  assert.ok((await senderPage.locator('#receiptSummary').innerText()).includes('不代表已閱讀'));
  await senderPage.reload();
  await senderPage.locator('#accessToken').fill(await fs.readFile(path.join(dir, 'operator.token'), 'utf8'));
  const historyResponse = senderPage.waitForResponse(response => response.url() === base + '/api/tasks' && response.request().method() === 'GET');
  await senderPage.locator('#refreshTasks').click();
  const history = await (await historyResponse).json();
  assert.ok(!JSON.stringify(history).includes('ciphertext'));
  assert.ok(!JSON.stringify(history).includes('wrappedKey'));
  await senderPage.waitForFunction(() => document.querySelector('#taskHistory').options.length === 2);
  await senderPage.locator('#taskHistory').selectOption('1');
  await senderPage.locator('#showTask').click();
  await senderPage.locator('#recipientLink').waitFor({ state: 'visible' });
  assert.equal(await senderPage.locator('#recipientLink').getAttribute('href'), link);
  await senderPage.close();
  assert.ok(!(await page.locator('body').innerText()).includes('MOCK_ONLY'));
  assert.deepEqual(errors, []);
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  }
  console.log('PASS: browser upload, double approval, worker status, recipient download, exact CSV bytes, no content preview, desktop/mobile width.');
  for (const scenario of bundle.scenarios) {
    const name = scenario.id === 'procurement' ? 'procurement.docx' : 'audit.pdf';
    const original = await fs.readFile(path.join(root, 'output/isolation/current_runs/20260907_business_pipeline/fixtures', name));
    const sender = await context.newPage();
    sender.on('pageerror', error => errors.push(error.message));
    await sender.goto(base + '/zh-TW/');
    await importCredential(sender, path.join(dir, scenario.senderId + '.token'));
    await sender.locator('#documentFile').setInputFiles({ name, mimeType: 'application/octet-stream', buffer: original });
    await sender.locator('#recipientReview').waitFor({ state: 'visible' });
    await sender.waitForFunction(id => document.querySelector('#authorizationId').value === id, scenario.id);
    await sender.locator('#authorizationId').selectOption(scenario.id);
    await sender.locator('#loadRecipients').click();
    await sender.locator('#recipientList input').first().waitFor();
    assert.equal(await sender.locator('#recipientList input').count(), scenario.selectableRecipients.length);
    const department = bundle.directory.find(person => person.id === scenario.selectedRecipients[0]).department;
    await sender.locator('#recipientDepartment').selectOption(department);
    for (const recipient of scenario.selectableRecipients) {
      await sender.locator('#recipientList label').filter({ hasText: 'MOCK ' + recipient }).locator('input').check();
    }
    for (const recipient of scenario.selectableRecipients.filter(id => !scenario.selectedRecipients.includes(id))) {
      await sender.locator('#recipientList label').filter({ hasText: 'MOCK ' + recipient }).locator('input').uncheck();
    }
    const mode = scenario.id === 'audit' ? 'TIME_LIMITED' : 'REQUIRED_ACK';
    assert.equal(await sender.locator('#requestedExpiryField').isVisible(), false);
    await sender.locator('#deliveryMode').selectOption(mode);
    assert.equal(await sender.locator('#downloadWindowField').isVisible(), mode === 'TIME_LIMITED');
    if (mode === 'TIME_LIMITED') await sender.locator('#downloadWindow').fill('10');
    let recoveredIntakeId;
    if (scenario.id === 'procurement') {
      let captured;
      const capturedResponse = new Promise(resolve => { captured = resolve; });
      await sender.route('**/api/file-tasks', async route => {
        const response = await route.fetch();
        assert.equal(response.status(), 201);
        recoveredIntakeId = (await response.json()).task.id;
        await route.abort();
        captured();
      });
      await sender.locator('#sealBtn').click();
      await capturedResponse;
      await sender.waitForFunction(() => !document.querySelector('#sealBtn').disabled);
      await sender.unroute('**/api/file-tasks');
      await sender.reload();
      await importCredential(sender, path.join(dir, scenario.senderId + '.token'));
      await sender.locator('#refreshTasks').click();
      await sender.waitForFunction(() => !document.querySelector('#restoreDraft').disabled);
      await sender.locator('#restoreDraft').click();
      await sender.waitForFunction(() => document.querySelector('#fileStatus').textContent.includes('已接回密件'));
      await sender.locator('#loadRecipients').click();
      await sender.locator('#recipientList input').first().waitFor();
      assert.equal(await sender.locator('#recipientList input:checked').count(), 0);
      for (const recipient of scenario.selectedRecipients) {
        await sender.locator('#recipientList label').filter({ hasText: 'MOCK ' + recipient }).locator('input').check();
      }
    }
    await sender.locator('#sealBtn').click();
    await sender.waitForFunction(() => !document.querySelector('#approveBtn').disabled);
    const approvalReply = sender.waitForResponse(response => response.url().endsWith('/confirm-second'));
    await sender.locator('#approveBtn').click();
    const approved = await (await approvalReply).json();
    const approvedContent = approved.task.snapshots.at(-1).content;
    assert.equal(approvedContent.deliveryMode, mode);
    if (mode === 'REQUIRED_ACK') {
      assert.equal(approvedContent.downloadUntil, null);
      assert.equal(approvedContent.expiresAt, registry.grants.find(grant => grant.id === scenario.id).expiresAt);
    } else {
      assert.ok(Date.parse(approvedContent.downloadUntil) < Date.parse(approvedContent.expiresAt));
    }
    const id = approved.task.id;
    const version = approved.task.snapshots.at(-1).version;
    const storedTask = JSON.parse(await fs.readFile(path.join(dir, 'tasks.json'), 'utf8')).find(task => task.id === id);
    const snapshot = storedTask.snapshots.find(item => item.version === version);
    assert.equal(snapshot.status, 'APPROVED');
    assert.deepEqual(snapshot.content.recipients, scenario.selectedRecipients);
    checkPrivateMapping(snapshot.privateMapping, id, version, snapshot.content);
    for (const channel of snapshot.content.channels) {
      assert.deepEqual(resolvePrivateRoute(snapshot.privateMapping, snapshot.content, channel),
        scenario.selectedRecipients.map(recipientId => ({ recipientId, endpointId: `dry-run:${recipientId}:${channel}` })));
    }
    const projection = JSON.stringify(mappingProjection(snapshot.privateMapping));
    for (const recipientId of scenario.selectableRecipients) assert.ok(!projection.includes(recipientId));
    if (recoveredIntakeId) { assert.equal(id, recoveredIntakeId); assert.equal(version, 2); }
    await sender.close();
    let job;
    for (let retry = 0; retry < 60; retry++) {
      const response = await fetch(base + '/api/tasks/' + id, { headers: { authorization: 'Bearer ' + businessTokens[scenario.senderId] } });
      assert.equal(response.status, 200);
      job = (await response.json()).task.jobs.find(item => item.version === version);
      if (job.status === 'DRY_RUN_PREPARED') break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(job.status, 'DRY_RUN_PREPARED');
    assert.equal(job.attempts, 2);
    await page.goto(base + '/zh-TW/decode.html?id=' + id + '&version=' + version);
    for (const denied of scenario.deniedRecipients) {
      await importCredential(page, path.join(dir, denied + '.token'));
      const reply = page.waitForResponse(response => response.url().endsWith('/packet'));
      await page.locator('#decodeBtn').click();
      assert.equal((await reply).status(), 403);
      await page.waitForFunction(() => !document.querySelector('#decodeBtn').disabled);
      for (const action of ['credential', 'key']) {
        const response = await fetch(base + '/api/file-access/' + id + '/' + action, {
          method: 'POST', headers: { authorization: 'Bearer ' + businessTokens[denied], 'content-type': 'application/json' },
          body: JSON.stringify({ version, ...(action === 'key' ? { credential: 'a'.repeat(43) } : {}) })
        });
        assert.equal(response.status, 403);
      }
    }
    await importCredential(page, path.join(dir, scenario.selectedRecipients[0] + '.token'));
    const downloadPromise = page.waitForEvent('download');
    const receiptPromise = page.waitForResponse(response => response.url().endsWith('/receipt') && response.request().postDataJSON()?.code === 'DOWNLOAD_REQUESTED');
    await page.locator('#decodeBtn').click();
    const artifact = await downloadPromise;
    assert.equal(artifact.suggestedFilename(), name);
    assert.deepEqual(await fs.readFile(await artifact.path()), original);
    const receiptResponse = await receiptPromise;
    assert.equal(receiptResponse.status(), 200);
    assert.equal((await receiptResponse.json()).evidence, 'CLIENT_REPORTED');
    await page.waitForFunction(() => !document.querySelector('#acknowledgeFile').disabled);
    await page.locator('#acknowledgeFile').click();
    await page.waitForFunction(() => document.querySelector('#decodeStatus').textContent.includes('已回報完整收件確認'));
    const statusResponse = await fetch(base + '/api/tasks/' + id, { headers: { authorization: 'Bearer ' + businessTokens[scenario.senderId] } });
    const summary = (await statusResponse.json()).task.jobs[0].receiptSummary;
    assert.equal(summary.downloadReportCount, 1);
    assert.equal(summary.acknowledgedCount, 1);
    assert.equal(summary.provesReading, false);
    const savedReceiptTask = JSON.parse(await fs.readFile(path.join(dir, 'tasks.json'), 'utf8')).find(task => task.id === id);
    assert.equal(savedReceiptTask.fileReceipts.filter(entry => entry.code === 'ACKNOWLEDGED').length, 1);
    const observer = await context.newPage();
    await observer.goto(base + '/zh-TW/');
    await importCredential(observer, path.join(dir, scenario.senderId + '.token'));
    await observer.locator('#refreshTasks').click();
    await observer.waitForFunction(() => document.querySelector('#taskHistory').options.length > 0);
    const historyValue = await observer.locator('#taskHistory option').evaluateAll((options, expected) =>
      options.find(option => option.textContent.includes(expected.id) && option.textContent.includes(`| v${expected.version} |`))?.value,
    { id, version });
    assert.notEqual(historyValue, undefined);
    await observer.locator('#taskHistory').selectOption(historyValue);
    await observer.locator('#showTask').click();
    await observer.waitForFunction(() => document.querySelector('#receiptSummary').textContent.includes('下載回報數: 1'));
    assert.ok((await observer.locator('#receiptSummary').textContent()).includes('已確認收件人數: 1'));
    await observer.close();
    assert.equal(await page.locator('#protectedView').count(), 0);
    console.log('PASS: ' + scenario.id + ' sender/recipient credential file chooser, department/subset, persisted private mapping, double approval, denied recipient, exact download, acknowledgement and sender receipt.');
  }
  const admin = await context.newPage();
  admin.on('pageerror', error => errors.push(error.message));
  await admin.goto(base + '/zh-TW/admin.html');
  await admin.locator('#accessToken').fill(businessTokens['manager-sender']);
  await admin.locator('#loadDirectory').click();
  await admin.waitForFunction(() => document.querySelector('#adminStatus').textContent.includes('需要管理員'));
  assert.equal(await admin.locator('#adminWorkspace').isVisible(), false);
  await admin.locator('#accessToken').fill(businessTokens.admin);
  await admin.locator('#loadDirectory').click();
  await admin.locator('#adminWorkspace').waitFor({ state: 'visible' });
  await admin.locator('#admin-id').fill('legal');
  await admin.locator('#admin-displayName').fill('Legal');
  const createDepartment = admin.waitForResponse(response => response.url().endsWith('/api/admin/directory') && response.request().method() === 'POST');
  await admin.locator('#adminForm [type=submit]').click();
  assert.equal((await createDepartment).status(), 200);
  await admin.waitForFunction(() => document.querySelector('#adminStatus').textContent.includes('變更已儲存'));
  await admin.locator('#adminCategory').selectOption('person');
  await admin.locator('#adminRecord').selectOption('sales-c');
  await admin.locator('#admin-department').selectOption('legal');
  await admin.locator('#admin-disabled').check();
  const changePerson = admin.waitForResponse(response => response.url().endsWith('/api/admin/directory') && response.request().method() === 'POST');
  await admin.locator('#adminForm [type=submit]').click();
  const changed = await (await changePerson).json();
  assert.equal(changed.principals.find(person => person.id === 'sales-c').department, 'legal');
  assert.equal(changed.principals.find(person => person.id === 'sales-c').disabled, true);
  assert.ok(!JSON.stringify(changed).includes('tokenHash'));
  await admin.locator('#adminRecord').selectOption('');
  await admin.locator('#admin-id').fill('qa-operator');
  await admin.locator('#admin-kind').selectOption('operator');
  await admin.locator('#admin-department').selectOption('legal');
  await admin.locator('#admin-displayName').fill('Synthetic operator');
  const createPerson = admin.waitForResponse(response => response.url().endsWith('/api/admin/directory') && response.request().method() === 'POST');
  await admin.locator('#adminForm [type=submit]').click();
  assert.equal((await createPerson).status(), 200);
  await admin.locator('#downloadCredential').waitFor({ state: 'visible' });
  const credentialDownload = admin.waitForEvent('download');
  await admin.locator('#downloadCredential').click();
  const oldCredentialFile = await credentialDownload;
  assert.equal(oldCredentialFile.suggestedFilename(), 'qa-operator.token');
  const oldToken = await fs.readFile(await oldCredentialFile.path(), 'utf8');
  assert.match(oldToken, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(!(await admin.locator('body').innerText()).includes(oldToken));
  assert.equal((await fetch(base + '/api/authorizations', { headers: { authorization: 'Bearer ' + oldToken } })).status, 200);
  await admin.locator('#adminCategory').selectOption('grant');
  await admin.locator('#admin-id').fill('qa-grant');
  await admin.locator('#admin-operatorId').selectOption('qa-operator');
  await admin.locator('#admin-coordinatorId').selectOption('coordinator');
  await admin.locator('input[name=recipients][value=sales-a]').check();
  await admin.locator('input[name=channels][value=email]').check();
  await admin.locator('#admin-expiresAt').fill(new Date(Date.now() + 3600000).toISOString());
  const createGrant = admin.waitForResponse(response => response.url().endsWith('/api/admin/directory') && response.request().method() === 'POST');
  await admin.locator('#adminForm [type=submit]').click();
  const createdGrant = (await (await createGrant).json()).grants.find(grant => grant.id === 'qa-grant');
  assert.equal(createdGrant.version, 1);
  assert.deepEqual(createdGrant.recipients, ['sales-a']);
  await admin.locator('#adminRecord').selectOption('qa-grant');
  await admin.locator('#admin-maxAttempts').fill('2');
  const updateGrant = admin.waitForResponse(response => response.url().endsWith('/api/admin/directory') && response.request().method() === 'POST');
  await admin.locator('#adminForm [type=submit]').click();
  const updatedGrant = (await (await updateGrant).json()).grants.find(grant => grant.id === 'qa-grant');
  assert.equal(updatedGrant.version, 2);
  assert.equal(updatedGrant.maxAttempts, 2);
  assert.deepEqual(updatedGrant.recipients, ['sales-a']);
  await admin.locator('#adminCategory').selectOption('person');
  await admin.locator('#adminRecord').selectOption('qa-operator');
  const rotate = admin.waitForResponse(response => response.url().endsWith('/api/admin/directory') && response.request().method() === 'POST');
  await admin.locator('#rotateCredential').click();
  const rotated = await (await rotate).json();
  assert.equal(rotated.grants.find(grant => grant.id === 'qa-grant').version, 3);
  await admin.locator('#downloadCredential').waitFor({ state: 'visible' });
  const rotatedDownload = admin.waitForEvent('download');
  await admin.locator('#downloadCredential').click();
  const newToken = await fs.readFile(await (await rotatedDownload).path(), 'utf8');
  assert.notEqual(newToken, oldToken);
  assert.equal((await fetch(base + '/api/authorizations', { headers: { authorization: 'Bearer ' + oldToken } })).status, 401);
  assert.equal((await fetch(base + '/api/authorizations', { headers: { authorization: 'Bearer ' + newToken } })).status, 200);
  assert.ok(!(await admin.locator('body').innerText()).includes(newToken));
  const retentionReply = admin.waitForResponse(response => response.url().endsWith('/api/admin/retention'));
  await admin.locator('#loadRetention').click();
  const retention = await (await retentionReply).json();
  assert.equal(retention.automaticDeletion, false);
  assert.ok(retention.retainedCount > 0);
  assert.ok(!JSON.stringify(retention).includes('ciphertext'));
  await admin.waitForFunction(() => document.querySelector('#retentionRows').children.length > 0);
  assert.equal(await admin.locator('[data-i18n="Status"]').textContent(), '狀態');
  assert.equal(await admin.locator('[data-i18n="Reasons"]').textContent(), '原因');
  const screenshots = path.join(root, 'output/isolation/current_runs/20260907_business_pipeline/admin-preview');
  await fs.mkdir(screenshots, { recursive: true });
  for (const width of [1280, 390]) {
    await admin.setViewportSize({ width, height: 900 });
    await admin.evaluate(() => scrollTo(0, 0));
    await admin.waitForFunction(() => scrollY === 0);
    assert.ok(await admin.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await admin.screenshot({ path: path.join(screenshots, 'admin-' + width + '.png'), fullPage: true });
  }
  console.log('PASS: administrator privilege denial, department/person/grant changes, credential download/rotation, retention and desktop/mobile layout.');
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  if (server && server.exitCode === null) { server.kill(); await once(server, 'exit'); }
  await fs.rm(dir, { recursive: true, force: true });
}
