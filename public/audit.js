import { authenticatedFetch } from './auth.js';
import { t, setText, clearLocalizedText, initializeLanguage } from './i18n.js';
const runtimeMode = document.querySelector('#runtimeMode');
const allowCount = document.querySelector('#allowCount');
const denyCount = document.querySelector('#denyCount');
const refreshBtn = document.querySelector('#refreshBtn');
const auditRows = document.querySelector('#auditRows');
let currentEvents = null;

function shortHash(value) {
  if (!value) return '-';
  return `${value.slice(0, 10)}...${value.slice(-6)}`;
}

async function refresh() {
  const [healthResponse, auditResponse] = await Promise.all([
    fetch('/api/health'),
    authenticatedFetch('/api/audit')
  ]);
  const health = await healthResponse.json();
  const audit = await auditResponse.json();
  if (!auditResponse.ok) {
    currentEvents = null;
    setText(auditRows, audit.error || 'Authentication required');
    return;
  }
  setText(runtimeMode, health.nebiusConfigured ? 'Nebius' : 'Demo');
  const events = audit.events || [];
  currentEvents = events;
  allowCount.textContent = String(events.filter(event => event.result === 'ALLOW').length);
  denyCount.textContent = String(events.filter(event => event.result === 'DENY').length);
  renderEvents();
}

function renderEvents() {
  if (!currentEvents) return;
  clearLocalizedText(auditRows);
  const events = currentEvents;
  auditRows.innerHTML = events.length
    ? events.map(event => `
      <tr>
        <td>${new Date(event.createdAt).toLocaleString()}</td>
        <td><span class="pill ${event.result === 'ALLOW' ? 'allow' : event.result === 'DENY' ? 'deny' : 'info'}">${t(event.result)}</span></td>
        <td>${t(event.type)}</td>
        <td>${event.snapshotVersion ?? '-'}</td>
        <td>${event.attempts ?? '-'}</td>
        <td><code>${shortHash(event.taskId || event.packageId)}</code></td>
        <td>${Array.isArray(event.reasons) ? event.reasons.map(t).join(', ') : '-'}</td>
      </tr>
    `).join('')
    : `<tr><td colspan="7">${t('No audit events yet.')}</td></tr>`;
}

refreshBtn.addEventListener('click', refresh);
window.addEventListener('languagechange', renderEvents);
initializeLanguage();
refresh();
