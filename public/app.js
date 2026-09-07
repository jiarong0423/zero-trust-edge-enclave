import { encryptText } from './crypto-utils.js';

const fileName = document.querySelector('#fileName');
const senderRole = document.querySelector('#senderRole');
const recipientRole = document.querySelector('#recipientRole');
const dataCategory = document.querySelector('#dataCategory');
const confidentiality = document.querySelector('#confidentiality');
const businessPurpose = document.querySelector('#businessPurpose');
const requestedExpiry = document.querySelector('#requestedExpiry');
const devicePolicy = document.querySelector('#devicePolicy');
const openLimit = document.querySelector('#openLimit');
const payload = document.querySelector('#payload');
const recommendBtn = document.querySelector('#recommendBtn');
const sealBtn = document.querySelector('#sealBtn');
const policyOutput = document.querySelector('#policyOutput');
const packageResult = document.querySelector('#packageResult');
const health = document.querySelector('#health');

let currentPolicy = null;

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

async function refreshHealth() {
  const response = await fetch('/api/health');
  const json = await response.json();
  health.className = json.nebiusConfigured ? 'status-card success' : 'status-card warning';
  health.textContent = json.nebiusConfigured
    ? `Nebius configured: ${json.nebiusModel}`
    : `Demo fallback active. Configure NEBIUS_API_KEY for real Token Factory evidence.`;
}

recommendBtn.addEventListener('click', async () => {
  recommendBtn.disabled = true;
  policyOutput.textContent = 'Requesting policy recommendation...';
  try {
    const response = await postJson('/api/policy/recommend', {
      fileName: fileName.value,
      senderRole: senderRole.value,
      intendedRecipientRole: recipientRole.value,
      policyMetadata: {
        dataCategory: dataCategory.value,
        confidentiality: confidentiality.value,
        businessPurpose: businessPurpose.value,
        requestedExpiry: requestedExpiry.value,
        devicePolicy: devicePolicy.value,
        openLimit: openLimit.value
      }
    });
    currentPolicy = response.policy;
    policyOutput.textContent = JSON.stringify(response, null, 2);
    sealBtn.disabled = false;
  } catch (error) {
    policyOutput.textContent = error instanceof Error ? error.message : 'policy request failed';
  } finally {
    recommendBtn.disabled = false;
  }
});

sealBtn.addEventListener('click', async () => {
  sealBtn.disabled = true;
  packageResult.innerHTML = '<div class="empty-state">Encrypting locally and sealing package...</div>';
  try {
    if (!currentPolicy) {
      throw new Error('policy recommendation is required before sealing');
    }
    const encrypted = await encryptText(payload.value, 'demo-passphrase');
    const response = await postJson('/api/packages', {
      fileName: fileName.value,
      senderRole: senderRole.value,
      policy: currentPolicy,
      ...encrypted
    });
    packageResult.innerHTML = `
      <div class="result-card">
        <span class="label">Package id</span>
        <strong>${response.packageId}</strong>
      </div>
      <div class="result-card">
        <span class="label">Ciphertext hash</span>
        <code>${response.envelope.packageHash}</code>
      </div>
      <div class="result-card">
        <span class="label">One-way delivery link</span>
        <a href="${response.sealedLink}">${location.origin}${response.sealedLink}</a>
      </div>
      <div class="result-card">
        <span class="label">Recipient passphrase for demo</span>
        <code>demo-passphrase</code>
      </div>
    `;
  } catch (error) {
    packageResult.innerHTML = `<div class="status-card danger">${error instanceof Error ? error.message : 'seal failed'}</div>`;
  } finally {
    sealBtn.disabled = false;
  }
});

refreshHealth();
