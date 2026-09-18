import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { openLocalKeyVault } from '../local-key-vault.js';

test('local key wrapping survives reopen and rejects changed bindings and unsafe storage', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'enclave-vault-test-')));
  try {
    const directory = path.join(root, 'private');
    const first = await openLocalKeyVault(directory);
    const key = crypto.randomBytes(32);
    const binding = { taskId: crypto.randomUUID(), version: 1, commitment: 'a'.repeat(64) };
    const wrapped = first.wrap(key, binding);
    assert.ok(!JSON.stringify(wrapped).includes(key.toString('hex')));
    first.close();
    assert.throws(() => first.unwrap(wrapped, binding));
    const reopened = await openLocalKeyVault(directory);
    assert.deepEqual(reopened.unwrap(wrapped, binding), key);
    for (const changed of [{ ...binding, version: 2 }, { ...binding, taskId: crypto.randomUUID() },
      { ...binding, commitment: 'b'.repeat(64) }]) assert.throws(() => reopened.unwrap(wrapped, changed));
    assert.throws(() => reopened.unwrap({ ...wrapped, tag: '0'.repeat(32) }, binding));
    reopened.close();
    await fs.chmod(path.join(directory, 'master.key'), 0o644);
    await assert.rejects(openLocalKeyVault(directory));
    await fs.symlink(directory, path.join(root, 'link'));
    await assert.rejects(openLocalKeyVault(path.join(root, 'link')));
    key.fill(0);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
