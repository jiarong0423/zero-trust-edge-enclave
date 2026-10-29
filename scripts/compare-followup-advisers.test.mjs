import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  inputs, selectCells, tableColumn, summarise, loadRecorded, parseArgs, thinkingRequest, median, p95, main,
  DEFAULT_MAX_CALLS, MAX_CALLS_CEILING, THINKING_MAX_TOKENS, FOOTER,
} from './compare-followup-advisers.mjs';
import { syntheticFollowupAdvice } from '../delivery-followup.js';

const FAKE_KEY = 'compare-test-key-DO-NOT-LEAK-0123456789';

function sinks() {
  const lines = { out: [], err: [] };
  return { lines, stdout: text => lines.out.push(text), stderr: text => lines.err.push(text) };
}

const failingRequest = calls => async url => { calls.push(String(url)); throw new Error(`network must not be used: ${FAKE_KEY}`); };

// A stub Token Factory: records every request body and answers with the fixture.
function stubRequest(calls = []) {
  return async (url, init = {}) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), body, signal: init.signal, authorization: init.headers?.authorization });
    const advice = syntheticFollowupAdvice(JSON.parse(body.messages[1].content));
    return new Response(JSON.stringify({ model: body.model, choices: [{ message: { content: JSON.stringify(advice) } }] }), { status: 200 });
  };
}

test('the inputs are the 36 cells of followup-table.js and the subsets are 6, 24 and 36', () => {
  const cells = inputs();
  assert.equal(cells.length, 36);
  assert.equal(new Set(cells.map(cell => cell.key)).size, 36);
  assert.equal(selectCells(cells, 'critical').length, 6);
  assert.ok(selectCells(cells, 'critical').every(cell => cell.timeCode === 'WINDOW_LAST' && cell.pickupCode !== 'PICKUP_ALL'));
  assert.equal(selectCells(cells, 'reachable').length, 24);
  assert.equal(selectCells(cells, 'all').length, 36);
  assert.throws(() => selectCells(cells, 'some'), /unknown --cells/);
});

test('the table column is accepted by the production validator on all 36 inputs and matches the fixture', () => {
  const cells = inputs();
  const table = tableColumn(cells);
  const summary = summarise(table, cells, table);
  assert.equal(summary.accepted, 36);
  assert.equal(summary.coherent, 1);
  assert.deepEqual(summary.distribution, { WAIT: 16, REMIND: 8, ESCALATE: 12 });
  assert.deepEqual(summary.escalatedWhereTableDoes, { count: 12, of: 12 });
  for (const cell of cells) assert.equal(table.rows[cell.key].action, syntheticFollowupAdvice(cell.metadata).action);
  assert.ok(cells.every(cell => Number.isFinite(table.rows[cell.key].ms)));
});

test('the recorded runs recompute to the figures the comparison document states', async () => {
  const cells = inputs();
  const table = tableColumn(cells);
  const { columns, summariesOnly } = await loadRecorded();
  const byId = Object.fromEntries(columns.map(column => [column.id, summarise(column, cells, table)]));

  // docs/agent/followup-adviser-comparison-2026-10-08.md: 120B accepted 36, WAIT 31 / REMIND 4 / ESCALATE 1, same 18; on the 24 reachable same 6.
  assert.equal(byId['super-120b-2026-10-08'].accepted, 36);
  assert.deepEqual(byId['super-120b-2026-10-08'].distribution, { WAIT: 31, REMIND: 4, ESCALATE: 1 });
  assert.equal(byId['super-120b-2026-10-08'].sameAsTable, 18);
  assert.deepEqual(byId['super-120b-2026-10-08'].escalatedWhereTableDoes, { count: 1, of: 12 });
  assert.equal(byId['super-120b-2026-10-08'].reachable.sameAsTable, 6);
  assert.equal(byId['super-120b-2026-10-08'].latencyMs.from, 'recorded summary');
  assert.equal(byId['super-120b-2026-10-08'].latencyMs.median, 987);

  // Same document: 4B accepted 34, 2 refused FOLLOWUP_REASON_INCOHERENT, WAIT 34, same 14.
  assert.equal(byId['nano-4b-2026-10-08'].accepted, 34);
  assert.deepEqual(byId['nano-4b-2026-10-08'].rejections, { FOLLOWUP_REASON_INCOHERENT: 2 });
  assert.deepEqual(byId['nano-4b-2026-10-08'].distribution, { WAIT: 34, REMIND: 0, ESCALATE: 0 });
  assert.equal(byId['nano-4b-2026-10-08'].sameAsTable, 14);

  // Addendum 2026-10-16: Ultra accepted 33, ESCALATE on 11 of 12, same 26, latency median 895 (min 681, max 1468).
  assert.equal(byId['ultra-550b-2026-10-16'].accepted, 33);
  assert.deepEqual(byId['ultra-550b-2026-10-16'].escalatedWhereTableDoes, { count: 11, of: 12 });
  assert.equal(byId['ultra-550b-2026-10-16'].sameAsTable, 26);
  assert.equal(byId['ultra-550b-2026-10-16'].reachable.sameAsTable, 17);
  assert.deepEqual({ ...byId['ultra-550b-2026-10-16'].latencyMs, p95: undefined }, { min: 681, median: 895, max: 1468, from: 'rows', p95: undefined });

  // SECURITY_SCAN_EVIDENCE.md: 60 calls per form, 88.3% -> 100%, p95 1728 -> 1205.
  const forms = summariesOnly.find(item => item.id === 'prompt-form-super-2026-09-18');
  assert.equal(forms.callsPerForm, 60);
  assert.equal(forms.forms.prose.reasonCoherent, 0.883);
  assert.equal(forms.forms.lookupTable.reasonCoherent, 1);
  assert.equal(forms.forms.prose.p95Ms, 1728);
  assert.equal(forms.forms.lookupTable.p95Ms, 1205);
});

