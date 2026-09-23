import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateAccess } from '../access-control.js';

/**
 * A hosted instance starts on an empty volume. The server does not create a registry, so without
 * one every authorized route answers 503 while the pages themselves load: the symptom is a site
 * that opens and does nothing. This runs setup exactly once, when the volume has no registry, and
 * then hands over to the server.
 *
 * The guard is the registry's own absence rather than a marker of our own, and setup refuses to
 * replace an existing one, so a restart on a volume that already has credentials cannot overwrite
 * them even if this check were wrong.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.resolve(root, process.env.DATA_DIR || 'data');
const run = (file, args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [file, ...args], { cwd: root, stdio: 'inherit' });
  child.on('close', code => code === 0 ? resolve() : reject(new Error(`${file} exited ${code}`)));
});

await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
// A mounted volume arrives with the platform's mode, which setup refuses. Tightening it is the one
// step a deployment would otherwise have to remember to do by hand.
await fs.chmod(dataDir, 0o700);
const registry = path.join(dataDir, 'access.json');
if (!(await fs.access(registry).then(() => true, () => false))) {
  const seeded = process.env.HOSTED_REGISTRY_B64;
  if (seeded) {
    // A registry prepared locally carries only token hashes, so the plaintext tokens stay with
    // whoever ran setup and can be handed to judges; the host never sees them.
    const config = validateAccess(JSON.parse(Buffer.from(seeded, 'base64').toString('utf8')));
    if (config.principals.some(person => Object.keys(person).some(key => /^token$|secret|password/i.test(key))))
      throw new Error('HOSTED_REGISTRY_B64 must contain token hashes only');
    await fs.writeFile(registry, JSON.stringify(config, null, 2), { flag: 'wx', mode: 0o600 });
    console.log('No registry on this volume; installed the provided hash-only registry.');
  } else {
    console.log('No registry on this volume; creating one before serving.');
    await run('scripts/setup-local.mjs', [dataDir]);
  }
}

// A container killed without its shutdown handler leaves the lock behind, and the next start would
// fail on it forever. The lock records the pid that wrote it, so a lock whose process is gone is
// stale and can be cleared; a live one is left alone and the server's own guard still fires.
const lock = path.join(dataDir, 'server.lock');
const pid = Number(await fs.readFile(lock, 'utf8').catch(() => ''));
if (pid) {
  try { process.kill(pid, 0); } catch { await fs.unlink(lock).catch(() => {}); }
}

await run('server.js', []);
