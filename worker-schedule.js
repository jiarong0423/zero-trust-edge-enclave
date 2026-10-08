import path from 'node:path';
import { fileWorkPass } from './worker-pass.js';
import { loadAccess } from './access-control.js';
import { advanceFileJobs, advanceFollowups } from './file-worker.js';
import { recordOverdueDeliveries } from './file-receipts.js';
import { exportNoticesSafe } from './notice-outbox.js';

// Background file work. Every pass runs on the shared serial queue (risk 1 in the split plan), so a
// pass never interleaves with an /api/ request. `workerBusy` allows one pending pass at a time.
export function createFileWorker({ queue, readJson, writeJson, tasksPath, accessPath, dataDir, recoverAudit, fileAdviser, webhook }) {
  let workerBusy = false;
  let workerFailureReported = false;
  const workerState = { dirty: true };
  const workerIo = {
    readTasks: () => readJson(tasksPath, []),
    writeTasks: tasks => writeJson(tasksPath, tasks),
    loadConfig: () => loadAccess(accessPath),
    advanceFileJobs, advanceFollowups,
    routeAdvise: async metadata => (await fileAdviser(metadata)).advice,
    followupAdvise: async metadata => (await fileAdviser(metadata, 'followup')).advice,
    recordOverdue: recordOverdueDeliveries,
    recover: () => recoverAudit(tasksPath),
    exportNotices: async tasks => {
      const result = await exportNoticesSafe(tasks, path.join(dataDir, 'outbox'));
      // kick() never throws and is not awaited, so retries and backoff never hold the serial queue.
      if (webhook && !result?.failed) void webhook.kick();
      return result;
    },
  };
  function scheduleFileWork() {
    if (workerBusy) return;
    workerBusy = true;
    queue.chain(async () => {
      await fileWorkPass(workerIo, workerState);
      workerFailureReported = false;
    }, run => run.catch(() => {
      if (!workerFailureReported) console.error('FILE_WORKER_STORAGE_UNAVAILABLE');
      workerFailureReported = true;
    }).finally(() => { workerBusy = false; }));
  }
  return { scheduleFileWork };
}
