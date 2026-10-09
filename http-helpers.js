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

// Every route that reads a body runs on the serial API queue, so a body that never finishes holds
// every other request. A promise that never settles is therefore a denial of service, not a leak:
// the request is also settled when the connection is closed or aborted before the body is complete
// (a malformed chunked body makes Node answer 400 and drop the socket without an 'end'), and a body
// that stalls is cut off after `timeoutMs`.
// Two deadlines. `idleMs` cuts a body that stops arriving: a connection that stays open and sends nothing
// for that long is refused, however much time is left overall, so a stalled client holds the queue for
// seconds, not minutes. `timeoutMs` bounds the whole read; it defaults to 120 s for the large file route
// (limit above 1 MB) and 30 s for everything else, so a client that keeps sending a byte at a time cannot
// hold the queue longer than that. A slow but steady upload never trips the idle deadline.
export const BODY_IDLE_MS = 15_000;
export function readBody(req, limit = 1_000_000, timeoutMs = limit > 1_000_000 ? 120_000 : 30_000, idleMs = BODY_IDLE_MS) {
  return new Promise((resolve, reject) => {
    // A request waits its turn on the serial queue before its handler reads the body, and the client can
    // go away in the meantime: its 'close' and 'error' events have then already been emitted and will not
    // come again. Listening for them now would wait for nothing until the deadline, so a request that is
    // already destroyed before it was fully received is refused here.
    if ((req.destroyed || req.errored) && !req.complete) {
      reject(Object.assign(new Error('Request aborted'), { status: 400 }));
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
      chunks.length = 0;
      settle(value);
    };
    const timer = setTimeout(() => finish(reject, Object.assign(new Error('Request body timed out'), { status: 408 })), timeoutMs);
    timer.unref();
    const stalled = () => finish(reject, Object.assign(new Error('Request body stalled'), { status: 408 }));
    const waitForData = () => { clearTimeout(idle); idle = setTimeout(stalled, idleMs); idle.unref(); };
    waitForData();
    req.on('data', chunk => {
      if (settled) return;
      waitForData();
      size += chunk.length;
      if (size > limit) {
        finish(reject, Object.assign(new Error('Request body too large'), { status: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      try {
        const body = Buffer.concat(chunks).toString('utf8');
        finish(resolve, body ? JSON.parse(body) : {});
      } catch {
        finish(reject, Object.assign(new Error('Invalid JSON body'), { status: 422 }));
      }
    });
    req.on('aborted', () => finish(reject, Object.assign(new Error('Request aborted'), { status: 400 })));
    req.on('close', () => { if (!req.complete) finish(reject, Object.assign(new Error('Request aborted'), { status: 400 })); });
    req.on('error', error => finish(reject, error));
  });
}
