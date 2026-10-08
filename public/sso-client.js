// The browser side of the optional OIDC sign-in (docs/agent/sso.md). Three calls, each taking the
// fetch function so they can be tested without a page. Nothing here stores a token: the caller puts
// it where a pasted token goes, and it lives only as long as the page.
export async function ssoEnabled(fetchImpl = fetch) {
  try {
    const response = await fetchImpl('/api/sso/status', { cache: 'no-store', credentials: 'same-origin' });
    if (!response.ok) return false;
    const body = await response.json();
    return body?.ok === true && body?.enabled === true;
  } catch {
    return false;
  }
}

// The callback leaves a one-minute, single-use hand-off cookie and redirects to the landing page.
// This turns it into a session token, once. A page opened without a hand-off simply gets null.
export async function ssoExchange(fetchImpl = fetch) {
  try {
    const response = await fetchImpl('/api/sso/session', {
      method: 'POST', credentials: 'same-origin', headers: { 'x-sso-exchange': '1' }
    });
    if (!response.ok) return null;
    const body = await response.json();
    return typeof body?.token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(body.token) ? body.token : null;
  } catch {
    return null;
  }
}

export async function ssoLogout(token, fetchImpl = fetch) {
  try {
    const response = await fetchImpl('/api/sso/logout', { method: 'POST', headers: { authorization: `Bearer ${token}` } });
    return response.ok;
  } catch {
    return false;
  }
}
