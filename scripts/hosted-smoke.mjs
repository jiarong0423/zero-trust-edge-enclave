#!/usr/bin/env node
// One-task smoke test for a running instance (the hosted demo, or a local server), run by the
// owner in their own terminal so that no credential ever has to be pasted into a chat.
//
//   SMOKE_BASE_URL=https://<host> SMOKE_TOKEN_DIR=<private dir> \
//   [SMOKE_GATE_USER=<user> SMOKE_GATE_PASSWORD=<password>] \
//   [SMOKE_EXPECT_PROVIDER=nebius_token_factory|synthetic_fixture|local_openai_compatible|any] \
//   node scripts/hosted-smoke.mjs
//
// Configuration comes only from the process environment. Nothing is read from a .env file and no
// argument is accepted. No request is made until the whole configuration has been validated.
// Exit codes: 0 every step passed, 1 a step failed, 2 configuration or usage error.
//
// Secrets (access tokens, the sign-in password and cookie, the document key, the file credential,
// the ciphertext and the plaintext) are held in memory only and are redacted from everything this
// script prints. One task, one synthetic document, one recipient; the task is revoked at the end.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { sealFileBytes, openFileBytes } from '../public/file-envelope.js';

const USER_AGENT = 'zte-hosted-smoke';
const FILE_NAME = 'smoke-test.csv';
const DOCUMENT = 'SMOKE_TEST_SYNTHETIC,amount\r\nrow,1\r\n';
const SENDER = 'manager-sender';
const RECIPIENT = 'sales-a';
const OTHER_RECIPIENT = 'sales-b';
const PREFERRED_GRANT = 'procurement';
const PROVIDERS = ['nebius_token_factory', 'synthetic_fixture', 'local_openai_compatible', 'any'];

// /api/health reports the configured COORDINATOR_PROVIDER value ("nebius"), while the evidence trail
// names the outlet that answered ("nebius_token_factory"). They are the same provider; compare in one
// vocabulary. (A first version compared them raw and reported a healthy hosted instance as a failure.)
export function providerLabel(configured) {
  return configured === 'nebius' ? 'nebius_token_factory' : configured;
}
const REQUEST_TIMEOUT_MS = 20_000;
const POLL_LIMIT_MS = 60_000;
const POLL_INTERVAL_MS = 1_000;
const DELIVERY_DEADLINE_MS = 5 * 60_000;
const TASK_LIFETIME_MS = 15 * 60_000;
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{32,256}$/;

class ConfigError extends Error {}

const secrets = new Set();
const remember = (value, minimum = 4) => {
  if (typeof value === 'string' && value.length >= minimum) secrets.add(value);
};

export function redact(text) {
  let output = String(text);
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) output = output.split(secret).join('[REDACTED]');
  return output
    .replace(/[A-Za-z0-9_-]{43,}/g, '[REDACTED]')
    .replace(/\b[a-f0-9]{64}\b/g, '[REDACTED]')
    .replace(/[A-Za-z0-9+/]{60,}={0,2}/g, '[REDACTED]');
}

const safe = value => (/^[A-Za-z0-9_.:-]{1,60}$/.test(String(value)) ? String(value) : '?');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const posix = process.platform !== 'win32';

function writeOut(stream, line) { stream.write(redact(line) + '\n'); }

async function privateEntry(target, kind) {
  const stat = await fs.lstat(target);
  if (kind === 'directory' ? !stat.isDirectory() : !stat.isFile()) {
    throw new ConfigError(`${kind === 'directory' ? 'SMOKE_TOKEN_DIR must be a directory' : 'token entry must be a regular file'}: ${path.basename(target)}`);
  }
  if (posix && (stat.mode & 0o077) !== 0) {
    throw new ConfigError(`${path.basename(target)} is group or other accessible; run chmod ${kind === 'directory' ? '700' : '600'} on it`);
  }
}