test('median and p95 follow the documented rules', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 3);
  assert.equal(median([0.5, 1.5]), 1);
  assert.equal(median([0.25, 0.5]), 0.375);
  assert.equal(median([]), null);
  assert.equal(p95([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), 10);
  assert.equal(p95(Array.from({ length: 20 }, (_, i) => i + 1)), 19);
});

test('offline mode prints the four columns and the recorded summaries without touching the network', async () => {
  const calls = [];
  const { lines, stdout, stderr } = sinks();
  const code = await main([], { env: {}, request: failingRequest(calls), stdout, stderr });
  assert.equal(code, 0, lines.err.join('\n'));
  assert.equal(calls.length, 0);
  const text = lines.out.join('\n');
  assert.match(text, /\| table \| - \| n\/a \| computed now \| 36 \| 36\/36 = 100\.0% \| 16\/8\/12 \| 36\/36 \| 12\/12 \| 24\/24 \|/);
  assert.match(text, /\| ultra-550b-2026-10-16 \| .* \| 33\/36 = 91\.7% \| 20\/2\/11 \| 26\/33 \| 11\/12 \| 17\/24 \| 681\/895\/1468\/1468 \|/);
  assert.match(text, /prompt-form-super-2026-09-18 \[lookupTable\]: 60 calls, .* reason coherent 100\.0%, .* p95 1205 ms/);
  assert.match(text, /nano-4b-reasoning-2026-10-08 \[reasoning_effort low\]: 6 inputs, .* median 21292 ms/);
  assert.ok(text.endsWith(FOOTER));
});

test('argument parsing: thinking, cells and the call cap', () => {
  assert.deepEqual(parseArgs([]), { cloud: false, yesSpend: false, thinking: 'off', cells: 'critical', maxCalls: DEFAULT_MAX_CALLS, out: null, help: false });
  assert.equal(parseArgs(['--thinking', 'both', '--cells', 'all', '--max-calls', '40']).maxCalls, 40);
  assert.throws(() => parseArgs(['--thinking', 'maybe']), /--thinking must be/);
  assert.throws(() => parseArgs(['--max-calls', String(MAX_CALLS_CEILING + 1)]), /--max-calls must be/);
  assert.throws(() => parseArgs(['--max-calls', '0']), /--max-calls must be/);
  assert.throws(() => parseArgs(['--bogus']), /unknown argument/);
  assert.throws(() => parseArgs(['--out']), /--out needs a value/);
});

test('--cloud is refused before any call without --yes-spend, without a key, or over the cap', async () => {
  for (const [argv, env, pattern] of [
    [['--cloud'], { NEBIUS_API_KEY: FAKE_KEY }, /needs --yes-spend/],
    [['--cloud', '--yes-spend'], {}, /needs NEBIUS_API_KEY/],
    [['--cloud', '--yes-spend', '--thinking', 'both', '--cells', 'all'], { NEBIUS_API_KEY: FAKE_KEY }, /72 calls .* exceeds --max-calls 20/],
    [['--cloud', '--yes-spend', '--cells', 'reachable'], { NEBIUS_API_KEY: FAKE_KEY }, /24 calls .* exceeds --max-calls 20/],
  ]) {
    const calls = [];
    const { lines, stdout, stderr } = sinks();
    const code = await main(argv, { env, request: failingRequest(calls), stdout, stderr });
    assert.equal(code, 2, argv.join(' '));
    assert.equal(calls.length, 0);
    assert.match(lines.err.join('\n'), pattern);
    assert.ok(!lines.err.join('\n').includes(FAKE_KEY), 'key must not be printed');
  }
});

