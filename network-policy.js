import net from 'node:net';
import { fail } from './access-control.js';

/**
 * An optional allowlist of client networks (ALLOWED_CLIENT_CIDRS, comma separated, IPv4 or IPv6).
 *
 * Unset, nothing changes: the server keeps relying on tokens and encryption alone. Set, a request
 * whose client address is outside every listed network is refused before any route runs, which
 * turns "private route" from a deployment habit into something the code enforces.
 *
 * Loopback is not allowed implicitly. Behind a reverse proxy on the same host every request would
 * arrive from 127.0.0.1 and an implicit allowance would bypass the list entirely, so a deployment
 * that wants loopback says so (127.0.0.1/32, ::1/128). With TRUST_PROXY the address is taken from
 * X-Forwarded-For; trust it only behind a proxy that overwrites that header.
 */
export function parseCidrList(value) {
  const list = new net.BlockList();
  const items = String(value ?? '').split(',').map(item => item.trim()).filter(Boolean);
  for (const item of items) {
    const [address, prefix, ...rest] = item.split('/');
    const family = net.isIP(address);
    const bits = Number(prefix);
    const max = family === 6 ? 128 : 32;
    if (!family || rest.length || prefix === undefined || !/^\d{1,3}$/.test(prefix) || bits > max) {
      fail(`ALLOWED_CLIENT_CIDRS has an invalid entry: ${item.slice(0, 60)}`, 503);
    }
    list.addSubnet(address, bits, family === 6 ? 'ipv6' : 'ipv4');
  }
  return { list, count: items.length };
}

export function normalizeAddress(address) {
  if (typeof address !== 'string') return null;
  let value = address.trim().replace(/^\[|\]$/g, '').split('%')[0];
  const mapped = value.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (mapped) value = mapped[1];
  return net.isIP(value) ? value : null;
}

/**
 * The client's address as an address (never a bucket or a label): the first X-Forwarded-For entry
 * when the proxy is trusted and the entry really is an address, otherwise the socket address.
 */
export function clientAddress(req, trustProxy = false) {
  if (trustProxy) {
    const forwarded = normalizeAddress(String(req.headers?.['x-forwarded-for'] || '').split(',')[0]);
    if (forwarded) return forwarded;
  }
  return normalizeAddress(req.socket?.remoteAddress);
}

export function createNetworkPolicy(value) {
  // Unset or an empty string means "no restriction". A value that is set but lists nothing (" " or
  // ",") is a mistake, and silently turning the policy off would be the unsafe way to read it.
  if (value === undefined || value === '') return { enabled: false, allows: () => true, allowsRequest: () => true };
  const { list, count } = parseCidrList(value);
  if (!count) fail('ALLOWED_CLIENT_CIDRS is set but lists no networks', 503);
  const allows = address => {
    const normalized = normalizeAddress(address);
    if (!normalized) return false;
    return list.check(normalized, net.isIP(normalized) === 6 ? 'ipv6' : 'ipv4');
  };
  return { enabled: true, allows, allowsRequest: (req, trustProxy = false) => allows(clientAddress(req, trustProxy)) };
}
