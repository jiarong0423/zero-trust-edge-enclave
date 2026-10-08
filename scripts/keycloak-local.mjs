import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * A throw-away Keycloak for trying the optional OIDC sign-in against a real provider on one machine.
 *
 *   node scripts/keycloak-local.mjs DIRECTORY          create the files, start Keycloak in Docker
 *   node scripts/keycloak-local.mjs --stop             remove the container
 *
 * Everything is bound to 127.0.0.1 and works over plain http (the app is started with
 * SSO_ALLOW_LOOPBACK_IDP=true). The administrator password, the test users' password and the client
 * secret are random, written only into DIRECTORY (mode 0700, files 0600) and never printed. This is a
 * trial rig: it proves the protocol against a real provider; it is not a deployment recipe.
 */
const run = promisify(execFile);
export const CONTAINER = 'enclave-kc';
export const IMAGE = 'quay.io/keycloak/keycloak:26.0';
export const REALM = 'enclave-test';

const secret = bytes => crypto.randomBytes(bytes).toString('base64url');

export function buildRealm({ appPort, clientSecret, userPassword }) {
  const user = (username, emailVerified) => ({
    username, enabled: true, email: `${username}@example.org`, emailVerified, firstName: 'Test', lastName: 'User',
    credentials: [{ type: 'password', value: userPassword, temporary: false }]
  });
  return {
    realm: REALM, enabled: true, sslRequired: 'none', registrationAllowed: false,
    clients: [{
      clientId: 'enclave', enabled: true, protocol: 'openid-connect', publicClient: false, secret: clientSecret,
      standardFlowEnabled: true, directAccessGrantsEnabled: false, implicitFlowEnabled: false, serviceAccountsEnabled: false,
      redirectUris: [`http://127.0.0.1:${appPort}/api/sso/callback`], webOrigins: [],
      attributes: { 'pkce.code.challenge.method': 'S256' }
    }],
    users: [user('manager.test', true), user('unverified.test', false), user('unmapped.test', true)]
  };
}

export function buildSubjectMap() {
  return { version: 1, entries: [
    { email: 'manager.test@example.org', principalId: 'manager-sender' },
    { email: 'unverified.test@example.org', principalId: 'sales-a' }
  ] };
}

export async function prepare(directory, { appPort = 3345, keycloakPort = 8081 } = {}) {
  const root = path.resolve(directory);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  if ((await fs.readdir(root)).length) throw new Error('Directory must be empty; refusing to overwrite credentials');
  await fs.chmod(root, 0o700);
  const adminPassword = secret(24);
  const userPassword = secret(24);
  const clientSecret = secret(32);
  await fs.mkdir(path.join(root, 'import'), { mode: 0o700 });
  const write = (name, text) => fs.writeFile(path.join(root, name), text, { flag: 'wx', mode: 0o600 });
  await write(path.join('import', 'enclave-test-realm.json'), JSON.stringify(buildRealm({ appPort, clientSecret, userPassword })));
  await write('sso-subjects.json', JSON.stringify(buildSubjectMap(), null, 2));
  await write('creds.env', `KC_ADMIN_PASSWORD=${adminPassword}\nKC_USER_PASSWORD=${userPassword}\nKC_CLIENT_SECRET=${clientSecret}\n`);
  await write('enclave.env', [
    'SKIP_LOCAL_ENV=true', 'HOST=127.0.0.1', `PORT=${appPort}`, `DATA_DIR=${path.join(root, 'data')}`,
    `SSO_ISSUER=http://127.0.0.1:${keycloakPort}/realms/${REALM}`, 'SSO_CLIENT_ID=enclave', `SSO_CLIENT_SECRET=${clientSecret}`,
    `SSO_REDIRECT_URI=http://127.0.0.1:${appPort}/api/sso/callback`, `SSO_SUBJECT_MAP=${path.join(root, 'sso-subjects.json')}`,
    'SSO_ALLOW_LOOPBACK_IDP=true', ''
  ].join('\n'));
  return { root, adminPassword };
}

async function waitReady(keycloakPort) {
  const url = `http://127.0.0.1:${keycloakPort}/realms/${REALM}/.well-known/openid-configuration`;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  throw new Error('Keycloak did not become ready in 180 seconds');
}

async function main(argv) {
  if (argv[0] === '--stop') {
    await run('docker', ['rm', '-f', CONTAINER]).catch(() => {});
    console.log(`removed container ${CONTAINER}`);
    return 0;
  }
  if (!argv[0] || argv[0].startsWith('-')) {
    console.error('ERROR usage: keycloak-local.mjs DIRECTORY | --stop');
    return 2;
  }
  const { root, adminPassword } = await prepare(argv[0]);
  await run('docker', ['rm', '-f', CONTAINER]).catch(() => {});
  await run('docker', ['run', '-d', '--name', CONTAINER, '-p', '127.0.0.1:8081:8080',
    '-e', 'KC_BOOTSTRAP_ADMIN_USERNAME=kcadmin', '-e', `KC_BOOTSTRAP_ADMIN_PASSWORD=${adminPassword}`,
    '-v', `${path.join(root, 'import')}:/opt/keycloak/data/import:ro`, IMAGE, 'start-dev', '--import-realm']);
  await waitReady(8081);
  await run('node', [path.join(import.meta.dirname, 'setup-local.mjs'), path.join(root, 'data'), '--business']);
  console.log(`Keycloak is up on 127.0.0.1:8081 (realm ${REALM}). Credentials are in ${root}/creds.env and were not printed.`);
  console.log('Start the app with:');
  console.log(`  cd <project> && set -a && . ${root}/enclave.env && set +a && node server.js`);
  console.log(`Then open http://127.0.0.1:3345/ and use "Sign in with SSO", or run: node scripts/sso-keycloak-check.mjs ${root}`);
  console.log('Remove it with: node scripts/keycloak-local.mjs --stop');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => { console.error(`ERROR ${error.message}`); process.exitCode = 1; });
}
