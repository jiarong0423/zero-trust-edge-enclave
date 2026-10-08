import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { exportNotices, exportNoticesSafe, noticeRecord } from '../notice-outbox.js';

const CANARY = 'sales-a@example.com';
const ALIAS = '11111111-2222-4333-8444-555555555555';
const ALLOWED_KEYS = ['kind', 'noticeId', 'preparedAt', 'sendsEmail', 'snapshotVersion', 'subjectCode', 'targets', 'taskAlias'];
const posix = process.platform !== 'win32';

function firstPassNotice(overrides = {}) {
  return { kind: 'LOCAL_DRY_RUN', subjectCode: 'SEALED_DOCUMENT_AVAILABLE', taskAlias: ALIAS, version: 1,
    preparedAt: '2026-10-08T01:02:03.000Z', sendsEmail: false, ...overrides };
}
function reminderNotice(overrides = {}) {
  return { kind: 'LOCAL_DRY_RUN', subjectCode: 'SEALED_DOCUMENT_REMINDER', taskAlias: ALIAS, version: 1,
    targets: ['B2', 'A1'], preparedAt: '2026-10-09T01:02:03.000Z', sendsEmail: false, ...overrides };
}
function taskWith(notice, extra = {}) {
  return { id: 'task-secret-id-0001', ownerId: CANARY, title: CANARY, file: { name: 'payroll-' + CANARY + '.pdf', sha256: 'f'.repeat(64) },
    snapshots: [{ version: 1, status: 'APPROVED', hash: 'a'.repeat(64),
      content: { recipients: [CANARY, 'sales-b@example.com'], channels: ['email'] },
      privateMapping: { taskId: 'task-secret-id-0001', version: 1, taskAlias: ALIAS,
        recipients: [{ alias: 'x', groupCode: 'B1', recipientId: 'sales-b@example.com', endpoints: [] },
          { alias: 'y', groupCode: 'A1', recipientId: CANARY, endpoints: [{ endpointId: 'dry-run:' + CANARY + ':email' }] }] } }],
    jobs: [{ version: 1, status: 'DRY_RUN_PREPARED', recipient: CANARY, notice }], ...extra };
}
async function tempDir() { return fs.mkdtemp(path.join(os.tmpdir(), 'notice-outbox-')); }
async function lines(file) { return (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean); }

test('record shape is exactly the allowlist and the id is the documented hash', () => {
  const record = noticeRecord(taskWith(reminderNotice()), taskWith(reminderNotice()).jobs[0], reminderNotice());
  assert.deepEqual(Object.keys(record).sort(), ALLOWED_KEYS);
  assert.equal(record.sendsEmail, false);
  assert.deepEqual(record.targets, ['A1', 'B2']);
  assert.equal(record.noticeId, createHash('sha256').update(`${ALIAS}|1|LOCAL_DRY_RUN|SEALED_DOCUMENT_REMINDER|2026-10-09T01:02:03.000Z`).digest('hex'));
});

test('first-pass notice takes group codes from the snapshot mapping, never identities', () => {
  const task = taskWith(firstPassNotice());
  const record = noticeRecord(task, task.jobs[0], task.jobs[0].notice);
  assert.deepEqual(Object.keys(record).sort(), ALLOWED_KEYS);
  assert.deepEqual(record.targets, ['A1', 'B1']);
  assert.ok(!JSON.stringify(record).includes('example.com'));
  assert.ok(!JSON.stringify(record).includes('task-secret-id'));
});

test('a first notice and a reminder are told apart by subjectCode, and a missing or free-text subject is refused', () => {
  const first = firstPassNotice(), reminder = reminderNotice();
  const a = noticeRecord(taskWith(first), taskWith(first).jobs[0], first);
  const b = noticeRecord(taskWith(reminder), taskWith(reminder).jobs[0], reminder);
  assert.equal(a.subjectCode, 'SEALED_DOCUMENT_AVAILABLE');
  assert.equal(b.subjectCode, 'SEALED_DOCUMENT_REMINDER');
  assert.notEqual(a.noticeId, b.noticeId);
  for (const bad of [undefined, '', 'lower_case', 'Send the document to bob@example.com', 'X', 42, 'ALICE_CORP_COM', 'SEALED_DOCUMENT_OTHER']) {
    const notice = { ...reminderNotice(), subjectCode: bad };
    assert.equal(noticeRecord(taskWith(notice), taskWith(notice).jobs[0], notice), null, String(bad));
  }
});

