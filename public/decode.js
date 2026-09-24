import { openFileBytes } from './file-envelope.js';
import { authenticatedFetch } from './auth.js';
import { setText, initializeLanguage } from './i18n.js';

const taskId = document.querySelector('#packageId');
const version = document.querySelector('#snapshotVersion');
const button = document.querySelector('#decodeBtn');
const status = document.querySelector('#decodeStatus');
const accessBadge = document.querySelector('#accessBadge');
// Shows the server's access decision for this delivery. DENIED is shown only when the server refused
// this identity (403); a network or format failure is not a denial and is not labelled as one.
function showAccess(state) {
  accessBadge.hidden = !state;
  if (!state) return;
  accessBadge.className = `access-badge ${state === 'APPROVED' ? 'approved' : 'denied'}`;
  setText(accessBadge, state === 'APPROVED' ? 'ACCESS APPROVED' : 'ACCESS DENIED');
}
const params = new URLSearchParams(location.search);
taskId.value = params.get('id') || '';
version.value = params.get('version') || '1';
let identityGeneration = 0;
let verifiedDelivery = null;
const acknowledge = document.querySelector('#acknowledgeFile');
const retryReceipt = document.querySelector('#retryReceipt');
const refreshReceipt = document.querySelector('#refreshReceipt');
let refreshTimer;
let receiptBusy = false;
const clearVerification = () => { verifiedDelivery = null; acknowledge.disabled = true; retryReceipt.disabled = true; };
function changed() {
  identityGeneration += 1;
  showAccess(null);
  clearVerification();
  clearTimeout(refreshTimer);
  setText(status, 'No decode attempt yet.');
  refreshTimer = setTimeout(() => { void restoreReceipt(); }, 250);
}
window.addEventListener('authenticationchange', changed);
taskId.addEventListener('input', changed);
version.addEventListener('input', changed);
async function report(target, code) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (verifiedDelivery !== target) throw Error('Identity changed; try again');
    let response;
    try {
      response = await authenticatedFetch('/api/file-access/' + target.id + '/receipt', { method: 'POST',
        signal: AbortSignal.timeout(5000),
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: target.version, code }) });
      if (verifiedDelivery !== target) throw Error('Identity changed; try again');
      if (response.ok) {
        const body = await response.json();
        if (verifiedDelivery !== target) throw Error('Identity changed; try again');
        if (body.ok !== true || body.code !== code || body.evidence !== 'CLIENT_REPORTED') throw Error('Invalid receipt response');
        return;
      }
    } catch {
      if (verifiedDelivery !== target) throw Error('Identity changed; try again');
      if (response?.ok) response = null;
    }
    if (response && response.status < 500 && response.status !== 429) break;
    if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 150 * (attempt + 1)));
  }
  throw Error('Acknowledgement unconfirmed');
}
async function flushReports(target) {
  retryReceipt.disabled = true;
  try {
    while (target.pending.length) { await report(target, target.pending[0]); target.pending.shift(); }
    if (verifiedDelivery === target) {
      acknowledge.disabled = false;
      setText(status, 'File verified; confirm receipt');
    }
  } catch {
    if (verifiedDelivery === target) { retryReceipt.disabled = false; setText(status, 'Download requested; receipt unconfirmed'); }
  }
}
async function restoreReceipt() {
  if (button.disabled || receiptBusy || verifiedDelivery?.pending?.length) return;
  const id = taskId.value.trim(), number = Number(version.value), generation = identityGeneration;
  if (!/^[a-f0-9-]{36}$/.test(id) || !Number.isSafeInteger(number) || number < 1 || !document.querySelector('#accessToken').value.trim()) return;
  refreshReceipt.disabled = true;
  try {
    const response = await authenticatedFetch('/api/file-access/' + id + '/receipt-status', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: number }) });
    const body = await response.json();
    if (generation !== identityGeneration || button.disabled || receiptBusy || verifiedDelivery?.pending?.length) return;
    if (!response.ok) throw Error('Receipt status unavailable');
    if (body.acknowledged) {
      clearVerification();
      setText(status, 'Receipt acknowledged');
    } else if (body.fileVerified) {
      verifiedDelivery = { id, version: number, pending: [] };
      acknowledge.disabled = false;
      setText(status, 'File verified; confirm receipt');
    }
  } catch { if (generation === identityGeneration) setText(status, 'Receipt status unavailable'); }
  finally { refreshReceipt.disabled = false; }
}
refreshReceipt.addEventListener('click', restoreReceipt);
retryReceipt.addEventListener('click', () => { if (verifiedDelivery) void flushReports(verifiedDelivery); });
acknowledge.addEventListener('click', async () => {
  const verified = verifiedDelivery;
  if (!verified) return;
  acknowledge.disabled = true;
  receiptBusy = true;
  try {
    await report(verified, 'ACKNOWLEDGED');
    if (verifiedDelivery !== verified) return;
    setText(status, 'Receipt acknowledged');
  } catch { if (verifiedDelivery === verified) { acknowledge.disabled = false; setText(status, 'Acknowledgement unconfirmed'); } }
  finally { receiptBusy = false; }
});

