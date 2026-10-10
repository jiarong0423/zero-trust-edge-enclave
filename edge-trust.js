import crypto from 'node:crypto';
import net from 'node:net';
import { normalizeAddress } from './network-policy.js';

// Real client addresses behind an edge that this deployment controls (a Cloudflare Worker or rule in front of the
// site). The edge adds two headers to every request it forwards: X-Origin-Auth, a secret only the operator and the
// edge know, and X-Verified-Client-IP, the visitor's address. This server believes the address ONLY when the secret
// matches; anyone else's X-Verified-Client-IP, and every X-Forwarded-For, is ignored unless TRUST_PROXY says
// otherwise. Without this, the address the throttles see is the platform proxy's, shared by every visitor.
//
//   EDGE_SECRET   at least 32 characters; unset leaves the feature off
//   REQUIRE_EDGE  'true' refuses requests that do not carry the secret (the site address that bypasses the edge),
//                 except /api/health so the platform can keep checking the service. Needs EDGE_SECRET.
//   EDGE_REDIRECT_TO  an https origin such as https://site.example. With REQUIRE_EDGE, a GET or HEAD that bypasses the edge is
//                 sent there (307, same path and query) instead of refused, so links already handed out keep working.
export function createEdgeTrust(env = process.env) {
  const secret = typeof env.EDGE_SECRET === 'string' ? env.EDGE_SECRET : '';
  const enabled = secret.length >= 32;
  const required = env.REQUIRE_EDGE === 'true';
  let redirectTo = null;
  if (env.EDGE_REDIRECT_TO) {
    let parsed;
    try { parsed = new URL(env.EDGE_REDIRECT_TO); } catch { throw new Error('EDGE_REDIRECT_TO must be an https origin'); }
    if (parsed.protocol !== 'https:' || parsed.origin !== env.EDGE_REDIRECT_TO || parsed.username || parsed.password) throw new Error('EDGE_REDIRECT_TO must be an https origin');
    if (!required) throw new Error('EDGE_REDIRECT_TO needs REQUIRE_EDGE');
    redirectTo = parsed.origin;
  }
  if (env.EDGE_SECRET && !enabled) throw new Error('EDGE_SECRET must be at least 32 characters');
  if (required && !enabled) throw new Error('REQUIRE_EDGE needs EDGE_SECRET');
  const digest = value => crypto.createHash('sha256').update(String(value)).digest();
  const expected = enabled ? digest(secret) : null;
  const verified = req => {
    if (!enabled) return false;
    const presented = req.headers?.['x-origin-auth'];
    return typeof presented === 'string' && crypto.timingSafeEqual(digest(presented), expected);
  };
  const address = req => {
    if (!verified(req)) return null;
    const value = String(req.headers['x-verified-client-ip'] || '').trim();
    return net.isIP(value) ? normalizeAddress(value) : null;
  };
  return { enabled, required, redirectTo, verified, address };
}
