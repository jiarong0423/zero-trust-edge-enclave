import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function bindingBytes(binding) {
  if (!binding || Object.keys(binding).sort().join(',') !== 'commitment,taskId,version' ||
      !/^[a-f0-9-]{36}$/.test(binding.taskId) || !Number.isSafeInteger(binding.version) || binding.version < 1 ||
      !/^[a-f0-9]{64}$/.test(binding.commitment)) throw new Error('INVALID_KEY_BINDING');
  return Buffer.from(JSON.stringify(['local-key-wrap-v1', binding.taskId, binding.version, binding.commitment]));
}

// Caller owns identity, revocation and single-use checks; this module only wraps keys.
export async function openLocalKeyVault(directory) {
  const root = path.resolve(directory);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  if (await fs.realpath(root) !== root || (await fs.stat(root)).mode & 0o077) throw new Error('UNSAFE_KEY_DIRECTORY');
  const target = path.join(root, 'master.key');
  let handle;
  let master;
  try {
    handle = await fs.open(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    master = crypto.randomBytes(32);
    await handle.writeFile(master);
    await handle.sync();
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  } finally { await handle?.close(); }
  if (!master) {
    handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== 32 || stat.mode & 0o077) throw new Error('INVALID_MASTER_KEY_FILE');
      master = await handle.readFile();
    } finally { await handle.close(); }
  }
  let closed = false;
  const available = () => { if (closed) throw new Error('KEY_VAULT_CLOSED'); };
  return {
    wrap(keyBytes, binding) {
      available();
      if (!(keyBytes instanceof Uint8Array) || keyBytes.length !== 32) throw new Error('INVALID_DOCUMENT_KEY');
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', master, iv);
      cipher.setAAD(bindingBytes(binding));
      const ciphertext = Buffer.concat([cipher.update(keyBytes), cipher.final()]);
      return { version: 1, iv: iv.toString('hex'), ciphertext: ciphertext.toString('hex'), tag: cipher.getAuthTag().toString('hex') };
    },
    unwrap(wrapped, binding) {
      available();
      if (!wrapped || Object.keys(wrapped).sort().join(',') !== 'ciphertext,iv,tag,version' || wrapped.version !== 1 ||
          !/^[a-f0-9]{24}$/.test(wrapped.iv) || !/^[a-f0-9]{64}$/.test(wrapped.ciphertext) || !/^[a-f0-9]{32}$/.test(wrapped.tag)) {
        throw new Error('INVALID_WRAPPED_KEY');
      }
      const decipher = crypto.createDecipheriv('aes-256-gcm', master, Buffer.from(wrapped.iv, 'hex'));
      decipher.setAAD(bindingBytes(binding));
      decipher.setAuthTag(Buffer.from(wrapped.tag, 'hex'));
      const pending = decipher.update(Buffer.from(wrapped.ciphertext, 'hex'));
      try { return Buffer.concat([pending, decipher.final()]); }
      finally { pending.fill(0); }
    },
    close() { master.fill(0); closed = true; }
  };
}
