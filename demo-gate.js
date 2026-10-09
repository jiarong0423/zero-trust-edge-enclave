import crypto from 'node:crypto';

/**
 * An outer sign-in for a hosted demo. It sits in front of the per-role access tokens, not in place
 * of them: passing it only lets a visitor reach the pages, and every API call still has to present
 * a registered token. Its job is to keep anonymous traffic away from the model outlet, whose calls
 * are billed.
 *
 * The username and password live only in the platform's environment. The browser keeps an HMAC
 * derived from them, never the password, so changing either value signs every session out.
 */
const cookieName = 'enclave_gate';
const openPaths = new Set(['/judge-login.html', '/judge-login.js', '/judge-next.js', '/styles.css', '/api/judge-login', '/api/health']);
const failureWindowMs = 60_000;
// One client is limited well below the global ceiling, so a single client guessing (or merely
// hammering the form) cannot sign every judge out. The global ceiling still bounds a distributed
// attempt against the shared password.
const failureLimit = 20;
const globalFailureLimit = 200;
const maxClients = 5_000;

export function gateConfig(env) {
  if (env.REQUIRE_DEMO_GATE !== 'true') return null;
  const user = env.DEMO_GATE_USER || '';
  const password = env.DEMO_GATE_PASSWORD || '';
  return { ready: Boolean(user && password), user, password, failures: [] };
}

const digest = value => crypto.createHash('sha256').update(String(value)).digest();
const same = (a, b) => crypto.timingSafeEqual(digest(a), digest(b));
const sessionValue = gate => crypto.createHmac('sha256', `${gate.user}:${gate.password}`)
  .update('enclave-demo-gate-v1').digest('base64url');

function cookieValue(req) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === cookieName) return rest.join('=');
  }
  return '';
}

export function gateAllows(gate, req, pathname) {
  if (!gate || openPaths.has(pathname)) return true;
  // Without both values the session key would be derivable by anyone, so nothing is let through.
  if (!gate.ready) return false;
  const presented = cookieValue(req);
  return Boolean(presented) && same(presented, sessionValue(gate));
}

// Returns the Set-Cookie value on success, or an HTTP status on failure.
export function gateSignIn(gate, input, secure, now = Date.now(), client = 'shared') {
  if (!gate.ready) return { status: 503 };
  gate.failures = gate.failures.filter(time => now - time < failureWindowMs);
  gate.clients ??= new Map();
  const mine = (gate.clients.get(client) ?? []).filter(time => now - time < failureWindowMs);
  if (mine.length >= failureLimit || gate.failures.length >= globalFailureLimit) {
    const oldest = mine.length >= failureLimit ? mine[0] : gate.failures[0];
    return { status: 429, retryAfter: Math.max(1, Math.ceil((oldest + failureWindowMs - now) / 1000)) };
  }
  const ok = input && typeof input.user === 'string' && typeof input.password === 'string' &&
    same(input.user, gate.user) & same(input.password, gate.password);
  if (!ok) {
    gate.failures.push(now);
    gate.clients.delete(client);
    gate.clients.set(client, [...mine, now]);
    while (gate.clients.size > maxClients) gate.clients.delete(gate.clients.keys().next().value);
    return { status: 401 };
  }
  return { cookie: `${cookieName}=${sessionValue(gate)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200${secure ? '; Secure' : ''}` };
}

// Where an unsigned visitor is sent. A page the visitor was heading to is remembered as a same-origin path in
// `next` so sign-in can return there; the sign-in page and the API are never remembered.
export function loginRedirect(method, pathname, search = '') {
  const base = '/judge-login.html';
  if (method !== 'GET' || pathname === '/' || pathname.startsWith('/api/') || pathname === base) return base;
  const target = pathname + search;
  return target.length > 300 ? base : base + '?next=' + encodeURIComponent(target);
}
