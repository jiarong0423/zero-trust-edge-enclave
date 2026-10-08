// The one serial queue shared by every /api/ request and every worker pass (see
// docs/agent/server-split-plan.md, risk 1). `chain` appends a task to the tail and lets the caller
// decide how the tail absorbs that task's outcome; `drain` returns the current tail so shutdown can
// wait for everything already queued. Build exactly one per process, in server.js.
export function createApiQueue() {
  let tail = Promise.resolve();
  return {
    chain(task, absorb) {
      const run = tail.then(task);
      tail = absorb(run);
      return run;
    },
    drain() {
      return tail;
    }
  };
}