test('extra fields on the notice are not copied', () => {
  const notice = reminderNotice({ recipientId: CANARY, address: CANARY, documentHash: 'f'.repeat(64) });
  const record = noticeRecord(taskWith(notice), taskWith(notice).jobs[0], notice);
  assert.deepEqual(Object.keys(record).sort(), ALLOWED_KEYS);
  assert.ok(!JSON.stringify(record).includes(CANARY));
});

test('malformed notices produce no record', () => {
  const task = taskWith(reminderNotice());
  const job = task.jobs[0];
  for (const bad of [null, undefined, 'x', [], {}, reminderNotice({ sendsEmail: true }), reminderNotice({ sendsEmail: undefined }),
    reminderNotice({ kind: 'SEND_EMAIL' }), reminderNotice({ taskAlias: '' }), reminderNotice({ taskAlias: CANARY }),
    reminderNotice({ version: 0 }), reminderNotice({ version: '1' }), reminderNotice({ version: 2 }),
    reminderNotice({ preparedAt: 'yesterday' }), reminderNotice({ preparedAt: 5 }),
    reminderNotice({ targets: [CANARY] }), reminderNotice({ targets: ['a1'] }), reminderNotice({ targets: 'A1' }),
    reminderNotice({ targets: ['A0'] }), reminderNotice({ targets: [['A1']] })]) {
    assert.equal(noticeRecord(task, job, bad), null, JSON.stringify(bad));
  }
});