// Validates everything and reads the token files. Makes no network request.
export async function loadConfig(env, argv = []) {
  if (argv.length) throw new ConfigError('no command-line arguments are accepted; use the SMOKE_* environment variables');
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new ConfigError('NODE_TLS_REJECT_UNAUTHORIZED=0 is refused: credentials must not travel over an unverified channel');
  const rawUrl = env.SMOKE_BASE_URL;
  if (!rawUrl) throw new ConfigError('SMOKE_BASE_URL is required');
  let url;
  try { url = new URL(rawUrl); } catch { throw new ConfigError('SMOKE_BASE_URL is not a valid URL'); }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === '127.0.0.1')) {
    throw new ConfigError('SMOKE_BASE_URL must be https://<host> or http://127.0.0.1:<port>');
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new ConfigError('SMOKE_BASE_URL must be an origin only (no credentials, path, query or fragment)');
  }
  const expect = env.SMOKE_EXPECT_PROVIDER || 'any';
  if (!PROVIDERS.includes(expect)) throw new ConfigError(`SMOKE_EXPECT_PROVIDER must be one of ${PROVIDERS.join(', ')}`);
  const gateUser = env.SMOKE_GATE_USER || '';
  const gatePassword = env.SMOKE_GATE_PASSWORD || '';
  if (Boolean(gateUser) !== Boolean(gatePassword)) throw new ConfigError('SMOKE_GATE_USER and SMOKE_GATE_PASSWORD must be set together or not at all');
  if (gateUser.length > 512 || gatePassword.length > 512) throw new ConfigError('sign-in values are too long');
  if (!env.SMOKE_TOKEN_DIR) throw new ConfigError('SMOKE_TOKEN_DIR is required');
  let directory;
  try { directory = await fs.realpath(path.resolve(env.SMOKE_TOKEN_DIR)); }
  catch { throw new ConfigError('SMOKE_TOKEN_DIR does not exist'); }
  await privateEntry(directory, 'directory');
  const tokens = {};
  for (const id of [SENDER, RECIPIENT, OTHER_RECIPIENT]) {
    const file = path.join(directory, `${id}.token`);
    try { await privateEntry(file, 'file'); }
    catch (error) {
      if (error instanceof ConfigError) throw error;
      throw new ConfigError(`${id}.token is missing or unreadable`);
    }
    const token = (await fs.readFile(file, 'utf8')).trim();
    if (!TOKEN_SHAPE.test(token)) throw new ConfigError(`${id}.token does not look like an access token`);
    tokens[id] = token;
    remember(token);
  }
  remember(gatePassword, 1);
  return { origin: url.origin, expect, gate: gateUser ? { user: gateUser, password: gatePassword } : null, tokens };
}

