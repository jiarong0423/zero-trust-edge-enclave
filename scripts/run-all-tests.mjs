// Runs every scripts/*.test.mjs with the Node test runner. `node --test "scripts/*.test.mjs"` only works from
// Node 21, which expands the pattern itself; the project supports Node 20.11, so the file list is built here.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const files = readdirSync(dir).filter(name => name.endsWith('.test.mjs')).sort().map(name => path.join(dir, name));
if (!files.length) { console.error('ERROR no scripts/*.test.mjs files found'); process.exit(1); }
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
if (result.error) { console.error(`ERROR could not start the Node test runner: ${result.error.message}`); process.exit(1); }
process.exit(result.status === null ? 1 : result.status);
