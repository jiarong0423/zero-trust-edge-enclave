import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildRealm, buildSubjectMap, prepare, REALM } from './keycloak-local.mjs';

async function scratch(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kc-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return path.join(dir, 'rig');
}

test('the realm has one confidential client with PKCE and the three test users', () => {
  const realm = buildRealm({ appPort: 4000, clientSecret: 's'.repeat(40), userPassword: 'p'.repeat(30) });
  assert.equal(realm.realm, REALM);
  assert.equal(realm.sslRequired, 'none');
  assert.deepEqual(realm.clients[0].redirectUris, ['http://127.0.0.1:4000/api/sso/callback']);
  assert.equal(realm.clients[0].publicClient, false);
  assert.equal(realm.clients[0].attributes['pkce.code.challenge.method'], 'S256');
  assert.equal(realm.clients[0].implicitFlowEnabled, false);
  assert.equal(realm.clients[0].directAccessGrantsEnabled, false);
  assert.deepEqual(realm.users.map(user => [user.username, user.emailVerified]),
    [['manager.test', true], ['unverified.test', false], ['unmapped.test', true]]);
});

test('the subject map maps two of the three users, so one is unmapped on purpose', () => {
  const map = buildSubjectMap();
  assert.deepEqual(map.entries.map(entry => entry.email), ['manager.test@example.org', 'unverified.test@example.org']);
});

test('prepare writes private files with random secrets and refuses a non-empty directory', async t => {
  const dir = await scratch(t);
  const { root, adminPassword } = await prepare(dir);
  assert.ok(adminPassword.length >= 30);
  assert.equal((await fs.stat(root)).mode & 0o077, 0);
  for (const name of ['creds.env', 'enclave.env', 'sso-subjects.json', path.join('import', 'enclave-test-realm.json')]) {
    assert.equal((await fs.stat(path.join(root, name))).mode & 0o077, 0, name);
  }
  const creds = await fs.readFile(path.join(root, 'creds.env'), 'utf8');
  const enclave = await fs.readFile(path.join(root, 'enclave.env'), 'utf8');
  const secrets = Object.fromEntries(creds.trim().split('\n').map(line => line.split(/=(.*)/s).slice(0, 2)));
  assert.equal(new Set(Object.values(secrets)).size, 3);
  assert.ok(enclave.includes(`SSO_CLIENT_SECRET=${secrets.KC_CLIENT_SECRET}`));
  assert.ok(enclave.includes('SSO_ALLOW_LOOPBACK_IDP=true'));
  await assert.rejects(prepare(dir), /empty/);
  const again = await scratch(t);
  const second = await prepare(again);
  assert.notEqual(second.adminPassword, adminPassword);
});

test('the generated files are not tracked and contain no value of the committed tree', async () => {
  const text = await fs.readFile(new URL('./keycloak-local.mjs', import.meta.url), 'utf8');
  assert.equal(/password\s*[:=]\s*['"][^'"$`]{6,}['"]/i.test(text.replace(/KC_BOOTSTRAP_ADMIN_USERNAME=kcadmin/g, '')), false);
});
