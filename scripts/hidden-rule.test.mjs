import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', 'public');

test('an element marked hidden stays hidden whatever display its class sets', async () => {
  const css = await fs.readFile(path.join(root, 'styles.css'), 'utf8');
  // The SSO row is created hidden and has display: flex; without a rule that wins over it, the button shows
  // on every page even when SSO is off (found on a phone, 2026-10-10).
  assert.match(css, /(^|\n)\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/);
  assert.match(css, /\.token-file-row\s*\{[^}]*display:\s*flex/);
});

test('every page loads the shared style sheet that carries the rule', async () => {
  for (const page of ['index.html', 'decode.html', 'audit.html', 'admin.html']) {
    const html = await fs.readFile(path.join(root, page), 'utf8');
    assert.match(html, /href="\/styles\.css"|href="styles\.css"/, page);
  }
});

test('a revoked delivery is explained in words on the recipient page, in both languages', async () => {
  const decode = await fs.readFile(path.join(root, 'decode.js'), 'utf8');
  const i18n = await fs.readFile(path.join(root, 'i18n.js'), 'utf8');
  const sentence = decode.match(/SNAPSHOT_REJECTED:\s*'([^']+)'/)?.[1];
  assert.ok(sentence, 'decode.js maps SNAPSHOT_REJECTED to a sentence');
  assert.ok(i18n.includes(`'${sentence}'`), 'i18n.js has the Chinese text for that sentence');
});
