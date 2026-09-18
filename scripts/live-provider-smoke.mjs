import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { requestFileAdvice } from '../file-adviser.js';
import { advanceFileJobs } from '../file-worker.js';
import { newTask, confirmFirst, confirmSecond } from '../snapshot-lifecycle.js';
import { sealFileBytes } from '../public/file-envelope.js';

if (!process.argv.includes('--live') || !process.env.NEBIUS_API_KEY) throw Error('Explicit --live and backend key required');
const root = path.resolve(import.meta.dirname, '..');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'enclave-live-proof-'));
const report = { timestamp: new Date().toISOString(), syntheticDocumentsOnly: true, calls: [], checks: {} };
const options = { provider: 'nebius', localOnly: false, baseUrl: 'https://api.tokenfactory.nebius.com/v1',
  model: process.env.NEBIUS_MODEL || 'nvidia/nemotron-3-super-120b-a12b', apiKey: process.env.NEBIUS_API_KEY };
let server;
let mcp;
let sealed;
const run = async (script, args, env) => {
  const child = spawn(process.execPath, [script, ...args], { cwd: root, env, stdio: 'ignore' });
  assert.equal((await once(child, 'exit'))[0], 0);
};
try {
  const env = { PATH: process.env.PATH, HOME: dir, SKIP_LOCAL_ENV: 'true', DATA_DIR: dir, PORT: '0',
    LOCAL_ONLY: 'false', COORDINATOR_PROVIDER: 'nebius', DEMO_FALLBACK_ENABLED: 'false',
    NEBIUS_API_KEY: options.apiKey, NEBIUS_MODEL: options.model };
  await run('scripts/setup-local.mjs', [dir], env);
  const config = JSON.parse(await fs.readFile(path.join(dir, 'access.json'), 'utf8'));
  const grant = config.grants[0];
  grant.channels = ['email', 'internal_queue'];
  grant.simulatedOutcomes = ['prepared'];
  await fs.writeFile(path.join(dir, 'access.json'), JSON.stringify(config), { mode: 0o600 });
  const actor = config.principals.find(p => p.id === grant.operatorId);
  sealed = await sealFileBytes(new TextEncoder().encode('SYNTHETIC_ONLY,value\nprobe,1\n'), 'probe.csv');
  const draft = newTask(actor, grant, { documentHash: sealed.commitment, recipients: grant.recipients,
    channels: grant.channels, expiresAt: grant.expiresAt });
  draft.file = { packet: sealed.packet };
  const first = confirmFirst(draft, actor, grant, 1);
  const approved = confirmSecond(first.task, actor, grant, 1, first.token);
  const advise = async metadata => {
    const entry = { input: metadata, requestedModel: options.model };
    report.calls.push(entry);
    const start = Date.now();
    const answer = await requestFileAdvice(metadata, options, async (url, init) => {
      const response = await fetch(url, init);
      entry.httpStatus = response.status;
      const body = await response.clone().json();
      entry.responseModel = body.model;
      entry.finishReason = body.choices?.[0]?.finish_reason;
      entry.usage = body.usage;
      return response;
    });
    entry.elapsedMs = Date.now() - start;
    entry.provider = answer.provider;
    entry.validatedAdvice = answer.advice;
    return answer.advice;
  };
  const done = await advanceFileJobs(approved, config, Date.now(), advise);
  assert.equal(done.jobs[0].status, 'DRY_RUN_PREPARED');
  assert.deepEqual(done.jobs[0].routeAdvice, report.calls[0].validatedAdvice);
  report.checks.workerUsedModelAdvice = true;
  report.worker = { state: done.jobs[0].status, advice: done.jobs[0].routeAdvice, sendsEmail: false };
  const metadata = report.calls[0].input;
  const retryAdvice = await advise({ ...metadata, state: 'RETRY_WAIT', attempts: 1 });
  assert.equal(retryAdvice.action, 'PAUSE');
  assert.equal(retryAdvice.reasonCode, 'INSUFFICIENT_INFORMATION');
  report.checks.retryAbstainedWithoutHistory = true;
  for (const [name, modify] of [['unapprovedChannel', advice => ({ ...advice, channel: 'external' })],
    ['recipientExpansion', advice => ({ ...advice, recipients: ['unapproved'] })]]) {
    const blocked = await advanceFileJobs(approved, config, Date.now(), async () => modify(report.calls[0].validatedAdvice));
    assert.equal(blocked.jobs[0].status, 'PAUSED');
    assert.equal(blocked.jobs[0].delivery, undefined);
    report.checks[name + 'BlockedByCode'] = true;
  }
  await fs.writeFile(path.join(dir, 'tasks.json'), JSON.stringify([done]), { mode: 0o600 });
  await fs.writeFile(path.join(dir, 'packages.json'), '[]\n', { mode: 0o600 });
  await fs.writeFile(path.join(dir, 'audit.json'), '[]\n', { mode: 0o600 });
  server = spawn(process.execPath, ['server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'ignore'] });
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Server startup timeout')), 10000);
    let text = '';
    server.stdout.on('data', bytes => { text += bytes; const match = text.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timer); resolve(match[0]); } });
    server.once('exit', () => { clearTimeout(timer); reject(Error('Server stopped')); });
  });
  mcp = spawn(process.execPath, ['scripts/coordinator-mcp.mjs'], { cwd: root,
    env: { PATH: process.env.PATH, COORDINATOR_BASE_URL: base, COORDINATOR_TOKEN_FILE: path.join(dir, 'coordinator.token') },
    stdio: ['pipe', 'pipe', 'ignore'] });
  const reply = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('MCP timeout')), 25000);
    let text = '';
    mcp.stdout.on('data', bytes => { text += bytes; if (text.includes('\n')) {
      clearTimeout(timer); try { resolve(JSON.parse(text.split('\n')[0])); } catch { reject(Error('MCP invalid JSON')); } } });
    mcp.once('exit', () => { clearTimeout(timer); reject(Error('MCP stopped')); });
  });
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'file_recommend', arguments: { taskAlias: metadata.taskAlias, snapshotVersion: 1 } } }) + '\n');
  const message = await reply;
  assert.equal(message.result.isError, false);
  const result = JSON.parse(message.result.content[0].text);
  assert.equal(result.provider, 'nebius_token_factory');
  assert.equal(result.ok, true);
  report.mcp = result;
  report.checks.mcpRealProvider = true;
  report.ok = true;
} catch {
  report.ok = false;
  report.failure = 'LIVE_PROOF_INCOMPLETE';
  process.exitCode = 1;
} finally {
  sealed?.key.fill(0);
  for (const child of [mcp, server]) if (child && child.exitCode === null) {
    const exit = once(child, 'exit'); child.kill('SIGTERM'); await exit;
  }
  await fs.rm(dir, { recursive: true, force: true });
  const output = path.join(root, 'output/isolation/current_runs/20260907_business_pipeline/live-provider');
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'evidence.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(report));
}
