import http from 'node:http';
import https from 'node:https';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeArrays, readArray, writeArray } from './local-array-store.js';
import { clientKey, countsAsGuess, throttleFromEnv } from './auth-throttle.js';
import { createNetworkPolicy } from './network-policy.js';
import { createSsoRoutes } from './sso-routes.js';
import { createWebhookFromEnv } from './webhook-adapter.js';
import { gateConfig, gateAllows, gateSignIn } from './demo-gate.js';
import { createBudget } from './nebius-budget.js';
import { loadAccess, authenticateWithSession, fail } from './access-control.js';
import { sendJson, readBody } from './http-helpers.js';
import { createStaticServer } from './static-files.js';
import { validatePolicy as validatePolicyWithModel } from './policy-envelope.js';
import { createEmailDraftBuilder } from './email-draft.js';
import { loadLocalEnv } from './local-env.js';
import { resolveTokenSigningSecret, createCredentialSigner } from './credentials.js';
import { requestContext, currentRequest } from './request-context.js';
import { createAudit } from './audit.js';
import { createApiQueue } from './api-queue.js';
import { createFileAdviser } from './file-adviser-outlet.js';
import { createFileWorker } from './worker-schedule.js';
import { createFileAccessRoutes } from './routes/file-access.js';
import { createFileTaskRoutes } from './routes/file-tasks.js';
import { createAdminRoutes } from './routes/admin.js';
import { createMatchGuard } from './match-guard.js';
import { createMatchReviewer } from './match-confirm.js';
import { createCoordinatorRoutes } from './routes/coordinator.js';
import { createLegacyPackages } from './legacy-packages.js';
import { createMcpRoutes } from './routes/mcp.js';
import { createPackageRoutes } from './routes/packages.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

if (process.env.SKIP_LOCAL_ENV !== 'true') {
  await loadLocalEnv(path.join(__dirname, '.env'));
  await loadLocalEnv(path.join(__dirname, '..', '.env'));
}

const publicDir = path.join(__dirname, 'public');
const serveStatic = createStaticServer(publicDir);
const dataDir = path.resolve(__dirname, process.env.DATA_DIR || 'data');
const accessPath = path.join(dataDir, 'access.json');
const packagesPath = path.join(dataDir, 'packages.json');
const auditsPath = path.join(dataDir, 'audit.json');
const tasksPath = path.join(dataDir, 'tasks.json');

const host = process.env.HOST || '127.0.0.1';
const trustProxy = process.env.TRUST_PROXY === 'true';
const authThrottle = throttleFromEnv(process.env, (key, seconds) => console.error(`WARN auth throttle locked client ${key} for ${seconds}s`));
const networkPolicy = createNetworkPolicy(process.env.ALLOWED_CLIENT_CIDRS);
// Off unless SSO_ISSUER is set (docs/agent/sso.md). `apiQueue` is defined further down; loadConfig is
// only called per request, so the forward reference is safe.
const sso = createSsoRoutes({
  env: process.env,
  loadConfig: () => apiQueue.chain(() => loadAccess(accessPath), run => run.catch(() => {})),
  throttle: authThrottle,
  clientKey: req => clientKey(req, trustProxy)
});
// LEGACY_HOSTED_ADVICE=off: the two legacy compatibility paths (/api/policy/recommend and the coordinator
// `recommend` tool) answer from the local fixture and never call the hosted model. They send more than
// the file workflow's five fields, so a deployment that wants that promise to be absolute turns them off.
const legacyHostedAdviceOff = process.env.LEGACY_HOSTED_ADVICE === 'off';
if (process.env.LEGACY_HOSTED_ADVICE !== undefined && process.env.LEGACY_HOSTED_ADVICE !== '' && !legacyHostedAdviceOff) {
  console.error('WARN LEGACY_HOSTED_ADVICE is set but is not exactly "off", so the legacy hosted paths stay ON');
}
const port = Number(process.env.PORT || 3344);
const buildDryRunEmailDraft = createEmailDraftBuilder(host, port);
const nebiusBaseUrl = process.env.NEBIUS_BASE_URL || 'https://api.tokenfactory.nebius.com/v1';
const localModelBaseUrl = process.env.LOCAL_MODEL_BASE_URL || 'http://127.0.0.1:1234/v1';
const localModelName = process.env.LOCAL_MODEL_NAME || 'nvidia-nemotron-3-nano-4b';
const nebiusModel = process.env.NEBIUS_MODEL || 'nvidia/nemotron-3-super-120b-a12b';
const validatePolicy = policy => validatePolicyWithModel(policy, nebiusModel);
const localOnly = process.env.LOCAL_ONLY !== 'false';
const demoFallbackEnabled = process.env.DEMO_FALLBACK_ENABLED !== 'false';
const tokenSigningSecret = resolveTokenSigningSecret();
const { createSignedCredential, readSignedCredential } = createCredentialSigner(tokenSigningSecret);
const demoGate = gateConfig(process.env);
const webhook = createWebhookFromEnv(process.env, { outboxDir: path.join(dataDir, 'outbox') });
const nebiusBudget = createBudget(process.env, path.join(dataDir, 'nebius-spend.json'));