test('the thinking wrapper flips enable_thinking on the wire and widens budget and deadline only for thinking on', async () => {
  const seen = [];
  const request = async (url, init) => { seen.push({ url, init }); return new Response('{}'); };
  const base = { body: JSON.stringify({ model: 'm', max_tokens: 512, chat_template_kwargs: { enable_thinking: false } }), signal: AbortSignal.timeout(5000), headers: { a: 'b' } };
  await thinkingRequest(request, false)('https://x/v1/chat/completions', base);
  await thinkingRequest(request, true)('https://x/v1/chat/completions', base);
  const off = JSON.parse(seen[0].init.body);
  const on = JSON.parse(seen[1].init.body);
  assert.equal(off.chat_template_kwargs.enable_thinking, false);
  assert.equal(off.max_tokens, 512);
  assert.equal(seen[0].init.signal, base.signal);
  assert.equal(on.chat_template_kwargs.enable_thinking, true);
  assert.equal(on.max_tokens, THINKING_MAX_TOKENS);
  assert.notEqual(seen[1].init.signal, base.signal);
  assert.deepEqual(seen[1].init.headers, { a: 'b' });
});

test('a live run with both modes makes 12 calls on the 6 critical inputs through the production path and summarises each mode', async () => {
  const calls = [];
  const { lines, stdout, stderr } = sinks();
  const code = await main(['--cloud', '--yes-spend', '--thinking', 'both'],
    { env: { NEBIUS_API_KEY: FAKE_KEY }, request: stubRequest(calls), stdout, stderr, sleep: async () => {}, now: (() => { let t = 0; return () => (t += 100); })() });
  assert.equal(code, 0, lines.err.join('\n'));
  assert.equal(calls.length, 12);
  assert.ok(calls.every(call => call.url === 'https://api.tokenfactory.nebius.com/v1/chat/completions'));
  assert.ok(calls.every(call => call.authorization === `Bearer ${FAKE_KEY}`));
  assert.equal(calls.filter(call => call.body.chat_template_kwargs.enable_thinking === false).length, 6);
  assert.equal(calls.filter(call => call.body.chat_template_kwargs.enable_thinking === true && call.body.max_tokens === THINKING_MAX_TOKENS).length, 6);
  for (const call of calls) {
    const metadata = JSON.parse(call.body.messages[1].content);
    assert.deepEqual(Object.keys(metadata).sort(), ['nudgeCount', 'pickupCode', 'snapshotVersion', 'taskAlias', 'timeCode']);
    assert.equal(metadata.timeCode, 'WINDOW_LAST');
  }
  const text = lines.out.join('\n');
  assert.match(text, /^live: 12 calls to nvidia\/nemotron-3-super-120b-a12b \(6 inputs, thinking off and on\)/m);
  assert.match(text, /\| live-thinking-off \| nvidia\/nemotron-3-super-120b-a12b \| off \| live \d{4}-\d{2}-\d{2} \| 6 \| 6\/6 = 100\.0% \| 0\/0\/6 \| 6\/6 \| 6\/6 \| 6\/6 \|/);
  assert.match(text, /\| live-thinking-on \| nvidia\/nemotron-3-super-120b-a12b \| on \| live \d{4}-\d{2}-\d{2} \| 6 \| 6\/6 = 100\.0% \|/);
  assert.ok(!text.includes(FAKE_KEY) && !lines.err.join('\n').includes(FAKE_KEY), 'key must not be printed');
});

test('a refused live answer is recorded as REFUSED with its code and the key redacted, and --out refuses to overwrite', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'compare-advisers-'));
  const outFile = path.join(dir, 'result.json');
  const request = async () => { throw new Error(`boom ${FAKE_KEY}`); };
  const { lines, stdout, stderr } = sinks();
  const code = await main(['--cloud', '--yes-spend', '--thinking', 'off', '--out', outFile],
    { env: { NEBIUS_API_KEY: FAKE_KEY }, request, stdout, stderr, sleep: async () => {}, now: (() => { let t = 0; return () => (t += 50); })() });
  assert.equal(code, 0, lines.err.join('\n'));
  const text = lines.out.join('\n') + lines.err.join('\n');
  assert.match(text, /REFUSED FILE_PROVIDER_UNREACHABLE/);
  assert.ok(!text.includes(FAKE_KEY));
  const written = JSON.parse(await fs.readFile(outFile, 'utf8'));
  assert.equal(written.schema, 'compare-followup-advisers/1');
  const live = written.columns.find(column => column.id === 'live-thinking-off');
  assert.equal(live.summary.accepted, 0);
  assert.equal(live.summary.rejected, 6);
  assert.ok(!JSON.stringify(written).includes(FAKE_KEY));
  const again = sinks();
  const second = await main(['--out', outFile], { env: {}, request, stdout: again.stdout, stderr: again.stderr });
  assert.equal(second, 2);
  assert.match(again.lines.err.join('\n'), /already exists/);
  await fs.rm(dir, { recursive: true, force: true });
});
