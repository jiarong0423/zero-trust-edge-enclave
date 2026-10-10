import test from 'node:test';
import assert from 'node:assert/strict';
import { safeNext } from '../public/judge-next.js';
import { loginRedirect, gateConfig, gateAllows } from '../demo-gate.js';

const origin = 'https://zero-trust-edge-enclave.zeabur.app';

test('sign-in returns only to a path on this site', () => {
  assert.equal(safeNext('/decode.html?id=abc&version=1', origin), '/decode.html?id=abc&version=1');
  assert.equal(safeNext('/audit.html', origin), '/audit.html');
  for (const bad of [null, undefined, '', 'decode.html', '//evil.example/x', 'https://evil.example/', '/\\evil.example', '/a\\b', '/a\nb',
    '/judge-login.html?next=/x', '/api/tasks', '/' + 'a'.repeat(400)]) assert.equal(safeNext(bad, origin), '/', String(bad).slice(0, 30));
});

test('dot segments cannot turn a same-site path into another site', () => {
  for (const bad of ['/.//evil.com', '/a/..//evil.com', '/%2e//evil.com', '/..//evil.com', '/x/../../..//evil.com', '/./\\evil.com', '/a/../\t/evil.com',
    '/%2e%2e//evil.com', '/%2E/%2F/evil.com', '/;//evil.com/..//x']) {
    const out = safeNext(bad, origin);
    assert.equal(new URL(out, origin).origin, origin, bad + ' -> ' + out);
    assert.ok(!out.startsWith('//'), bad + ' -> ' + out);
  }
  assert.equal(safeNext('/a/../decode.html?id=1', origin), '/decode.html?id=1');
});

test('an unsigned page visit is sent to sign-in with the page it wanted', () => {
  assert.equal(loginRedirect('GET', '/decode.html', '?id=abc&version=1'), '/judge-login.html?next=' + encodeURIComponent('/decode.html?id=abc&version=1'));
  assert.equal(loginRedirect('GET', '/', ''), '/judge-login.html');
  assert.equal(loginRedirect('POST', '/decode.html', ''), '/judge-login.html');
  assert.equal(loginRedirect('GET', '/api/tasks', ''), '/judge-login.html');
  assert.equal(loginRedirect('GET', '/decode.html', '?x=' + 'a'.repeat(400)), '/judge-login.html');
});

test('the module the sign-in page loads is reachable before sign-in', () => {
  const gate = gateConfig({ REQUIRE_DEMO_GATE: 'true', DEMO_GATE_USER: 'judge', DEMO_GATE_PASSWORD: 'correct horse' });
  assert.equal(gateAllows(gate, { headers: {} }, '/judge-next.js'), true);
  assert.equal(gateAllows(gate, { headers: {} }, '/app.js'), false);
});
