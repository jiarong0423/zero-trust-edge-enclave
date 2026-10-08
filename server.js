import http from 'node:http';
import https from 'node:https';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { auditProjection } from './audit-boundary.js';
import { queueAudit } from './audit-outbox.js';
import { dispatchSnapshot } from './snapshot-lifecycle.js';
import { principalEnabled } from './registry-schema.js';
import { adminDirectory, changeDirectory } from './directory-admin.js';
import { saveRegistry } from './registry-store.js';
import { resolvePrivateRoute } from './private-mapping.js';
import { fileRoutingMetadata } from './file-routing.js';
import { initializeArrays, readArray, writeArray } from './local-array-store.js';
import { auditArchiveIndex } from './audit-retention.js';
import { clientKey, countsAsGuess, throttleFromEnv } from './auth-throttle.js';
import { createNetworkPolicy } from './network-policy.js';
import { retentionInventory } from './retention-policy.js';
import { gateConfig, gateAllows, gateSignIn } from './demo-gate.js';
import { createBudget } from './nebius-budget.js';
import { loadAccess, authenticate, activeGrant, authorizeRecord, safeMetadata, validateAdvice, advanceDelivery, exact, fail } from './access-control.js';
import { sendJson, readBody } from './http-helpers.js';
import { createStaticServer } from './static-files.js';
import { getMcpToolSchemas, fallbackMessageFromReasons } from './mcp-tools.js';
import { normalizePolicyMetadata, buildFallbackPolicy, validatePolicy as validatePolicyWithModel, compileEnvelope } from './policy-envelope.js';
import { hashJson, normalizeString } from './value-helpers.js';
import { createEmailDraftBuilder } from './email-draft.js';
import { loadLocalEnv } from './local-env.js';
import { resolveTokenSigningSecret, createCredentialSigner } from './credentials.js';
import { requestContext, currentRequest, setAuditTarget } from './request-context.js';
import { createAudit } from './audit.js';
import { createApiQueue } from './api-queue.js';
import { createFileAdviser } from './file-adviser-outlet.js';
import { createFileWorker } from './worker-schedule.js';
import { createFileAccessRoutes } from './routes/file-access.js';
import { createFileTaskRoutes } from './routes/file-tasks.js';

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
const fileTasks = createFileTaskRoutes({ dataDir, tasksPath, packagesPath, auditsPath, readJson, writeJson, appendAudit, recoverAudit });

