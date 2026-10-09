import { authenticatedFetch } from './auth.js';
import { t, setText } from './i18n.js';

// The recipient's own list of what was approved for them. Everything shown comes from GET /api/inbox, which the
// server builds for this token alone; the page only renders it. Text is set as text, never as markup.
const list = document.querySelector('#inboxList');
const status = document.querySelector('#inboxStatus');
const refresh = document.querySelector('#refreshInbox');
const taskId = document.querySelector('#packageId');
const version = document.querySelector('#snapshotVersion');
let generation = 0;

const STATES = { WAITING: 'Waiting for you', DOWNLOADED: 'Downloaded, receipt not confirmed', RECEIVED: 'Received', REVOKED: 'Revoked by the sender', EXPIRED: 'Expired' };
const when = value => { const time = Date.parse(value); return Number.isFinite(time) ? new Date(time).toLocaleString() : ''; };

function render(items) {
  list.replaceChildren();
  for (const item of items) {
    const row = document.createElement('li');
    const text = document.createElement('span');
    text.textContent = [item.fromDepartment ? `${t('From')} ${item.fromDepartment}` : t('From a sender'), t(STATES[item.state] || item.state),
      item.expiresAt ? `${t('Expires')} ${when(item.expiresAt)}` : ''].filter(Boolean).join(' · ');
    row.append(text);
    if (item.state === 'WAITING' || item.state === 'DOWNLOADED') {
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'button';
      open.textContent = t('Open');
      open.addEventListener('click', () => {
        taskId.value = item.id;
        version.value = String(item.version);
        taskId.dispatchEvent(new Event('input', { bubbles: true }));
        taskId.scrollIntoView({ block: 'center' });
      });
      row.append(open);
    }
    list.append(row);
  }
}

async function load() {
  const mine = ++generation;
  list.replaceChildren();
  const response = await authenticatedFetch('/api/inbox').catch(() => null);
  if (mine !== generation) return;
  if (!response || response.status === 401 || response.status === 403) { setText(status, 'Choose your token to see what was approved for you.'); return; }
  if (!response.ok) { setText(status, 'The inbox could not be loaded.'); return; }
  const { items } = await response.json();
  if (mine !== generation) return;
  setText(status, items.length ? 'These were approved for you.' : 'Nothing has been approved for you yet.');
  render(items);
}

refresh.addEventListener('click', () => { void load(); });
window.addEventListener('authenticationchange', () => { void load(); });
void load();
