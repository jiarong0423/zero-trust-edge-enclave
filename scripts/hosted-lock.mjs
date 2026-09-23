import { promises as fs } from 'node:fs';

/**
 * Whether the pid a server.lock records is a server still running in this container.
 *
 * `process.kill(pid, 0)` is not enough on Linux: it also succeeds for a thread id, and container pid
 * numbering is deterministic. The server that wrote the lock was pid 18 in the last container, and in
 * the next one this wrapper's own threads occupy 7 to 17 and sometimes 18, so a stale lock could look
 * held by the process meant to clear it. Where /proc exists, the pid must lead its own thread group and
 * be running server.js. Without /proc, as on macOS, the plain probe is the only signal available.
 */
export async function lockHeldByLiveServer(pid, {
  self = process.pid,
  readProc = file => fs.readFile(file, 'utf8'),
  probe = id => process.kill(id, 0)
} = {}) {
  if (!Number.isSafeInteger(pid) || pid < 1 || pid === self) return false;
  const hasProc = await readProc('/proc/self/status').then(() => true, () => false);
  if (!hasProc) {
    try { probe(pid); return true; } catch { return false; }
  }
  const status = await readProc(`/proc/${pid}/status`).catch(() => null);
  if (status === null) return false;
  if (Number(/^Tgid:\s*(\d+)/m.exec(status)?.[1]) !== pid) return false;
  const cmdline = await readProc(`/proc/${pid}/cmdline`).catch(() => '');
  return cmdline.split('\0').some(arg => /(^|\/)server\.js$/.test(arg));
}
