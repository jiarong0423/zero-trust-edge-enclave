import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiQueue } from '../api-queue.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test('tasks run strictly one after another in arrival order', async () => {
  const queue = createApiQueue();
  const log = [];
  const absorb = run => run.catch(() => {});
  const runs = [30, 10, 20].map((ms, index) => queue.chain(async () => {
    log.push(`start ${index}`); await pause(ms); log.push(`end ${index}`); return index;
  }, absorb));
  assert.deepEqual(await Promise.all(runs), [0, 1, 2]);
  assert.deepEqual(log, ['start 0', 'end 0', 'start 1', 'end 1', 'start 2', 'end 2']);
});

test('a rejected task reaches its caller, is absorbed by the tail and does not stop later tasks', async () => {
  const queue = createApiQueue();
  const absorb = run => run.catch(() => {});
  const failing = queue.chain(async () => { throw new Error('boom'); }, absorb);
  const later = queue.chain(async () => 'ok', absorb);
  await assert.rejects(failing, /boom/);
  assert.equal(await later, 'ok');
});

test('the absorb function decides what the tail becomes, and drain waits for it', async () => {
  const queue = createApiQueue();
  const events = [];
  queue.chain(async () => { await pause(20); events.push('task'); throw new Error('x'); },
    run => run.catch(() => { events.push('absorbed'); }).finally(() => { events.push('finally'); }));
  await queue.drain();
  assert.deepEqual(events, ['task', 'absorbed', 'finally']);
  await queue.drain();
});
