import crypto from 'node:crypto';
import { queueAudit } from './audit-outbox.js';
import { dispatchSnapshot } from './snapshot-lifecycle.js';
import { principalEnabled } from './registry-schema.js';
import { resolvePrivateRoute } from './private-mapping.js';
import { activeGrant, authorizeRecord, safeMetadata, advanceDelivery, fail } from './access-control.js';
import { compileEnvelope } from './policy-envelope.js';
import { hashJson, normalizeString } from './value-helpers.js';
import { currentRequest, setAuditTarget } from './request-context.js';

// The sealed-package operations behind the legacy browser flow, the MCP transport tools and the
// coordinator's `status`, `recommend` and `deliver` tools. Moved out of server.js verbatim. Every one
// of them reads the live per-request store through currentRequest(), so none may run outside a
// request. State writes go through the server's own `writeJson`, and `performLocalDelivery` keeps the
// order the audit contract needs: write the record, then recoverAudit, with nothing else awaited between.
export function createLegacyPackages({ packagesPath, tasksPath, readJson, writeJson, appendAudit, recoverAudit,
  validatePolicy, createSignedCredential, buildDryRunEmailDraft }) {
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

  return { createTimedCredential, evaluateDecodeAttempt, findPackage, approvedPackage, createSealedPackageRecord, performLocalDelivery };
}
