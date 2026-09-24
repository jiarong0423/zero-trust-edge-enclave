import { setText, t } from './i18n.js';

export function authenticatedFetch(url, options = {}) {
  const token = document.querySelector('#accessToken').value.trim();
  return fetch(url, { ...options, headers: { ...options.headers, authorization: `Bearer ${token}` } });
}

const panel = document.createElement('section');
panel.className = 'token-panel';
const label = document.createElement('label');
const title = document.createElement('span');
setText(title, 'Local access token');
label.append(title);
const input = document.createElement('input');
input.id = 'accessToken';
input.type = 'password';
input.autocomplete = 'off';
input.spellcheck = false;
input.addEventListener('input', () => window.dispatchEvent(new Event('authenticationchange')));
label.append(input);
panel.append(label);
const fileLabel = document.createElement('label');
fileLabel.className = 'token-file-row';
const fileTitle = document.createElement('span');
setText(fileTitle, 'Token file');
fileLabel.append(fileTitle);
const file = document.createElement('input');
file.type = 'file';
file.accept = '.token';
file.hidden = true;
const choose = document.createElement('button');
choose.type = 'button';
choose.className = 'button';
setText(choose, 'Choose token file');
choose.addEventListener('click', () => file.click());
const fileStatus = document.createElement('span');
fileStatus.setAttribute('role', 'status');
setText(fileStatus, 'No token file loaded');
file.addEventListener('change', async () => {
  try {
    if (!file.files[0]) return;
    if (file.files[0].size > 256) throw new Error('Invalid token file');
    const value = (await file.files[0].text()).trim();
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(value)) throw new Error('Invalid token file');
    input.value = value;
    setText(fileStatus, 'Token file loaded');
  } catch {
    input.value = '';
    setText(fileStatus, 'Invalid token file');
  }
  file.value = '';
  window.dispatchEvent(new Event('authenticationchange'));
});
fileLabel.append(file, choose, fileStatus);
panel.append(fileLabel);

// The server, not the page, decides whether a token is a registered identity. This badge only reports
// that answer; it says nothing about access to any task, which each page checks separately.
const identity = document.createElement('p');
identity.className = 'identity-badge';
identity.hidden = true;
identity.setAttribute('role', 'status');
panel.append(identity);
const roles = { operator: 'Sender', recipient: 'Recipient', coordinator: 'Coordinator', administrator: 'Administrator' };
let identityCheck = 0;
window.addEventListener('authenticationchange', () => {
  const current = ++identityCheck;
  if (!input.value.trim()) { identity.hidden = true; return; }
  setTimeout(async () => {
    if (current !== identityCheck) return;
    let result = null;
    try {
      const response = await authenticatedFetch('/api/whoami');
      result = response.ok ? await response.json() : { denied: response.status === 401 };
    } catch { result = null; }
    if (current !== identityCheck) return;
    identity.hidden = false;
    if (result?.ok) {
      identity.className = 'identity-badge verified';
      setText(identity, () => `${t('IDENTITY VERIFIED')} · ${t(roles[result.kind] || 'Unknown role')}`);
    } else {
      identity.className = 'identity-badge rejected';
      setText(identity, result?.denied ? 'IDENTITY NOT VERIFIED' : 'Identity check unavailable');
    }
  }, 250);
});
document.querySelector('main').before(panel);
