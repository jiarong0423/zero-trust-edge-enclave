import { authenticatedFetch } from './auth.js';
import { setText } from './i18n.js';

export function initializeAuthorizationPicker() {
  const select = document.querySelector('#authorizationId');
  const status = document.querySelector('#authorizationStatus');
  const row = document.querySelector('#authorizationRow');
  const loadRecipients = document.querySelector('#loadRecipients');
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
      // With exactly one authorization there is nothing to choose: the row folds away and its recipients load by themselves.
      row.hidden = result.grants.length === 1;
      if (result.grants.length >= 1) setTimeout(() => { if (current === generation && !loadRecipients.disabled) loadRecipients.click(); }, 0);
    } catch {
      if (current === generation) setText(status, 'Authorization unavailable');
    }
  }
  window.addEventListener('authenticationchange', reload);
  document.querySelector('#refreshAuthorizations').addEventListener('click', reload);
  select.addEventListener('change', () => { if (!loadRecipients.disabled) loadRecipients.click(); });
  return { reload };
}
