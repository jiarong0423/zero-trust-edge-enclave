/**
 * One tick of the file worker: route prepared deliveries, then follow up on the ones nobody has
 * collected, persist, and hand the prepared notices to the outbox. It lives here, with its storage
 * and effects passed in, so the order of those steps can be tested without a server.
 *
 * The order matters in one place. The follow-up pass is consulted at approval as well (the first
 * countdown band is WINDOW_FULL), so a model that answers REMIND there replaces `job.notice` on the
 * same tick that routing created it. Routing's result is therefore persisted and exported BEFORE the
 * follow-up pass runs; otherwise the first notice would never reach the outbox.
 *
 * `state.dirty` says whether the outbox may be behind tasks.json: it starts true (a restart exports
 * whatever is already prepared, and the outbox deduplicates), is set when a tick changed anything,
 * and stays set after a failed export so the next tick retries. An unchanged tick does no export work.
 */
export async function fileWorkPass(io, state = { dirty: true }, now = Date.now) {
  const tasks = await io.readTasks();
  if (!tasks.some(task => task.file)) return { ran: false };
  const config = await io.loadConfig();
  let changed = false;
  const exportAll = async () => {
    const result = await io.exportNotices(tasks);
    state.dirty = Boolean(result?.failed);
  };
  for (let index = 0; index < tasks.length; index += 1) {
    const routed = await io.advanceFileJobs(tasks[index], config, now(), io.routeAdvise, io.loadConfig);
    if (routed !== tasks[index]) {
      tasks[index] = routed;
      await io.writeTasks(tasks);
      await io.recover();
      await exportAll();
    }
    const chased = await io.advanceFollowups(routed, config, now(), io.followupAdvise, io.loadConfig);
    const next = io.recordOverdue(chased);
    if (next !== tasks[index]) { tasks[index] = next; changed = true; }
  }
  if (changed) {
    await io.writeTasks(tasks);
    state.dirty = true;
  }
  await io.recover();
  if (state.dirty) await exportAll();
  return { ran: true, changed };
}
