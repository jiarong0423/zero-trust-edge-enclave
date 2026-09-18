import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { retainAuditWindow, findArchivedAudit, auditArchiveIndex } from '../audit-retention.js';

test('audit retention preserves overflow, replays idempotently and fails closed on corrupt archive', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'enclave-audit-retention-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'audit.json');
  await fs.writeFile(file, '[]', { mode: 0o600 });
  const events = Array.from({ length: 6 }, (_, index) => ({ id: 'event-' + index, previousHash: index ? 'hash-' + (index - 1) : null, eventHash: 'hash-' + index }));
  await retainAuditWindow(file, events, { limit: 5, keep: 3 });
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), events.slice(3));
  const index = await auditArchiveIndex(file);
  assert.equal(index.pages.length, 1);
  assert.equal(index.pages[0].count, 3);
  assert.equal(index.deletesArchives, false);
  assert.deepEqual(await findArchivedAudit(file, 'event-0'), events[0]);
  assert.equal(await findArchivedAudit(file, 'missing'), null);
  await retainAuditWindow(file, events, { limit: 5, keep: 3 });
  assert.deepEqual(await auditArchiveIndex(file), index);
  const page = path.join(root, 'audit-archive', index.pages[0].pageId + '.json');
  await fs.writeFile(page, '[]');
  const before = await fs.readFile(file);
  await assert.rejects(retainAuditWindow(file, events, { limit: 5, keep: 3 }), /AUDIT_ARCHIVE_UNAVAILABLE/);
  assert.deepEqual(await fs.readFile(file), before);
  await assert.rejects(auditArchiveIndex(file), /AUDIT_ARCHIVE_UNAVAILABLE/);
});

test('audit archive refuses symlink directories without pruning the active log', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'enclave-audit-link-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'audit.json');
  await fs.writeFile(file, '[]');
  await fs.mkdir(path.join(root, 'other'));
  await fs.symlink(path.join(root, 'other'), path.join(root, 'audit-archive'));
  await assert.rejects(retainAuditWindow(file, [{ id: '1' }, { id: '2' }, { id: '3' }], { limit: 2, keep: 1 }));
  assert.equal(await fs.readFile(file, 'utf8'), '[]');
  assert.deepEqual(await fs.readdir(path.join(root, 'other')), []);
});
