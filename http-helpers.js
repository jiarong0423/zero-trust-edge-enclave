// The pages carry no inline script, no inline style, no event attributes and no external origin,
// so the strictest policy is also the accurate one. Plaintext and document keys exist only inside
// these pages, which makes the browser layer part of the boundary rather than decoration.
export function securityHeaders(req) {
  const forwarded = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  // Either TLS terminated in front of this process, or terminated by it. Browsers ignore HSTS on an
  // IP literal, so a LAN demo address simply does not receive it.
  const overTls = forwarded === 'https' || Boolean(req.socket?.encrypted);
  const hostHeader = String(req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  const isIpLiteral = /^\d{1,3}(\.\d{1,3}){3}$/.test(hostHeader) || hostHeader.includes(':');
  return {
    'content-security-policy': "default-src 'self'; base-uri 'none'; form-action 'none'; " +
      "frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self'",
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'cross-origin-embedder-policy': 'require-corp',
    ...(overTls && !isIpLiteral ? { 'strict-transport-security': 'max-age=31536000; includeSubDomains' } : {})
  };
}

export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...securityHeaders(res.req)
  });
  res.end(body);
}

// A request body is read in one of two places. Normally the server reads it BEFORE the request joins the
// serial API queue (`createBodyGate`), so a body that never finishes can use up a read slot but can never
// hold the queue; `readBody` then returns what was already read. A caller that has not pre-read (the sign-in
// routes outside the queue, and the tests) gets the same checks by reading live. Either way the request
// is settled when its connection closes or breaks before the body is complete (a malformed chunked body
// makes Node answer 400 and drop the socket without an 'end'), a body that stops arriving is cut off after
// `idleMs`, and the whole read is bounded by `timeoutMs`: 120 s for the large file route (limit above
// 1 MB), 30 s for everything else. A slow but steady upload never trips the idle deadline.
export const BODY_IDLE_MS = 15_000;
export const BODY_MAX_BYTES = 7_100_000;
const fail = (message, status) => Object.assign(new Error(message), { status });

function readRaw(req, limit, timeoutMs, idleMs) {
  return new Promise((resolve, reject) => {
    // A request may wait before its body is read, and the client can go away in the meantime: its 'close'
    // and 'error' events have then already been emitted and will not come again. A request that is already
    // destroyed before it was fully received is refused here.
    if ((req.destroyed || req.errored) && !req.complete) {
      reject(fail('Request aborted', 400));
      return;
    }
    const chunks = [];
    let size = 0;
    let settled = false;
    let idle;
    const finish = (settle, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(idle);
      settle(value);
    };
    const timer = setTimeout(() => finish(reject, fail('Request body timed out', 408)), timeoutMs);
    timer.unref();
    const waitForData = () => { clearTimeout(idle); idle = setTimeout(() => finish(reject, fail('Request body stalled', 408)), idleMs); idle.unref(); };
    waitForData();
    req.on('data', chunk => {
      if (settled) return;
      waitForData();
      size += chunk.length;
      if (size > limit) {
        chunks.length = 0;
        finish(reject, fail('Request body too large', 413));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish(resolve, Buffer.concat(chunks)));
    req.on('aborted', () => { chunks.length = 0; finish(reject, fail('Request aborted', 400)); });
    req.on('close', () => { if (!req.complete) { chunks.length = 0; finish(reject, fail('Request aborted', 400)); } });
    req.on('error', error => { chunks.length = 0; finish(reject, error); });
  });
}

const preRead = new WeakMap();
const declaredLength = req => Number(req.headers['content-length']);
export const hasBody = req => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) &&
  (declaredLength(req) > 0 || /chunked/i.test(String(req.headers['transfer-encoding'] || '')));

// Reads the whole body now and remembers the outcome, a Buffer or an error, for `readBody`. Never rejects:
// an error is handed to the handler, which throws it from the place it always threw from, so the response
// and the audit record are the same as for a live read.
export function startBodyRead(req) {
  const declared = declaredLength(req);
  if (declared > BODY_MAX_BYTES) { preRead.set(req, Promise.resolve({ error: fail('Request body too large', 413) })); return preRead.get(req); }
  const timeoutMs = declared > 0 && declared <= 1_000_000 ? 30_000 : 120_000;
  const outcome = readRaw(req, BODY_MAX_BYTES, timeoutMs, BODY_IDLE_MS).then(buffer => ({ buffer }), error => ({ error }));
  preRead.set(req, outcome);
  return outcome;
}

export async function readBody(req, limit = 1_000_000, timeoutMs = limit > 1_000_000 ? 120_000 : 30_000, idleMs = BODY_IDLE_MS) {
  let buffer;
  if (preRead.has(req)) {
    const outcome = await preRead.get(req);
    if (outcome.error) throw outcome.error;
    buffer = outcome.buffer;
    if (buffer.length > limit) throw fail('Request body too large', 413);
  } else buffer = await readRaw(req, limit, timeoutMs, idleMs);
  const text = buffer.toString('utf8');
  try { return text ? JSON.parse(text) : {}; }
  catch { throw fail('Invalid JSON body', 422); }
}

// Limits how many bodies are being read, or waiting in the queue after being read, at once: per client and
// in all. A slot is released when the response is finished or the connection goes, so a flood of bodies
// cannot pile up in memory behind the queue. A request that finds the slots full WAITS for one (a burst of
// honest requests is only slowed), and is refused with 429 only if none frees up within `waitMs`; a client
// that opens many stalled bodies uses up its own slots and is refused, and other clients are not held back.
// Requests without a body pass straight through.
export function createBodyGate({ perClient = 8, total = 24, waitMs = 10_000 } = {}) {
  const perKey = new Map();
  const waiting = [];
  let inFlight = 0;
  const hasRoom = key => inFlight < total && (perKey.get(key) || 0) < perClient;
  const take = key => { inFlight++; perKey.set(key, (perKey.get(key) || 0) + 1); };
  const wake = () => {
    for (let index = 0; index < waiting.length;) {
      const waiter = waiting[index];
      if (hasRoom(waiter.key)) { waiting.splice(index, 1); clearTimeout(waiter.timer); take(waiter.key); waiter.resolve(true); }
      else index++;
    }
  };
  return async function admit(req, res, key) {
    if (!hasBody(req)) return;
    if (hasRoom(key)) take(key);
    else {
      const granted = await new Promise(resolve => {
        const waiter = { key, resolve };
        waiter.timer = setTimeout(() => { const at = waiting.indexOf(waiter); if (at !== -1) waiting.splice(at, 1); resolve(false); }, waitMs);
        waiting.push(waiter);
        // A client that gives up while it waits must not keep a place.
        req.once('close', () => { const at = waiting.indexOf(waiter); if (at !== -1) { waiting.splice(at, 1); clearTimeout(waiter.timer); resolve(false); } });
      });
      if (!granted) throw Object.assign(fail('Too many requests in flight', 429), { retryAfter: 1 });
    }
    let released = false;
    const release = () => {
      if (released) return;
      released = true; inFlight--;
      const left = (perKey.get(key) || 1) - 1;
      if (left > 0) perKey.set(key, left); else perKey.delete(key);
      wake();
    };
    res.once('close', release); res.once('finish', release);
    await startBodyRead(req);
  };
}
