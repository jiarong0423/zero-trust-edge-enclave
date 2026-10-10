import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { featureVisibility } from '../public/feature-flags.js';

// The recipient-list response tells the sender page which optional controls can work, so the page never
// shows a find box on a directory with no Chinese names (every attempt there would fail and count toward
// the quarantine). Each case runs the real server as a child process because the flags are read at start.
const root = path.resolve(import.meta.dirname, '..');
const running = [];

async function start({ env = {}, names = false, onlyUnlisted = false } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'enclave-features-test-'));
  const base = { PATH: process.env.PATH, HOME: dir, SKIP_LOCAL_ENV: 'true', DATA_DIR: dir, PORT: '0', COORDINATOR_PROVIDER: 'synthetic_fixture', ...env };
  const setup = spawn(process.execPath, ['scripts/setup-local.mjs', dir], { cwd: root, env: base, stdio: 'ignore' });
  assert.equal((await once(setup, 'exit'))[0], 0);
  const registry = JSON.parse(await fs.readFile(path.join(dir, 'access.json'), 'utf8'));
  for (const person of registry.principals) delete person.nameZh;
  const recipients = registry.principals.filter(person => person.kind === 'recipient');
  assert.ok(recipients.length >= 2);
  if (names) {
    // Both people are put on the authorization so both are listed.
    registry.grants[0].recipients = [...new Set([...registry.grants[0].recipients, recipients[0].id, recipients[1].id])];
    recipients[0].nameZh = '劉文祥';
    recipients[1].nameZh = '劉慶龍';
  }
  if (onlyUnlisted) {
    // A name on someone who is not on this authorization must not switch the find box on.
    const unlisted = recipients.find(person => !registry.grants[0].recipients.includes(person.id));
    assert.ok(unlisted);
    unlisted.nameZh = '王外部';
  }
  await fs.writeFile(path.join(dir, 'access.json'), JSON.stringify(registry, null, 2));
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env: base, stdio: ['ignore', 'pipe', 'ignore'] });
  let output = '';
  const url = await new Promise((resolve, reject) => {
    child.on('exit', code => reject(new Error(`server exited ${code}`)));
    child.stdout.on('data', chunk => {
      output += chunk;
      const found = output.match(/listening at (http:\/\/\S+)/);
      if (found) resolve(found[1]);
    });
  });
  running.push({ child, dir });
  const token = (await fs.readFile(path.join(dir, 'operator.token'), 'utf8')).trim();
  const grantId = registry.grants[0].id;
  async function list(body = {}) {
    const response = await fetch(`${url}/api/directory`, { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ authorizationId: grantId, ...body }) });
    assert.equal(response.status, 200);
    return response.json();
  }
  return { list };
}

test.after(async () => {
  for (const { child, dir } of running) {
    child.removeAllListeners('exit');
    child.kill();
    await once(child, 'exit').catch(() => {});
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('no Chinese names and no model flags: every feature is off and the plain list is intact', async () => {
  const server = await start();
  const result = await server.list();
  assert.deepEqual(result.features, { findByName: false, noteReader: false, ranking: false });
  assert.equal(result.noteModel, false);
  assert.ok(result.recipients.length >= 1);
  assert.ok(result.recipients.every(person => !('nameZh' in person)));
});

test('two people with a Chinese name turn the find box on, whatever the list is filtered by', async () => {
  const server = await start({ names: true });
  const result = await server.list();
  assert.deepEqual(result.features, { findByName: true, noteReader: false, ranking: false });
  assert.equal(result.recipients.length, 2);
  const filtered = await server.list({ query: 'no-such-person-anywhere' });
  assert.equal(filtered.recipients.length, 0);
  assert.equal(filtered.features.findByName, true);
});

test('a Chinese name on someone who is not on the authorization does not turn the find box on', async () => {
  const server = await start({ onlyUnlisted: true });
  const result = await server.list();
  assert.equal(result.features.findByName, false);
  assert.ok(result.recipients.every(person => !('nameZh' in person)));
});

test('NOTE_AI=local turns on the note reader only', async () => {
  const server = await start({ env: { NOTE_AI: 'local' } });
  const result = await server.list();
  assert.deepEqual(result.features, { findByName: false, noteReader: true, ranking: false });
  assert.equal(result.noteModel, true);
});

test('RECIPIENT_RANKING=vector turns on ranking only', async () => {
  const server = await start({ env: { RECIPIENT_RANKING: 'vector' } });
  const result = await server.list();
  assert.deepEqual(result.features, { findByName: false, noteReader: false, ranking: true });
});

test('the page decision: only an exact true shows a control, and a missing field shows none', () => {
  const off = { findByName: false, noteReader: false, ranking: false };
  assert.deepEqual(featureVisibility({ findByName: true, noteReader: true, ranking: true }), { findByName: true, noteReader: true, ranking: true });
  assert.deepEqual(featureVisibility({ findByName: true }), { ...off, findByName: true });
  for (const missing of [undefined, null, {}, 'yes', 1, [], { findByName: 'true', noteReader: 1, ranking: {} }]) {
    assert.deepEqual(featureVisibility(missing), off);
  }
});