async function ensureStore() {
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  await initializeArrays([packagesPath, auditsPath, tasksPath]);
}

async function readJson(filePath, fallback) {
  return readArray(filePath);
}

async function writeJson(filePath, value) {
  return writeArray(filePath, value);
}

const { appendAudit, recoverAudit, auditRejection } = createAudit({ auditsPath, readJson, writeJson });
const fileAccess = createFileAccessRoutes({ dataDir, tasksPath, readJson, writeJson, appendAudit, recoverAudit });
const matchGuard = createMatchGuard(path.join(dataDir, 'match-guard.json'));
const fileTasks = createFileTaskRoutes({ dataDir, tasksPath, packagesPath, auditsPath, readJson, writeJson, appendAudit, recoverAudit, matchGuard, matchReviewer: createMatchReviewer({ fileAdviser: (...args) => fileAdviser(...args) }) });
const adminRoutes = createAdminRoutes({ accessPath, tasksPath, auditsPath, readJson, matchGuard, appendAudit });
const { createTimedCredential, evaluateDecodeAttempt, findPackage, approvedPackage, createSealedPackageRecord, performLocalDelivery } =
  createLegacyPackages({ packagesPath, tasksPath, readJson, writeJson, appendAudit, recoverAudit, validatePolicy, createSignedCredential, buildDryRunEmailDraft });
const mcp = createMcpRoutes({ packagesPath, auditsPath, readJson, writeJson, appendAudit, auditRejection, buildDryRunEmailDraft,
  findPackage, approvedPackage, createSealedPackageRecord, performLocalDelivery, createTimedCredential });
const packages = createPackageRoutes({ packagesPath, readJson, writeJson, appendAudit, auditRejection, readSignedCredential,
  createSealedPackageRecord, approvedPackage, createTimedCredential, evaluateDecodeAttempt });
const fileAdviser = createFileAdviser({ nebiusBudget, localOnly, localModelBaseUrl, localModelName, nebiusBaseUrl, nebiusModel,
  legacyHostedAdviceOff });
const coordinator = createCoordinatorRoutes({ tasksPath, packagesPath, readJson, fileAdviser, nebiusBudget, nebiusBaseUrl, nebiusModel,
  localOnly, legacyHostedAdviceOff, demoFallbackEnabled, validatePolicy, approvedPackage, performLocalDelivery });

async function routeApi(req, res, pathname) {
  if (req.method === 'GET' && pathname === '/api/health') {
    sendJson(res, 200, {
      ok: true,
      project: 'zero-trust-edge-enclave',
      localOnly,
      adviserProvider: process.env.COORDINATOR_PROVIDER || 'synthetic_fixture',
      nebiusConfigured: !localOnly && Boolean(process.env.NEBIUS_API_KEY),
      nebiusBaseUrl,
      nebiusModel,
      localOutletBaseUrl: localModelBaseUrl,
      localOutletModel: localModelName,
      demoFallbackEnabled,
      legacyHostedAdviceOff,
      nebiusBudget: await nebiusBudget.status()
    });
    return;
  }

  const config = await loadAccess(accessPath);
  const throttleKey = clientKey(req, trustProxy);
  authThrottle.check(throttleKey);
  let principal;
  try { principal = authenticateWithSession(config, req.headers.authorization, sso.resolveSession); }
  catch (error) {
    // Only a real guess counts: a 43-character token that belongs to no registered identity. Every
    // prefix of a token being typed reaches this point too; see auth-throttle.js. A live SSO session
    // token is not a guess, even when its person has since been disabled.
    if (error.status === 401 && countsAsGuess(config, req.headers.authorization) &&
        !sso.knowsSession(req.headers.authorization)) authThrottle.fail(throttleKey);
    throw error;
  }
  Object.assign(currentRequest(), { config, principal });
  if (await adminRoutes.handleAdmin(req, res, pathname, { config, principal })) return;
  if (principal.kind === 'administrator') fail('Administrator endpoint only');
  await recoverAudit(tasksPath);
  await recoverAudit(packagesPath);
  if (principal.kind === 'coordinator' && pathname !== '/api/coordinator/call') fail('Coordinator endpoint only');
  if (principal.kind === 'recipient' && !/^\/api\/packages\/[a-zA-Z0-9-]+\/(credential|verify)$/.test(pathname) &&
      !/^\/api\/file-access\/[a-f0-9-]{36}\/(credential|packet|key|receipt|receipt-status)$/.test(pathname)) fail('Recipient endpoint only');
  const fileAccessRoute = pathname.match(/^\/api\/file-access\/([a-f0-9-]{36})\/(credential|packet|key|receipt|receipt-status)$/);
  if (fileAccessRoute && req.method === 'POST') {
    await fileAccess.handleFileAccess(req, res, fileAccessRoute, { config, principal });
    return;
  }
  if (await fileTasks.handleFileTasks(req, res, pathname, { config, principal })) return;
  if (await coordinator.handleCoordinator(req, res, pathname, { principal })) return;
  if (await mcp.handleMcp(req, res, pathname)) return;
  if (await packages.handlePackages(req, res, pathname, { config, principal })) return;

  sendJson(res, 404, { ok: false, error: 'not found' });
}

