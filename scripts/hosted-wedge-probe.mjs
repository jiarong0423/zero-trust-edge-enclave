#!/usr/bin/env node
// Checks, against a running instance, that a request whose body never arrives cannot freeze the service.
// Run by the owner in their own terminal, like hosted-smoke.mjs, so no credential is pasted into a chat.
//
//   SMOKE_BASE_URL=https://<host> SMOKE_TOKEN_DIR=<private dir> \
//   [SMOKE_GATE_USER=<user> SMOKE_GATE_PASSWORD=<password>] [PROBE_HOLD_MS=8000] \
//   node scripts/hosted-wedge-probe.mjs
//
// Same configuration, token files and redaction as hosted-smoke.mjs; it needs only the sender's token.
//
// Background: every /api/ request runs on one serial queue. Before the fix, a request that declared a body
// and never finished sending it held that queue forever. The fix settles a body when its connection
// closes or breaks and cuts one off after a deadline (120 s). So the three things worth checking are:
//   1. a connection dropped half way through a body does not leave the service stuck;
//   2. a malformed chunked body does not leave the service stuck;
//   3. while a stalled connection is held open the service waits (that is the bounded cost of the fix, and
//      it is reported, not failed), and it answers again quickly once the connection is closed.
//
// What it sends: three requests to POST /api/directory (the sender's own recipient list, which reads its
// body on the queue) that carry no real data. The longest is held open for PROBE_HOLD_MS (default 8 s,
// at most 30 s), during which other users of the instance wait. It creates no task and changes nothing.
//
// Exit codes: 0 every check passed, 1 a check failed or was inconclusive, 2 configuration or usage error.
import net from 'node:net';
import tls from 'node:tls';
import { pathToFileURL } from 'node:url';
import { loadConfig, redact } from './hosted-smoke.mjs';

const SENDER = 'manager-sender';
const RECOVERY_LIMIT_MS = 5000;
const REQUEST_LIMIT_MS = 30000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const out = line => process.stdout.write(redact(line) + '\n');

async function timed(origin, headers, label) {
  const started = performance.now();
  try {
    const response = await fetch(origin + '/api/whoami', { headers, signal: AbortSignal.timeout(REQUEST_LIMIT_MS) });
    await response.arrayBuffer();
    return { ms: Math.round(performance.now() - started), status: response.status };
  } catch (error) {
    return { ms: Math.round(performance.now() - started), status: 0, failed: error?.name === 'TimeoutError' ? 'timed out' : 'network error' };
  }
}

// One raw connection that sends a header block and part of a body, then does what the caller says.
function rawPost(origin, headers, bodyHead, { chunked = false } = {}) {
  const url = new URL(origin);
  const secure = url.protocol === 'https:';
  const port = Number(url.port) || (secure ? 443 : 80);
  const socket = secure ? tls.connect({ host: url.hostname, port, servername: url.hostname }) : net.connect({ host: url.hostname, port });
  socket.on('error', () => {});
  const lines = ['POST /api/directory HTTP/1.1', `Host: ${url.host}`, 'Content-Type: application/json', ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
    chunked ? 'Transfer-Encoding: chunked' : 'Content-Length: 500', '', ''];
  const ready = new Promise(resolve => socket.once(secure ? 'secureConnect' : 'connect', resolve));
  const reply = { text: '' };
  socket.on('data', chunk => { reply.text += chunk.toString('latin1').slice(0, 200); });
  return { socket, reply,
    async send() { await ready; socket.write(lines.join('\r\n') + bodyHead); },
    close() { socket.destroy(); } };
}

