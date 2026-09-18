import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';

/**
 * A certificate for a LAN address, so a second device can reach the pages over https and therefore
 * get a secure context. Browsers exempt only loopback from that rule, so a phone on http://<lan-ip>
 * finds crypto.subtle undefined and nothing can be encrypted or decrypted there.
 *
 * This is a demonstration aid, not part of the delivery boundary. The key is generated locally,
 * written into an ignored directory with owner-only permissions, and never leaves this machine.
 */
const run = promisify(execFile);
let target = path.resolve(process.argv[2] || 'data/tls');

function lanAddresses() {
  return Object.values(os.networkInterfaces()).flat()
    .filter(entry => entry && entry.family === 'IPv4' && !entry.internal)
    .map(entry => entry.address);
}

const addresses = lanAddresses();
if (!addresses.length) throw new Error('No LAN address found; connect to a network first');

await fs.mkdir(target, { recursive: true, mode: 0o700 });
// Resolve once and write only to the resolved location, so a symlinked component cannot redirect
// the key somewhere else. Equality is not the test: on macOS /var is itself a symlink to /private/var.
target = await fs.realpath(target);
if (!(await fs.lstat(target)).isDirectory()) throw new Error('Certificate target must be a directory');
for (const name of ['cert.pem', 'key.pem']) {
  try {
    await fs.access(path.join(target, name));
    throw new Error(`${name} already exists; remove the directory deliberately before regenerating`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

// Subject Alternative Names are what browsers actually check; a bare Common Name is ignored.
const san = ['DNS:localhost', 'IP:127.0.0.1', 'IP:::1', ...addresses.map(address => `IP:${address}`)].join(',');
await run('openssl', ['req', '-x509', '-nodes', '-newkey', 'rsa:2048',
  '-days', '30',
  '-subj', '/CN=zero-trust-edge-enclave local demo',
  '-addext', `subjectAltName=${san}`,
  '-addext', 'basicConstraints=critical,CA:TRUE',
  '-keyout', path.join(target, 'key.pem'),
  '-out', path.join(target, 'cert.pem')]);
await fs.chmod(path.join(target, 'key.pem'), 0o600);
await fs.chmod(path.join(target, 'cert.pem'), 0o600);

console.log(JSON.stringify({
  mode: 'local_demo_only',
  directory: target,
  validDays: 30,
  subjectAltNames: san.split(','),
  run: `TLS_CERT_FILE=${path.join(target, 'cert.pem')} TLS_KEY_FILE=${path.join(target, 'key.pem')} HOST=0.0.0.0 npm run dev`,
  openOnPhone: addresses.map(address => `https://${address}:3344/`),
  trustNote: 'The phone must trust this certificate once: iOS installs the profile, then enables it under Settings > General > About > Certificate Trust Settings. Android installs it as a CA under Encryption & credentials.'
}, null, 2));
