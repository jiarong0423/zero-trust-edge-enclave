import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { rolePlan } from '../public/role-plan.js';
import { gateConfig, gateAllows, recipientPages } from '../demo-gate.js';

const root = path.resolve(import.meta.dirname, '..');
const gate = gateConfig({ REQUIRE_DEMO_GATE: 'true', DEMO_GATE_USER: 'judge', DEMO_GATE_PASSWORD: 'correct horse' });
const anonymous = { headers: {} };
const hrefs = ['/', '/decode.html', '/audit.html'];

test('an employee who receives is never asked for the judge sign-in', async () => {
  for (const page of recipientPages) assert.equal(gateAllows(gate, anonymous, page), true, page);
  for (const api of ['/api/whoami', '/api/inbox', '/api/file-access/' + '0'.repeat(8) + '-0000-0000-0000-' + '0'.repeat(12) + '/key']) {
    assert.equal(gateAllows(gate, anonymous, api), true, api);
  }
});

test('sending, auditing, administration and the model outlet stay behind the gate', () => {
  for (const path of ['/', '/index.html', '/app.js', '/audit.html', '/admin.html', '/api/tasks', '/api/file-tasks', '/api/audit', '/api/admin/directory',
    '/api/directory/resolve', '/api/coordinator/call', '/api/policy/recommend', '/api/packages', '/api/file-access/abc/key']) {
    assert.equal(gateAllows(gate, anonymous, path), false, path);
  }
});

test('everything the receiving page imports is reachable without the sign-in', async () => {
  const seen = new Set();
  const visit = async file => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = await fs.readFile(path.join(root, 'public', file), 'utf8');
    for (const match of text.matchAll(/from '\.\/([A-Za-z0-9._-]+\.js)'/g)) await visit(match[1]);
  };
  const html = await fs.readFile(path.join(root, 'public/decode.html'), 'utf8');
  for (const match of html.matchAll(/<script src="\/([A-Za-z0-9._-]+\.js)"/g)) await visit(match[1]);
  assert.ok(seen.size >= 5, [...seen].join());
  for (const file of seen) assert.equal(gateAllows(gate, anonymous, '/' + file), true, file);
});

test('each role sees only its own pages, and a wrong-role page is flagged', () => {
  assert.deepEqual(rolePlan('recipient', '/decode.html', ['recipient'], hrefs).visible, ['/decode.html']);
  assert.deepEqual(rolePlan('operator', '/', ['operator'], hrefs).visible, ['/', '/audit.html']);
  assert.deepEqual(rolePlan('administrator', '/admin.html', ['administrator'], [...hrefs, '/admin.html']).visible, ['/admin.html']);
  assert.deepEqual(rolePlan('coordinator', '/', ['operator'], hrefs).visible, []);
  assert.equal(rolePlan('recipient', '/', ['operator'], hrefs).wrongPage, true);
  assert.equal(rolePlan('recipient', '/', ['operator'], hrefs).home, '/decode.html');
  assert.equal(rolePlan('operator', '/', ['operator'], hrefs).wrongPage, false);
  // Before a token is verified a page offers only itself, and never flags itself as the wrong page.
  const before = rolePlan(null, '/decode.html', ['recipient'], hrefs);
  assert.deepEqual([before.visible, before.wrongPage], [['/decode.html'], false]);
});

test('the Chinese pages are the same pages for every role', () => {
  const zh = ['/zh-TW/', '/zh-TW/decode.html', '/zh-TW/audit.html'];
  assert.deepEqual(rolePlan('recipient', '/zh-TW/decode.html', ['recipient'], zh).visible, ['/zh-TW/decode.html']);
  assert.deepEqual(rolePlan('operator', '/zh-TW/', ['operator'], zh).visible, ['/zh-TW/', '/zh-TW/audit.html']);
  assert.deepEqual(rolePlan(null, '/zh-TW/decode.html', ['recipient'], zh).visible, ['/zh-TW/decode.html']);
});

test('the Chinese receiving page needs no judge sign-in either', () => {
  assert.equal(gateAllows(gate, anonymous, '/zh-TW/decode.html'), true);
  assert.equal(gateAllows(gate, anonymous, '/zh-TW/'), false);
  assert.equal(gateAllows(gate, anonymous, '/zh-TW/audit.html'), false);
});
