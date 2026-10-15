import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArguments, summarise, scrubber, phoneStartArgs, main } from './hosted-walkthrough.mjs';

test('the phone is the default and --no-phone is the only option', () => {
  assert.deepEqual(parseArguments([]), { phone: true, headless: false });
  assert.deepEqual(parseArguments(['--no-phone', '--headless']), { phone: false, headless: true });
  assert.throws(() => parseArguments(['--force']), /unknown argument/);
});
test('the summary says how many steps passed, or which failed', () => {
  assert.equal(summarise([{ name: 'a', ok: true }, { name: 'b', ok: true }]), 'SUMMARY PASS 2 of 2');
  assert.equal(summarise([{ name: 'a', ok: true }, { name: 'b', ok: false }]), 'SUMMARY FAIL 1 of 2: b');
});
test('secrets are cleaned out of anything printed, and short strings are left alone', () => {
  const clean = scrubber(['correct horse battery', 'T'.repeat(43), 'ab']);
  assert.equal(clean('typed correct horse battery then ' + 'T'.repeat(43) + ' and ab'), 'typed *** then *** and ab');
});
test('a usage error and a missing sign-in stop before anything is opened', async () => {
  const lines = [];
  assert.equal(await main({}, ['--force'], { write: line => lines.push(line) }), 2);
  const noSignIn = await main({ SMOKE_BASE_URL: 'https://site.example', SMOKE_GATE_USER: '', SMOKE_GATE_PASSWORD: '' }, [], { write: line => lines.push(line), prompts: { interactive: false } });
  assert.equal(noSignIn, 2);
  assert.match(lines.join('\n'), /the judge sign-in is needed/);
});
test('a plain http origin is refused', async () => {
  const lines = [];
  assert.equal(await main({ SMOKE_BASE_URL: 'http://site.example', SMOKE_GATE_USER: 'u', SMOKE_GATE_PASSWORD: 'p' }, [], { write: line => lines.push(line), prompts: { interactive: false } }), 2);
  assert.match(lines.join('\n'), /https origin/);
});
test('the recipient link is quoted for the phone shell, so its & does not cut the command', () => {
  const link = 'https://enclave.jace0423.com/decode.html?id=07f18a48-d3fd-439a-8c99-1d2811c35ca0&version=1';
  assert.equal(phoneStartArgs(link).at(-2), `'${link}'`);
  assert.throws(() => phoneStartArgs("https://x.example/a'; rm -rf /"), /plain https address/);
});
