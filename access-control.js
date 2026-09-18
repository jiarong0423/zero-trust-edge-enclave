import { promises as fs } from 'node:fs';
import crypto from 'node:crypto';
import { mappingProjection } from './private-mapping.js';
import { normalizeDirectory, principalEnabled } from './registry-schema.js';

export function fail(message, status = 403) {
  throw Object.assign(new Error(message), { status });
}

export function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !keys.includes(key))) fail('Unsupported request fields', 422);
}

export async function loadAccess(file) {
  let config;
  try { config = JSON.parse(await fs.readFile(file, 'utf8')); }
  catch { fail('Local access registry is unavailable', 503); }
  return validateAccess(config);
}

export function validateAccess(config) {
  config = normalizeDirectory(config);
  const ids = new Set();
  for (const principal of config.principals) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(principal.id) || ids.has(principal.id) ||
        !/^[a-f0-9]{64}$/.test(principal.tokenHash) ||
        !['administrator', 'operator', 'recipient', 'coordinator'].includes(principal.kind) ||
        (principal.role !== undefined && !/^[a-zA-Z0-9_-]{1,64}$/.test(principal.role))) fail('Invalid principal registry', 503);
    ids.add(principal.id);
  }
  const grants = new Set();
  for (const grant of config.grants) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(grant.id) || grants.has(grant.id) ||
        !Number.isSafeInteger(grant.version) || grant.version < 1 ||
        !Number.isFinite(Date.parse(grant.expiresAt)) ||
        !Number.isSafeInteger(grant.maxAttempts) || grant.maxAttempts < 1 || grant.maxAttempts > 5 ||
        !Number.isSafeInteger(grant.maxOpens) || grant.maxOpens < 1 || grant.maxOpens > 10 ||
        !Array.isArray(grant.recipients) || !grant.recipients.length ||
        !Array.isArray(grant.channels) || !grant.channels.length ||
        grant.channels.some(channel => !['email', 'internal_queue'].includes(channel)) ||
        grant.recipients.some(id => !config.principals.some(p => p.id === id && p.kind === 'recipient')) ||
        !config.principals.some(p => p.id === grant.operatorId && p.kind === 'operator') ||
        !config.principals.some(p => p.id === grant.coordinatorId && p.kind === 'coordinator')) fail('Invalid grant registry', 503);
    grants.add(grant.id);
  }
  return config;
}

export function authenticate(config, header) {
  if (typeof header !== 'string' || !/^Bearer [A-Za-z0-9_-]{32,256}$/.test(header)) fail('Authentication required', 401);
  const digest = crypto.createHash('sha256').update(header.slice(7)).digest();
  const principal = config.principals.find(p => crypto.timingSafeEqual(digest, Buffer.from(p.tokenHash, 'hex')));
  if (!principalEnabled(config, principal)) fail('Authentication failed', 401);
  return principal;
}

export function activeGrant(config, id, version) {
  const grant = config.grants.find(g => g.id === id);
  if (!grant || grant.revoked || Date.now() >= Date.parse(grant.expiresAt) ||
      (version !== undefined && grant.version !== version)) fail('Authorization expired, revoked, or superseded');
  return grant;
}

export function authorizeRecord(config, principal, record) {
  if (!record?.authorization) fail('Package has no approved recipient binding');
  const grant = activeGrant(config, record.authorization.id, record.authorization.version);
  const allowed = principal.kind === 'operator' ? grant.operatorId === principal.id :
    principal.kind === 'coordinator' ? grant.coordinatorId === principal.id : grant.recipients.includes(principal.id);
  if (!allowed || record.revoked) fail('Package access denied');
  return grant;
}

export function safeMetadata(record, grant) {
  if (!grant.privateMapping?.taskAlias) fail('Private mapping required', 409);
  return {
    taskAlias: grant.privateMapping.taskAlias,
    snapshotVersion: grant.privateMapping.version,
    authorizationVersion: grant.version,
    taskType: 'DOCUMENT_DELIVERY',
    requiredCapability: 'RECEIVE_DOCUMENT',
    recipientCapabilities: ['RECEIVE_DOCUMENT'],
    channels: [...grant.channels],
    status: record.delivery?.status || 'PENDING_CHECK',
    attempts: record.delivery?.attempts || 0,
    attemptsRemaining: Math.max(0, grant.maxAttempts - (record.delivery?.attempts || 0)),
    ...(grant.privateMapping ? { routing: mappingProjection(grant.privateMapping) } : {})
  };
}

