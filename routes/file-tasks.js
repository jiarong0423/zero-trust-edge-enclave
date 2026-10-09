import { promises as fs } from 'node:fs';
import path from 'node:path';
import { auditProjection } from '../audit-boundary.js';
import { queueAudit } from '../audit-outbox.js';
import { newTask, reviseTask, confirmFirst, confirmSecond, revokeSnapshot, invalidatePending } from '../snapshot-lifecycle.js';
import { listRecipients } from '../recipient-directory.js';
import { resolveRecipient, validTags, MATCH_MESSAGES } from '../recipient-match.js';
import { fixedOrder, RANK_TEXT_MAX } from '../recipient-rank.js';
import { matchProjection, matchTable, reviewMatch } from '../match-confirm.js';
import crypto from 'node:crypto';
import { departmentMap } from '../registry-schema.js';
import { resumeFileTask } from '../task-operations.js';
import { packetCommitment } from '../public/file-envelope.js';
import { openLocalKeyVault } from '../local-key-vault.js';
import { taskEvidence } from '../task-evidence.js';
import { activeGrant, exact, fail } from '../access-control.js';
import { sendJson, readBody } from '../http-helpers.js';
import { senderTask } from '../task-view.js';
import { setAuditTarget } from '../request-context.js';

const sanitizeAuditEvent = event => auditProjection(event);

