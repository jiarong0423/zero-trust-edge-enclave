import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readArray, writeArray } from './local-array-store.js';

const unavailable = () => Object.assign(new Error('AUDIT_ARCHIVE_UNAVAILABLE'), { status: 503 });
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const pageName = /^[a-f0-9]{64}\.json$/;

async function directory(file) {
  const root = path.join(path.dirname(file), 'audit-archive');
  try { await fs.mkdir(root, { mode: 0o700 }); }
  catch (error) { if (error.code !== 'EEXIST') throw unavailable(); }
  if (!(await fs.lstat(root)).isDirectory() || (await fs.lstat(root)).isSymbolicLink()) throw unavailable();
  return root;
}

async function readPage(root, name) {
  let handle;
  try {
    if (!pageName.test(name)) throw unavailable();
    handle = await fs.open(path.join(root, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!(await handle.stat()).isFile()) throw unavailable();
    const bytes = await handle.readFile();
    if (digest(bytes) + '.json' !== name) throw unavailable();
    const entries = JSON.parse(bytes);
    if (!Array.isArray(entries) || !entries.length || entries.some(entry => typeof entry.id !== 'string')) throw unavailable();
    return entries;
  } catch { throw unavailable(); }
  finally { await handle?.close(); }
}

async function archivePage(root, entries) {
  const bytes = Buffer.from(JSON.stringify(entries) + '\n');
  const name = digest(bytes) + '.json';
  const target = path.join(root, name);
  const temp = path.join(root, '.' + crypto.randomUUID() + '.tmp');
  let handle;
  try {
    handle = await fs.open(temp, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    // Link publishes a fully written page without overwriting an existing archive.
    try { await fs.link(temp, target); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const confirmed = await readPage(root, name);
    if (JSON.stringify(confirmed) !== JSON.stringify(entries)) throw unavailable();
    const dir = await fs.open(root, constants.O_RDONLY);
    try { await dir.sync(); } finally { await dir.close(); }
  } catch { throw unavailable(); }
  finally {
    await handle?.close();
    await fs.unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw unavailable(); });
  }
}

export async function findArchivedAudit(file, id) {
  const root = await directory(file);
  for (const name of (await fs.readdir(root)).filter(name => !name.startsWith('.')).sort()) {
    const entry = (await readPage(root, name)).find(entry => entry.id === id);
    if (entry) return entry;
  }
  return null;
}

export async function retainAuditWindow(file, entries, options = {}) {
  const limit = options.limit ?? 500;
  const keep = options.keep ?? 400;
  if (!Array.isArray(entries) || !Number.isSafeInteger(limit) || !Number.isSafeInteger(keep) || keep < 1 || keep >= limit) throw unavailable();
  await readArray(file);
  if (entries.length <= limit) return writeArray(file, entries);
  const root = await directory(file);
  await archivePage(root, entries.slice(0, -keep));
  // A crash before this replacement leaves duplicates, never a missing history page.
  await writeArray(file, entries.slice(-keep));
}

export async function auditArchiveIndex(file) {
  const root = await directory(file);
  const pages = [];
  for (const name of (await fs.readdir(root)).filter(name => !name.startsWith('.')).sort()) {
    const entries = await readPage(root, name);
    pages.push({ pageId: name.slice(0, -5), count: entries.length,
      firstEventId: entries[0].id, lastEventId: entries.at(-1).id });
  }
  return { policy: 'PRESERVE_ARCHIVED_EVENTS', deletesArchives: false, pages };
}
