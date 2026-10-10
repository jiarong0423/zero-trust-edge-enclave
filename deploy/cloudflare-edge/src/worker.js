// The edge in front of the hosted site. It forwards every request to the origin and adds two headers the origin
// trusts only together: X-Origin-Auth (a secret held here and in the origin's environment) and X-Verified-Client-IP
// (the visitor's address as Cloudflare saw it). Any copy of those headers, or of the usual forwarding headers, that
// the visitor sent is removed first, so the visitor cannot claim an address. The origin refuses the claim without the secret.
const STRIP = ['x-origin-auth', 'x-verified-client-ip', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'forwarded', 'host'];

export function buildOriginRequest(request, { originHost, secret }) {
  const url = new URL(request.url);
  const target = new URL(url.pathname + url.search, `https://${originHost}`);
  const headers = new Headers(request.headers);
  const visitor = headers.get('cf-connecting-ip');
  for (const name of STRIP) headers.delete(name);
  headers.set('x-origin-auth', secret);
  if (visitor) headers.set('x-verified-client-ip', visitor);
  const hasBody = !['GET', 'HEAD'].includes(request.method);
  // redirect: 'manual' hands the origin's redirects (sign-in, language) to the browser instead of following them here.
  return new Request(target, { method: request.method, headers, body: hasBody ? request.body : undefined, redirect: 'manual', ...(hasBody ? { duplex: 'half' } : {}) });
}

export default {
  async fetch(request, env) {
    if (!env.EDGE_SECRET || !env.ORIGIN_HOST) return new Response('The edge is not configured', { status: 503 });
    try { return await fetch(buildOriginRequest(request, { originHost: env.ORIGIN_HOST, secret: env.EDGE_SECRET })); }
    catch { return new Response('The site is not reachable', { status: 502 }); }
  }
};