// The sender's workspace: file intake, the task list and lifecycle (revise, confirm, revoke, invalidate,
// resume), the evidence chain, and the read-only lists the sender's pages need (grants, directory,
// audit view). Moved out of routeApi in the order it had there. The caller has authenticated the
// principal; `handleFileTasks` returns true when it answered the request and false when the path is
// not one of its own, so routeApi can carry on. Every state write is followed by recoverAudit inside
// the same queued request (risk 2 in the split plan).
export function createFileTaskRoutes({ dataDir, tasksPath, packagesPath, auditsPath, readJson, writeJson, appendAudit, recoverAudit, matchGuard, matchReviewer = null,
  recipientRanker = { rank: async people => ({ order: fixedOrder(people), method: 'fixed', fallback: 'RANKING_OFF' }) } }) {
  // One EVIDENCE_VIEWED record per task per minute: repeated views add nothing and would push older
  // delivery events out of the retained audit window.
  const evidenceViews = new Map();

  async function handleFileTasks(req, res, pathname, { config, principal }) {
    if (pathname === '/api/file-tasks' && req.method === 'POST') {
      if (principal.kind !== 'operator') fail('Operator required');
      const input = await readBody(req, 7_100_000);
      exact(input, ['authorizationId', 'recipients', 'channels', 'expiresAt', 'deliveryDeadline', 'deliveryMode', 'downloadUntil', 'packet', 'documentKey']);
      let commitment;
      try { commitment = await packetCommitment(input.packet); }
      catch { fail('Invalid file packet', 422); }
      if (typeof input.documentKey !== 'string' || !/^[a-f0-9]{64}$/.test(input.documentKey)) fail('Invalid document key', 422);
      const grant = activeGrant(config, input.authorizationId);
      const task = newTask(principal, grant, { documentHash: commitment, recipients: input.recipients,
        channels: input.channels, expiresAt: input.expiresAt, deliveryDeadline: input.deliveryDeadline,
        deliveryMode: input.deliveryMode, downloadUntil: input.downloadUntil }, Date.now(), departmentMap(config));
      const tasks = await readJson(tasksPath, []);
      if (tasks.some(item => item.file?.packet.context === input.packet.context && item.ownerId === principal.id)) fail('File intake already exists', 409);
      if (tasks.filter(item => item.file).length >= 50) fail('Local file staging quota reached', 507);
      const keyBytes = Buffer.from(input.documentKey, 'hex');
      delete input.documentKey;
      let vault;
      try {
        vault = await openLocalKeyVault(path.join(await fs.realpath(dataDir), 'private-keys'));
        task.file = { packet: input.packet, wrappedKey: vault.wrap(keyBytes, { taskId: task.id, version: 1, commitment }),
          stagedAt: new Date().toISOString(), keyVersion: 1 };
      } finally { keyBytes.fill(0); vault?.close(); }
      tasks.push(queueAudit(task, [{ taskId: task.id, snapshotVersion: 1, type: 'SNAPSHOT_TRANSITION', result: 'INFO',
        previousState: null, nextState: 'DRAFT', attempts: 0, reasons: ['STATE_CHANGED'] }]));
      await writeJson(tasksPath, tasks);
      await recoverAudit(tasksPath);
      sendJson(res, 201, { task: senderTask(task), mode: 'local_encrypted_staging', sendsEmail: false });
      return true;
    }
    if (pathname === '/api/tasks' && req.method === 'GET') {
      if (principal.kind !== 'operator') fail('Operator required');
      const tasks = await readJson(tasksPath, []);
      sendJson(res, 200, { tasks: tasks.filter(task => task.ownerId === principal.id).map(task => ({
        id: task.id, authorizationId: task.grantId, hasFile: Boolean(task.file), stagedAt: task.file?.stagedAt || null,
        snapshots: task.snapshots.map(snapshot => ({ version: snapshot.version, status: snapshot.status, revokedAt: snapshot.revokedAt })),
        jobs: senderTask(task).jobs })) });
      return true;
    }
    if (pathname === '/api/tasks' && req.method === 'POST') {
      if (principal.kind !== 'operator') fail('Operator required');
      const input = await readBody(req);
      exact(input, ['authorizationId', 'content']);
      const grant = activeGrant(config, input.authorizationId);
      const task = newTask(principal, grant, input.content, Date.now(), departmentMap(config));
      const tasks = await readJson(tasksPath, []);
      tasks.push(queueAudit(task, [{ taskId: task.id, snapshotVersion: 1, type: 'SNAPSHOT_TRANSITION', result: 'INFO',
        previousState: null, nextState: 'DRAFT', attempts: 0, reasons: ['STATE_CHANGED'] }]));
      await writeJson(tasksPath, tasks);
      await recoverAudit(tasksPath);
      sendJson(res, 201, { task: senderTask(task) });
      return true;
    }
    const taskRoute = pathname.match(/^\/api\/tasks\/([a-f0-9-]{36})(?:\/(revise|confirm-first|confirm-second|revoke|invalidate|resume|evidence))?$/);
    if (taskRoute) {
      if (principal.kind !== 'operator') fail('Operator required');
      const tasks = await readJson(tasksPath, []);
      const index = tasks.findIndex(task => task.id === taskRoute[1]);
      if (index < 0 || tasks[index].ownerId !== principal.id) fail('Task unavailable', 404);
      const task = tasks[index];
      if (req.method === 'GET' && !taskRoute[2]) {
        sendJson(res, 200, { task: senderTask(task) });
        return true;
      }
      if (taskRoute[2] === 'evidence') {
        if (req.method !== 'GET') fail('Unsupported task operation', 405);
        const evidence = taskEvidence(task);
        if (!evidence) fail('Evidence unavailable', 404);
        // Reading the chain is itself an access to what was approved, so it leaves a record too.
        const viewedAt = Date.now();
        if (!(viewedAt - (evidenceViews.get(task.id) || 0) < 60000)) {
          evidenceViews.set(task.id, viewedAt);
          await appendAudit({ taskId: task.id, snapshotVersion: evidence.version, type: 'EVIDENCE_VIEWED',
            result: 'INFO', reasons: ['EVIDENCE_VIEWED'] });
        }
        sendJson(res, 200, { evidence });
        return true;
      }
      if (req.method !== 'POST' || !taskRoute[2]) fail('Unsupported task operation', 405);
      const input = await readBody(req);
      const previousSnapshot = task.snapshots.find(item => item.version === input.version);
      setAuditTarget({ taskId: task.id, snapshotVersion: previousSnapshot?.version,
        previousState: previousSnapshot?.status, attempts: task.jobs.find(job => job.version === input.version)?.attempts || 0 });
      exact(input, ['version', 'content', 'token', 'expectedRevision']);
      let next;
      let token;
      if (taskRoute[2] === 'resume') {
        exact(input, ['version', 'expectedRevision']);
        next = await resumeFileTask(task, principal, config, input.version, input.expectedRevision);
      } else if (['revoke', 'invalidate'].includes(taskRoute[2])) {
        exact(input, ['version']);
        next = taskRoute[2] === 'revoke' ? revokeSnapshot(task, principal, input.version) : invalidatePending(task, principal, input.version);
      } else {
        const grant = activeGrant(config, task.grantId);
        if (taskRoute[2] === 'revise') {
          exact(input, ['version', 'content']);
          if (input.version !== task.snapshots.at(-1).version) fail('Stale task revision', 409);
          next = reviseTask(task, principal, grant, input.content, Date.now(), departmentMap(config));
          if (task.file) {
            const commitment = await packetCommitment(task.file.packet);
            if (input.content.documentHash !== commitment) fail('Replace file through new intake', 409);
            const vault = await openLocalKeyVault(path.join(await fs.realpath(dataDir), 'private-keys'));
            let key;
            try {
              key = vault.unwrap(task.file.wrappedKey, { taskId: task.id, version: task.file.keyVersion, commitment });
              next.file = { ...task.file, keyVersion: next.snapshots.at(-1).version,
                wrappedKey: vault.wrap(key, { taskId: task.id, version: next.snapshots.at(-1).version, commitment }) };
            } finally { key?.fill(0); vault.close(); }
          }
        } else if (taskRoute[2] === 'confirm-first') {
          exact(input, ['version']);
          ({ task: next, token } = confirmFirst(task, principal, grant, input.version));
        } else {
          exact(input, ['version', 'token']);
          next = confirmSecond(task, principal, grant, input.version, input.token);
        }
      }
      const events = [];
      for (const snapshot of next.snapshots) {
        const previous = task.snapshots.find(item => item.version === snapshot.version);
        if (previous?.status === snapshot.status && previous?.revokedAt === snapshot.revokedAt) continue;
        events.push({ taskId: task.id, snapshotVersion: snapshot.version, type: 'SNAPSHOT_TRANSITION', result: 'INFO',
          previousState: previous?.status || null, nextState: snapshot.revokedAt ? 'REVOKED' : snapshot.status,
          attempts: next.jobs.find(job => job.version === snapshot.version)?.attempts || 0, reasons: ['STATE_CHANGED'] });
      }
      tasks[index] = queueAudit(next, events);
      await writeJson(tasksPath, tasks);
      await recoverAudit(tasksPath);
      sendJson(res, 200, { task: senderTask(next), ...(token ? { token } : {}) });
      return true;
    }

    if (pathname === '/api/authorizations' && req.method === 'GET') {
      sendJson(res, 200, { grants: config.grants.filter(g => g.operatorId === principal.id && !g.revoked && Date.parse(g.expiresAt) > Date.now()).map(g => ({ id: g.id, version: g.version, recipients: g.recipients, channels: g.channels, expiresAt: g.expiresAt })) });
      return true;
    }

    // Recipient matching for the sender: the Chinese name first, the employee number second, and a
    // refusal otherwise (recipient-match.js). Fixed code only; the answer carries ids and the sender's
    // own view of people already on this authorization, never anyone outside it. Three failures in a
    // row on one (sender, authorization) quarantine it until an administrator unlocks it.
    if (pathname === '/api/directory/resolve' && req.method === 'POST') {
      const input = await readBody(req);
      exact(input, ['authorizationId', 'nameZh', 'employeeId', 'department', 'tags']);
      const visible = listRecipients(config, principal, input.authorizationId);
      const audit = (result, reasons) => appendAudit({ type: 'MATCH_ATTEMPT', result, reasons });
      if ((await matchGuard.status(principal.id, input.authorizationId)).quarantined) {
        await audit('DENY', ['MATCH_REFUSED_WHILE_QUARANTINED']);
        throw Object.assign(new Error('MATCH_QUARANTINED'), { status: 423 });
      }
      const { authorizationId, ...question } = input;
      const found = resolveRecipient(config, question);
      const onGrant = new Map(visible.recipients.map(person => [person.id, person]));
      let result = found;
      if (found.status === 'MATCHED' && !onGrant.has(found.id)) {
        result = { status: 'NONE', code: 'NONE_NOT_AUTHORIZED', via: null, id: null, candidates: [], nameVerified: false };
      } else if (found.status === 'AMBIGUOUS') {
        const allowed = found.candidates.filter(id => onGrant.has(id));
        result = allowed.length ? { ...found, candidates: allowed }
          : { status: 'NONE', code: 'NONE_NOT_AUTHORIZED', via: null, id: null, candidates: [], nameVerified: false };
      }
      const success = result.status === 'MATCHED';
      const failsBefore = (await matchGuard.status(principal.id, authorizationId)).fails;
      const state = await matchGuard.record(principal.id, authorizationId, success);
      // The checklist: fixed code holds the full table and a veto; an adviser, when one is configured,
      // is asked only about outcomes the table did not already refuse, and can only add care.
      const projection = matchProjection({ status: result.status, code: result.code },
        { reversePass: success, failsBefore, alias: crypto.randomUUID() });
      const table = matchTable(projection);
      let review = reviewMatch(table, []);
      if (matchReviewer && table.action !== 'REFUSE') review = await matchReviewer(projection, table);
      await audit(success ? 'ALLOW' : 'DENY', [result.code.startsWith('MATCH_') ? result.code : `MATCH_${result.code}`]);
      if (state.justQuarantined) await audit('DENY', ['MATCH_QUARANTINED']);
      if (matchReviewer) {
        await audit('INFO', [`MATCH_REVIEW_${review.final}`]);
        if (review.disagreement) await audit('INFO', ['MATCH_REVIEW_DISAGREE']);
        if (review.sources.some(entry => entry.status === 'UNAVAILABLE')) await audit('INFO', ['MATCH_REVIEW_UNAVAILABLE']);
      }
      sendJson(res, 200, {
        ok: true, status: result.status, code: result.code, via: result.via, nameVerified: result.nameVerified,
        message: result.status === 'MATCHED' ? null : MATCH_MESSAGES[result.code] || MATCH_MESSAGES.NONE_NOT_FOUND,
        person: success ? onGrant.get(result.id) : null,
        candidates: result.candidates.map(id => onGrant.get(id)),
        attemptsLeft: state.quarantined ? 0 : matchGuard.limit - state.fails, quarantined: state.quarantined,
        review: { final: review.final, reason: table.reasonCode, disagreement: review.disagreement, sources: review.sources }
      });
      return true;
    }

    // Display order for the sender's own list, by similarity to a short text the sender types for this
    // purpose. The text goes to this server and, when ranking is on, to the embedding model on this
    // machine; it is not the note (which stays in the browser) and it is never stored. Only people on the
    // authorization are ranked and returned, the answer is an order and nothing else, and nobody is selected.
    if (pathname === '/api/directory/rank' && req.method === 'POST') {
      const input = await readBody(req, 4096);
      exact(input, ['authorizationId', 'text', 'department', 'tags']);
      if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > RANK_TEXT_MAX) fail('Invalid ranking text', 422);
      if (input.department !== undefined && typeof input.department !== 'string') fail('Invalid ranking department', 422);
      if (!validTags(input.tags)) fail('Invalid ranking tags', 422);
      const visible = listRecipients(config, principal, input.authorizationId, input.department || '');
      const pool = visible.recipients.filter(person => Object.entries(input.tags || {}).every(([key, tag]) => person.tags?.[key] === tag));
      const ranked = await recipientRanker.rank(input.text, pool, visible.departmentLabels);
      await appendAudit({ type: 'MATCH_ATTEMPT', result: 'INFO', reasons: [ranked.method === 'vector' ? 'MATCH_RANK_VECTOR' : 'MATCH_RANK_FIXED'] });
      sendJson(res, 200, { ok: true, method: ranked.method, fallback: ranked.fallback, order: ranked.order });
      return true;
    }

    if (pathname === '/api/directory' && req.method === 'POST') {
      const input = await readBody(req);
      exact(input, ['authorizationId', 'department', 'query']);
      sendJson(res, 200, listRecipients(config, principal, input.authorizationId, input.department, input.query));
      return true;
    }

    if (req.method === 'GET' && pathname === '/api/audit') {
      const audits = await readJson(auditsPath, []);
      const records = await readJson(packagesPath, []);
      const owned = new Set(records.filter(r => config.grants.some(g => g.id === r.authorization?.id && g.operatorId === principal.id)).map(r => r.id));
      const tasks = await readJson(tasksPath, []);
      const ownedTasks = new Set(tasks.filter(task => task.ownerId === principal.id).map(task => task.id));
      sendJson(res, 200, { events: audits.filter(event => owned.has(event.packageId) || ownedTasks.has(event.taskId)).map(sanitizeAuditEvent).reverse() });
      return true;
    }
    return false;
  }

  return { handleFileTasks };
}
