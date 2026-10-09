// Where sign-in returns to. Only a path on this same site is accepted, so the sign-in page cannot be used to
// send someone elsewhere: no scheme or host, no backslash, not the sign-in page, not the API.
export function safeNext(raw, origin) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 300 || !raw.startsWith('/') || raw.startsWith('//') || /[\\\u0000-\u001f]/.test(raw)) return '/';
  let url;
  try { url = new URL(raw, origin); } catch { return '/'; }
  if (url.origin !== origin || url.pathname.startsWith('/judge-login') || url.pathname.startsWith('/api/')) return '/';
  return url.pathname + url.search;
}