test('export writes allowlisted lines only, with 0700 directory and 0600 file', async () => {
  const root = await tempDir();
  try {
    const outbox = path.join(root, 'outbox');
    const tasks = [taskWith(firstPassNotice()), taskWith(reminderNotice(), { id: 'task-secret-id-0002' }),
      { id: 'plain', jobs: [{ version: 1, notice: { junk: CANARY } }] }, { id: 'nojobs' }, null, { id: 'badjobs', jobs: 'x' }];
    assert.deepEqual(await exportNotices(tasks, outbox), { appended: 2, skipped: 0 });
    const file = path.join(outbox, 'notices.jsonl');
    const text = await fs.readFile(file, 'utf8');
    assert.ok(!text.includes(CANARY));
    assert.ok(!text.includes('task-secret-id'));
    assert.ok(!text.includes('payroll'));
    assert.ok(!text.includes('f'.repeat(64)));
    const rows = (await lines(file)).map(line => JSON.parse(line));
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.deepEqual(Object.keys(row).sort(), ALLOWED_KEYS);
      assert.ok(row.targets.every(code => /^[A-Z][1-9][0-9]{0,2}$/.test(code)));
      assert.deepEqual(row.targets, [...row.targets].sort());
    }
    if (posix) {
      assert.equal((await fs.stat(outbox)).mode & 0o777, 0o700);
      assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('a second call and a new notice dedupe against the file', async () => {
  const root = await tempDir();
  try {
    const outbox = path.join(root, 'outbox');
    const tasks = [taskWith(firstPassNotice())];
    assert.deepEqual(await exportNotices(tasks, outbox), { appended: 1, skipped: 0 });
    assert.deepEqual(await exportNotices(tasks, outbox), { appended: 0, skipped: 1 });
    tasks[0].jobs.push({ version: 1, notice: reminderNotice() });
    assert.deepEqual(await exportNotices(tasks, outbox), { appended: 1, skipped: 1 });
    assert.deepEqual(await exportNotices(structuredClone(tasks), outbox), { appended: 0, skipped: 2 });
    assert.equal((await lines(path.join(outbox, 'notices.jsonl'))).length, 2);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('a truncated trailing line is tolerated and its notice is written again on a fresh line', async () => {
  const root = await tempDir();
  try {
    const outbox = path.join(root, 'outbox');
    const file = path.join(outbox, 'notices.jsonl');
    const tasks = [taskWith(firstPassNotice()), taskWith(reminderNotice())];
    await exportNotices(tasks, outbox);
    const whole = await fs.readFile(file, 'utf8');
    const rows = whole.split('\n').filter(Boolean);
    await fs.writeFile(file, rows[0] + '\n' + rows[1].slice(0, 40), { mode: 0o600 });
    assert.deepEqual(await exportNotices(tasks, outbox), { appended: 1, skipped: 1 });
    const after = (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean);
    assert.equal(after.length, 3);
    assert.throws(() => JSON.parse(after[1]));
    assert.equal(JSON.parse(after[2]).noticeId, JSON.parse(rows[1]).noticeId);
    assert.deepEqual(await exportNotices(tasks, outbox), { appended: 0, skipped: 2 });
    // A complete last record that merely lacks its newline counts as present.
    await fs.writeFile(file, rows[0] + '\n' + rows[1], { mode: 0o600 });
    assert.deepEqual(await exportNotices(tasks, outbox), { appended: 0, skipped: 2 });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('a restart (state held only in the file) neither duplicates nor loses notices', async () => {
  const root = await tempDir();
  try {
    const outbox = path.join(root, 'outbox');
    await exportNotices([taskWith(firstPassNotice())], outbox);
    const later = [taskWith(firstPassNotice()), taskWith(reminderNotice())];
    assert.deepEqual(await exportNotices(later, outbox), { appended: 1, skipped: 1 });
    assert.equal((await lines(path.join(outbox, 'notices.jsonl'))).length, 2);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('nothing to export creates nothing', async () => {
  const root = await tempDir();
  try {
    const outbox = path.join(root, 'outbox');
    assert.deepEqual(await exportNotices([{ id: 't', jobs: [{ version: 1, status: 'PENDING_CHECK' }] }], outbox), { appended: 0, skipped: 0 });
    await assert.rejects(fs.stat(outbox));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('a write failure rejects exportNotices but never escapes exportNoticesSafe', async () => {
  const root = await tempDir();
  try {
    const blocked = path.join(root, 'outbox');
    await fs.writeFile(blocked, 'not a directory');
    const tasks = [taskWith(firstPassNotice())];
    await assert.rejects(exportNotices(tasks, blocked));
    const logged = [];
    const result = await exportNoticesSafe(tasks, blocked, line => logged.push(line), Date.now, new Map());
    assert.equal(result.failed, true);
    assert.equal(result.appended, 0);
    assert.equal(logged.length, 1);
    assert.match(logged[0], /^ERROR outbox/);
    assert.ok(!logged[0].includes(root));
    // A logger that throws is still contained.
    assert.equal((await exportNoticesSafe(tasks, blocked, () => { throw new Error('log down'); }, Date.now, new Map())).failed, true);
    // Default logger writes one greppable stderr line.
    const original = console.error;
    const captured = [];
    console.error = line => captured.push(line);
    try { await exportNoticesSafe(tasks, blocked, undefined, Date.now, new Map()); } finally { console.error = original; }
    assert.equal(captured.length, 1);
    assert.match(captured[0], /^ERROR outbox/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('exportNoticesSafe tolerates garbage input', async () => {
  const root = await tempDir();
  try {
    for (const input of [undefined, null, 'x', 7, {}, [null, 1, 'a']]) {
      assert.deepEqual(await exportNoticesSafe(input, path.join(root, 'outbox')), { appended: 0, skipped: 0 });
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('an unwritable outbox is logged once a minute per cause, not on every worker tick', async () => {
  const dir = await tempDir();
  const blocker = path.join(dir, 'outbox');
  await fs.writeFile(blocker, 'not a directory');
  const lines = [];
  const gate = new Map();
  let clock = 1_000_000;
  const tasks = [taskWith(reminderNotice())];
  for (let tick = 0; tick < 5; tick += 1) {
    const result = await exportNoticesSafe(tasks, blocker, line => lines.push(line), () => clock, gate);
    assert.equal(result.failed, true);
    clock += 250;
  }
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^ERROR outbox export failed: /);
  clock += 60_000;
  await exportNoticesSafe(tasks, blocker, line => lines.push(line), () => clock, gate);
  assert.equal(lines.length, 2);
});
