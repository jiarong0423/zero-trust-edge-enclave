import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { advanceFileJobs, advanceFollowups } from '../file-worker.js';
import { newTask, confirmFirst, confirmSecond } from '../snapshot-lifecycle.js';
import { sealFileBytes } from '../public/file-envelope.js';
import { exportNoticesSafe } from '../notice-outbox.js';
import { fileWorkPass } from '../worker-pass.js';

const HOUR = 3600000;
const actor = { id: 'sender', kind: 'operator' };

// An approved delivery that routing has not touched yet, so one pass does the routing AND the follow-up.
async function approved(now) {
  const expiresAt = new Date(now + 40 * HOUR).toISOString();
  const grant = { id: 'grant', version: 1, operatorId: actor.id, recipients: ['a', 'b'], channels: ['email'],
    maxAttempts: 2, expiresAt, simulatedOutcomes: ['prepared'] };
  const config = { grants: [grant], principals: [actor, { id: 'a', kind: 'recipient' }, { id: 'b', kind: 'recipient' }] };
  const sealed = await sealFileBytes(new Uint8Array([1, 2, 3]), 'mock.csv');
  const draft = newTask(actor, grant, { documentHash: sealed.commitment, recipients: ['a', 'b'], channels: ['email'], expiresAt,
    deliveryDeadline: expiresAt, deliveryMode: 'REQUIRED_ACK', downloadUntil: null }, now);
  draft.file = { packet: sealed.packet };
  const first = confirmFirst(draft, actor, grant, 1, now);
  return { task: confirmSecond(first.task, actor, grant, 1, first.token, now), config };
}

async function harness(t, { followupAdvise, exportNotices } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'worker-pass-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const now = Date.now();
  const { task, config } = await approved(now);
  const store = { tasks: [task], writes: 0, recovers: 0, exports: 0 };
  const io = {
    readTasks: async () => store.tasks,
    writeTasks: async tasks => { store.tasks = structuredClone(tasks); store.writes += 1; },
    loadConfig: async () => config,
    advanceFileJobs, advanceFollowups,
    followupAdvise,
    recordOverdue: value => value,
    recover: async () => { store.recovers += 1; },
    exportNotices: async tasks => { store.exports += 1; return (exportNotices ?? (list => exportNoticesSafe(list, path.join(dir, 'outbox'), () => {})))(tasks); },
  };
  const outbox = async () => (await fs.readFile(path.join(dir, 'outbox', 'notices.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { io, store, outbox, now };
}

test('the first notice reaches the outbox even when the follow-up pass replaces it on the same tick', async t => {
  const remind = async metadata => ({ taskAlias: metadata.taskAlias, snapshotVersion: metadata.snapshotVersion, action: 'REMIND', reasonCode: 'NO_PICKUP_YET' });
  const { io, store, outbox } = await harness(t, { followupAdvise: remind });
  const result = await fileWorkPass(io, { dirty: true });
  assert.deepEqual(result, { ran: true, changed: true });
  assert.equal(store.tasks[0].jobs[0].notice.subjectCode, 'SEALED_DOCUMENT_REMINDER', 'the follow-up really did replace job.notice');
  const subjects = (await outbox()).map(record => record.subjectCode).sort();
  assert.deepEqual(subjects, ['SEALED_DOCUMENT_AVAILABLE', 'SEALED_DOCUMENT_REMINDER']);
});

test('an unchanged tick does no export work, and a failed export is retried on the next tick', async t => {
  let failing = true;
  const { io, store } = await harness(t, {
    exportNotices: async () => ({ appended: 0, skipped: 0, ...(failing ? { failed: true } : {}) }),
  });
  const state = { dirty: true };
  await fileWorkPass(io, state);
  assert.equal(state.dirty, true, 'a failed export leaves the outbox marked behind');
  const afterFirst = store.exports;
  failing = false;
  await fileWorkPass(io, state);
  assert.ok(store.exports > afterFirst, 'the failed export is retried');
  assert.equal(state.dirty, false);
  const settled = store.exports;
  await fileWorkPass(io, state);
  await fileWorkPass(io, state);
  assert.equal(store.exports, settled, 'nothing changed, so nothing is exported');
});

test('a tick with no file tasks reads once and touches nothing', async t => {
  const { io, store } = await harness(t);
  store.tasks = [{ id: 'no-file', jobs: [], snapshots: [] }];
  assert.deepEqual(await fileWorkPass(io, { dirty: true }), { ran: false });
  assert.equal(store.writes + store.recovers + store.exports, 0);
});
