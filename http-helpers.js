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
export function readBody(req, limit = 1_000_000, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (settle, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chunks.length = 0;
      settle(value);
    };
    const timer = setTimeout(() => finish(reject, Object.assign(new Error('Request body timed out'), { status: 408 })), timeoutMs);
    timer.unref();
    req.on('data', chunk => {
      if (settled) return;
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
