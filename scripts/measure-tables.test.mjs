import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const script = path.resolve(import.meta.dirname, 'measure-tables.mjs');

test('the report prints both tables from a result file and makes no model call', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'measure-'));
  const file = path.join(dir, 'result.json');
  await fs.writeFile(file, JSON.stringify({ model: 'stand-in', rows: [
    { timeCode: 'WINDOW_FULL', pickupCode: 'PICKUP_NONE', nudgeCount: 0, local4b: 'WAIT/NO_PICKUP_YET', cloud120b: 'REMIND/NO_PICKUP_YET' }] }));
  const run = spawnSync(process.execPath, [script, file], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Cells where more than one action is legal: 24 of 36/);
  assert.match(run.stdout, /Recipient match: 405 cells/);
  assert.match(run.stdout, /\| WINDOW_FULL \| PICKUP_NONE \| 0 \| WAIT \| WAIT REMIND ESCALATE \| WAIT \| REMIND \|/);
  assert.match(run.stdout, /4B 1\/1, 120B 0\/1/);
  assert.match(run.stdout, /Agreement is not accuracy/);
});

test('an unreadable result file is reported on stderr, the tables still print, and the exit code says it failed', async () => {
  const run = spawnSync(process.execPath, [script, path.join(os.tmpdir(), 'no-such-result.json')], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /ERROR cannot read/);
  assert.match(run.stdout, /Follow-up decision: 36 cells/);
});
