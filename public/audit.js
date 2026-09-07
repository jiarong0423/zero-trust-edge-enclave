const runtimeMode = document.querySelector('#runtimeMode');
const allowCount = document.querySelector('#allowCount');
const denyCount = document.querySelector('#denyCount');
const refreshBtn = document.querySelector('#refreshBtn');
const auditRows = document.querySelector('#auditRows');

function shortHash(value) {
  if (!value) return '-';
  return `${value.slice(0, 10)}...${value.slice(-6)}`;
}

async function refresh() {
  const [healthResponse, auditResponse] = await Promise.all([
    fetch('/api/health'),
    fetch('/api/audit')
  ]);
  const health = await healthResponse.json();
  const audit = await auditResponse.json();
  runtimeMode.textContent = health.nebiusConfigured ? 'Nebius' : 'Demo';
  const events = audit.events || [];
  allowCount.textContent = String(events.filter(event => event.result === 'ALLOW').length);
  denyCount.textContent = String(events.filter(event => event.result === 'DENY').length);
  auditRows.innerHTML = events.length
    ? events.map(event => `
      <tr>
        <td>${new Date(event.createdAt).toLocaleString()}</td>
        <td><span class="pill ${event.result === 'ALLOW' ? 'allow' : event.result === 'DENY' ? 'deny' : 'info'}">${event.result}</span></td>
        <td>${event.type}</td>
        <td>${event.role || '-'}</td>
        <td>${event.deviceClaim || '-'}</td>
        <td><code>${shortHash(event.packageHash)}</code></td>
        <td>${Array.isArray(event.reasons) ? event.reasons.join(', ') : '-'}</td>
      </tr>
    `).join('')
    : '<tr><td colspan="7">No audit events yet.</td></tr>';
}

refreshBtn.addEventListener('click', refresh);
refresh();
