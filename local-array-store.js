import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const unavailable = () => Object.assign(new Error('LOCAL_STORE_UNAVAILABLE'), { status: 503 });

export async function initializeArrays(files) {
  const existing = [];
  for (const file of files) {
    try { await fs.lstat(file); existing.push(file); }
    catch (error) { if (error.code !== 'ENOENT') throw unavailable(); }
  }
  if (existing.length && existing.length !== files.length) throw unavailable();
  if (existing.length) {
    for (const file of files) await readArray(file);
    return;
  }
  for (const file of files) await fs.writeFile(file, '[]\n', { flag: 'wx', mode: 0o600 });
}

export async function readArray(file) {
  let handle;
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!(await handle.stat()).isFile()) throw unavailable();
    const value = JSON.parse(await handle.readFile('utf8'));
    if (!Array.isArray(value)) throw unavailable();
    return value;
  } catch { throw unavailable(); }
  finally { await handle?.close(); }
}

export async function writeArray(file, value) {
  if (!Array.isArray(value)) throw unavailable();
  const temp = path.join(path.dirname(file), '.' + path.basename(file) + '.' + crypto.randomUUID() + '.tmp');
  let handle;
  let created = false;
  try {
    await readArray(file);
    handle = await fs.open(temp, 'wx', 0o600);
    created = true;
    await handle.writeFile(JSON.stringify(value, null, 2) + '\n');
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temp, file);
    const directory = await fs.open(path.dirname(file), constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  } catch { throw unavailable(); }
  finally {
    await handle?.close();
    if (created) await fs.unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw unavailable(); });
  }
}
