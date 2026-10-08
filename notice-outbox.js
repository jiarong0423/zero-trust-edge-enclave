import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

// A durable, identity-free copy of every dry-run notice, for an operator's own gateway to pick up.
// The app never sends anything (sendsEmail is always false); this file is the integration point.
//
// What leaves this module is a NEW object built from an allowlist. Nothing is spread from the
// task, the job or the notice, so a field added to those records later cannot reach the outbox by
// accident. Recipients appear only as group codes (A1, B2), never as ids or addresses.
//
// Durability is the file itself: a notice is appended before anything else is remembered, and the
// next call re-reads the noticeIds already on disk. A crash between two passes therefore can
// neither duplicate a notice nor lose one, and there is no second state file to drift.

const GROUP_CODE = /^[A-Z][1-9][0-9]{0,2}$/;
const TASK_ALIAS = /^[A-Za-z0-9-]{8,64}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const KINDS = new Set(['LOCAL_DRY_RUN']);
// A fixed vocabulary of two words, never free text, so a gateway can tell a first notice from a reminder
// and a producer cannot smuggle text through this field.
const SUBJECT_CODES = new Set(['SEALED_DOCUMENT_AVAILABLE', 'SEALED_DOCUMENT_REMINDER']);
const MAX_TARGETS = 26 * 999;
// Reading the whole file is how duplicates are avoided, so it must be bounded: past this size the
// export refuses rather than guessing, and the operator rotates the file.
const MAX_OUTBOX_BYTES = 64 * 1024 * 1024;

export function noticeId(taskAlias, snapshotVersion, kind, preparedAt) {
  return createHash('sha256').update(`${taskAlias}|${snapshotVersion}|${kind}|${preparedAt}`).digest('hex');
}

function validTargets(list) {
  if (!Array.isArray(list) || list.length > MAX_TARGETS) return null;
  if (!list.every(code => typeof code === 'string' && GROUP_CODE.test(code))) return null;
  return [...new Set(list)].sort();
}

// The first-pass notice carries no targets of its own; the codes come from the approved snapshot's
// private mapping, which is where the receipt view reads them from as well.
function snapshotTargets(task, version) {
  const snapshot = Array.isArray(task?.snapshots) ? task.snapshots.find(item => item?.version === version) : null;
  const recipients = snapshot?.privateMapping?.recipients;
  if (!Array.isArray(recipients)) return [];
  return validTargets(recipients.map(entry => entry?.groupCode)) || [];
}

export function noticeRecord(task, job, notice) {
  try {
    if (!notice || typeof notice !== 'object' || Array.isArray(notice)) return null;
    if (notice.sendsEmail !== false) return null;
    const kind = notice.kind;
    if (typeof kind !== 'string' || !KINDS.has(kind)) return null;
    const subjectCode = notice.subjectCode;
    if (typeof subjectCode !== 'string' || !SUBJECT_CODES.has(subjectCode)) return null;
    const taskAlias = notice.taskAlias;
    if (typeof taskAlias !== 'string' || !TASK_ALIAS.test(taskAlias)) return null;
    const snapshotVersion = notice.version;
    if (!Number.isSafeInteger(snapshotVersion) || snapshotVersion < 1) return null;
    if (job && typeof job === 'object' && job.version !== undefined && job.version !== snapshotVersion) return null;
    const preparedAt = notice.preparedAt;
    if (typeof preparedAt !== 'string' || !ISO_INSTANT.test(preparedAt) || !Number.isFinite(Date.parse(preparedAt))) return null;
    let targets;
    if (notice.targets === undefined) targets = snapshotTargets(task, snapshotVersion);
    else {
      targets = validTargets(notice.targets);
      if (!targets) return null;
    }
    return {
      noticeId: noticeId(taskAlias, snapshotVersion, kind + '|' + subjectCode, preparedAt),
      kind,
      subjectCode,
      taskAlias,
      snapshotVersion,
      targets,
      preparedAt,
      sendsEmail: false
    };
  } catch { return null; }
}

function collect(tasks) {
  const records = new Map();
  if (!Array.isArray(tasks)) return records;
  for (const task of tasks) {
    if (!task || typeof task !== 'object' || !Array.isArray(task.jobs)) continue;
    for (const job of task.jobs) {
      if (!job || typeof job !== 'object' || !job.notice) continue;
      const record = noticeRecord(task, job, job.notice);
      if (record && !records.has(record.noticeId)) records.set(record.noticeId, record);
    }
  }
  return records;
}

