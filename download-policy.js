import { fail } from './access-control.js';

export function normalizeDownloadPolicy(input) {
  const deliveryMode = input.deliveryMode ?? 'TIME_LIMITED';
  if (!['REQUIRED_ACK', 'TIME_LIMITED'].includes(deliveryMode)) fail('INVALID_DELIVERY_MODE', 422);
  if (deliveryMode === 'REQUIRED_ACK') {
    if (input.downloadUntil != null) fail('UNEXPECTED_DOWNLOAD_CUTOFF', 422);
    return { deliveryMode, downloadUntil: null };
  }
  const cutoff = input.downloadUntil ?? input.expiresAt;
  if (!Number.isFinite(Date.parse(cutoff)) || Date.parse(cutoff) > Date.parse(input.expiresAt)) fail('INVALID_DOWNLOAD_CUTOFF', 422);
  return { deliveryMode, downloadUntil: new Date(cutoff).toISOString() };
}

export function downloadAccessDeadline(content) {
  const policy = normalizeDownloadPolicy(content);
  const authority = Date.parse(content.expiresAt);
  if (!Number.isFinite(authority)) fail('INVALID_DOWNLOAD_CUTOFF', 422);
  return policy.deliveryMode === 'TIME_LIMITED' ? Math.min(authority, Date.parse(policy.downloadUntil)) : authority;
}

export function checkDownloadAccess(content, now = Date.now()) {
  const until = downloadAccessDeadline(content);
  if (now >= until) fail('DOWNLOAD_WINDOW_CLOSED', 403);
  return until;
}

// Stops bytes not yet written by this service; already transmitted bytes cannot be recalled.
export function sendDeadlineJson(res, status, payload, until) {
  if (Date.now() >= until) fail('DOWNLOAD_WINDOW_CLOSED', 403);
  const bytes = Buffer.from(JSON.stringify(payload));
  let offset = 0;
  let timer;
  let immediate;
  const clear = () => { clearTimeout(timer); clearImmediate(immediate); res.off('drain', pump); };
  const expire = () => {
    if (Date.now() >= until) { clear(); res.destroy(); }
    else timer = setTimeout(expire, Math.min(until - Date.now(), 2147483647));
  };
  function pump() {
    if (res.destroyed || res.writableEnded) return clear();
    if (Date.now() >= until) return expire();
    if (offset === bytes.length) { clear(); res.end(); return; }
    const chunk = bytes.subarray(offset, offset + 65536);
    offset += chunk.length;
    if (res.write(chunk)) immediate = setImmediate(pump);
    else res.once('drain', pump);
  }
  res.once('close', clear);
  res.once('finish', clear);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': bytes.length });
  timer = setTimeout(expire, Math.min(until - Date.now(), 2147483647));
  pump();
}
