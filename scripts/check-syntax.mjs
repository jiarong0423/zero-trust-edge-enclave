// Syntax-checks every JavaScript file with `node --check`. Replaces the old `check` script, which
// only looked at three entry files and so missed every extracted module. Inside a git checkout it
// checks tracked and new files; outside one (an exported candidate) it walks the directory, skipping
// dependencies, data and build output.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const SKIP = new Set(['node_modules', '.git', 'output', 'logs', 'security-audit-output']);

function walk(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP.has(entry.name) || entry.name === 'data' || entry.name.startsWith('data-')) continue;
      walk(path.join(dir, entry.name), found);
    } else if (/\.(m?js)$/.test(entry.name)) found.push(path.relative(root, path.join(dir, entry.name)));
  }
  return found;
}

function listFiles() {
  try {
    const out = execFileSync('git', ['ls-files', '-z', '-co', '--exclude-standard', '--', '*.js', '*.mjs'],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    // -z keeps non-ASCII names unquoted; a tracked file deleted in the working tree is not a syntax error.
    const files = out.split('\0').filter(file => file && existsSync(path.join(root, file)));
    if (files.length) return files;
  } catch { /* not a git checkout */ }
  return walk(root).sort();
}

const listed = listFiles();
let failed = 0;
for (const file of listed) {
  const result = spawnSync(process.execPath, ['--check', file], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) {
    failed += 1;
    console.error(`ERROR syntax ${file}\n${result.stderr.trim().split('\n').slice(0, 4).join('\n')}`);
  }
}
if (failed) { console.error(`ERROR ${failed} of ${listed.length} files failed the syntax check`); process.exit(1); }
console.log(`syntax ok: ${listed.length} files`);
