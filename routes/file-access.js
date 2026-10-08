import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { queueAudit } from '../audit-outbox.js';
import { dispatchSnapshot } from '../snapshot-lifecycle.js';
import { packetCommitment } from '../public/file-envelope.js';
import { openLocalKeyVault } from '../local-key-vault.js';
import { recordFileReceipt, recipientReceiptStatus } from '../file-receipts.js';
import { checkDownloadAccess, sendDeadlineJson } from '../download-policy.js';
import { activeGrant, exact, fail } from '../access-control.js';
import { sendJson, readBody } from '../http-helpers.js';
import { hashJson } from '../value-helpers.js';
import { setAuditTarget } from '../request-context.js';

// POST /api/file-access/{id}/{credential|packet|key|receipt|receipt-status}: the recipient side of a
// file delivery. Moved out of routeApi verbatim. The caller has authenticated the principal and
// matched the route; every branch below ends the response or throws, and the state write is always
// followed by recoverAudit inside the same queued request (risk 2 in the split plan).
export function createFileAccessRoutes({ dataDir, tasksPath, readJson, writeJson, appendAudit, recoverAudit }) {
  async function handleFileAccess(req, res, fileAccessRoute, { config, principal }) {
    if (principal.kind !== 'recipient') fail('Recipient required');
    const input = await readBody(req);
    exact(input, fileAccessRoute[2] === 'key' ? ['version', 'credential'] :
      fileAccessRoute[2] === 'receipt' ? ['version', 'code'] : ['version']);
    const tasks = await readJson(tasksPath, []);
    const index = tasks.findIndex(task => task.id === fileAccessRoute[1]);
    const task = tasks[index];
    if (!task?.file) fail('File unavailable', 404);
    // The task is resolved from server state here, so a refusal from this point on belongs to it and
    // reaches its sender's audit view. Only the task is named: the version is still the caller's claim.
    setAuditTarget({ taskId: task.id });
    if (fileAccessRoute[2] === 'receipt-status') {
      sendJson(res, 200, recipientReceiptStatus(task, principal, input.version));
      return;
    }
    if (fileAccessRoute[2] === 'receipt') {
      const result = recordFileReceipt(task, principal, input.version, input.code);
      if (result.task !== task) {
        tasks[index] = queueAudit(result.task, [{ taskId: task.id, snapshotVersion: input.version,
          type: 'DECODE_ATTEMPT', result: 'INFO', reasons: [input.code === 'ACKNOWLEDGED' ? 'RECIPIENT_ACKNOWLEDGED'
            : input.code === 'FILE_VERIFIED' ? 'CLIENT_FILE_VERIFIED' : 'CLIENT_DOWNLOAD_REPORTED'] }]);
        await writeJson(tasksPath, tasks); await recoverAudit(tasksPath);
      }
      sendJson(res, 200, { ok: true, code: result.receipt.code, evidence: result.receipt.evidence, reportedAt: result.receipt.reportedAt });
      return;
    }
    const grant = activeGrant(config, task.grantId);
    const snapshot = dispatchSnapshot(task, grant, input.version);
    const downloadDeadline = checkDownloadAccess(snapshot.content);
    if (!snapshot.content.recipients.includes(principal.id)) fail('Recipient outside approved snapshot');
    if (task.jobs.find(job => job.version === input.version)?.status !== 'DRY_RUN_PREPARED') fail('File delivery not prepared', 409);
    const commitment = await packetCommitment(task.file.packet);
    if (commitment !== snapshot.content.documentHash) fail('File integrity rejected', 409);
    const target = { taskId: task.id, snapshotVersion: snapshot.version, previousState: 'DRY_RUN_PREPARED' };
    setAuditTarget(target);
    if (fileAccessRoute[2] === 'packet') {
      await appendAudit({ ...target, type: 'DECODE_ATTEMPT', result: 'INFO', reasons: ['RECIPIENT_ACCEPTED'] });
      sendDeadlineJson(res, 200, { packet: task.file.packet }, downloadDeadline);
      return;
    }
    const released = (task.fileKeyReleases || []).filter(entry => entry.version === snapshot.version && entry.subject === principal.id).length;
    if (released >= grant.maxOpens) fail('File key release limit reached');
    if (fileAccessRoute[2] === 'credential') {
      const credential = crypto.randomBytes(32).toString('base64url');
      const expiresAt = Math.min(Date.now() + 5 * 60000, downloadDeadline);
      const tickets = (task.fileAccessTickets || []).filter(ticket => ticket.expiresAt > Date.now() && !ticket.used);
      if (tickets.length >= 50) fail('Too many pending credentials', 429);
      tickets.push({ hash: hashJson(credential), subject: principal.id, version: snapshot.version, expiresAt, used: false });
      tasks[index] = queueAudit({ ...task, fileAccessTickets: tickets }, [{ ...target, type: 'TIMED_CREDENTIAL_ISSUED', result: 'ALLOW', reasons: ['RECIPIENT_ACCEPTED'] }]);
      await writeJson(tasksPath, tasks);
      await recoverAudit(tasksPath);
      sendDeadlineJson(res, 201, { credential, expiresAt: new Date(expiresAt).toISOString() }, downloadDeadline);
      return;
    }
    if (typeof input.credential !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.credential)) fail('Invalid file credential');
    const ticket = task.fileAccessTickets?.find(entry => entry.hash === hashJson(input.credential));
    if (!ticket || ticket.used || ticket.subject !== principal.id || ticket.version !== snapshot.version || ticket.expiresAt <= Date.now()) fail('File credential rejected');
    const vault = await openLocalKeyVault(path.join(await fs.realpath(dataDir), 'private-keys'));
    let key;
    try {
      key = vault.unwrap(task.file.wrappedKey, { taskId: task.id, version: task.file.keyVersion, commitment });
      ticket.used = true;
      tasks[index] = queueAudit({ ...task, fileKeyReleases: [...(task.fileKeyReleases || []),
        { subject: principal.id, version: snapshot.version, at: new Date().toISOString() }] },
        [{ ...target, type: 'DECODE_ATTEMPT', result: 'ALLOW', reasons: ['RECIPIENT_ACCEPTED'] }]);
      await writeJson(tasksPath, tasks);
      await recoverAudit(tasksPath);
      sendDeadlineJson(res, 200, { key: key.toString('hex') }, downloadDeadline);
    } finally { key?.fill(0); vault.close(); }
    return;
  }

  return { handleFileAccess };
}