button.addEventListener('click', async () => {
  const id = taskId.value.trim();
  const snapshotVersion = Number(version.value);
  const generation = ++identityGeneration;
  const token = document.querySelector('#accessToken').value;
  let key;
  let recovered;
  let objectUrl;
  function checkIdentity() {
    if (generation !== identityGeneration || token !== document.querySelector('#accessToken').value) {
      throw new Error('Identity changed; try again');
    }
  }
  async function post(action, extra = {}) {
    checkIdentity();
    const response = await authenticatedFetch('/api/file-access/' + id + '/' + action, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: snapshotVersion, ...extra })
    });
    const result = await response.json();
    checkIdentity();
    if (!response.ok) throw Object.assign(new Error(result.error || 'File access failed'), { status: response.status });
    return result;
  }
  button.disabled = true;
  clearTimeout(refreshTimer);
  clearVerification();
  taskId.disabled = true;
  version.disabled = true;
  status.className = 'status-card';
  showAccess(null);
  setText(status, 'Issuing timed access credential...');
  try {
    if (!/^[a-f0-9-]{36}$/.test(id) || !Number.isSafeInteger(snapshotVersion) || snapshotVersion < 1) {
      throw new Error('Invalid task or version');
    }
    const packet = await post('packet');
    const ticket = await post('credential');
    showAccess('APPROVED');
    const release = await post('key', { credential: ticket.credential });
    ticket.credential = '';
    if (!/^[a-f0-9]{64}$/.test(release.key)) throw new Error('File access failed');
    key = Uint8Array.from(release.key.match(/../g), value => parseInt(value, 16));
    release.key = '';
    recovered = await openFileBytes(packet.packet, key);
    checkIdentity();
    objectUrl = URL.createObjectURL(new Blob([recovered.bytes], { type: recovered.type }));
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = recovered.name;
    document.body.append(link);
    link.click();
    link.remove();
    status.className = 'status-card success';
    setText(status, 'Original file download requested');
    verifiedDelivery = { id, version: snapshotVersion, pending: ['FILE_VERIFIED', 'DOWNLOAD_REQUESTED'] };
    await flushReports(verifiedDelivery);
  } catch (error) {
    if (error?.status === 403) showAccess('DENIED');
    status.className = 'status-card danger';
    setText(status, error instanceof Error ? error.message : 'File access failed');
  } finally {
    key?.fill(0);
    recovered?.bytes.fill(0);
    if (objectUrl) {
      const pendingUrl = objectUrl;
      setTimeout(() => URL.revokeObjectURL(pendingUrl), 1000);
    }
    button.disabled = false;
    taskId.disabled = false;
    version.disabled = false;
  }
});
initializeLanguage();