const apiQueue = createApiQueue();
let workerTimer;
let webhookTimer;
const { scheduleFileWork } = createFileWorker({ queue: apiQueue, readJson, writeJson, tasksPath, accessPath, dataDir, recoverAudit, fileAdviser, webhook });
// Web Crypto only exists in a secure context, so a second device on the LAN needs https: a phone
// reaching http://<lan-ip> connects and renders, then finds crypto.subtle undefined. Supplying a
// certificate switches this listener to TLS; without one it stays plain http on loopback, which
// browsers already treat as a secure context.
const tlsCert = process.env.TLS_CERT_FILE;
const tlsKey = process.env.TLS_KEY_FILE;
const tlsOptions = tlsCert && tlsKey
  ? { cert: await fs.readFile(tlsCert), key: await fs.readFile(tlsKey) }
  : null;
const createServer = handler => tlsOptions ? https.createServer(tlsOptions, handler) : http.createServer(handler);
const server = createServer(async (req, res) => {
  try {
    // First, before anything is parsed: a client outside the allowlist gets the same 403 whatever it sends.
    if (!networkPolicy.allowsRequest(req, trustProxy)) fail('Client network not allowed', 403);
    let url;
    try { url = new URL(req.url || '/', `http://${req.headers.host || `${host}:${port}`}`); }
    catch { fail('Bad request', 400); }
    if (demoGate && url.pathname === '/api/judge-login') {
      if (req.method !== 'POST') fail('Method not allowed', 405);
      const input = await readBody(req, 4096);
      const secure = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https' || Boolean(req.socket?.encrypted);
      const result = gateSignIn(demoGate, input, secure, Date.now(), clientKey(req, trustProxy));
      if (result.status) throw Object.assign(new Error(result.status === 401 ? 'Sign-in rejected' : 'Sign-in unavailable'),
        { status: result.status, retryAfter: result.retryAfter });
      res.setHeader('set-cookie', result.cookie);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (!gateAllows(demoGate, req, url.pathname)) {
      if (!demoGate.ready) fail('Demo sign-in is not configured', 503);
      if (url.pathname.startsWith('/api/')) fail('Demo sign-in required', 401);
      res.writeHead(302, { location: '/judge-login.html', 'cache-control': 'no-store' });
      res.end();
      return;
    }
    // Outside apiQueue on purpose: the handler makes network calls to the identity provider and must
    // not stall every other API request.
    if (url.pathname.startsWith('/api/sso/') && await sso(req, res, url)) return;
    if (url.pathname.startsWith('/api/')) {
      await apiQueue.chain(() => requestContext.run({}, async () => {
        try { return await routeApi(req, res, url.pathname); }
        catch (error) { await auditRejection(error); throw error; }
      }), run => run.catch(() => {}));
      return;
    }
    await serveStatic(req, res, url.pathname);
  } catch (error) {
    if (error?.status === 429 && Number.isSafeInteger(error.retryAfter)) res.setHeader('retry-after', String(error.retryAfter));
    sendJson(res, error.status || 500, {
      ok: false,
      error: error instanceof Error ? error.message : 'unknown error'
    });
  }
});

await ensureStore();
const lockPath = path.join(dataDir, 'server.lock');
const lock = await fs.open(lockPath, 'wx', 0o600);
await lock.writeFile(String(process.pid));
await lock.close();
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    clearInterval(workerTimer);
    clearInterval(webhookTimer);
    server.close(async () => {
      await webhook.close();
      await apiQueue.drain();
      await fs.unlink(lockPath);
      process.exit(0);
    });
    server.closeAllConnections();
  });
}
server.on('error', async () => {
  clearInterval(workerTimer);
  clearInterval(webhookTimer);
  await fs.unlink(lockPath).catch(() => {});
  process.exitCode = 1;
});
server.listen(port, host, () => {
  workerTimer = setInterval(scheduleFileWork, 250);
  workerTimer.unref();
  // A notice deferred by a receiver outage is retried when its backoff has passed, not only after the
  // next export. kick() never throws and does nothing while the webhook is off.
  if (webhook.enabled) {
    webhookTimer = setInterval(() => void webhook.kick(), 60_000);
    webhookTimer.unref();
  }
  scheduleFileWork();
  console.log(`Zero-Trust Edge Enclave listening at ${tlsOptions ? 'https' : 'http'}://${host}:${server.address().port}`);
});