export function validateAdvice(advice, metadata) {
  exact(advice, ['action', 'channel', 'reasonCode']);
  if (!['DELIVER', 'PAUSE'].includes(advice.action) ||
      !['CAPABILITY_MATCH', 'INSUFFICIENT_INFORMATION', 'CHANNEL_UNAVAILABLE'].includes(advice.reasonCode) ||
      !metadata.channels.includes(advice.channel)) fail('Invalid model recommendation', 422);
  return { action: advice.action, channel: advice.channel, reasonCode: advice.reasonCode };
}

const RETRY_CAP_MS = 60000;

/**
 * Equal jitter (AWS, Exponential Backoff And Jitter) capped by the remaining download window.
 * Full jitter draws from [0, backoff] and so may return zero, which for a single worker is not
 * decorrelation but an immediate re-send; equal jitter keeps half the backoff as a floor and
 * randomises the rest. That floor holds only while the window is wide enough: close to the cutoff
 * the cap below wins and the last attempt fires early rather than late, which is the intended
 * trade — a short wait can still land, a wait past the cutoff cannot.
 *
 * The download cutoff is the only time ceiling here: the delivery deadline records an overdue
 * event without stopping delivery, and the open limit is a counter, so neither may shorten this.
 * A retry scheduled past the cutoff would spend an open against a window that is already closed,
 * so null is returned and the caller pauses instead of queueing it.
 */
function retryDelayMs(attempts, now, deadline) {
  if (!Number.isSafeInteger(attempts) || attempts < 1) fail('Invalid delivery attempt count', 503);
  const half = Math.floor(Math.min(RETRY_CAP_MS, 1000 * 2 ** (attempts - 1)) / 2);
  const backoff = half + crypto.randomInt(half + 1);
  // Infinity means "no download cutoff applies"; anything else non-finite is a broken deadline and
  // must fail closed rather than silently schedule an unbounded retry.
  if (deadline === Infinity) return backoff;
  if (!Number.isFinite(deadline)) fail('Invalid download deadline', 503);
  const remaining = deadline - now;
  if (remaining <= 1) return null;
  return Math.min(backoff, remaining - 1);
}

// This simulator records local outcomes only; it never contacts a mail provider.
export function advanceDelivery(record, grant, input, now = Date.now(), deadline = Infinity) {
  exact(input, ['packageId', 'requestId', 'channel']);
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(input.requestId || '') || !grant.channels.includes(input.channel)) fail('Invalid delivery request', 422);
  const previous = record.delivery || { status: 'PENDING_CHECK', attempts: 0, requests: [] };
  const repeated = previous.requests.find(r => r.id === input.requestId);
  if (repeated) {
    if (repeated.channel !== input.channel) fail('Idempotency key conflict', 409);
    return previous;
  }
  if (['DRY_RUN_PREPARED', 'PAUSED', 'OUTCOME_UNKNOWN'].includes(previous.status)) return previous;
  if (previous.nextAttemptAt && now < Date.parse(previous.nextAttemptAt)) fail('Retry is not due', 409);
  if (previous.attempts >= grant.maxAttempts) return { ...previous, status: 'PAUSED' };
  const attempts = previous.attempts + 1;
  const outcome = grant.simulatedOutcomes?.[attempts - 1] || 'prepared';
  let status;
  if (outcome === 'prepared') status = 'DRY_RUN_PREPARED';
  else if (outcome === 'unknown') status = 'OUTCOME_UNKNOWN';
  else if (outcome === 'transient') status = attempts >= grant.maxAttempts ? 'PAUSED' : 'RETRY_WAIT';
  else fail('Invalid configured simulation outcome', 503);
  const delay = status === 'RETRY_WAIT' ? retryDelayMs(attempts, now, deadline) : null;
  // Distinguish "no retries left" from "retries left but the download window closed first": the
  // attempt budget is untouched in the second case, so reporting it as exhausted is misleading.
  const pausedBy = status === 'RETRY_WAIT' && delay === null ? 'DELIVERY_WINDOW_CLOSED' : null;
  if (pausedBy) status = 'PAUSED';
  return {
    status, attempts, channel: input.channel, updatedAt: new Date(now).toISOString(),
    ...(pausedBy ? { pausedBy } : {}),
    nextAttemptAt: status === 'RETRY_WAIT' ? new Date(now + delay).toISOString() : null,
    requests: [...previous.requests, { id: input.requestId, channel: input.channel }],
    events: [...(previous.events || []), { status, attempt: attempts, at: new Date(now).toISOString() }]
  };
}
