import test from 'node:test';
import assert from 'node:assert/strict';
import { lockHeldByLiveServer } from './hosted-lock.mjs';

// A fake /proc: pid 7 is the wrapper with threads 8-18, pid 30 is a live server.
const proc = {
  '/proc/self/status': 'Name:\tnode\nTgid:\t7\n',
  '/proc/7/status': 'Name:\tnode\nTgid:\t7\n', '/proc/7/cmdline': 'node\0scripts/start-hosted.mjs\0',
  '/proc/18/status': 'Name:\tnode\nTgid:\t7\n', '/proc/18/cmdline': 'node\0scripts/start-hosted.mjs\0',
  '/proc/30/status': 'Name:\tnode\nTgid:\t30\n', '/proc/30/cmdline': '/usr/local/bin/node\0server.js\0'
};
const readProc = async file => {
  if (file in proc) return proc[file];
  throw Object.assign(new Error('missing'), { code: 'ENOENT' });
};
const alive = () => {};

test('a stale lock whose pid is now a thread of this wrapper is not treated as held', async () => {
  assert.equal(await lockHeldByLiveServer(18, { self: 7, readProc, probe: alive }), false);
});

test('a lock naming a live server process is left alone', async () => {
  assert.equal(await lockHeldByLiveServer(30, { self: 7, readProc, probe: alive }), true);
});

test('a lock naming this wrapper, a missing pid or a non-server process is stale', async () => {
  assert.equal(await lockHeldByLiveServer(7, { self: 7, readProc, probe: alive }), false);
  assert.equal(await lockHeldByLiveServer(99, { self: 7, readProc, probe: alive }), false);
  proc['/proc/40/status'] = 'Tgid:\t40\n'; proc['/proc/40/cmdline'] = 'sleep\u0000100\u0000';
  assert.equal(await lockHeldByLiveServer(40, { self: 7, readProc, probe: alive }), false);
  assert.equal(await lockHeldByLiveServer(Number.NaN, { self: 7, readProc, probe: alive }), false);
});

test('without /proc the signal probe decides', async () => {
  const noProc = async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); };
  assert.equal(await lockHeldByLiveServer(18, { self: 7, readProc: noProc, probe: alive }), true);
  assert.equal(await lockHeldByLiveServer(18, { self: 7, readProc: noProc,
    probe: () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); } }), false);
});