function parseIds(text) {
  const ids = new Set();
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const value = JSON.parse(line);
      if (value && typeof value.noticeId === 'string' && /^[0-9a-f]{64}$/.test(value.noticeId)) ids.add(value.noticeId);
    } catch { /* a truncated or damaged line is not an identity; the notice behind it is simply written again */ }
  }
  return ids;
}

async function readAll(handle, size) {
  const buffer = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await handle.read(buffer, offset, size - offset, offset);
    if (!bytesRead) break;
    offset += bytesRead;
  }
  return buffer.subarray(0, offset);
}

// One export at a time per directory inside this process; the worker queue already serializes
// passes, this keeps a direct caller from interleaving two appends.
const chains = new Map();
const idCache = new Map();

async function exportLocked(tasks, outboxDir) {
  const candidates = collect(tasks);
  if (!candidates.size) return { appended: 0, skipped: 0 };
  const dir = path.resolve(outboxDir);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await fs.chmod(dir, 0o700);
  const file = path.join(dir, 'notices.jsonl');
  const handle = await fs.open(file, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw Object.assign(new Error('OUTBOX_NOT_A_FILE'), { code: 'OUTBOX_NOT_A_FILE' });
    if (stat.size > MAX_OUTBOX_BYTES) throw Object.assign(new Error('OUTBOX_TOO_LARGE'), { code: 'OUTBOX_TOO_LARGE' });
    if (process.platform !== 'win32') await handle.chmod(0o600);
    // The worker calls this every tick; an unchanged file (same size and mtime) is not read again.
    const cached = idCache.get(file);
    const unchanged = cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs;
    const existing = unchanged ? null : await readAll(handle, stat.size);
    const known = unchanged ? cached.ids : parseIds(existing.toString('utf8'));
    const fresh = [...candidates.values()].filter(record => !known.has(record.noticeId));
    const skipped = candidates.size - fresh.length;
    if (!fresh.length) {
      idCache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, ids: known });
      return { appended: 0, skipped };
    }
    // A crash can leave a last line without its newline. Starting on a new line keeps the damaged
    // fragment separate instead of fusing it with the first record written now.
    const tailByte = Buffer.alloc(1);
    const needsLead = stat.size > 0 && (await handle.read(tailByte, 0, 1, stat.size - 1)).bytesRead === 1 && tailByte[0] !== 0x0a;
    await handle.write((needsLead ? '\n' : '') + fresh.map(record => JSON.stringify(record)).join('\n') + '\n');
    await handle.sync();
    const after = await handle.stat();
    idCache.set(file, { size: after.size, mtimeMs: after.mtimeMs, ids: new Set([...known, ...fresh.map(record => record.noticeId)]) });
    return { appended: fresh.length, skipped };
  } finally { await handle.close(); }
}

export function exportNotices(tasks, outboxDir) {
  const key = path.resolve(String(outboxDir));
  const previous = chains.get(key) || Promise.resolve();
  const run = previous.catch(() => {}).then(() => exportLocked(tasks, outboxDir));
  const tail = run.catch(() => {});
  chains.set(key, tail);
  tail.then(() => { if (chains.get(key) === tail) chains.delete(key); });
  return run;
}

// The worker and the request path must never fail because a file could not be written: the notice
// stays in tasks.json and is exported by the next pass.
const lastLogged = new Map();
const LOG_INTERVAL_MS = 60_000;
export async function exportNoticesSafe(tasks, outboxDir, log = line => console.error(line), now = Date.now, gate = lastLogged) {
  try { return await exportNotices(tasks, outboxDir); }
  catch (error) {
    // The worker retries every tick while the outbox is unwritable; one line a minute per cause is
    // enough to see it without burying everything else in the log.
    const code = error?.code || error?.name || 'UNKNOWN';
    const current = now();
    if (current - (gate.get(code) ?? -Infinity) >= LOG_INTERVAL_MS) {
      gate.set(code, current);
      try { log(`ERROR outbox export failed: ${code}`); } catch { /* logging must not throw either */ }
    }
    return { appended: 0, skipped: 0, failed: true };
  }
}
