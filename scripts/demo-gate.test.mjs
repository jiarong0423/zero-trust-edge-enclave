import test from 'node:test';
import assert from 'node:assert/strict';
import { gateConfig, gateAllows, gateSignIn } from '../demo-gate.js';

const request = cookie => ({ headers: cookie ? { cookie } : {} });

test('demo gate is off unless explicitly required', () => {
  assert.equal(gateConfig({}), null);
  assert.equal(gateAllows(null, request(), '/api/tasks'), true);
});

test('demo gate issues a derived session and admits only that session', () => {
  const gate = gateConfig({ REQUIRE_DEMO_GATE: 'true', DEMO_GATE_USER: 'judge', DEMO_GATE_PASSWORD: 'correct horse' });
  assert.equal(gateAllows(gate, request(), '/'), false);
  assert.equal(gateAllows(gate, request(), '/judge-login.html'), true);
  assert.equal(gateSignIn(gate, { user: 'judge', password: 'wrong' }, true).status, 401);
  const { cookie } = gateSignIn(gate, { user: 'judge', password: 'correct horse' }, true);
  assert.match(cookie, /HttpOnly; SameSite=Strict; Max-Age=43200; Secure$/);
  assert.ok(!cookie.includes('correct horse'));
  const session = cookie.split(';')[0];
  assert.equal(gateAllows(gate, request(`other=1; ${session}`), '/api/tasks'), true);
  assert.equal(gateAllows(gate, request(`${session}x`), '/api/tasks'), false);
  const rotated = gateConfig({ REQUIRE_DEMO_GATE: 'true', DEMO_GATE_USER: 'judge', DEMO_GATE_PASSWORD: 'new value' });
  assert.equal(gateAllows(rotated, request(session), '/'), false);
});

test('demo gate fails closed when required but not configured, and throttles guessing', () => {
  const unset = gateConfig({ REQUIRE_DEMO_GATE: 'true' });
  assert.equal(unset.ready, false);
  assert.equal(gateSignIn(unset, { user: '', password: '' }, false).status, 503);
  assert.equal(gateAllows(unset, request('enclave_gate=anything'), '/'), false);
  const gate = gateConfig({ REQUIRE_DEMO_GATE: 'true', DEMO_GATE_USER: 'judge', DEMO_GATE_PASSWORD: 'pw' });
  for (let i = 0; i < 20; i += 1) assert.equal(gateSignIn(gate, { user: 'x', password: 'y' }, false, 1000).status, 401);
  assert.equal(gateSignIn(gate, { user: 'judge', password: 'pw' }, false, 1000).status, 429);
  assert.ok(gateSignIn(gate, { user: 'judge', password: 'pw' }, false, 70_000).cookie);
});
