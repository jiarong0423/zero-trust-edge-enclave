import { authenticatedFetch } from './auth.js';
import { setText, initializeLanguage, t } from './i18n.js';

const get = id => document.getElementById(id);
const category = get('adminCategory'), record = get('adminRecord'), fields = get('adminFields');
let directory = null, generation = 0, credentialUrl = null, busy = false;
const items = () => directory[category.value === 'department' ? 'departments' : category.value === 'person' ? 'principals' : 'grants'];
const current = () => items().find(item => item.id === record.value);
function clearCredential() {
  if (credentialUrl) URL.revokeObjectURL(credentialUrl);
  credentialUrl = null; get('downloadCredential').hidden = true; get('downloadCredential').removeAttribute('href');
}
function control(name, label, type, value, options = []) {
  const wrapper = document.createElement('label'); wrapper.className = 'field';
  const title = document.createElement('span'); setText(title, label); wrapper.append(title);
  const input = document.createElement(type === 'select' ? 'select' : 'input');
  input.name = name; input.id = 'admin-' + name;
  if (type === 'select') for (const item of options) {
    const option = new Option('', item.id); setText(option, item.displayName || item.id); input.append(option);
  }
  else input.type = type;
  if (type === 'checkbox') input.checked = Boolean(value);
  else { input.value = value ?? ''; input.required = !['email', 'displayName'].includes(name); }
  if (type === 'text') input.maxLength = name === 'id' ? 64 : 128;
  if (name === 'id') { input.pattern = '[a-zA-Z0-9_-]{1,64}'; input.readOnly = Boolean(current()); }
  if (type === 'number') { input.min = '1'; input.max = name === 'maxAttempts' ? '5' : '10'; input.step = '1'; }
  wrapper.append(input); fields.append(wrapper);
  return input;
}
function choices(name, label, options, selected) {
  const group = document.createElement('fieldset'); group.className = 'admin-choices';
  const legend = document.createElement('legend'); setText(legend, label); group.append(legend);
  for (const item of options) {
    const row = document.createElement('label'), check = document.createElement('input'), text = document.createElement('span');
    row.className = 'admin-choice'; check.type = 'checkbox'; check.name = name; check.value = item.id;
    check.checked = selected.includes(item.id); text.textContent = item.displayName || item.id;
    row.append(check, text); group.append(row);
  }
  fields.append(group);
}
function renderForm() {
  fields.replaceChildren();
  const selected = current(), item = selected || {};
  const kind = category.value;
  control('id', 'Code', 'text', item.id);
  if (kind === 'department') {
    control('displayName', 'Name', 'text', item.displayName).required = true;
    control('disabled', 'Disabled', 'checkbox', item.disabled);
  } else if (kind === 'person') {
    if (!selected) control('kind', 'Identity type', 'select', 'recipient', ['recipient', 'operator', 'coordinator'].map(id => ({ id })));
    control('department', 'Department', 'select', item.department || directory.departments[0]?.id, directory.departments);
    control('displayName', 'Name', 'text', item.displayName);
    control('email', 'Email', 'email', item.email);
    control('disabled', 'Disabled', 'checkbox', item.disabled);
  } else {
    control('operatorId', 'Sender', 'select', item.operatorId, directory.principals.filter(p => p.kind === 'operator'));
    control('coordinatorId', 'Coordinator', 'select', item.coordinatorId, directory.principals.filter(p => p.kind === 'coordinator'));
    choices('recipients', 'Recipients', directory.principals.filter(p => p.kind === 'recipient'), item.recipients || []);
    choices('channels', 'Channels', ['email', 'internal_queue'].map(id => ({ id })), item.channels || []);
    control('expiresAt', 'Authorization expiry UTC', 'text', item.expiresAt);
    control('maxAttempts', 'Maximum attempts', 'number', item.maxAttempts ?? 3);
    control('maxOpens', 'Maximum key releases', 'number', item.maxOpens ?? 2);
    control('revoked', 'Revoked', 'checkbox', item.revoked);
  }
  const protectedAdmin = selected?.kind === 'administrator';
  fields.disabled = busy || protectedAdmin;
  get('adminForm').querySelector('[type=submit]').disabled = busy || protectedAdmin;
  get('rotateCredential').hidden = kind !== 'person' || !selected || protectedAdmin;
}
function render() {
  const previous = record.value;
  record.replaceChildren();
  const option = new Option('', ''); setText(option, 'New record'); record.append(option);
  for (const item of items()) record.append(new Option(item.displayName ? `${item.id} | ${item.displayName}` : item.id, item.id));
  if (items().some(item => item.id === previous)) record.value = previous;
  get('adminRows').replaceChildren();
  for (const item of items()) {
    const row = document.createElement('tr');
    for (const [index, value] of [item.id, item.displayName || '-', item.department || '-', item.disabled || item.revoked ? 'Yes' : 'No'].entries()) {
      const cell = document.createElement('td');
      if (index === 3) setText(cell, value); else cell.textContent = value;
      row.append(cell);
    }
    get('adminRows').append(row);
  }
  renderForm();
}
function setBusy(value) {
  busy = value;
  for (const element of [category, record, get('loadDirectory'), get('rotateCredential')]) element.disabled = value;
  fields.disabled = value || currentAdminProtected();
  get('adminForm').querySelector('[type=submit]').disabled = fields.disabled;
}
function currentAdminProtected() { return Boolean(directory && current()?.kind === 'administrator'); }
async function request(body) {
  const response = await authenticatedFetch('/api/admin/directory', body ? { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const result = await response.json();
  if (!response.ok) throw Error(result.error || 'Administration unavailable');
  return result;
}
async function load() {
  clearCredential(); const epoch = ++generation; setBusy(true);
  try {
    const result = await request();
    if (epoch !== generation) return;
    directory = result; get('adminWorkspace').hidden = false; render();
    setText(get('adminStatus'), () => `${t('Registry revision')}: ${directory.revision}`);
  } catch (error) {
    if (epoch === generation) { directory = null; get('adminWorkspace').hidden = true; setText(get('adminStatus'), error.message); }
  } finally { if (epoch === generation) setBusy(false); }
}
async function mutate(operation, value) {
  if (busy || !directory) return;
  clearCredential(); const epoch = generation; const revision = directory.revision; setBusy(true);
  try {
    const result = await request({ expectedRevision: revision, operation, value });
    if (epoch !== generation) return;
    if (result.credential) {
      credentialUrl = URL.createObjectURL(new Blob([result.credential], { type: 'application/octet-stream' }));
      get('downloadCredential').href = credentialUrl;
      get('downloadCredential').download = value.id + '.token';
      get('downloadCredential').hidden = false;
      delete result.credential;
    }
    directory = result; render();
    setText(get('adminStatus'), () => `${t('Changes saved')} | ${t('Registry revision')}: ${directory.revision}`);
  } catch (error) { if (epoch === generation) setText(get('adminStatus'), error.message); }
  finally { if (epoch === generation) setBusy(false); }
}
get('adminForm').addEventListener('submit', event => {
  event.preventDefault();
  const data = new FormData(event.target), value = Object.fromEntries(data);
  if (category.value === 'grant') {
    value.recipients = data.getAll('recipients'); value.channels = data.getAll('channels');
    value.maxAttempts = Number(value.maxAttempts); value.maxOpens = Number(value.maxOpens); value.revoked = data.has('revoked');
  } else {
    value.disabled = data.has('disabled');
    if (category.value === 'person') {
      if (!value.displayName) delete value.displayName;
      if (!value.email) value.email = null;
    }
  }
  void mutate(category.value + (current() ? '.update' : '.create'), value);
});
get('rotateCredential').addEventListener('click', () => { if (current()) void mutate('person.rotate', { id: current().id }); });
get('loadDirectory').addEventListener('click', load);
get('loadRetention').addEventListener('click', async () => {
  const epoch = generation;
  get('loadRetention').disabled = true;
  get('retentionRows').replaceChildren();
  try {
    const response = await authenticatedFetch('/api/admin/retention');
    const body = await response.json();
    if (epoch !== generation) return;
    if (!response.ok) throw Error('Administrator required');
    for (const item of body.items) {
      const row = document.createElement('tr');
      const id = document.createElement('td'); id.textContent = item.taskId; row.append(id);
      const state = document.createElement('td'); setText(state, item.state); row.append(state);
      const reasons = document.createElement('td'); setText(reasons, () => item.reasons.map(code => t(code)).join(' / ')); row.append(reasons);
      get('retentionRows').append(row);
    }
    setText(get('retentionStatus'), 'Inventory only; no automatic deletion');
  } catch (error) { if (epoch === generation) setText(get('retentionStatus'), error.message); }
  finally { get('loadRetention').disabled = false; }
});
category.addEventListener('change', () => { record.value = ''; render(); });
record.addEventListener('change', renderForm);
window.addEventListener('authenticationchange', () => {
  generation++; directory = null; clearCredential(); get('adminWorkspace').hidden = true; fields.replaceChildren();
  get('retentionRows').replaceChildren(); setText(get('retentionStatus'), '');
  get('adminRows').replaceChildren(); setText(get('adminStatus'), ''); setBusy(false);
});
window.addEventListener('pagehide', clearCredential);
initializeLanguage();
