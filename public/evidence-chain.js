import { authenticatedFetch } from './auth.js';
import { t, setText, isChinese } from './i18n.js';

// The sender's evidence chain, built with textContent only: every value is shown as text, never as
// markup, whatever the stored data contains.
const taskSelect = document.querySelector('#evidenceTask');
const showButton = document.querySelector('#evidenceBtn');
const chain = document.querySelector('#evidenceChain');
const status = document.querySelector('#evidenceStatus');

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function json(value) {
  return element('pre', 'code-block evidence-json', JSON.stringify(value, null, 2));
}

function step(number, title, note) {
  const box = element('section', 'evidence-step');
  const heading = element('h3', 'evidence-title');
  heading.append(element('span', 'evidence-number', String(number)), document.createTextNode(' ' + t(title)));
  box.append(heading);
  if (note) box.append(element('p', 'evidence-note', t(note)));
  return box;
}

const SOURCE_LABELS = { nebius_token_factory: 'Token Factory', local_openai_compatible: 'Local model outlet',
  synthetic_fixture: 'Synthetic fixture (no model call)' };
let shown = null;
// Bumped whenever the identity changes or a new request starts; a response for an older number is
// dropped, so a slow reply cannot redraw a previous sender's chain.
let generation = 0;

function when(value) {
  return value ? new Date(value).toLocaleString(isChinese ? 'zh-TW' : 'en-US') : '-';
}

// Called when the viewer changes or stops being valid: nothing of the previous
// sender's chain may stay on screen for the next person.
export function clearEvidence() {
  generation++;
  shown = null;
  taskSelect.replaceChildren();
  chain.replaceChildren();
  showButton.disabled = true;
  setText(status, 'Sign in as the sender to see an evidence chain.');
}

export async function loadEvidenceTasks() {
  const ticket = ++generation;
  const response = await authenticatedFetch('/api/tasks');
  if (ticket !== generation) return;
  if (!response.ok) { clearEvidence(); return; }
  const { tasks } = await response.json();
  if (ticket !== generation) return;
  const withFiles = tasks.filter(task => task.hasFile && task.jobs.length);
  taskSelect.replaceChildren(...withFiles.map(task => {
    const job = task.jobs.at(-1);
    // The time the file was staged tells two deliveries under the same authorization apart.
    return element('option', '', `${when(task.stagedAt)} | ${task.authorizationId} | v${job.version} | ${t(job.status)}`);
  }));
  withFiles.forEach((task, index) => { taskSelect.options[index].value = task.id; });
  if (withFiles.length) taskSelect.selectedIndex = withFiles.length - 1;
  showButton.disabled = !withFiles.length;
  setText(status, withFiles.length ? 'Choose a delivery and show its evidence.' : 'No file deliveries yet.');
}

async function showEvidence() {
  if (!taskSelect.value || showButton.disabled) return;
  // One request at a time: each view is recorded in the audit trail, so a double click must not
  // record two.
  showButton.disabled = true;
  const ticket = ++generation;
  try {
    const response = await authenticatedFetch(`/api/tasks/${encodeURIComponent(taskSelect.value)}/evidence`);
    const body = await response.json().catch(() => ({}));
    if (ticket !== generation) return;
    if (!response.ok) { shown = null; chain.replaceChildren(); setText(status, body.error || 'Evidence unavailable'); return; }
    shown = body.evidence;
    render(shown);
  } catch {
    if (ticket !== generation) return;
    shown = null;
    chain.replaceChildren();
    setText(status, 'Evidence unavailable');
  } finally {
    showButton.disabled = !taskSelect.value;
  }
}

function render(evidence) {

  const approved = step(1, 'Sender approved', 'Real identifiers. They stay inside the boundary.');
  approved.append(json({ taskId: evidence.taskId, ...evidence.approved }));

  const mapping = step(2, 'Private mapping', 'Fresh for this snapshot. Kept on the server, never sent to the model.');
  mapping.append(json(evidence.mapping));

  const sent = step(3, 'What the model received', 'Exactly what each adviser call was given, stored at the time of the call.');
  const answered = step(4, 'What the model answered', 'Validated answers, or the refusal when an answer failed validation.');
  if (!evidence.trail.length) {
    sent.append(element('p', 'evidence-note', t('No adviser call recorded for this delivery.')));
  }
  for (const entry of evidence.trail) {
    const clean = entry.realValuesInInput === 0;
    const row = element('div', 'evidence-call');
    const source = t(SOURCE_LABELS[entry.source] || 'Outlet not recorded');
    row.append(element('p', 'evidence-meta', `${t(entry.kind === 'route' ? 'Routing' : 'Follow-up')} · ${source} · ${when(entry.at)}`));
    row.append(json(entry.input));
    row.append(element('p', `pill ${clean ? 'allow' : 'deny'}`,
      clean ? t('Real identifiers in this input: none') : `${t('Real identifiers in this input')}: ${entry.realValuesInInput}`));
    sent.append(row);
    const outcome = element('div', 'evidence-call');
    outcome.append(element('p', 'evidence-meta', `${t(entry.kind === 'route' ? 'Routing' : 'Follow-up')} · ${source} · ${when(entry.at)}`));
    if (entry.answer) outcome.append(json(entry.answer));
    else outcome.append(element('p', 'pill deny', `${t('Refused')}: ${t(entry.refusal.reasonCode)}${entry.refusal.detail ? ' · ' + entry.refusal.detail : ''}`));
    answered.append(outcome);
  }

  const back = step(5, 'Mapped back by fixed code', 'The alias resolved to real recipients, and what actually happened to the key and the file.');
  if (!evidence.mappedBack.channel) {
    back.append(element('p', 'pill deny', t('Not routed: no validated route, so nothing was sent.')));
  }
  back.append(json({ channel: evidence.mappedBack.channel, recipients: evidence.mappedBack.recipients,
    keyReleases: evidence.keyReleases, receipts: evidence.receipts, status: evidence.status, reasonCode: evidence.reasonCode }));

  chain.replaceChildren(approved, mapping, sent, answered, back);
  setText(status, 'Evidence loaded.');
}

showButton.addEventListener('click', showEvidence);
window.addEventListener('languagechange', async () => {
  if (taskSelect.options.length) {
    const selected = taskSelect.value;
    await loadEvidenceTasks();
    if ([...taskSelect.options].some(option => option.value === selected)) taskSelect.value = selected;
  }
  if (shown) render(shown);
});
window.addEventListener('authenticationchange', clearEvidence);
