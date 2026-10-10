import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';

// The release builder reads the allowlist block of public-export-manifest.md line by line and refuses a list with
// a blank or repeated line. This check runs the same parse, so a bad edit fails here and not at release time.
const root = path.resolve(import.meta.dirname, '..');
const text = await fs.readFile(path.join(root, 'public-export-manifest.md'), 'utf8');

test('the manifest has exactly one allowlist block with no blank or repeated line', () => {
  const blocks = [...text.matchAll(/```text\n([\s\S]*?)\n```/g)];
  assert.equal(blocks.length, 1);
  const files = blocks[0][1].split('\n');
  assert.ok(files.length > 0);
  assert.ok(files.every(name => name !== ''), 'blank line in the allowlist');
  assert.equal(new Set(files).size, files.length, 'repeated line in the allowlist');
});

test('every file the manifest lists exists, and the count in its heading is the real count', async () => {
  const files = [...text.matchAll(/```text\n([\s\S]*?)\n```/g)][0][1].split('\n');
  for (const name of files) await fs.access(path.join(root, name));
  const stated = Number(text.match(/\((\d+) entries/)?.[1]);
  assert.equal(stated, files.length, 'the heading says ' + stated + ' entries, the list has ' + files.length);
});
