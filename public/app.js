import { authenticatedFetch } from './auth.js';
import { sealFileBytes, MAX_FILE_BYTES } from './file-envelope.js';
import { createRecipientPicker } from './recipient-picker.js';
import { initializeAuthorizationPicker } from './authorization-picker.js';
import { initializeTaskHistory } from './task-history.js';
import { setText, setJson, initializeLanguage, t } from './i18n.js';

async function showModelRuntime() {
  const view = document.querySelector('#modelRuntimeStatus');
  try {
    // The health request waits behind any adviser call in progress, so give it time for one.
    const response = await fetch('/api/health', { cache: 'no-store', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw Error('Health unavailable');
    const health = await response.json();
    if (health.ok !== true || typeof health.localOnly !== 'boolean' || typeof health.nebiusConfigured !== 'boolean') throw Error('Invalid health');
    // Describe the outlet that will answer, not merely whether a Token Factory key is present.
    const local = health.adviserProvider === 'local_openai_compatible';
    const tokenFactory = health.adviserProvider === 'nebius' && health.nebiusConfigured && !health.localOnly
      && !health.nebiusBudget?.exhausted;
    setText(view, local ? 'Local model outlet configured; successful model call not verified'
      : tokenFactory ? 'Provider configured; successful model call not verified'
      : health.nebiusBudget?.exhausted ? 'Token Factory budget spent; local simulation, no real model call'
      : 'Local simulation; no real model call');
    const model = local ? health.localOutletModel : tokenFactory ? health.nebiusModel : null;
    const modelView = document.querySelector('#configuredModel');
    if (typeof model === 'string') setText(modelView, () => `${t('Configured model (not execution evidence)')}: ${model}`);
    else setText(modelView, 'No model is called in this mode');
  } catch { setText(view, 'Model status unavailable'); }
}
void showModelRuntime();
// The outlet can change while this page stays open (a server restarted with another adviser).
document.addEventListener('visibilitychange', () => { if (!document.hidden) void showModelRuntime(); });

const upload = document.querySelector('#documentFile');
const choose = document.querySelector('#chooseDocument');
const review = document.querySelector('#recipientReview');
const first = document.querySelector('#sealBtn');
const second = document.querySelector('#approveBtn');
const status = document.querySelector('#fileStatus');
const snapshotView = document.querySelector('#snapshotReview');
const result = document.querySelector('#packageResult');
const authorization = document.querySelector('#authorizationId');
const expiry = document.querySelector('#requestedExpiry');
const deadline = document.querySelector('#requestedDeadline');
const deliveryMode = document.querySelector('#deliveryMode');
const downloadWindow = document.querySelector('#downloadWindow');
let sealed = null;
let fileInfo = null;
let draft = null;
let pending = null;
let invalidation = Promise.resolve();
let failed = false;
let working = false;
let trackingGeneration = 0;
const recipientLink = document.querySelector('#recipientLink');
const refreshDelivery = document.querySelector('#refreshDelivery');
const receiptView = document.querySelector('#receiptSummary');
let trackedTask = null;
let pipelineGeneration = 0;
refreshDelivery.addEventListener('click', () => {
  if (trackedTask) void trackDelivery(trackedTask.id, trackedTask.version);
});
window.addEventListener('languagechange', () => {
  if (!recipientLink.hasAttribute('href')) return;
  const url = new URL(recipientLink.href);
  url.pathname = location.pathname.startsWith('/zh-TW/') ? '/zh-TW/decode.html' : '/decode.html';
  recipientLink.href = url.pathname + url.search;
});
window.addEventListener('authenticationchange', () => {
  pipelineGeneration += 1;
  sealed?.key.fill(0);
  sealed = null;
  draft = null;
  pending = null;
  failed = false;
  invalidation = Promise.resolve();
  review.hidden = true;
  first.disabled = true;
  second.disabled = true;
  trackingGeneration += 1;
  trackedTask = null;
  refreshDelivery.disabled = true;
  setText(receiptView, '');
  recipientLink.hidden = true;
  setText(result, 'No delivery task.');
  setText(document.querySelector('#deliveryStatus'), 'No delivery task.');
});
async function trackDelivery(id, version) {
  trackedTask = { id, version };
  refreshDelivery.disabled = false;
  const generation = ++trackingGeneration;
  const deliveryStatus = document.querySelector('#deliveryStatus');
  recipientLink.hidden = true;
  for (let attempt = 0; attempt < 120 && generation === trackingGeneration; attempt++) {
    try {
      const response = await authenticatedFetch('/api/tasks/' + id);
      const body = await response.json();
      if (generation !== trackingGeneration) return;
      if (!response.ok) throw new Error('Delivery status unavailable');
      const job = body.task.jobs.find(item => item.version === version);
      if (!job) throw new Error('Delivery status unavailable');
      setJson(result, { taskId: id, version, status: job.status, attempts: job.attempts || 0 });
      // While routing waits to ask an unreachable adviser again, say so and how far along it is.
      const retrying = job.status === 'PENDING_CHECK' && job.reasonCode === 'ADVISER_UNAVAILABLE' && job.adviceRetries > 0;
      setText(deliveryStatus, () => retrying ? `${t('Adviser not answering; asking again')} ${job.adviceRetries}/3`
        : t(job.status) + (job.reasonCode ? ' | ' + t(job.reasonCode) : ''));
      if (job.receiptSummary) {
        const summary = job.receiptSummary;
        setText(receiptView, () => `${t('Recipients')}: ${summary.recipientCount} | ${t('Key recipients')}: ${summary.keyRecipientCount} | ${t('Client download reports')}: ${summary.downloadReportCount} | ${t('Acknowledged recipients')}: ${summary.acknowledgedCount || 0} | ${t(summary.downloadWindowState || '')} | ${t(summary.receiptState || '')} | ${t(summary.deliveryState || '')} | ${t('Not proof of reading')}`);
      }
      if (job.status === 'DRY_RUN_PREPARED') {
        const prefix = location.pathname.startsWith('/zh-TW/') ? '/zh-TW' : '';
        recipientLink.href = prefix + '/decode.html?id=' + encodeURIComponent(id) + '&version=' + version;
        recipientLink.hidden = false;
      }
      // A prepared notice used to end this loop. It no longer ends the work: a delivery that must be
      // acknowledged is reconsidered in the backend until its deadline, and a reminder returns to
      // this same state. Leaving the loop here suppressed the one line that tells the sender work
      // continues without the page open, for exactly the state where that is now true.
      if (!['PENDING_CHECK', 'RETRY_WAIT', 'DRY_RUN_PREPARED'].includes(job.status)) return;
    } catch {
      if (generation === trackingGeneration) setText(deliveryStatus, 'Delivery status unavailable');
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  if (generation === trackingGeneration) setText(deliveryStatus, 'Status tracking stopped; backend continues');
}
async function postJson(url, body) {
  const response = await authenticatedFetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const json = await response.json();
  if (!response.ok) throw new Error(json.error || 'Request failed');
  return json;
}
function invalidate() {
  second.disabled = true;
  const old = pending;
  pending = null;
  setText(snapshotView, 'Draft changed. Confirm again.');
  if (!old || old.approved) return;
  invalidation = invalidation.then(() => postJson('/api/tasks/' + old.taskId + '/invalidate', { version: old.version }))
    .catch(() => { failed = true; first.disabled = true; setText(snapshotView, 'Invalidation not confirmed. Reconnect and reload task before continuing.'); });
}
const picker = createRecipientPicker(postJson, invalidate);
const authorizations = initializeAuthorizationPicker();
initializeTaskHistory((id, version) => { void trackDelivery(id, version); }, restoreDraft);
async function restoreDraft(id, version) {
  if (working) throw Error('Request failed');
  const generation = ++pipelineGeneration;
  const check = () => { if (generation !== pipelineGeneration) throw Error('Identity changed; try again'); };
  busy(true);
  try {
    invalidate();
    await invalidation;
    check();
    const response = await authenticatedFetch('/api/tasks/' + id);
    const body = await response.json();
    check();
    if (!response.ok || !body.task.hasFile) throw Error('Task history unavailable');
    let task = body.task;
    const snapshot = task.snapshots.at(-1);
    if (snapshot.version !== version) throw Error('Refresh history before restoring');
    if (snapshot.status !== 'APPROVED') {
      task = (await postJson('/api/tasks/' + id + '/invalidate', { version })).task;
      check();
    }
    await authorizations.reload();
    check();
    if (![...authorization.options].some(option => option.value === task.authorizationId)) throw Error('Authorization unavailable');
    pending = null;
    authorization.value = task.authorizationId;
    authorization.dispatchEvent(new Event('input'));
    sealed?.key.fill(0);
    sealed = null;
    draft = { id, version, authorizationId: task.authorizationId, documentHash: snapshot.content.documentHash };
    fileInfo = { name: t('Staged encrypted file') + ' | ' + id };
    deliveryMode.value = snapshot.content.deliveryMode || 'TIME_LIMITED';
    document.querySelector('#downloadWindowField').hidden = deliveryMode.value !== 'TIME_LIMITED';
    document.querySelector('#requestedExpiryField').hidden = deliveryMode.value !== 'TIME_LIMITED';
    failed = false;
    invalidation = Promise.resolve();
    review.hidden = false;
    setText(status, 'Staged file restored; select recipients again');
    setJson(snapshotView, { taskId: id, version, recipients: snapshot.content.recipients,
      deliveryMode: snapshot.content.deliveryMode, expiresAt: snapshot.content.expiresAt });
  } finally { busy(false); }
}
function busy(value) {
  working = value;
  picker.setBusy(value);
  for (const control of [choose, authorization, expiry, deadline, deliveryMode, downloadWindow, document.querySelector('#refreshAuthorizations')]) control.disabled = value;
  first.disabled = value || (!sealed && !draft) || failed;
  second.disabled = value || !pending;
}
expiry.addEventListener('change', invalidate);
deadline.addEventListener('input', invalidate);
deliveryMode.addEventListener('change', () => {
  document.querySelector('#downloadWindowField').hidden = deliveryMode.value !== 'TIME_LIMITED';
  document.querySelector('#requestedExpiryField').hidden = deliveryMode.value !== 'TIME_LIMITED';
  invalidate();
});
downloadWindow.addEventListener('input', invalidate);
choose.addEventListener('click', () => upload.click());
upload.addEventListener('change', async () => {
  const file = upload.files[0];
  upload.value = '';
  if (!file || working) return;
  const generation = ++pipelineGeneration;
  invalidate();
  sealed?.key.fill(0);
  sealed = null;
  draft = null;
  review.hidden = true;
  busy(true);
  setText(status, 'Encrypting locally');
  let bytes;
  try {
    if (!file.size || file.size > MAX_FILE_BYTES) throw new Error('File must be between 1 byte and 5 MiB');
    bytes = new Uint8Array(await file.arrayBuffer());
    const candidate = await sealFileBytes(bytes, file.name);
    if (generation !== pipelineGeneration) { candidate.key.fill(0); throw Error('Identity changed; try again'); }
    sealed = candidate;
    fileInfo = { name: file.name, size: file.size };
    setText(status, () => fileInfo.name + ' | ' + fileInfo.size + ' bytes | ' + t('Encrypted locally'));
    review.hidden = false;
  } catch (error) { setText(status, error.message); }
  finally { bytes?.fill(0); busy(false); }
});
first.addEventListener('click', async () => {
  if ((!sealed && !draft) || working) return;
  const generation = pipelineGeneration;
  const check = () => { if (generation !== pipelineGeneration) throw Error('Identity changed; try again'); };
  const post = async (url, input) => { check(); const value = await postJson(url, input); check(); return value; };
  busy(true);
  try {
    await invalidation;
    check();
    if (failed) throw new Error('Pending invalidation must be resolved');
    const response = await authenticatedFetch('/api/authorizations');
    const json = await response.json();
    check();
    if (!response.ok) throw new Error('Authorization unavailable');
    const grant = json.grants.find(item => item.id === authorization.value.trim());
    if (!grant) throw new Error('Authorization unavailable');
    const recipients = picker.selection(grant);
    const expiresAt = deliveryMode.value === 'REQUIRED_ACK' ? grant.expiresAt
      : new Date(Math.min(Date.now() + Number(expiry.value) * 3600000, Date.parse(grant.expiresAt))).toISOString();
    if (!deadline.checkValidity()) throw new Error('Invalid delivery deadline');
    const deliveryDeadline = new Date(Math.min(Date.now() + Number(deadline.value) * 60000, Date.parse(expiresAt))).toISOString();
    if (deliveryMode.value === 'TIME_LIMITED' && !downloadWindow.checkValidity()) throw new Error('INVALID_DOWNLOAD_CUTOFF');
    const downloadUntil = deliveryMode.value === 'TIME_LIMITED'
      ? new Date(Math.min(Date.now() + Number(downloadWindow.value) * 60000, Date.parse(expiresAt))).toISOString() : null;
    const content = { documentHash: sealed?.commitment || draft.documentHash, recipients, channels: grant.channels, expiresAt, deliveryDeadline,
      deliveryMode: deliveryMode.value, downloadUntil };
    if (draft && draft.authorizationId !== grant.id) throw new Error('Choose the file again for another authorization');
    if (pending) { invalidate(); await invalidation; if (failed) throw new Error('Pending invalidation must be resolved'); }
    const saved = draft
      ? await post('/api/tasks/' + draft.id + '/revise', { version: draft.version, content })
      : await post('/api/file-tasks', { authorizationId: grant.id, recipients, channels: grant.channels, expiresAt, deliveryDeadline,
        deliveryMode: content.deliveryMode, downloadUntil,
        packet: sealed.packet, documentKey: [...sealed.key].map(byte => byte.toString(16).padStart(2, '0')).join('') });
    const snapshot = saved.task.snapshots.at(-1);
    draft = { id: saved.task.id, version: snapshot.version, authorizationId: grant.id, documentHash: snapshot.content.documentHash };
    sealed?.key.fill(0);
    const locked = await post('/api/tasks/' + draft.id + '/confirm-first', { version: draft.version });
    pending = { taskId: draft.id, version: draft.version, token: locked.token };
    setJson(snapshotView, { document: fileInfo.name, version: snapshot.version, recipients: snapshot.content.recipients,
      channels: snapshot.content.channels, expiresAt: snapshot.content.expiresAt, deliveryDeadline: snapshot.content.deliveryDeadline,
      deliveryMode: snapshot.content.deliveryMode, downloadUntil: snapshot.content.downloadUntil });
  } catch (error) { setText(snapshotView, error.message); }
  finally { busy(false); }
});
second.addEventListener('click', async () => {
  if (!pending || working) return;
  const confirmation = pending;
  const generation = pipelineGeneration;
  busy(true);
  try {
    await invalidation;
    if (pending !== confirmation || generation !== pipelineGeneration) throw Error('Identity changed; try again');
    const approved = await postJson('/api/tasks/' + pending.taskId + '/confirm-second', { version: pending.version, token: pending.token });
    if (pending !== confirmation || generation !== pipelineGeneration) throw Error('Identity changed; try again');
    pending.approved = true;
    const approvedVersion = pending.version;
    setJson(result, { taskId: approved.task.id, version: pending.version, status: 'PENDING_CHECK' });
    pending = null;
    setText(document.querySelector('#deliveryStatus'), 'Approved; delivery pending');
    void trackDelivery(approved.task.id, approvedVersion);
  } catch (error) { setText(result, error.message); }
  finally { busy(false); }
});
initializeLanguage();