async function callNebiusPolicy(input) {
  if (localOnly || legacyHostedAdviceOff) return validatePolicy(buildFallbackPolicy(input));
  const apiKey = process.env.NEBIUS_API_KEY;
  if (!apiKey) {
    if (!demoFallbackEnabled) {
      throw new Error('NEBIUS_API_KEY is required and demo fallback is disabled');
    }
    return validatePolicy(buildFallbackPolicy(input));
  }
  if (await nebiusBudget.exhausted()) {
    return validatePolicy(buildFallbackPolicy(input, 'Demo fallback was used because the Token Factory budget is spent.'));
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  const messages = [
    {
      role: 'system',
      content: [
        'You are an enterprise security policy assistant.',
        'Return only JSON with keys: riskLevel, classification, summary, allowedRoles, ttlMinutes, maxOpens, deviceBindingRequired, redactionRules, watermarkRequired, warnings.',
        'You must not ask for document content, summaries, snippets, extracted fields, or decryption keys.',
        'Use only non-content policy metadata. Do not approve access. Recommend policy only.'
      ].join(' ')
    },
    {
      role: 'user',
      content: JSON.stringify({
        policyMetadata: normalizePolicyMetadata(input.policyMetadata)
      })
    }
  ];

  try {
    const response = await nebiusBudget.fetch(`${nebiusBaseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: nebiusModel,
        temperature: 0.1,
        messages
      }),
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`Nebius request failed with HTTP ${response.status}`);
    }
    const payload = await response.json();
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new Error('Nebius response did not include message content');
    }
    const jsonStart = content.indexOf('{');
    const jsonEnd = content.lastIndexOf('}');
    if (jsonStart < 0 || jsonEnd < jsonStart) {
      throw new Error('Nebius response was not JSON');
    }
    const parsed = JSON.parse(content.slice(jsonStart, jsonEnd + 1));
    return validatePolicy({
      ...parsed,
      provider: 'nebius_token_factory',
      model: nebiusModel
    });
  } finally {
    clearTimeout(timeout);
  }
}

function createTimedCredential(record, input) {
  const { config, principal } = currentRequest();
  if (principal.kind !== 'recipient') fail('Only authenticated recipients may request credentials');
  authorizeRecord(config, principal, record);
  if (Object.keys(input).length) fail('Recipient role and device claims are not accepted', 422);
  const now = Date.now();
  const envelopeTtl = Math.max(Date.parse(record.envelope.expiresAt) - now, 0);
  const credentialTtl = Math.min(envelopeTtl, 5 * 60_000);
  const issuedAt = new Date(now).toISOString();
  const expiresAt = new Date(now + credentialTtl).toISOString();
  const claims = {
    credentialId: crypto.randomUUID(),
    packageId: record.id,
    packageHash: record.packageHash,
    policyHash: record.envelope.signature,
    subject: principal.id,
    authorizationVersion: record.authorization.version,
    role: principal.role || principal.id,
    deviceClaim: 'local-token-no-attestation',
    issuedAt,
    expiresAt,
    maxUses: 1,
    revocationVersion: record.revocationVersion || 0
  };
  return {
    claims,
    token: createSignedCredential(claims)
  };
}

function evaluateDecodeAttempt(record, credential) {
  const now = Date.now();
  const allowed = [];
  const denied = [];
  const { config, principal } = currentRequest();
  authorizeRecord(config, principal, record);
  if (principal.kind !== 'recipient' || credential.subject !== principal.id) denied.push('credential subject mismatch');
  if (credential.authorizationVersion !== record.authorization.version) denied.push('authorization version mismatch');
  if ((record.usedCredentials || []).includes(credential.credentialId)) denied.push('credential already used');
  if (!Number.isFinite(Date.parse(credential.expiresAt))) denied.push('invalid credential expiry');
  const role = normalizeString(credential.role, 'employee').toLowerCase();
  const deviceClaim = normalizeString(credential.deviceClaim, 'unknown-device');

  if (record.revoked) denied.push('package revoked');
  if (credential.packageId !== record.id) denied.push('credential package mismatch');
  if (credential.packageHash !== record.packageHash) denied.push('credential package hash mismatch');
  if (credential.policyHash !== record.envelope.signature) denied.push('credential policy hash mismatch');
  if ((credential.revocationVersion || 0) !== (record.revocationVersion || 0)) denied.push('credential revocation version mismatch');
  if (now > Date.parse(credential.expiresAt)) denied.push('credential expired');
  if (now > Date.parse(record.envelope.expiresAt)) denied.push('policy expired');
  if (record.openCount >= record.envelope.maxOpens) denied.push('open count limit reached');
  if (!record.envelope.allowedRoles.includes(role)) denied.push('recipient role not allowed');
  if (record.envelope.deviceBindingRequired && !deviceClaim.startsWith('managed-')) {
    denied.push('managed device claim required');
  }

  if (denied.length === 0) {
    allowed.push('credential signature accepted');
    allowed.push('recipient role accepted');
    allowed.push('registered recipient accepted; no device attestation');
    allowed.push('time window accepted');
  }

  return {
    ok: denied.length === 0,
    result: denied.length === 0 ? 'ALLOW' : 'DENY',
    reasons: denied.length ? denied : allowed,
    role,
    deviceClaim
  };
}

async function findPackage(packageId) {
  const packages = await readJson(packagesPath, []);
  const index = packages.findIndex(item => item.id === packageId);
  return {
    packages,
    index,
    record: index >= 0 ? packages[index] : null
  };
}

function sanitizeAuditEvent(event) {
  return auditProjection(event);
}

async function approvedPackage(record) {
  const { config, principal } = currentRequest();
  setAuditTarget({ packageId: record.id, taskId: record.snapshot?.taskId,
    snapshotVersion: record.snapshot?.version, previousState: record.delivery?.status || 'PENDING_CHECK', attempts: record.delivery?.attempts || 0 });
  const grant = authorizeRecord(config, principal, record);
  const tasks = await readJson(tasksPath, []);
  const task = tasks.find(item => item.id === record.snapshot?.taskId);
  if (!task || task.grantId !== grant.id) fail('Approved snapshot required');
  const snapshot = dispatchSnapshot(task, grant, record.snapshot.version);
  if (snapshot.content.documentHash !== record.packageHash) fail('Snapshot document mismatch');
  if (principal.kind === 'recipient' && !snapshot.content.recipients.includes(principal.id)) fail('Recipient outside approved snapshot');
  return { ...grant, recipients: [...snapshot.content.recipients], channels: [...snapshot.content.channels],
    privateMapping: snapshot.privateMapping };
}

async function createSealedPackageRecord(input, source = 'api') {
  const { config, principal } = currentRequest();
  if (principal.kind !== 'operator') fail('Operator required');
  const grant = activeGrant(config, input.authorizationId);
  if (grant.operatorId !== principal.id) fail('Authorization owner mismatch');
  const tasks = await readJson(tasksPath, []);
  const task = tasks.find(item => item.id === input.taskId);
  if (!task || task.ownerId !== principal.id || task.grantId !== grant.id) fail('Approved task binding required');
  const requestedSnapshot = task.snapshots.find(item => item.version === input.snapshotVersion);
  setAuditTarget({ taskId: task.id, snapshotVersion: requestedSnapshot?.version,
    previousState: requestedSnapshot?.status, attempts: 0 });
  const snapshot = dispatchSnapshot(task, grant, input.snapshotVersion);
  const commitment = crypto.createHash('sha256').update(`${input.ciphertext}.${input.iv}.${input.salt}`).digest('hex');
  if (snapshot.content.documentHash !== commitment || input.packageHash !== commitment) fail('Snapshot document mismatch', 409);
  if (!input.ciphertext || !input.iv || !input.packageHash || !input.policy) {
    const error = new Error('ciphertext, iv, packageHash, and policy are required');
    error.status = 422;
    throw error;
  }
  if (input.plaintext || input.payload || input.rawPayload) {
    const error = new Error('plaintext payload fields are not accepted by the transport shell');
    error.status = 422;
    throw error;
  }
  const policy = validatePolicy(input.policy);
  policy.allowedRoles = snapshot.content.recipients.map(id => {
    const recipient = config.principals.find(p => p.id === id);
    return recipient.role || recipient.id;
  });
  policy.ttlMinutes = (Date.parse(snapshot.content.expiresAt) - Date.now()) / 60000;
  policy.maxOpens = grant.maxOpens;
  policy.deviceBindingRequired = false;
  const packageId = crypto.randomUUID();
  const envelope = compileEnvelope(policy, {
    packageHash: input.packageHash,
    fileName: input.fileName,
    senderRole: input.senderRole
  });
  envelope.expiresAt = snapshot.content.expiresAt;
  delete envelope.signature;
  envelope.signature = hashJson(envelope);
  const record = {
    id: packageId,
    authorization: { id: grant.id, version: grant.version },
    snapshot: { taskId: task.id, version: snapshot.version },
    fileName: normalizeString(input.fileName, 'sealed-package.txt'),
    packageHash: normalizeString(input.packageHash),
    ciphertext: normalizeString(input.ciphertext),
    iv: normalizeString(input.iv),
    salt: normalizeString(input.salt),
    envelope,
    openCount: 0,
    revoked: false,
    revocationVersion: 0,
    deliveryReceipts: [],
    createdAt: new Date().toISOString()
  };
  const packages = await readJson(packagesPath, []);
  const existing = packages.find(item => item.snapshot?.taskId === task.id && item.snapshot.version === snapshot.version);
  if (existing) return { ok: true, packageId: existing.id, sealedLink: `/decode.html?id=${existing.id}`, envelope: existing.envelope };
  packages.push(record);
  await writeJson(packagesPath, packages);
  await appendAudit({
    type: 'PACKAGE_CREATED',
    result: 'INFO',
    packageId,
    packageHash: record.packageHash,
    role: normalizeString(input.senderRole, 'employee'),
    deviceClaim: source === 'mcp' ? 'mcp-transport-shell' : 'sender-browser'
  });
  return {
    ok: true,
    packageId,
    sealedLink: `/decode.html?id=${encodeURIComponent(packageId)}`,
    envelope
  };
}

async function executeMcpTool(toolName, input) {
  if (toolName === 'issue_timed_credential') fail('Credentials are available only through the recipient API');
  if (toolName !== 'create_sealed_package') {
    const { record } = await findPackage(normalizeString(input.packageId));
    if (!record) fail('Package not found', 404);
    const { config, principal } = currentRequest();
    authorizeRecord(config, principal, record);
    await approvedPackage(record);
  }
  if (toolName === 'create_sealed_package') {
    return createSealedPackageRecord(input, 'mcp');
  }

  if (toolName === 'route_package') {
    return performLocalDelivery(input);
  }

  if (toolName === 'prepare_email_delivery') {
    const { packages, index, record } = await findPackage(normalizeString(input.packageId));
    if (!record) {
      const error = new Error('package not found');
      error.status = 404;
      throw error;
    }
    const approved = await approvedPackage(record);
    if (!approved.channels.includes('email')) fail('Email outside approved snapshot');
    exact(input, ['packageId']);
    const draft = buildDryRunEmailDraft(record, { recipientLabel: 'authorized-recipients' });
    const receipt = {
      id: crypto.randomUUID(),
      channel: 'email',
      endpoint: draft.to,
      regionHint: normalizeString(input.regionHint, 'global'),
      status: 'DRY_RUN_READY',
      sentAt: null,
      preparedAt: new Date().toISOString(),
      dryRun: true
    };
    packages[index] = {
      ...record,
      deliveryReceipts: [...(record.deliveryReceipts || []), receipt].slice(-20)
    };
    await writeJson(packagesPath, packages);
    await appendAudit({
      type: 'EMAIL_DRY_RUN_PREPARED',
      result: 'INFO',
      packageId: record.id,
      packageHash: record.packageHash,
      role: 'mcp-transport-shell',
      deviceClaim: 'mcp-transport-shell',
      deliveryReceiptId: receipt.id,
      deliveryChannel: receipt.channel,
      deliveryEndpoint: receipt.endpoint,
      regionHint: receipt.regionHint
    });
    return {
      ok: true,
      packageId: record.id,
      receipt,
      draft
    };
  }

  if (toolName === 'check_endpoint_receipt') {
    const { record } = await findPackage(normalizeString(input.packageId));
    if (!record) {
      const error = new Error('package not found');
      error.status = 404;
      throw error;
    }
    return {
      ok: true,
      packageId: record.id,
      latestReceipt: (record.deliveryReceipts || []).at(-1) || null,
      receiptCount: (record.deliveryReceipts || []).length
    };
  }

  if (toolName === 'issue_timed_credential') {
    const { record } = await findPackage(normalizeString(input.packageId));
    if (!record) {
      const error = new Error('package not found');
      error.status = 404;
      throw error;
    }
    await approvedPackage(record);
    const credential = createTimedCredential(record, input);
    await appendAudit({
      type: 'TIMED_CREDENTIAL_ISSUED',
      result: 'INFO',
      packageId: record.id,
      packageHash: record.packageHash,
      role: credential.claims.role,
      deviceClaim: credential.claims.deviceClaim,
      credentialId: credential.claims.credentialId,
      credentialExpiresAt: credential.claims.expiresAt
    });
    return {
      ok: true,
      credential
    };
  }

  if (toolName === 'read_fallback_status') {
    const packageId = normalizeString(input.packageId);
    const audits = await readJson(auditsPath, []);
    const latestDenied = audits.map(sanitizeAuditEvent)
      .filter(event => event.packageId === packageId && event.type === 'DECODE_ATTEMPT' && event.result === 'DENY')
      .at(-1);
    return {
      ok: true,
      packageId,
      fallback: latestDenied
        ? {
            status: 'DENIED',
            reasons: latestDenied.reasons || [],
            message: fallbackMessageFromReasons(latestDenied.reasons),
            eventHash: latestDenied.eventHash,
            createdAt: latestDenied.createdAt
          }
        : {
            status: 'NONE',
            reasons: [],
            message: 'No fallback condition has been recorded for this package.',
            eventHash: null,
            createdAt: null
          }
    };
  }

  if (toolName === 'read_audit_log') {
    const packageId = normalizeString(input.packageId);
    const limit = Math.min(Math.max(Number(input.limit || 20), 1), 50);
    const audits = await readJson(auditsPath, []);
    const events = audits
      .filter(event => !packageId || event.packageId === packageId)
      .slice(-limit)
      .map(sanitizeAuditEvent)
      .reverse();
    return {
      ok: true,
      events
    };
  }

  const error = new Error('unknown MCP transport tool');
  error.status = 404;
  throw error;
}

async function performLocalDelivery(input) {
  const { config, principal } = currentRequest();
  const { packages, index, record } = await findPackage(input.packageId);
  if (!record) fail('Package not found', 404);
  const grant = await approvedPackage(record);
  if (Date.now() >= Date.parse(record.envelope.expiresAt)) fail('Package expired');
  const destinations = resolvePrivateRoute(grant.privateMapping, { recipients: grant.recipients, channels: grant.channels }, input.channel);
  if (destinations.some(destination => !config.principals.some(person =>
    person.id === destination.recipientId && person.kind === 'recipient' && principalEnabled(config, person)))) {
    fail('Recipient unavailable');
  }
  // Sealed packages carry no download cutoff of their own, so no deadline ceiling is passed here;
  // the file workflow supplies one from downloadAccessDeadline in file-worker.js.
  const delivery = advanceDelivery(record, grant, input);
  const draft = delivery.status === 'DRY_RUN_PREPARED' && input.channel === 'email'
    ? buildDryRunEmailDraft(record, { recipientLabel: 'authorized-recipients' }) : null;
  packages[index] = queueAudit({ ...record, delivery, emailDraft: draft }, delivery !== record.delivery ? [{
    ...currentRequest().auditTarget, type: 'DELIVERY_TRANSITION', result: 'INFO',
    reasons: ['DELIVERY_UPDATED'], nextState: delivery.status, attempts: delivery.attempts }] : []);
  await writeJson(packagesPath, packages);
  await recoverAudit(packagesPath);
  return { ok: true, mode: 'dry_run_only', sendsEmail: false,
    ...safeMetadata(packages[index], grant), nextAttemptAt: delivery.nextAttemptAt || null };
}

async function coordinatorCall(input) {
  exact(input, ['tool', 'arguments']);
  const args = input.arguments;
  if (['file_status', 'file_recommend'].includes(input.tool)) {
    exact(args, ['taskAlias', 'snapshotVersion']);
    const { config, principal } = currentRequest();
    const tasks = await readJson(tasksPath, []);
    const task = tasks.find(item => item.file && item.snapshots.some(snapshot =>
      snapshot.version === args.snapshotVersion && snapshot.privateMapping?.taskAlias === args.taskAlias));
    if (!task) fail('File task unavailable', 404);
    const grant = activeGrant(config, task.grantId);
    if ((principal.kind === 'coordinator' && principal.id !== grant.coordinatorId) ||
        (principal.kind === 'operator' && principal.id !== task.ownerId)) fail('Task access denied');
    const snapshot = dispatchSnapshot(task, grant, args.snapshotVersion);
    const job = task.jobs.find(item => item.version === snapshot.version);
    if (!job) fail('File task unavailable', 404);
    const metadata = fileRoutingMetadata(snapshot, job);
    if (input.tool === 'file_status') return { ok: true, metadata };
    const recommendation = await fileAdviser(metadata);
    return { ok: true, provider: recommendation.provider, metadata, recommendation: recommendation.advice };
  }
  exact(args, input.tool === 'deliver' ? ['taskAlias', 'snapshotVersion', 'requestId', 'channel'] : ['taskAlias', 'snapshotVersion']);
  const { config, principal } = currentRequest();
  if (typeof args.taskAlias !== 'string' || !Number.isSafeInteger(args.snapshotVersion)) fail('Invalid routing reference', 422);
  const tasks = await readJson(tasksPath, []);
  const task = tasks.find(item => !item.file && item.snapshots.some(snapshot =>
    snapshot.version === args.snapshotVersion && snapshot.privateMapping?.taskAlias === args.taskAlias));
  if (!task) fail('Package not found', 404);
  const packages = await readJson(packagesPath, []);
  const record = packages.find(item => item.snapshot?.taskId === task.id && item.snapshot?.version === args.snapshotVersion);
  if (!record) fail('Package not found', 404);
  const grant = await approvedPackage(record);
  if (input.tool === 'deliver') return performLocalDelivery({ packageId: record.id, requestId: args.requestId, channel: args.channel });
  const metadata = safeMetadata(record, grant);
  if (input.tool === 'status') return { ok: true, metadata };
  if (input.tool !== 'recommend') fail('Coordinator tool not allowed', 422);
  let provider = 'synthetic_fixture';
  let advice = { action: 'DELIVER', channel: metadata.channels[0], reasonCode: 'CAPABILITY_MATCH' };
  if (process.env.COORDINATOR_PROVIDER === 'nebius' && !legacyHostedAdviceOff && !(await nebiusBudget.exhausted())) {
    if (localOnly) fail('External inference disabled in local-only mode', 503);
    if (!process.env.NEBIUS_API_KEY) fail('Coordinator provider unavailable', 503);
    const response = await nebiusBudget.fetch(`${nebiusBaseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST', signal: AbortSignal.timeout(15000),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.NEBIUS_API_KEY}` },
      body: JSON.stringify({ model: nebiusModel, temperature: 0,
        messages: [
          { role: 'system', content: 'Return JSON only with action DELIVER or PAUSE, channel from channels, and reasonCode CAPABILITY_MATCH, INSUFFICIENT_INFORMATION, or CHANNEL_UNAVAILABLE. Compare requiredCapability against recipientCapabilities. Never grant access.' },
          { role: 'user', content: JSON.stringify(metadata) }
        ] })
    });
    if (!response.ok) fail('Coordinator provider failed', 502);
    try { advice = JSON.parse((await response.json()).choices[0].message.content); }
    catch { fail('Invalid provider response', 502); }
    provider = 'nebius_token_factory';
  }
  return { ok: true, provider, metadata, recommendation: validateAdvice(advice, metadata) };
}

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
  try { principal = authenticate(config, req.headers.authorization); }
  catch (error) {
    // Only a real guess counts: a 43-character token that belongs to no registered identity. Every
    // prefix of a token being typed reaches this point too; see auth-throttle.js.
    if (error.status === 401 && countsAsGuess(config, req.headers.authorization)) authThrottle.fail(throttleKey);
    throw error;
  }
  Object.assign(currentRequest(), { config, principal });
  // Answers only "is this token a registered identity, and of which kind". It says nothing about
  // any task or grant: being authenticated is not being authorized, and the pages show the two apart.
  if (pathname === '/api/whoami') {
    if (req.method !== 'GET') fail('Method not allowed', 405);
    sendJson(res, 200, { ok: true, kind: principal.kind });
    return;
  }
  if (pathname === '/api/admin/retention') {
    if (principal.kind !== 'administrator') fail('Administrator required');
    if (req.method !== 'GET') fail('Method not allowed', 405);
    sendJson(res, 200, retentionInventory(await readJson(tasksPath, [])));
    return;
  }
  if (pathname === '/api/admin/audit-retention') {
    if (principal.kind !== 'administrator') fail('Administrator required');
    if (req.method !== 'GET') fail('Method not allowed', 405);
    sendJson(res, 200, await auditArchiveIndex(auditsPath));
    return;
  }
  if (pathname === '/api/admin/directory') {
    if (req.method === 'GET') {
      sendJson(res, 200, adminDirectory(config, principal));
      return;
    }
    if (req.method === 'POST') {
      const input = await readBody(req);
      const result = changeDirectory(config, principal, input);
      await saveRegistry(accessPath, result.config, input.expectedRevision);
      sendJson(res, 200, { ...adminDirectory(result.config, principal), credential: result.credential });
      return;
    }
    fail('Method not allowed', 405);
  }
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
  if (pathname === '/api/coordinator/call' && req.method === 'POST') {
    if (!['operator', 'coordinator'].includes(principal.kind)) fail('Coordinator required');
    sendJson(res, 200, await coordinatorCall(await readBody(req)));
    return;
  }
  if (req.method === 'GET' && pathname === '/api/mcp/tools') {
    sendJson(res, 200, {
      ok: true,
      name: 'zero-trust-edge-enclave-transport-shell',
      description: 'MCP-style secure package transport shell for globally portable sealed data delivery.',
      contentBoundary: 'No plaintext, document summaries, snippets, encryption keys, IV, or salt are returned by read tools.',
      tools: getMcpToolSchemas().filter(tool => tool.name !== 'issue_timed_credential')
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/mcp/call') {
    const input = await readBody(req);
    const toolName = normalizeString(input.tool);
    try {
      const result = await executeMcpTool(toolName, input.arguments || {});
      sendJson(res, 200, {
        ok: true,
        tool: toolName,
        result
      });
    } catch (error) {
      await auditRejection(error);
      sendJson(res, error.status || 500, {
        ok: false,
        tool: toolName,
        error: error instanceof Error ? error.message : 'MCP transport tool failed'
      });
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/api/delivery/email/dry-run') {
    const input = await readBody(req);
    try {
      const result = await executeMcpTool('prepare_email_delivery', input);
      sendJson(res, 200, result);
    } catch (error) {
      await auditRejection(error);
      sendJson(res, error.status || 500, {
        ok: false,
        error: error instanceof Error ? error.message : 'email dry-run failed'
      });
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/api/policy/recommend') {
    const input = await readBody(req);
    exact(input, ['fileName', 'senderRole', 'intendedRecipientRole', 'policyMetadata', 'packageHash']);
    const policy = await callNebiusPolicy({
      fileName: normalizeString(input.fileName, 'internal-document.txt'),
      senderRole: normalizeString(input.senderRole, 'employee'),
      intendedRecipientRole: normalizeString(input.intendedRecipientRole, 'cfo'),
      policyMetadata: normalizePolicyMetadata(input.policyMetadata)
    });
    sendJson(res, 200, {
      policy,
      envelopePreview: compileEnvelope(policy, {
        packageHash: normalizeString(input.packageHash, 'pending-client-hash'),
        fileName: input.fileName,
        senderRole: input.senderRole
      })
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/packages') {
    const input = await readBody(req);
    if (!input.ciphertext || !input.iv || !input.packageHash || !input.policy) {
      sendJson(res, 422, { ok: false, error: 'ciphertext, iv, packageHash, and policy are required' });
      return;
    }
    try {
      const created = await createSealedPackageRecord(input, 'api');
      sendJson(res, 201, created);
    } catch (error) {
      await auditRejection(error);
      sendJson(res, error.status || 500, {
        ok: false,
        error: error instanceof Error ? error.message : 'package creation failed'
      });
    }
    return;
  }

  if (req.method === 'GET' && pathname.startsWith('/api/packages/')) {
    const packageId = pathname.split('/').at(-1);
    const packages = await readJson(packagesPath, []);
    const record = packages.find(item => item.id === packageId);
    if (!record) {
      sendJson(res, 404, { ok: false, error: 'package not found' });
      return;
    }
    authorizeRecord(config, principal, record);
    sendJson(res, 200, {
      id: record.id,
      fileName: record.fileName,
      packageHash: record.packageHash,
      envelope: record.envelope,
      openCount: record.openCount,
      revoked: record.revoked,
      revocationVersion: record.revocationVersion || 0
    });
    return;
  }

  if (req.method === 'POST' && pathname.endsWith('/credential') && pathname.startsWith('/api/packages/')) {
    const packageId = pathname.split('/')[3];
    const input = await readBody(req);
    const packages = await readJson(packagesPath, []);
    const record = packages.find(item => item.id === packageId);
    if (!record) {
      sendJson(res, 404, { ok: false, error: 'package not found' });
      return;
    }
    await approvedPackage(record);
    const credential = createTimedCredential(record, input);
    const audit = await appendAudit({
      type: 'TIMED_CREDENTIAL_ISSUED',
      result: 'INFO',
      packageId,
      packageHash: record.packageHash,
      role: credential.claims.role,
      deviceClaim: credential.claims.deviceClaim,
      credentialId: credential.claims.credentialId,
      credentialExpiresAt: credential.claims.expiresAt
    });
    sendJson(res, 201, {
      ok: true,
      credential,
      audit
    });
    return;
  }

  if (req.method === 'POST' && pathname.endsWith('/verify') && pathname.startsWith('/api/packages/')) {
    const packageId = pathname.split('/')[3];
    const input = await readBody(req);
    const packages = await readJson(packagesPath, []);
    const index = packages.findIndex(item => item.id === packageId);
    if (index < 0) {
      sendJson(res, 404, { ok: false, error: 'package not found' });
      return;
    }
    const record = packages[index];
    await approvedPackage(record);
    let credential;
    try {
      credential = readSignedCredential(input.credential);
    } catch (error) {
      const audit = await appendAudit({
        type: 'DECODE_ATTEMPT',
        result: 'DENY',
        packageId,
        packageHash: record.packageHash,
        role: normalizeString(input.role, 'unknown'),
        deviceClaim: normalizeString(input.deviceClaim, 'unknown-device'),
        reasons: [error instanceof Error ? error.message : 'invalid credential']
      });
      sendJson(res, 200, {
        ok: false,
        result: 'DENY',
        reasons: audit.reasons,
        package: {
          id: record.id,
          fileName: record.fileName,
          packageHash: record.packageHash,
          ciphertext: null,
          iv: null,
          salt: null,
          envelope: record.envelope
        },
        audit
      });
      return;
    }
    const decision = evaluateDecodeAttempt(record, credential);
    if (decision.ok) {
      packages[index] = {
        ...record,
        openCount: record.openCount + 1,
        usedCredentials: [...(record.usedCredentials || []), credential.credentialId]
      };
      await writeJson(packagesPath, packages);
    }

    const audit = await appendAudit({
      type: 'DECODE_ATTEMPT',
      result: decision.result,
      packageId,
      packageHash: record.packageHash,
      role: decision.role,
      deviceClaim: decision.deviceClaim,
      credentialId: credential.credentialId,
      credentialExpiresAt: credential.expiresAt,
      reasons: decision.reasons
    });
    sendJson(res, 200, {
      ok: decision.ok,
      result: decision.result,
      reasons: decision.reasons,
      package: {
        id: record.id,
        fileName: record.fileName,
        packageHash: record.packageHash,
        ciphertext: decision.ok ? record.ciphertext : null,
        iv: decision.ok ? record.iv : null,
        salt: decision.ok ? record.salt : null,
        envelope: record.envelope
      },
      audit
    });
    return;
  }

  if (req.method === 'POST' && pathname.endsWith('/revoke') && pathname.startsWith('/api/packages/')) {
    const packageId = pathname.split('/')[3];
    const packages = await readJson(packagesPath, []);
    const index = packages.findIndex(item => item.id === packageId);
    if (index < 0) {
      sendJson(res, 404, { ok: false, error: 'package not found' });
      return;
    }
    if (principal.kind !== 'operator') fail('Operator required');
    authorizeRecord(config, principal, packages[index]);
    packages[index].revoked = true;
    packages[index].revocationVersion = (packages[index].revocationVersion || 0) + 1;
    await writeJson(packagesPath, packages);
    const audit = await appendAudit({
      type: 'PACKAGE_REVOKED',
      result: 'INFO',
      packageId,
      packageHash: packages[index].packageHash,
      role: 'security-admin',
      deviceClaim: 'soc-dashboard'
    });
    sendJson(res, 200, { ok: true, audit });
    return;
  }

  sendJson(res, 404, { ok: false, error: 'not found' });
}

const apiQueue = createApiQueue();
const fileAdviser = createFileAdviser({ nebiusBudget, localOnly, localModelBaseUrl, localModelName, nebiusBaseUrl, nebiusModel });
let workerTimer;
const { scheduleFileWork } = createFileWorker({ queue: apiQueue, readJson, writeJson, tasksPath, accessPath, dataDir, recoverAudit, fileAdviser });
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
    server.close(async () => {
      await apiQueue.drain();
      await fs.unlink(lockPath);
      process.exit(0);
    });
    server.closeAllConnections();
  });
}
server.on('error', async () => {
  clearInterval(workerTimer);
  await fs.unlink(lockPath).catch(() => {});
  process.exitCode = 1;
});
server.listen(port, host, () => {
  workerTimer = setInterval(scheduleFileWork, 250);
  workerTimer.unref();
  scheduleFileWork();
  console.log(`Zero-Trust Edge Enclave listening at ${tlsOptions ? 'https' : 'http'}://${host}:${server.address().port}`);
});
