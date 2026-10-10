#!/usr/bin/env node
// Starts a local copy of the demo with two employees who share the name 劉文祥 (told apart by employee number and region) and one called
// 劉慶龍, so the same-name finder can be recorded. Synthetic people only; nothing leaves this computer.
//
//   node scripts/demo-local-same-name.mjs [directory]       prepares the data (once) and starts the server on http://127.0.0.1:3344
//   node scripts/demo-local-same-name.mjs [directory] --prepare-only
//
// The tokens are written to <directory>/*.token (manager-sender.token, sales-a.token, sales-b.token, ...). Choose manager-sender.token on the
// sender page; the find box appears because the directory has Chinese names. A sender is locked after three failed matches; an administrator
// unlocks it on the administration page (admin.token).
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { validateAccess } from '../access-control.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PEOPLE = [['sales-a', '劉文祥', { region: 'north' }], ['sales-b', '劉文祥', { region: 'south' }], ['sales-c', '劉慶龍', { region: 'north' }]];

export async function prepare(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const registry = path.join(directory, 'access.json');
  const exists = await fs.access(registry).then(() => true, () => false);
  if (!exists) {
    await new Promise((resolve, reject) => { const child = spawn(process.execPath, ['scripts/setup-local.mjs', directory, '--business'], { cwd: root, stdio: 'ignore' });
      child.on('close', code => code === 0 ? resolve() : reject(new Error('setup-local failed'))); });
  }
  const config = JSON.parse(await fs.readFile(registry, 'utf8'));
  for (const [id, nameZh, tags] of PEOPLE) { const person = config.principals.find(item => item.id === id); if (!person) throw new Error(`${id} is missing from the demo data`); Object.assign(person, { nameZh, tags }); }
  const grant = config.grants.find(item => item.id === 'procurement');
  grant.recipients = [...new Set([...grant.recipients, ...PEOPLE.map(([id]) => id)])];
  validateAccess(config);
  await fs.writeFile(registry, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  return { directory, registry, created: !exists };
}

export async function main(argv = process.argv.slice(2)) {
  const prepareOnly = argv.includes('--prepare-only');
  const directory = path.resolve(argv.find(item => !item.startsWith('--')) || path.join(os.homedir(), 'zte-local-demo'));
  const info = await prepare(directory);
  process.stdout.write(`${info.created ? 'Created' : 'Reused'} the demo data in ${directory}\nTokens: ${directory}/manager-sender.token, sales-a.token, sales-b.token, sales-c.token, admin.token\n`);
  if (prepareOnly) return 0;
  process.stdout.write('Starting on http://127.0.0.1:3344 (Ctrl+C to stop). Open it, choose manager-sender.token, choose a document, type 劉文祥 in the find box.\n');
  const server = spawn(process.execPath, ['server.js'], { cwd: root, stdio: 'inherit', env: { ...process.env, DATA_DIR: directory, PORT: '3344', HOST: '127.0.0.1', LOCAL_ONLY: 'true', COORDINATOR_PROVIDER: 'synthetic_fixture' } });
  return new Promise(resolve => server.on('close', code => resolve(code ?? 0)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) process.exit(await main());
