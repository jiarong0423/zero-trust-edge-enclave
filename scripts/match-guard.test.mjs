import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMatchGuard, MATCH_FAILURE_LIMIT } from '../match-guard.js';

async function fresh() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'match-guard-'));
  return { dir, file: path.join(dir, 'match-guard.json') };
}

test('the limit is three and a missing file means nobody is counted', async () => {
  assert.equal(MATCH_FAILURE_LIMIT, 3);
  const { file } = await fresh();
  const guard = createMatchGuard(file);
  assert.deepEqual(await guard.status('op', 'g'), { fails: 0, quarantined: false });
  assert.deepEqual(await guard.list(), []);
});

test('failures count per sender and authorization, the third quarantines, a success resets', async () => {
  const { file } = await fresh();
  const guard = createMatchGuard(file);
  assert.deepEqual(await guard.record('op', 'g', false), { fails: 1, quarantined: false, justQuarantined: false });
  assert.deepEqual(await guard.record('op', 'g', false), { fails: 2, quarantined: false, justQuarantined: false });
  assert.deepEqual(await guard.record('other', 'g', false), { fails: 1, quarantined: false, justQuarantined: false });
  assert.deepEqual(await guard.record('op', 'g2', false), { fails: 1, quarantined: false, justQuarantined: false });
  assert.deepEqual(await guard.record('op', 'g', true), { fails: 0, quarantined: false, justQuarantined: false });
  assert.deepEqual(await guard.status('op', 'g'), { fails: 0, quarantined: false });
  await guard.record('op', 'g', false); await guard.record('op', 'g', false);
  assert.deepEqual(await guard.record('op', 'g', false), { fails: 3, quarantined: true, justQuarantined: true });
  // Once locked, neither a success nor another failure changes anything.
  assert.deepEqual(await guard.record('op', 'g', true), { fails: 3, quarantined: true, justQuarantined: false });
  assert.deepEqual(await guard.record('op', 'g', false), { fails: 3, quarantined: true, justQuarantined: false });
});

test('a new guard on the same file sees the lock, and unlock is the only way out', async () => {
  const { file } = await fresh();
  const first = createMatchGuard(file);
  for (let i = 0; i < 3; i++) await first.record('op', 'g', false);
  const second = createMatchGuard(file);
  assert.equal((await second.status('op', 'g')).quarantined, true);
  assert.equal(await second.unlock('op', 'g'), true);
  assert.equal(await second.unlock('op', 'g'), false);
  assert.deepEqual(await createMatchGuard(file).status('op', 'g'), { fails: 0, quarantined: false });
});

test('a file that exists but cannot be understood stops matching instead of opening it', async () => {
  for (const content of ['not json', '{}', '[{"operatorId":"op"}]', '[{"operatorId":"op","grantId":"g","fails":-1,"quarantined":false}]']) {
    const { file } = await fresh();
    await fs.writeFile(file, content);
    const guard = createMatchGuard(file);
    await assert.rejects(guard.status('op', 'g'), error => error.status === 503 && error.message === 'MATCH_GUARD_UNAVAILABLE');
    await assert.rejects(guard.record('op', 'g', false), error => error.status === 503);
  }
});

test('the stored file is private and holds no names', async () => {
  const { file } = await fresh();
  const guard = createMatchGuard(file);
  await guard.record('op', 'g', false);
  assert.equal((await fs.stat(file)).mode & 0o077, 0);
  assert.deepEqual(Object.keys(JSON.parse(await fs.readFile(file, 'utf8'))[0]).sort(), ['fails', 'grantId', 'operatorId', 'quarantined', 'since']);
});
