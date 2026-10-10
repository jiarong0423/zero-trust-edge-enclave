import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepare } from './demo-local-same-name.mjs';
import { validateAccess } from '../access-control.js';

test('the same-name demo data has two people called 劉文祥, one 劉慶龍, valid and kept on a second run', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'same-name-'));
  try {
    const first = await prepare(dir);
    assert.equal(first.created, true);
    const config = validateAccess(JSON.parse(await fs.readFile(first.registry, 'utf8')));
    const named = id => config.principals.find(person => person.id === id);
    assert.deepEqual([named('sales-a').nameZh, named('sales-b').nameZh, named('sales-c').nameZh], ['劉文祥', '劉文祥', '劉慶龍']);
    assert.notDeepEqual(named('sales-a').tags, named('sales-b').tags);
    assert.ok(['sales-a', 'sales-b', 'sales-c'].every(id => config.grants.find(grant => grant.id === 'procurement').recipients.includes(id)));
    const token = await fs.readFile(path.join(dir, 'manager-sender.token'), 'utf8');
    const second = await prepare(dir);
    assert.equal(second.created, false);
    assert.equal(await fs.readFile(path.join(dir, 'manager-sender.token'), 'utf8'), token);   // the credentials are not replaced
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