export async function runProbe(config, { holdMs = 8000, write = out } = {}) {
  const { origin, gate, tokens } = config;
  const results = [];
  const record = (name, ok, detail) => { write(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); results.push(ok); };
  const info = text => write(`INFO ${text}`);

  const health = await fetch(origin + '/api/health', { signal: AbortSignal.timeout(REQUEST_LIMIT_MS) }).catch(() => null);
  record('health', Boolean(health?.ok), health ? `HTTP ${health.status}` : 'no answer');
  if (!health?.ok) return 1;

  let cookie = null;
  if (gate) {
    const login = await fetch(origin + '/api/judge-login', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user: gate.user, password: gate.password }), signal: AbortSignal.timeout(REQUEST_LIMIT_MS) }).catch(() => null);
    const raw = login?.headers.getSetCookie?.().find(value => value.startsWith('enclave_gate='));
    record('judge-signin', Boolean(login?.ok && raw), login ? `HTTP ${login.status}` : 'no answer');
    if (!raw) return 1;
    cookie = raw.split(';')[0];
  }
  const headers = { authorization: `Bearer ${tokens[SENDER]}`, ...(cookie ? { cookie } : {}) };

  const base = await timed(origin, headers, 'baseline');
  const baseOk = base.status === 200;
  record('baseline', baseOk, baseOk ? `whoami answered in ${base.ms} ms` : `whoami returned ${base.status || base.failed}`);
  if (!baseOk) return 1;
  const ceiling = Math.max(RECOVERY_LIMIT_MS, base.ms * 10);

  // 1. A connection dropped half way through a body.
  const dropped = rawPost(origin, headers, '{"authorizationId":');
  await dropped.send(); await sleep(1000); dropped.close();
  const afterDrop = await timed(origin, headers, 'after drop');
  record('dropped-body', afterDrop.status === 200 && afterDrop.ms <= ceiling, `whoami answered in ${afterDrop.ms} ms after the connection was dropped (limit ${ceiling} ms)`);

  // 2. A malformed chunked body.
  const chunked = rawPost(origin, headers, 'ZZZ\r\nnot a chunk\r\n', { chunked: true });
  await chunked.send(); await sleep(1000);
  const afterChunk = await timed(origin, headers, 'after malformed');
  chunked.close();
  record('malformed-chunked-body', afterChunk.status === 200 && afterChunk.ms <= ceiling, `whoami answered in ${afterChunk.ms} ms (limit ${ceiling} ms)`);

  // 3. A stalled connection held open, then closed.
  const stalled = rawPost(origin, headers, '{"authorizationId":');
  await stalled.send(); await sleep(500);
  const during = timed(origin, headers, 'during stall');
  await sleep(holdMs);
  stalled.close();
  const blocked = await during;
  const afterStall = await timed(origin, headers, 'after stall');
  record('recovers-after-stall', afterStall.status === 200 && afterStall.ms <= ceiling, `whoami answered in ${afterStall.ms} ms once the stalled connection was closed (limit ${ceiling} ms)`);
  if (blocked.ms >= Math.min(holdMs, 2000)) {
    info(`while the stalled connection was open, one other request waited ${blocked.ms} ms. This is the bounded cost: it ends when the connection closes or at the 120 s read deadline, whichever comes first.`);
  } else {
    record('stall-reached-the-queue', false, `the other request was not delayed (${blocked.ms} ms), so the stalled request probably never held the queue; this run proves nothing about the fix`);
  }

  const failed = results.filter(ok => !ok).length;
  write(`SUMMARY ${failed ? 'FAIL' : 'PASS'} checks=${results.length} passed=${results.length - failed} failed=${failed} hold_ms=${holdMs}`);
  return failed ? 1 : 0;
}

export async function main(env = process.env, argv = process.argv.slice(2)) {
  let config;
  try { config = await loadConfig(env, argv); }
  catch (error) {
    process.stderr.write(redact(`CONFIG ERROR: ${error?.message || 'configuration could not be read'}`) + '\n');
    process.stderr.write('Usage: SMOKE_BASE_URL=... SMOKE_TOKEN_DIR=... [SMOKE_GATE_USER=... SMOKE_GATE_PASSWORD=...] [PROBE_HOLD_MS=8000] node scripts/hosted-wedge-probe.mjs\n');
    return 2;
  }
  const requested = env.PROBE_HOLD_MS === undefined ? 8000 : Number(env.PROBE_HOLD_MS);
  if (!Number.isInteger(requested) || requested < 1000 || requested > 30000) {
    process.stderr.write('CONFIG ERROR: PROBE_HOLD_MS must be a whole number from 1000 to 30000\n');
    return 2;
  }
  out(`INFO target ${config.origin} hold=${requested}ms gate=${config.gate ? 'configured' : 'none'}`);
  try { return await runProbe(config, { holdMs: requested }); }
  catch (error) { process.stderr.write(redact(`FAIL probe: unexpected error: ${String(error?.message || error).slice(0, 200)}`) + '\n'); return 1; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const code = await main();
  process.stdout.write('', () => process.exit(code));
}
