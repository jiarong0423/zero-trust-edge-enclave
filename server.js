import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

await loadLocalEnv(path.join(__dirname, '.env'));
await loadLocalEnv(path.join(__dirname, '..', '.env'));

const publicDir = path.join(__dirname, 'public');
const dataDir = path.join(__dirname, process.env.DATA_DIR || 'data');
const packagesPath = path.join(dataDir, 'packages.json');
const auditsPath = path.join(dataDir, 'audit.json');

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3344);
const nebiusBaseUrl = process.env.NEBIUS_BASE_URL || 'https://api.tokenfactory.nebius.com/v1';
const nebiusModel = process.env.NEBIUS_MODEL || 'nvidia/nemotron-3-super-120b-a12b';
const demoFallbackEnabled = process.env.DEMO_FALLBACK_ENABLED !== 'false';
const tokenSigningSecret = resolveTokenSigningSecret();

const mimeTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml']
]);

async function loadLocalEnv(envPath) {
  try {
    const raw = await fs.readFile(envPath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const separatorIndex = trimmed.indexOf('=');
      if (separatorIndex < 1) continue;
      const key = trimmed.slice(0, separatorIndex).trim();
      let value = trimmed.slice(separatorIndex + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }
}

function resolveTokenSigningSecret() {
  if (process.env.TOKEN_SIGNING_SECRET) {
    return process.env.TOKEN_SIGNING_SECRET;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('TOKEN_SIGNING_SECRET is required when NODE_ENV=production');
  }
  return crypto.randomBytes(32).toString('hex');
}

async function ensureStore() {
  await fs.mkdir(dataDir, { recursive: true });
  await ensureJson(packagesPath, []);
  await ensureJson(auditsPath, []);
}

async function ensureJson(filePath, fallback) {
  try {
    await fs.access(filePath);
  } catch {
    await fs.writeFile(filePath, `${JSON.stringify(fallback, null, 2)}\n`, 'utf8');
  }
}

async function readJson(filePath, fallback) {
  await ensureStore();
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(tempPath, filePath);
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error('request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function hashJson(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function base64UrlEncode(value) {
  return Buffer.from(value).toString('base64url');
}

function base64UrlDecode(value) {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function signValue(value) {
  return crypto.createHmac('sha256', tokenSigningSecret).update(value).digest('base64url');
}

function createSignedCredential(claims) {
  const header = {
    alg: 'HS256',
    typ: 'ZTEE-TAC',
    version: '0.1'
  };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(claims));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  return `${signingInput}.${signValue(signingInput)}`;
}

function readSignedCredential(token) {
  const parts = normalizeString(token).split('.');
  if (parts.length !== 3) {
    throw new Error('invalid credential format');
  }
  const [encodedHeader, encodedPayload, signature] = parts;
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const expected = signValue(signingInput);
  const actualBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);
  if (actualBytes.length !== expectedBytes.length || !crypto.timingSafeEqual(actualBytes, expectedBytes)) {
    throw new Error('invalid credential signature');
  }
  const header = JSON.parse(base64UrlDecode(encodedHeader));
  const payload = JSON.parse(base64UrlDecode(encodedPayload));
  if (header.typ !== 'ZTEE-TAC') {
    throw new Error('invalid credential type');
  }
  return payload;
}

function normalizeString(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  return value.trim().slice(0, 4000);
}

function normalizeArray(value, fallback) {
  if (!Array.isArray(value)) return fallback;
  return value.map(item => normalizeString(item)).filter(Boolean).slice(0, 20);
}

function normalizePolicyMetadata(value) {
  const metadata = value && typeof value === 'object' ? value : {};
  return {
    dataCategory: normalizeString(metadata.dataCategory, 'finance').toLowerCase(),
    confidentiality: normalizeString(metadata.confidentiality, 'confidential').toLowerCase(),
    businessPurpose: normalizeString(metadata.businessPurpose, 'approval').toLowerCase(),
    requestedExpiry: normalizeString(metadata.requestedExpiry, '1h').toLowerCase(),
    devicePolicy: normalizeString(metadata.devicePolicy, 'managed_device_only').toLowerCase(),
    openLimit: normalizeString(metadata.openLimit, 'single_use').toLowerCase()
  };
}

function buildFallbackPolicy(input) {
  const metadata = normalizePolicyMetadata(input.policyMetadata);
  const highRisk = metadata.confidentiality === 'confidential' || metadata.dataCategory === 'finance' || metadata.dataCategory === 'legal';
  const requestedTtl = metadata.requestedExpiry === '24h' ? 1440 : metadata.requestedExpiry === '4h' ? 240 : 60;
  return {
    provider: 'demo_fallback',
    model: 'local-rule-policy-demo',
    riskLevel: highRisk ? 'high' : 'medium',
    classification: highRisk ? 'internal_confidential' : 'internal_restricted',
    summary: highRisk
      ? 'Non-content metadata requests a high-control route for a confidential internal package.'
      : 'Non-content metadata requests a policy-bound route for an internal package.',
    allowedRoles: highRisk ? ['cfo'] : ['cfo', 'manager'],
    ttlMinutes: Math.min(requestedTtl, highRisk ? 60 : 240),
    maxOpens: metadata.openLimit === 'limited_use' ? 3 : 1,
    deviceBindingRequired: metadata.devicePolicy !== 'any_authenticated_device',
    redactionRules: highRisk
      ? ['mask customer identifiers for non-cfo roles', 'mask unreleased revenue figures for non-cfo roles']
      : ['mask direct identifiers for non-manager roles'],
    watermarkRequired: true,
    warnings: ['Demo fallback was used because NEBIUS_API_KEY is not configured. This is not hackathon submission evidence.']
  };
}

function validatePolicy(policy) {
  const allowedRisk = new Set(['low', 'medium', 'high', 'critical']);
  const allowedClassifications = new Set(['public', 'internal', 'internal_restricted', 'internal_confidential', 'regulated']);
  const normalized = {
    provider: normalizeString(policy.provider, 'unknown'),
    model: normalizeString(policy.model, nebiusModel),
    riskLevel: allowedRisk.has(policy.riskLevel) ? policy.riskLevel : 'high',
    classification: allowedClassifications.has(policy.classification) ? policy.classification : 'internal_confidential',
    summary: normalizeString(policy.summary, 'Policy recommendation requires human review.'),
    allowedRoles: normalizeArray(policy.allowedRoles, ['cfo']),
    ttlMinutes: Math.min(Math.max(Number(policy.ttlMinutes || 60), 5), 1440),
    maxOpens: Math.min(Math.max(Number(policy.maxOpens || 1), 1), 10),
    deviceBindingRequired: Boolean(policy.deviceBindingRequired),
    redactionRules: normalizeArray(policy.redactionRules, []),
    watermarkRequired: policy.watermarkRequired !== false,
    warnings: normalizeArray(policy.warnings, [])
  };

  if (normalized.allowedRoles.length === 0) {
    normalized.allowedRoles = ['cfo'];
  }

  return normalized;
}

async function callNebiusPolicy(input) {
  const apiKey = process.env.NEBIUS_API_KEY;
  if (!apiKey) {
    if (!demoFallbackEnabled) {
      throw new Error('NEBIUS_API_KEY is required and demo fallback is disabled');
    }
    return validatePolicy(buildFallbackPolicy(input));
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
        fileName: input.fileName,
        senderRole: input.senderRole,
        intendedRecipientRole: input.intendedRecipientRole,
        policyMetadata: normalizePolicyMetadata(input.policyMetadata)
      })
    }
  ];

  try {
    const response = await fetch(`${nebiusBaseUrl.replace(/\/$/, '')}/chat/completions`, {
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

function compileEnvelope(policy, input) {
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + policy.ttlMinutes * 60_000).toISOString();
  const envelope = {
    version: '0.1',
    createdAt,
    expiresAt,
    packageHash: normalizeString(input.packageHash),
    fileName: normalizeString(input.fileName, 'sealed-package.txt'),
    senderRole: normalizeString(input.senderRole, 'employee'),
    allowedRoles: policy.allowedRoles,
    classification: policy.classification,
    riskLevel: policy.riskLevel,
    ttlMinutes: policy.ttlMinutes,
    maxOpens: policy.maxOpens,
    deviceBindingRequired: policy.deviceBindingRequired,
    redactionRules: policy.redactionRules,
    watermarkRequired: policy.watermarkRequired,
    aiRecommendation: {
      provider: policy.provider,
      model: policy.model,
      summary: policy.summary,
      warnings: policy.warnings
    }
  };
  return {
    ...envelope,
    signature: hashJson(envelope)
  };
}

function createTimedCredential(record, input) {
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
    role: normalizeString(input.role, 'employee').toLowerCase(),
    deviceClaim: normalizeString(input.deviceClaim, 'unknown-device'),
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
    allowed.push('device claim accepted');
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

function getMcpToolSchemas() {
  return [
    {
      name: 'create_sealed_package',
      description: 'Create a sealed package from ciphertext, crypto metadata, and a policy recommendation. Plaintext is not accepted.',
      inputSchema: {
        type: 'object',
        required: ['fileName', 'senderRole', 'policy', 'ciphertext', 'iv', 'salt', 'packageHash'],
        properties: {
          fileName: { type: 'string' },
          senderRole: { type: 'string' },
          policy: { type: 'object' },
          ciphertext: { type: 'string' },
          iv: { type: 'string' },
          salt: { type: 'string' },
          packageHash: { type: 'string' }
        }
      },
      outputBoundary: 'Returns package id, sealed link, and policy envelope only. Does not return plaintext.'
    },
    {
      name: 'route_package',
      description: 'Record one-way routing intent for a sealed package through a globally portable relay channel.',
      inputSchema: {
        type: 'object',
        required: ['packageId', 'channel', 'endpoint'],
        properties: {
          packageId: { type: 'string' },
          channel: { enum: ['email', 'internal_queue', 'edge_endpoint', 'offline_package', 'cross_region_relay'] },
          endpoint: { type: 'string' }
        }
      },
      outputBoundary: 'Returns delivery status and receipt id. Does not send plaintext.'
    },
    {
      name: 'prepare_email_delivery',
      description: 'Create a dry-run one-way email notification for a sealed package without sending mail.',
      inputSchema: {
        type: 'object',
        required: ['packageId', 'recipientLabel', 'baseUrl'],
        properties: {
          packageId: { type: 'string' },
          recipientLabel: { type: 'string' },
          baseUrl: { type: 'string' }
        }
      },
      outputBoundary: 'Returns email subject/body text containing only sealed-link metadata. Does not include plaintext, ciphertext, keys, IV, or salt.'
    },
    {
      name: 'check_endpoint_receipt',
      description: 'Read the latest delivery receipt state for a sealed package.',
      inputSchema: {
        type: 'object',
        required: ['packageId'],
        properties: {
          packageId: { type: 'string' }
        }
      },
      outputBoundary: 'Returns delivery metadata only.'
    },
    {
      name: 'issue_timed_credential',
      description: 'Issue a short-lived signed decode credential bound to package hash, policy hash, role, device claim, and revocation version.',
      inputSchema: {
        type: 'object',
        required: ['packageId', 'role', 'deviceClaim'],
        properties: {
          packageId: { type: 'string' },
          role: { type: 'string' },
          deviceClaim: { type: 'string' }
        }
      },
      outputBoundary: 'Returns a signed timed credential. The credential is not plaintext and still requires Decode Gate validation.'
    },
    {
      name: 'read_fallback_status',
      description: 'Read the latest fallback status for a package from denied decode attempts or routing failures.',
      inputSchema: {
        type: 'object',
        required: ['packageId'],
        properties: {
          packageId: { type: 'string' }
        }
      },
      outputBoundary: 'Returns denial reasons and safe fallback message only.'
    },
    {
      name: 'read_audit_log',
      description: 'Read recent package-scoped audit events.',
      inputSchema: {
        type: 'object',
        properties: {
          packageId: { type: 'string' },
          limit: { type: 'number' }
        }
      },
      outputBoundary: 'Returns audit metadata without plaintext, ciphertext, keys, IV, or salt.'
    }
  ];
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
  return {
    id: event.id,
    createdAt: event.createdAt,
    type: event.type,
    result: event.result,
    packageId: event.packageId,
    packageHash: event.packageHash,
    role: event.role,
    deviceClaim: event.deviceClaim,
    credentialId: event.credentialId,
    credentialExpiresAt: event.credentialExpiresAt,
    deliveryReceiptId: event.deliveryReceiptId,
    deliveryChannel: event.deliveryChannel,
    deliveryEndpoint: event.deliveryEndpoint,
    reasons: event.reasons,
    eventHash: event.eventHash,
    previousHash: event.previousHash
  };
}

function fallbackMessageFromReasons(reasons) {
  const joined = Array.isArray(reasons) ? reasons.join(' ') : '';
  if (joined.includes('expired')) return 'This timed access credential is expired. Request a fresh sealed-package access grant.';
  if (joined.includes('device')) return 'This endpoint is not eligible for local decryption. Use a managed device or contact the sender.';
  if (joined.includes('role') || joined.includes('recipient')) return 'This recipient is not eligible for this sealed package.';
  if (joined.includes('revoked')) return 'This sealed package has been revoked.';
  if (joined.includes('signature') || joined.includes('format')) return 'This access credential is invalid.';
  return 'This sealed package cannot be opened under the current policy.';
}

function hasForbiddenEmailMaterial(value) {
  const text = String(value).toLowerCase();
  const forbidden = [
    'ciphertext',
    'smoke-ciphertext',
    'content key',
    'encryption key',
    'decryption key',
    '"iv"',
    '"salt"',
    'plaintext',
    'raw payload'
  ];
  return forbidden.some(term => text.includes(term));
}

function buildDryRunEmailDraft(record, input) {
  const baseUrl = normalizeString(input.baseUrl, `http://${host}:${port}`).replace(/\/$/, '');
  const recipientLabel = normalizeString(input.recipientLabel, 'authorized-recipient');
  const decodeUrl = `${baseUrl}/decode.html?id=${encodeURIComponent(record.id)}`;
  const bodyLines = [
    `You have received a sealed enterprise data package.`,
    ``,
    `Package ID: ${record.id}`,
    `Classification: ${record.envelope.classification}`,
    `Risk level: ${record.envelope.riskLevel}`,
    `Expires at: ${record.envelope.expiresAt}`,
    `Allowed roles: ${record.envelope.allowedRoles.join(', ')}`,
    ``,
    `Open through the Decode Gate:`,
    decodeUrl,
    ``,
    `This is a one-way sealed-package notification. The message contains only sealed-link metadata and no protected content or cryptographic material.`,
    `If access fails, request a fresh timed credential from the sender or security operator.`
  ];
  const draft = {
    mode: 'dry_run_only',
    to: recipientLabel,
    subject: `Sealed package access notice: ${record.envelope.classification}`,
    body: bodyLines.join('\n'),
    sealedLink: decodeUrl,
    packageId: record.id,
    packageHash: record.packageHash,
    expiresAt: record.envelope.expiresAt,
    safetyChecks: {
      includesPlaintext: false,
      includesCiphertext: false,
      includesKeyMaterial: false,
      sendsEmail: false
    }
  };
  const outboundText = [draft.subject, draft.body, draft.sealedLink].join('\n');
  if (hasForbiddenEmailMaterial(outboundText)) {
    const error = new Error('dry-run email draft contains forbidden material');
    error.status = 500;
    throw error;
  }
  return draft;
}

async function createSealedPackageRecord(input, source = 'api') {
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
  const packageId = crypto.randomUUID();
  const envelope = compileEnvelope(policy, {
    packageHash: input.packageHash,
    fileName: input.fileName,
    senderRole: input.senderRole
  });
  const record = {
    id: packageId,
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
  if (toolName === 'create_sealed_package') {
    return createSealedPackageRecord(input, 'mcp');
  }

  if (toolName === 'route_package') {
    const { packages, index, record } = await findPackage(normalizeString(input.packageId));
    if (!record) {
      const error = new Error('package not found');
      error.status = 404;
      throw error;
    }
    const allowedChannels = new Set(['email', 'internal_queue', 'edge_endpoint', 'offline_package', 'cross_region_relay']);
    const channel = normalizeString(input.channel, 'internal_queue');
    if (!allowedChannels.has(channel)) {
      const error = new Error('unsupported route channel');
      error.status = 422;
      throw error;
    }
    const receipt = {
      id: crypto.randomUUID(),
      channel,
      endpoint: normalizeString(input.endpoint, 'demo-endpoint'),
      regionHint: normalizeString(input.regionHint, 'global'),
      status: 'SENT',
      sentAt: new Date().toISOString()
    };
    packages[index] = {
      ...record,
      deliveryReceipts: [...(record.deliveryReceipts || []), receipt].slice(-20)
    };
    await writeJson(packagesPath, packages);
    await appendAudit({
      type: 'PACKAGE_ROUTED',
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
      receipt
    };
  }

  if (toolName === 'prepare_email_delivery') {
    const { packages, index, record } = await findPackage(normalizeString(input.packageId));
    if (!record) {
      const error = new Error('package not found');
      error.status = 404;
      throw error;
    }
    const draft = buildDryRunEmailDraft(record, input);
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
    const latestDenied = audits
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

async function appendAudit(event) {
  const audits = await readJson(auditsPath, []);
  const previousHash = audits.at(-1)?.eventHash || null;
  const entry = {
    ...event,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    previousHash
  };
  entry.eventHash = hashJson(entry);
  audits.push(entry);
  await writeJson(auditsPath, audits.slice(-500));
  return entry;
}

async function routeApi(req, res, pathname) {
  if (req.method === 'GET' && pathname === '/api/health') {
    sendJson(res, 200, {
      ok: true,
      project: 'zero-trust-edge-enclave',
      nebiusConfigured: Boolean(process.env.NEBIUS_API_KEY),
      nebiusBaseUrl,
      nebiusModel,
      demoFallbackEnabled
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/mcp/tools') {
    sendJson(res, 200, {
      ok: true,
      name: 'zero-trust-edge-enclave-transport-shell',
      description: 'MCP-style secure package transport shell for globally portable sealed data delivery.',
      contentBoundary: 'No plaintext, document summaries, snippets, encryption keys, IV, or salt are returned by read tools.',
      tools: getMcpToolSchemas()
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
      sendJson(res, error.status || 500, {
        ok: false,
        error: error instanceof Error ? error.message : 'email dry-run failed'
      });
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/api/policy/recommend') {
    const input = await readBody(req);
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
        openCount: record.openCount + 1
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

  if (req.method === 'GET' && pathname === '/api/audit') {
    const audits = await readJson(auditsPath, []);
    sendJson(res, 200, { events: audits.slice().reverse() });
    return;
  }

  sendJson(res, 404, { ok: false, error: 'not found' });
}

async function serveStatic(req, res, pathname) {
  const safePathname = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.normalize(path.join(publicDir, safePathname));
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  try {
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, {
      'content-type': mimeTypes.get(ext) || 'application/octet-stream',
      'cache-control': 'no-store'
    });
    res.end(data);
  } catch {
    const fallback = await fs.readFile(path.join(publicDir, 'index.html'));
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store'
    });
    res.end(fallback);
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || `${host}:${port}`}`);
    if (url.pathname.startsWith('/api/')) {
      await routeApi(req, res, url.pathname);
      return;
    }
    await serveStatic(req, res, url.pathname);
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      error: error instanceof Error ? error.message : 'unknown error'
    });
  }
});

await ensureStore();
server.listen(port, host, () => {
  console.log(`Zero-Trust Edge Enclave listening at http://${host}:${port}`);
});
