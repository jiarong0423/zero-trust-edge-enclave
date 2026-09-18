import { promises as fs, constants } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fail, validateAccess } from './access-control.js';

// Caller serializes mutations with the server queue and owns the data-directory process lock.
export async function saveRegistry(file, config, expectedRevision) {
  validateAccess(config);
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  let current;
  try { current = validateAccess(JSON.parse(await handle.readFile('utf8'))); }
  finally { await handle.close(); }
  if ((current.revision || 1) !== expectedRevision || config.revision !== expectedRevision + 1) fail('DIRECTORY_REVISION_CONFLICT', 409);
  const temporary = path.join(path.dirname(file), '.registry-' + crypto.randomUUID() + '.tmp');
  let output;
  try {
    output = await fs.open(temporary, 'wx', 0o600);
    await output.writeFile(JSON.stringify(config, null, 2) + '\n');
    await output.sync();
    await output.close(); output = null;
    await fs.rename(temporary, file);
    const directory = await fs.open(path.dirname(file), constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    await output?.close();
    await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}