export async function runSmoke(config, { out = line => writeOut(process.stdout, line) } = {}) {
  const { origin, expect, gate, tokens } = config;
  const results = [];
  const ctx = { cookie: null, grant: null, taskId: null, version: null, packet: null, expiresAt: null, revoked: false };

  async function call(method, route, { token, body } = {}) {
    const headers = { 'user-agent': USER_AGENT, accept: 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    if (ctx.cookie) headers.cookie = ctx.cookie;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(origin + route, { method, headers, redirect: 'manual',
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: response.status, json, setCookie: response.headers.getSetCookie?.() ?? [] };
  }
  const describe = result => `HTTP ${result.status}${typeof result.json?.error === 'string' ? ` "${result.json.error.slice(0, 100)}"` : ''}`;
  const expectStatus = (result, status, label) => {
    if (result.status !== status) throw new Error(`${label} returned ${describe(result)}, expected ${status}`);
    return result.json ?? {};
  };
  const need = (value, label) => {
    if (value === null || value === undefined) throw new Error(`not run: ${label} is unavailable`);
    return value;
  };
  const reason = error => {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'request timed out';
    if (error?.cause?.code) return `network error ${safe(error.cause.code)}`;
    return String(error?.message || error).slice(0, 240);
  };
  async function step(name, run) {
    try {
      const detail = await run();
      out(`PASS ${name}${detail ? `: ${detail}` : ''}`);
      results.push({ name, ok: true });
    } catch (error) {
      out(`FAIL ${name}: ${reason(error)}`);
      results.push({ name, ok: false });
    }
  }

  await step('health', async () => {
    const health = expectStatus(await call('GET', '/api/health'), 200, 'health');
    const budget = health.nebiusBudget && typeof health.nebiusBudget === 'object' ? health.nebiusBudget : {};
    const budgetText = budget.limited ? `limited spentUsd=${safe(budget.spentUsd)} exhausted=${safe(budget.exhausted)}` : 'unlimited';
    const detail = `adviserProvider=${safe(health.adviserProvider)} nebiusConfigured=${safe(health.nebiusConfigured)} ` +
      `demoFallbackEnabled=${safe(health.demoFallbackEnabled)} nebiusBudget=${budgetText}`;
    if (expect === 'nebius_token_factory' && health.demoFallbackEnabled === true) {
      throw new Error(`demoFallbackEnabled is true while a Nebius answer is expected (${detail})`);
    }
    if (expect !== 'any' && providerLabel(health.adviserProvider) !== expect) throw new Error(`adviserProvider is not ${expect} (${detail})`);
    if (expect === 'nebius_token_factory' && budget.limited && budget.exhausted === true) throw new Error(`Nebius budget is exhausted (${detail})`);
    return detail;
  });

  if (gate) {
    await step('judge-signin', async () => {
      const result = await call('POST', '/api/judge-login', { body: { user: gate.user, password: gate.password } });
      expectStatus(result, 200, 'judge sign-in');
      const raw = result.setCookie.find(value => value.startsWith('enclave_gate='));
      if (!raw) throw new Error('sign-in succeeded but no session cookie was set');
      const value = raw.split(';')[0].slice('enclave_gate='.length);
      if (!value) throw new Error('session cookie is empty');
      remember(value);
      ctx.cookie = `enclave_gate=${value}`;
      return 'session cookie held in memory only';
    });
  }

  await step('whoami-unauthenticated', async () => {
    const result = await call('GET', '/api/whoami');
    if (result.status !== 401) throw new Error(`expected 401 without a token, got ${describe(result)}`);
    return 'HTTP 401';
  });

  await step('whoami-identities', async () => {
    const wanted = [[SENDER, 'operator'], [RECIPIENT, 'recipient'], [OTHER_RECIPIENT, 'recipient']];
    for (const [id, kind] of wanted) {
      const body = expectStatus(await call('GET', '/api/whoami', { token: tokens[id] }), 200, `whoami ${id}`);
      if (body.kind !== kind) throw new Error(`${id} is kind ${safe(body.kind)}, expected ${kind}`);
    }
    return wanted.map(([id, kind]) => `${id}=${kind}`).join(' ');
  });

  await step('grant-select', async () => {
    const body = expectStatus(await call('GET', '/api/authorizations', { token: tokens[SENDER] }), 200, 'authorizations');
    const grants = Array.isArray(body.grants) ? body.grants : [];
    const usable = grant => grant && typeof grant.id === 'string' && Array.isArray(grant.recipients) &&
      grant.recipients.includes(RECIPIENT) && grant.recipients.includes(OTHER_RECIPIENT) &&
      Array.isArray(grant.channels) && grant.channels.length > 0 && Date.parse(grant.expiresAt) > Date.now() + 2 * 60_000;
    const grant = grants.find(item => item.id === PREFERRED_GRANT && usable(item)) || grants.find(usable);
    if (!grant) throw new Error(`no active grant lists both ${RECIPIENT} and ${OTHER_RECIPIENT} with at least two minutes left`);
    ctx.grant = grant;
    return `grant ${safe(grant.id)} v${safe(grant.version)}, channels=${grant.channels.map(safe).join(',')}`;
  });

  await step('stage-file-task', async () => {
    const grant = need(ctx.grant, 'grant');
    const sealed = await sealFileBytes(new TextEncoder().encode(DOCUMENT), FILE_NAME);
    const keyHex = Buffer.from(sealed.key).toString('hex');
    for (const value of [keyHex, Buffer.from(sealed.key).toString('base64'), sealed.packet.ciphertext, sealed.packet.iv, DOCUMENT, 'SMOKE_TEST_SYNTHETIC']) remember(value, 6);
    const now = Date.now();
    const expiresAt = new Date(Math.min(now + TASK_LIFETIME_MS, Date.parse(grant.expiresAt))).toISOString();
    const deliveryDeadline = new Date(Math.min(now + DELIVERY_DEADLINE_MS, Date.parse(expiresAt))).toISOString();
    const staged = await call('POST', '/api/file-tasks', { token: tokens[SENDER], body: {
      authorizationId: grant.id, recipients: [RECIPIENT], channels: grant.channels, expiresAt, deliveryDeadline,
      deliveryMode: 'REQUIRED_ACK', downloadUntil: null, packet: sealed.packet, documentKey: keyHex } });
    sealed.key.fill(0);
    const body = expectStatus(staged, 201, 'stage file task');
    const snapshot = body.task?.snapshots?.at(-1);
    if (typeof body.task?.id !== 'string' || !Number.isSafeInteger(snapshot?.version)) throw new Error('stage response is missing the task id or version');
    ctx.taskId = body.task.id;
    ctx.version = snapshot.version;
    ctx.expiresAt = expiresAt;
    return `task ${ctx.taskId} v${ctx.version} for ${RECIPIENT} only, expires ${expiresAt}`;
  });

  await step('approve', async () => {
    const taskId = need(ctx.taskId, 'task');
    const route = `/api/tasks/${taskId}`;
    const first = expectStatus(await call('POST', `${route}/confirm-first`, { token: tokens[SENDER], body: { version: ctx.version } }), 200, 'confirm-first');
    if (typeof first.token !== 'string') throw new Error('confirm-first returned no confirmation token');
    remember(first.token);
    const second = expectStatus(await call('POST', `${route}/confirm-second`, { token: tokens[SENDER], body: { version: ctx.version, token: first.token } }), 200, 'confirm-second');
    const status = second.task?.snapshots?.find(item => item.version === ctx.version)?.status;
    if (status !== 'APPROVED') throw new Error(`snapshot is ${safe(status)}, expected APPROVED`);
    return 'confirm-first and confirm-second accepted';
  });

  await step('worker-prepared', async () => {
    const taskId = need(ctx.taskId, 'task');
    const started = Date.now();
    for (;;) {
      const body = expectStatus(await call('GET', `/api/tasks/${taskId}`, { token: tokens[SENDER] }), 200, 'task view');
      const job = body.task?.jobs?.find(item => item.version === ctx.version);
      if (job?.status === 'DRY_RUN_PREPARED') return `DRY_RUN_PREPARED after ${Math.round((Date.now() - started) / 1000)}s`;
      if (job && ['PAUSED', 'REVOKED', 'OUTCOME_UNKNOWN'].includes(job.status)) {
        throw new Error(`job stopped at ${safe(job.status)} (reasonCode=${safe(job.reasonCode)})`);
      }
      if (Date.now() - started >= POLL_LIMIT_MS) {
        throw new Error(`job not prepared within ${POLL_LIMIT_MS / 1000}s (status=${safe(job?.status)}, adviceRetries=${safe(job?.adviceRetries)}, reasonCode=${safe(job?.reasonCode)})`);
      }
      await sleep(POLL_INTERVAL_MS);
    }
  });

  await step('evidence-provider', async () => {
    const taskId = need(ctx.taskId, 'task');
    const body = expectStatus(await call('GET', `/api/tasks/${taskId}/evidence`, { token: tokens[SENDER] }), 200, 'evidence');
    const trail = Array.isArray(body.evidence?.trail) ? body.evidence.trail : [];
    const route = trail.filter(entry => entry.kind === 'route').at(-1);
    const source = typeof route?.source === 'string' ? route.source : null;
    const detail = `routing advice answered by ${safe(source ?? 'unknown')} (adviser calls=${trail.length})`;
    if (trail.some(entry => entry.realValuesInInput !== 0)) throw new Error(`an adviser input carried a real identifier (${detail})`);
    if (expect !== 'any' && source !== expect) throw new Error(`provider mismatch: expected ${expect}, ${detail}`);
    if (!source) throw new Error(`no routing source was recorded (${detail})`);
    return detail;
  });

  await step('recipient-decrypt', async () => {
    const taskId = need(ctx.taskId, 'task');
    const access = `/api/file-access/${taskId}`;
    const asRecipient = (action, body) => call('POST', `${access}/${action}`, { token: tokens[RECIPIENT], body });
    const packetBody = expectStatus(await asRecipient('packet', { version: ctx.version }), 200, 'packet');
    const credentialBody = expectStatus(await asRecipient('credential', { version: ctx.version }), 201, 'credential');
    if (typeof credentialBody.credential !== 'string') throw new Error('no credential was issued');
    remember(credentialBody.credential);
    const keyBody = expectStatus(await asRecipient('key', { version: ctx.version, credential: credentialBody.credential }), 200, 'key');
    if (typeof keyBody.key !== 'string' || !/^[a-f0-9]{64}$/.test(keyBody.key)) throw new Error('key response is malformed');
    remember(keyBody.key);
    const key = Uint8Array.from(Buffer.from(keyBody.key, 'hex'));
    let opened;
    try { opened = await openFileBytes(packetBody.packet, key); }
    catch { throw new Error('the released key did not decrypt the packet'); }
    finally { key.fill(0); }
    if (opened.name !== FILE_NAME) throw new Error('decrypted file name differs from the one sealed');
    if (Buffer.from(opened.bytes).toString('utf8') !== DOCUMENT) throw new Error('decrypted plaintext differs from the synthetic document');
    opened.bytes.fill(0);
    const replay = await asRecipient('key', { version: ctx.version, credential: credentialBody.credential });
    if (replay.status < 400 || replay.status >= 500 || replay.json?.key) throw new Error(`a used credential was not refused (${describe(replay)})`);
    return `packet, one-use credential and key obtained; plaintext verified locally; credential replay refused (HTTP ${replay.status})`;
  });

  await step('non-recipient-denied', async () => {
    const taskId = need(ctx.taskId, 'task');
    const identity = expectStatus(await call('GET', '/api/whoami', { token: tokens[OTHER_RECIPIENT] }), 200, `whoami ${OTHER_RECIPIENT}`);
    if (identity.kind !== 'recipient') throw new Error(`${OTHER_RECIPIENT} is no longer a recipient identity`);
    const messages = [];
    for (const action of ['packet', 'credential']) {
      const result = await call('POST', `/api/file-access/${taskId}/${action}`, { token: tokens[OTHER_RECIPIENT], body: { version: ctx.version } });
      if (result.status !== 403) throw new Error(`${action} for ${OTHER_RECIPIENT} returned ${describe(result)}, expected 403`);
      if (result.json?.packet || result.json?.credential || result.json?.key) throw new Error(`${action} refusal still carried material`);
      messages.push(`${action}: HTTP 403 "${String(result.json?.error ?? '').slice(0, 60)}"`);
    }
    return `authenticated (whoami 200) but denied; ${messages.join('; ')}`;
  });

  // Always attempted when a task exists, so the smoke test leaves nothing deliverable behind.
  if (ctx.taskId && Number.isSafeInteger(ctx.version)) {
    await step('revoke', async () => {
      expectStatus(await call('POST', `/api/tasks/${ctx.taskId}/revoke`, { token: tokens[SENDER], body: { version: ctx.version } }), 200, 'revoke');
      ctx.revoked = true;
      const after = await call('POST', `/api/file-access/${ctx.taskId}/credential`, { token: tokens[RECIPIENT], body: { version: ctx.version } });
      if (after.status < 400 || after.status >= 500) throw new Error(`revoked task still answered ${describe(after)}`);
      return `snapshot v${ctx.version} revoked; recipient access refused (HTTP ${after.status})`;
    });
  } else {
    out('INFO revoke: no task was created, nothing to revoke');
  }

  const failed = results.filter(item => !item.ok).length;
  out(`SUMMARY ${failed ? 'FAIL' : 'PASS'} steps=${results.length} passed=${results.length - failed} failed=${failed} ` +
    `provider_expectation=${expect} task_revoked=${ctx.taskId ? (ctx.revoked ? 'yes' : 'no') : 'n/a'}`);
  if (ctx.taskId && !ctx.revoked) {
    out(`WARNING task ${ctx.taskId} could not be revoked here and stays deliverable until ${ctx.expiresAt}; revoke it as ${SENDER} (POST /api/tasks/${ctx.taskId}/revoke with version ${ctx.version}).`);
  }
  return failed ? 1 : 0;
}

export async function main(env = process.env, argv = process.argv.slice(2)) {
  let config;
  try { config = await loadConfig(env, argv); }
  catch (error) {
    writeOut(process.stderr, `CONFIG ERROR: ${error instanceof ConfigError ? error.message : 'configuration could not be read'}`);
    writeOut(process.stderr, 'Usage: SMOKE_BASE_URL=... SMOKE_TOKEN_DIR=... [SMOKE_GATE_USER=... SMOKE_GATE_PASSWORD=...] [SMOKE_EXPECT_PROVIDER=...] node scripts/hosted-smoke.mjs');
    return 2;
  }
  writeOut(process.stdout, `INFO target ${config.origin} expect=${config.expect} gate=${config.gate ? 'configured' : 'none'}`);
  try { return await runSmoke(config); }
  catch (error) {
    writeOut(process.stderr, `FAIL smoke: unexpected error: ${String(error?.message || error).slice(0, 200)}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const code = await main();
  process.stdout.write('', () => process.exit(code));
}
