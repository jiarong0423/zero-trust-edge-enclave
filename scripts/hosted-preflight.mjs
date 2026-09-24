import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

/**
 * A hosted instance fails differently from a laptop: the data directory is a mounted volume with
 * whatever mode the platform chose, it starts empty, and the container can be killed without the
 * shutdown handler ever running. None of that is visible from a local `npm test`, which is why
 * these checks exist separately.
 *
 * This runs the real server against a temporary directory and reports what a deployment would hit.
 * It writes nothing outside that directory, makes no network request beyond its own loopback port,
 * and never prints a token value.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'enclave-preflight-'));
const results = [];
const record = (name, ok, detail, blocking = true) => {
  results.push({ name, ok, detail, blocking });
  process.stdout.write(`${ok ? 'pass' : blocking ? 'FAIL' : 'note'}  ${name}\n      ${detail}\n`);
};

const run = (file, args, env) => new Promise(resolve => {
  const child = spawn(process.execPath, [file, ...args], { cwd: root, env: { ...process.env, ...env } });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  child.on('close', code => resolve({ code, output }));
});

const serve = (dataDir, port) => {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(port), HOST: '0.0.0.0', SKIP_LOCAL_ENV: 'true', LOCAL_ONLY: 'true' }
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  return { child, log: () => output };
};

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const reachable = async (port, tries = 40) => {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    try { return await fetch(`http://127.0.0.1:${port}/api/health`); } catch { await wait(250); }
  }
  return null;
};
const port = 4000 + crypto.randomInt(1000);

// 1. Platform volumes are commonly group- and world-readable. Setup refuses those deliberately, so
// the deployment needs one explicit chmod; this check exists so that step is never a surprise.
const openVolume = path.join(workspace, 'open-volume');
await fs.mkdir(openVolume, { mode: 0o755 });
await fs.chmod(openVolume, 0o755);
const openResult = await run('scripts/setup-local.mjs', [openVolume], {});
record('volume mode', openResult.code !== 0,
  openResult.code !== 0
    ? 'A 0755 volume is refused, as intended. Deployment must chmod 700 the mounted directory once.'
    : 'A 0755 volume was accepted; the private-directory guard did not fire.');

// 2. An empty volume has no registry. The server still starts and serves pages, so the symptom is
// not a crash but every authorized route answering 503.
const emptyVolume = path.join(workspace, 'empty-volume');
await fs.mkdir(emptyVolume, { mode: 0o700 });
const empty = serve(emptyVolume, port);
const emptyHealth = await reachable(port);
const emptyTasks = emptyHealth ? await fetch(`http://127.0.0.1:${port}/api/tasks`) : null;
record('empty volume', Boolean(emptyHealth) && emptyTasks?.status === 503,
  emptyHealth
    ? `Server starts without a registry; /api/tasks answers ${emptyTasks?.status}. Run setup once against the volume.`
    : `Server did not become reachable. ${empty.log().split('\n')[0] || ''}`);
empty.child.kill('SIGTERM');
await wait(600);

// 3. The working case: a private volume with a registry.
const volume = path.join(workspace, 'volume');
await fs.mkdir(volume, { mode: 0o700 });
const setup = await run('scripts/setup-local.mjs', [volume], {});
record('setup on a private volume', setup.code === 0, setup.output.trim().split('\n').pop() || 'no output');

const live = serve(volume, port);
const health = await reachable(port);
const posture = health ? await health.json() : null;
record('server reachable on 0.0.0.0', Boolean(posture),
  posture ? `localOnly=${posture.localOnly} demoFallbackEnabled=${posture.demoFallbackEnabled}` : live.log().split('\n')[0] || 'no response');

if (posture) {
  // A missing page falls back to the sender page with 200, so status alone proves nothing: each
  // page must also carry its own script.
  const pages = await Promise.all([['/', 'app.js'], ['/decode.html', 'decode.js'], ['/audit.html', 'audit.js'],
    ['/admin.html', 'admin.js'], ['/zh-TW/', 'app.js']].map(async ([route, script]) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`);
    return [route, response.status, (await response.text()).includes(script)];
  }));
  record('pages served', pages.every(([, status, own]) => status === 200 && own),
    pages.map(([route, status, own]) => `${route} ${status}${own ? '' : ' (wrong page)'}`).join('  '));

  const guarded = await Promise.all(['/api/tasks', '/api/audit', '/api/whoami']
    .map(async route => [route, (await fetch(`http://127.0.0.1:${port}${route}`)).status]));
  record('unauthenticated routes refused', guarded.every(([, status]) => status === 401),
    guarded.map(([route, status]) => `${route} ${status}`).join('  '));

  // Headers matter more on a hosted origin than locally: this is what a judge's browser enforces.
  const headers = (await fetch(`http://127.0.0.1:${port}/`)).headers;
  const required = ['content-security-policy', 'x-content-type-options', 'x-frame-options', 'referrer-policy'];
  const missing = required.filter(name => !headers.get(name));
  record('security headers', missing.length === 0, missing.length ? `missing ${missing.join(', ')}` : required.join(', '));
}

// 4. A container killed without its shutdown handler leaves server.lock on the persistent volume.
// Whether the next start recovers is the difference between one restart and a restart loop.
live.child.kill('SIGKILL');
await wait(600);
const lockSurvived = await fs.access(path.join(volume, 'server.lock')).then(() => true, () => false);
const restart = serve(volume, port);
const restarted = await reachable(port, 16);
record('restart after a non-graceful stop', Boolean(restarted),
  restarted
    ? 'A stale lock did not block startup.'
    : `A stale server.lock (${lockSurvived ? 'present' : 'absent'}) blocked startup: ${restart.log().split('\n').find(line => line.includes('Error')) || 'server did not start'}`,
  false);
restart.child.kill('SIGTERM');
await wait(400);
restart.child.kill('SIGKILL');

await fs.rm(workspace, { recursive: true, force: true });

const blocking = results.filter(entry => entry.blocking && !entry.ok);
const advisory = results.filter(entry => !entry.blocking && !entry.ok);
process.stdout.write(`\n${results.filter(entry => entry.ok).length}/${results.length} checks pass. `
  + `${blocking.length} blocking, ${advisory.length} advisory.\n`);
if (advisory.length) process.stdout.write(`Advisory: ${advisory.map(entry => entry.name).join(', ')}. These need a manual step, not a code change, before or during hosting.\n`);
process.exitCode = blocking.length ? 1 : 0;
