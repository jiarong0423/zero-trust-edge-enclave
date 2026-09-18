import { lstat, mkdir, copyFile, readFile, writeFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const source = await realpath(path.resolve(import.meta.dirname, '..'));
const argument = process.argv[2];
if (process.argv.length !== 3 || !argument || !path.isAbsolute(argument)) {
  throw new Error('Provide one absolute, nonexistent candidate directory');
}
const target = path.resolve(argument);
const relativeTarget = path.relative(source, target);
if (!relativeTarget || (!relativeTarget.startsWith('..' + path.sep) && relativeTarget !== '..' && !path.isAbsolute(relativeTarget))) {
  throw new Error('Candidate must be outside the source repository');
}
const parent = await realpath(path.dirname(target));
if (parent !== path.dirname(target)) throw new Error('Candidate parent must be canonical');
const manifest = await readFile(path.join(source, 'public-export-manifest.md'), 'utf8');
const blocks = [...manifest.matchAll(/\x60\x60\x60text\n([\s\S]*?)\n\x60\x60\x60/g)];
if (blocks.length !== 1) throw new Error('Exactly one manifest allowlist required');
const files = blocks[0][1].split('\n');
if (!files.length || new Set(files).size !== files.length) throw new Error('Invalid manifest');
const entries = [];
for (const name of files) {
  const parts = name.split('/');
  if (!/^[a-zA-Z0-9._/-]+$/.test(name) || path.isAbsolute(name) ||
      parts.some(part => !part || part === '.' || part === '..' ||
        /^\.env/.test(part) || ['.git', 'data', 'logs', 'output', 'node_modules', 'security-audit-output'].includes(part))) {
    throw new Error('Disallowed manifest path');
  }
  const src = path.join(source, name);
  if (await realpath(src) !== src || !(await lstat(src)).isFile()) throw new Error('Non-regular source path');
  const bytes = await readFile(src);
  entries.push({ path: name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
}
// Validate the entire input before reserving a fresh target; never overwrite a candidate.
await mkdir(target);
for (const entry of entries) {
  const dest = path.join(target, entry.path);
  await mkdir(path.dirname(dest), { recursive: true });
  await copyFile(path.join(source, entry.path), dest);
  const bytes = await readFile(dest);
  if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new Error('Source changed during copy');
}
const inventory = { status: 'UNAPPROVED_LOCAL_CANDIDATE', generatedAt: new Date().toISOString(), files: entries };
await writeFile(target + '-inventory.json', JSON.stringify(inventory, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ status: inventory.status, files: entries.length }));
