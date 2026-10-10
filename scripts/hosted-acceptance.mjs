#!/usr/bin/env node
// The owner's one-command acceptance of the hosted demo before it is sent again, run in their own terminal. It asks for the judge
// sign-in once, reads the role tokens from the private token directory, and runs, in order:
//   1. the credential-free employee probe        (the receiving side needs no sign-in; the sending side does)
//   2. the stalled-connection probe              (one slow client must not hold up another)
//   3. the end-to-end smoke                       (manager sends, sales-a receives and decrypts, sales-b is refused, the task is revoked;
//                                                  it expects the Nebius Token Factory model to answer, so it also proves the key and credit work now)
//   4. the capacity check                         (how many more deliveries fit)
// It prints no credential. What it cannot check is how the pages look: that is the owner's eyes on a phone and a computer.
//
//   node scripts/hosted-acceptance.mjs
//   SMOKE_EXPECT_PROVIDER=synthetic_fixture node scripts/hosted-acceptance.mjs   (a local server that has no model)
// Exit codes: 0 everything passed, 1 something failed, 2 configuration or usage error.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { withDefaults, runProbe as runWedge, DEFAULT_TOKEN_DIR } from './hosted-wedge-probe.mjs';
import { runProbe as runEmployee } from './hosted-employee-probe.mjs';
import { loadConfig, runSmoke, redact } from './hosted-smoke.mjs';
import { checkCapacity } from './hosted-capacity.mjs';

const out = line => process.stdout.write(line + '\n');

// Runs every step even when one fails, so a single run shows the whole picture.
export async function runAcceptance({ steps, write = out }) {
  const outcomes = [];
  for (const step of steps) {
    write(`\n=== ${step.name}`);
    let code;
    try { code = await step.run(); } catch (error) { write(`FAIL ${step.name}: unexpected error: ${String(error?.message || error).slice(0, 160)}`); code = 1; }
    outcomes.push({ name: step.name, ok: code === 0 });
  }
  write('\n=== ACCEPTANCE');
  for (const outcome of outcomes) write(`${outcome.ok ? 'PASS' : 'FAIL'} ${outcome.name}`);
  const failed = outcomes.filter(outcome => !outcome.ok);
  write(failed.length ? `SUMMARY FAIL ${failed.length} of ${outcomes.length}: ${failed.map(outcome => outcome.name).join(', ')}` : `SUMMARY PASS ${outcomes.length} of ${outcomes.length}`);
  if (!failed.length) write('Next: look at the pages yourself on a phone and a computer (the kits\' README steps), then send.');
  return failed.length ? 1 : 0;
}

export async function main(env = process.env, options = {}) {
  const write = options.write || out;
  let config, adminToken;
  try {
    const filled = await withDefaults({ SMOKE_EXPECT_PROVIDER: 'nebius_token_factory', ...env }, options.prompts || {});
    config = await loadConfig(filled, []);
    adminToken = (await fs.readFile(path.join(path.resolve(filled.SMOKE_TOKEN_DIR || DEFAULT_TOKEN_DIR), 'admin.token'), 'utf8')).trim();
  } catch (error) {
    process.stderr.write(redact(`CONFIG ERROR: ${error?.message || 'configuration could not be read'}`) + '\n');
    return 2;
  }
  write(`INFO target ${config.origin} expect=${config.expect} gate=${config.gate ? 'configured' : 'none'}`);
  return runAcceptance({ write, steps: options.steps || [
    { name: 'employee probe (no credential)', run: () => runEmployee(config.origin, { write }) },
    { name: 'stalled-connection probe', run: () => runWedge(config, { holdMs: 8000, write }) },
    { name: 'end-to-end delivery (manager sends, employee receives, outsider refused, revoke)', run: () => runSmoke(config, { out: write }) },
    { name: 'capacity', run: () => checkCapacity({ origin: config.origin, gate: config.gate ? { user: config.gate.user, password: config.gate.password } : null, adminToken, write }) }
  ] });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const code = await main();
  process.stdout.write('', () => process.exit(code));
}
