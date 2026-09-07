import { decryptText } from './crypto-utils.js';

const packageId = document.querySelector('#packageId');
const decodeRole = document.querySelector('#decodeRole');
const deviceClaim = document.querySelector('#deviceClaim');
const passphrase = document.querySelector('#passphrase');
const decodeBtn = document.querySelector('#decodeBtn');
const decodeStatus = document.querySelector('#decodeStatus');
const credentialView = document.querySelector('#credentialView');
const protectedView = document.querySelector('#protectedView');

const params = new URLSearchParams(location.search);
if (params.get('id')) {
  packageId.value = params.get('id');
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const json = await response.json();
  if (!response.ok) {
    throw new Error(json.error || `request failed with HTTP ${response.status}`);
  }
  return json;
}

function redactForRole(text, role) {
  if (role === 'cfo') return text;
  return text
    .replace(/\bQ[1-4]\b/gi, '[quarter]')
    .replace(/\b(revenue|profit|customer|renewal|board)\b/gi, '[redacted]')
    .replace(/\$?\b\d{4,}\b/g, '[amount]');
}

decodeBtn.addEventListener('click', async () => {
  decodeBtn.disabled = true;
  decodeStatus.className = 'status-card';
  decodeStatus.textContent = 'Issuing timed access credential...';
  credentialView.textContent = 'No timed credential issued.';
  protectedView.innerHTML = '<div class="empty-state">Waiting for policy decision.</div>';
  try {
    const credentialResponse = await postJson(`/api/packages/${encodeURIComponent(packageId.value)}/credential`, {
      role: decodeRole.value,
      deviceClaim: deviceClaim.value
    });
    credentialView.textContent = JSON.stringify({
      credentialId: credentialResponse.credential.claims.credentialId,
      packageId: credentialResponse.credential.claims.packageId,
      role: credentialResponse.credential.claims.role,
      deviceClaim: credentialResponse.credential.claims.deviceClaim,
      expiresAt: credentialResponse.credential.claims.expiresAt,
      maxUses: credentialResponse.credential.claims.maxUses,
      policyHash: credentialResponse.credential.claims.policyHash
    }, null, 2);
    decodeStatus.textContent = 'Checking signed credential against decode policy...';

    const response = await postJson(`/api/packages/${encodeURIComponent(packageId.value)}/verify`, {
      credential: credentialResponse.credential.token
    });
    if (!response.ok) {
      decodeStatus.className = 'status-card danger';
      decodeStatus.textContent = `DENY: ${response.reasons.join(', ')}`;
      protectedView.innerHTML = '<div class="empty-state">Ciphertext was not released to this decode path.</div>';
      return;
    }
    const sealed = response.package;
    const plaintext = await decryptText(sealed.ciphertext, sealed.iv, sealed.salt, passphrase.value);
    const renderedText = redactForRole(plaintext, decodeRole.value);
    decodeStatus.className = 'status-card success';
    decodeStatus.textContent = `ALLOW: ${response.reasons.join(', ')}`;
    protectedView.innerHTML = `
      <div class="watermark">Viewed by ${decodeRole.value} on ${new Date().toLocaleString()}</div>
      <pre>${renderedText.replace(/[&<>"']/g, character => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      })[character])}</pre>
    `;
  } catch (error) {
    decodeStatus.className = 'status-card danger';
    decodeStatus.textContent = error instanceof Error ? error.message : 'decode failed';
  } finally {
    decodeBtn.disabled = false;
  }
});
