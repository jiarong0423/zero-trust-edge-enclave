import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAcceptance, main } from './hosted-acceptance.mjs';

const collect = () => { const lines = []; return { lines, write: line => lines.push(line) }; };

test('every step runs, even after one fails, and the exit code says whether all passed', async () => {
  const order = []; const { lines, write } = collect();
  const step = (name, code) => ({ name, run: async () => { order.push(name); return code; } });
  assert.equal(await runAcceptance({ write, steps: [step('a', 0), step('b', 1), step('c', 0)] }), 1);
  assert.deepEqual(order, ['a', 'b', 'c']);
  assert.match(lines.join('\n'), /SUMMARY FAIL 1 of 3: b/);
  const second = collect();
  assert.equal(await runAcceptance({ write: second.write, steps: [step('x', 0), step('y', 0)] }), 0);
  assert.match(second.lines.join('\n'), /SUMMARY PASS 2 of 2/);
  assert.match(second.lines.join('\n'), /look at the pages yourself/);
});

test('a step that throws is a failed step, not a crash, and its message is short', async () => {
  const { lines, write } = collect();
  const code = await runAcceptance({ write, steps: [{ name: 'boom', run: async () => { throw new Error('x'.repeat(500)); } }, { name: 'after', run: async () => 0 }] });
  assert.equal(code, 1);
  const text = lines.join('\n');
  assert.match(text, /FAIL boom: unexpected error/);
  assert.match(text, /PASS after/);
  assert.ok(text.length < 900);
});

test('main stops with a configuration error when the token directory or its tokens are missing, before running anything', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'acceptance-'));
  try {
    let ran = 0;
    const env = { SMOKE_BASE_URL: 'https://site.example', SMOKE_TOKEN_DIR: dir, SMOKE_GATE_USER: 'judge', SMOKE_GATE_PASSWORD: 'pw' };
    const code = await main(env, { prompts: { interactive: false }, steps: [{ name: 'never', run: async () => { ran += 1; return 0; } }] });
    assert.equal(code, 2);
    assert.equal(ran, 0);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
