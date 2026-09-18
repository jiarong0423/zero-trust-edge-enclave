import { authenticatedFetch } from './auth.js';
import { setText } from './i18n.js';

export function initializeAuthorizationPicker() {
  const select = document.querySelector('#authorizationId');
  const status = document.querySelector('#authorizationStatus');
  let generation = 0;
  async function reload() {
    const current = ++generation;
    select.replaceChildren();
    select.dispatchEvent(new Event('input'));
    setText(status, 'Loading authorizations');
    try {
      const response = await authenticatedFetch('/api/authorizations');
      const result = await response.json();
      if (current !== generation) return;
      if (!response.ok) throw new Error('Authorization unavailable');
      for (const grant of result.grants) {
        const option = new Option('', grant.id);
        setText(option, grant.displayName || grant.id);
        select.append(option);
      }
      setText(status, result.grants.length ? 'Authorizations loaded' : 'No active authorizations');
      select.dispatchEvent(new Event('input'));
    } catch {
      if (current === generation) setText(status, 'Authorization unavailable');
    }
  }
  window.addEventListener('authenticationchange', reload);
  document.querySelector('#refreshAuthorizations').addEventListener('click', reload);
  return { reload };
}
