import { authenticatedFetch } from './auth.js';
import { t, setText, clearLocalizedText, initializeLanguage, isChinese } from './i18n.js';
import { loadEvidenceTasks, clearEvidence } from './evidence-chain.js';
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

// A refresh started before the identity changed must not draw its answer over a newer one.
let refreshGeneration = 0;
async function refresh() {
  const ticket = ++refreshGeneration;
  const [healthResponse, auditResponse] = await Promise.all([
    fetch('/api/health'),
    authenticatedFetch('/api/audit')
  ]);
  const health = await healthResponse.json();
  const audit = await auditResponse.json();
  if (ticket !== refreshGeneration) return;
  if (!auditResponse.ok) {
    // A failed sign-in leaves nothing of the previous viewer's records or evidence on screen.
    currentEvents = null;
    allowCount.textContent = '0';
    denyCount.textContent = '0';
    setText(auditRows, audit.error || 'Authentication required');
    clearEvidence();
    return;
  }
  // Name the outlet actually answering, not merely whether a Token Factory key is present. A spent
  // budget hands decisions to the synthetic adviser, so the label must say so.
  const tokenFactory = health.adviserProvider === 'nebius' && health.nebiusConfigured;
  setText(runtimeMode, tokenFactory && health.nebiusBudget?.exhausted ? 'Demo (Token Factory budget spent)'
    : tokenFactory ? 'Token Factory'
    : health.adviserProvider === 'local_openai_compatible'
      ? () => `${t('Local model outlet')}: ${health.localOutletModel || '-'}` : 'Demo');
  const events = audit.events || [];
  currentEvents = events;
  allowCount.textContent = String(events.filter(event => event.result === 'ALLOW').length);
  denyCount.textContent = String(events.filter(event => event.result === 'DENY').length);
  renderEvents();
  await loadEvidenceTasks();
}

function renderEvents() {
  if (!currentEvents) return;
  clearLocalizedText(auditRows);
  const events = currentEvents;
  auditRows.innerHTML = events.length
    ? events.map(event => `
      <tr>
        <td>${new Date(event.createdAt).toLocaleString(isChinese ? 'zh-TW' : 'en-US')}</td>
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
let authenticationTimer;
window.addEventListener('authenticationchange', () => {
  clearTimeout(authenticationTimer);
  authenticationTimer = setTimeout(refresh, 300);
});
window.addEventListener('languagechange', renderEvents);
initializeLanguage();
refresh();
