import crypto from 'node:crypto';
import { exact, fail } from './access-control.js';
import { createPrivateMapping, checkPrivateMapping } from './private-mapping.js';
import { normalizeDownloadPolicy } from './download-policy.js';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const reject = () => fail('SNAPSHOT_REJECTED', 409);
const snapshotHash = (taskId, snapshot) => hash(JSON.stringify({ taskId, version: snapshot.version,
  content: snapshot.content, privateMapping: snapshot.privateMapping }));

function owner(task, actor) {
  if (!actor || actor.kind !== 'operator' || actor.disabled || task.ownerId !== actor.id) reject();
}

function content(input, grant, now) {
  exact(input, ['documentHash', 'recipients', 'channels', 'expiresAt', 'deliveryDeadline', 'deliveryMode', 'downloadUntil']);
  if (!/^[a-f0-9]{64}$/.test(input.documentHash || '') ||
      !Array.isArray(input.recipients) || !input.recipients.length ||
      input.recipients.some(id => !grant.recipients.includes(id)) ||
      !Array.isArray(input.channels) || !input.channels.length ||
      input.channels.some(channel => !grant.channels.includes(channel)) ||
      !Number.isFinite(Date.parse(input.expiresAt)) || Date.parse(input.expiresAt) <= now ||
      Date.parse(input.expiresAt) > Date.parse(grant.expiresAt)) reject();
  const deadline = input.deliveryDeadline || input.expiresAt;
  if (!Number.isFinite(Date.parse(deadline)) || Date.parse(deadline) > Date.parse(input.expiresAt)) reject();
  return { ...normalizeDownloadPolicy(input), documentHash: input.documentHash, recipients: [...new Set(input.recipients)].sort(), deliveryDeadline: new Date(deadline).toISOString(),
    channels: [...new Set(input.channels)].sort(), expiresAt: new Date(input.expiresAt).toISOString() };
}

function validGrant(task, grant, now) {
  if (grant.id !== task.grantId || grant.operatorId !== task.ownerId || grant.revoked ||
      !Number.isFinite(Date.parse(grant.expiresAt)) || Date.parse(grant.expiresAt) <= now) reject();
}

function version(task, number) {
  if (!Number.isSafeInteger(number)) reject();
  const snapshot = task.snapshots.find(item => item.version === number);
  if (!snapshot) reject();
  return snapshot;
}

function checked(task, number, grant, now) {
  validGrant(task, grant, now);
  const snapshot = version(task, number);
  if (snapshot.grantVersion !== grant.version || snapshot.revokedAt ||
      snapshot.status === 'INVALIDATED' || Date.parse(snapshot.content.expiresAt) <= now) reject();
  content(snapshot.content, grant, now);
  checkPrivateMapping(snapshot.privateMapping, task.id, number, snapshot.content);
  if (snapshot.hash !== snapshotHash(task.id, snapshot)) reject();
  return snapshot;
}

// Callers must commit the returned task atomically under an authoritative revision check.
export function newTask(actor, grant, input, now = Date.now(), departments = {}) {
  const task = { id: crypto.randomUUID(), ownerId: actor.id, grantId: grant.id, snapshots: [], jobs: [] };
  return reviseTask(task, actor, grant, input, now, departments);
}

export function reviseTask(original, actor, grant, input, now = Date.now(), departments = {}) {
  owner(original, actor);
  validGrant(original, grant, now);
  const nextContent = content(input, grant, now);
  const task = structuredClone(original);
  for (const previous of task.snapshots) {
    if (['DRAFT', 'LOCKED'].includes(previous.status)) {
      previous.status = 'INVALIDATED';
      previous.confirmedAt = null;
      previous.submissionHash = null;
      previous.invalidatedAt = new Date(now).toISOString();
    }
  }
  const number = (task.snapshots.at(-1)?.version || 0) + 1;
  const privateMapping = createPrivateMapping(task.id, number, nextContent, departments);
  task.snapshots.push({ version: number, status: 'DRAFT', grantVersion: grant.version,
    content: nextContent, privateMapping, hash: snapshotHash(task.id, { version: number, content: nextContent, privateMapping }),
    confirmedAt: null, submissionHash: null, approvedAt: null, revokedAt: null });
  return task;
}

export function confirmFirst(original, actor, grant, number, now = Date.now()) {
  owner(original, actor);
  const task = structuredClone(original);
  const snapshot = checked(task, number, grant, now);
  if (snapshot.status !== 'DRAFT') reject();
  const token = crypto.randomBytes(32).toString('base64url');
  snapshot.status = 'LOCKED';
  snapshot.confirmedAt = new Date(now).toISOString();
  snapshot.submissionHash = hash(token);
  return { task, token };
}

export function confirmSecond(original, actor, grant, number, token, now = Date.now()) {
  owner(original, actor);
  const task = structuredClone(original);
  const snapshot = checked(task, number, grant, now);
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) reject();
  const digest = hash(token);
  if (snapshot.status === 'APPROVED') {
    if (snapshot.consumedSubmissionHash !== digest) reject();
    return task;
  }
  if (snapshot.status !== 'LOCKED' || !snapshot.confirmedAt || snapshot.submissionHash !== digest) reject();
  snapshot.status = 'APPROVED';
  snapshot.approvedAt = new Date(now).toISOString();
  snapshot.consumedSubmissionHash = digest;
  snapshot.submissionHash = null;
  task.jobs.push({ taskId: task.id, version: number, status: 'PENDING_CHECK', attempts: 0 });
  return task;
}

export function revokeSnapshot(original, actor, number, now = Date.now()) {
  owner(original, actor);
  const task = structuredClone(original);
  const snapshot = version(task, number);
  snapshot.revokedAt ||= new Date(now).toISOString();
  snapshot.submissionHash = null;
  for (const job of task.jobs) {
    if (job.version !== number) continue;
    job.status = 'REVOKED';
    // A pending adviser retry ends with the revocation; leaving it would label a revoked delivery
    // as waiting on the adviser.
    delete job.nextAdviceAt;
    delete job.adviceRetries;
    if (job.reasonCode === 'ADVISER_UNAVAILABLE') job.reasonCode = null;
  }
  return task;
}

export function dispatchSnapshot(authoritativeTask, grant, number, now = Date.now()) {
  const snapshot = checked(authoritativeTask, number, grant, now);
  const job = authoritativeTask.jobs.find(item => item.version === number);
  if (snapshot.status !== 'APPROVED' || !job || job.status === 'REVOKED') reject();
  return structuredClone(snapshot);
}

export function invalidatePending(original, actor, number, now = Date.now()) {
  owner(original, actor);
  const task = structuredClone(original);
  const snapshot = version(task, number);
  if (snapshot.status === 'APPROVED') reject();
  snapshot.status = 'INVALIDATED';
  snapshot.confirmedAt = null;
  snapshot.submissionHash = null;
  snapshot.invalidatedAt = new Date(now).toISOString();
  return task;
}
