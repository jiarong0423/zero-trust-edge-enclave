import { setText, t } from './i18n.js';
import { recipientLabel, sharesChineseName } from './recipient-label.js';
import { classifyNote } from './note-classify.js';

export function createRecipientPicker(postJson, onEdit) {
  const grantInput = document.querySelector('#authorizationId');
  const load = document.querySelector('#loadRecipients');
  const department = document.querySelector('#recipientDepartment');
  const query = document.querySelector('#recipientQuery');
  const list = document.querySelector('#recipientList');
  const status = document.querySelector('#recipientSelectionStatus');
  const findName = document.querySelector('#findNameZh');
  const findId = document.querySelector('#findEmployeeId');
  const findButton = document.querySelector('#findRecipient');
  const findStatus = document.querySelector('#findStatus');
  const findCandidates = document.querySelector('#findCandidates');
  const noteInput = document.querySelector('#senderNote');
  const readNote = document.querySelector('#readNote');
  const rankInput = document.querySelector('#rankText');
  const rankButton = document.querySelector('#rankRecipients');
  let directory = null;
  let rankOrder = null;
  let selected = new Set();
  let generation = 0;
  let locked = false;
  function render() {
    list.replaceChildren();
    const needle = query.value.trim().toLowerCase();
    const position = new Map((rankOrder || []).map((id, index) => [id, index]));
    const people = [...(directory?.recipients || [])];
    if (rankOrder) people.sort((a, b) => (position.get(a.id) ?? 1e9) - (position.get(b.id) ?? 1e9));
    for (const person of people) {
      const row = document.createElement('label');
      row.className = 'recipient-row';
      row.hidden = Boolean((department.value && person.department !== department.value) ||
        (needle && ![person.id, person.displayName, person.nameZh || '', person.email || ''].some(value => value.toLowerCase().includes(needle))));
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.checked = selected.has(person.id);
      check.disabled = locked;
      check.addEventListener('change', () => {
        if (check.checked) selected.add(person.id); else selected.delete(person.id);
        onEdit();
        renderCount();
      });
      const name = document.createElement('span');
      name.textContent = recipientLabel(person);
      row.append(check, name);
      if (sharesChineseName(person, directory.recipients)) {
        const warning = document.createElement('strong');
        warning.className = 'same-name';
        setText(warning, ' Same name as another person: check the employee number');
        row.append(warning);
      }
      list.append(row);
    }
  }
  function renderCount() { setText(status, () => `${t('Selected recipients')}: ${selected.size}`); }
  function reset() {
    generation++;
    directory = null;
    rankOrder = null;
    selected.clear();
    department.replaceChildren();
    const option = new Option(t('All departments'), '');
    option.dataset.i18n = 'All departments';
    department.append(option);
    render();
    setText(status, 'Load authorized recipients');
    findCandidates.replaceChildren();
    findStatus.textContent = '';
    onEdit();
  }
  grantInput.addEventListener('input', reset);
  window.addEventListener('authenticationchange', reset);
  department.addEventListener('change', render);
  query.addEventListener('input', render);
  load.addEventListener('click', async () => {
    reset();
    const requestGeneration = generation;
    const authorizationId = grantInput.value.trim();
    load.disabled = true;
    try {
      const result = await postJson('/api/directory', { authorizationId });
      if (generation !== requestGeneration || authorizationId !== grantInput.value.trim()) return;
      directory = result;
      for (const name of result.departments) {
        const option = new Option('', name);
        setText(option, result.departmentLabels?.[name] || name);
        department.append(option);
      }
      render();
      renderCount();
    } catch (error) {
      if (generation === requestGeneration) setText(status, error.message);
    } finally { load.disabled = locked; }
  });
  // The note is read here and goes nowhere: only the fields it fills in are ever sent. Nobody is selected.
  readNote.addEventListener('click', () => {
    findCandidates.replaceChildren();
    if (!directory) { setText(findStatus, 'Load authorized recipients'); return; }
    const departments = (directory.departments || []).map(id => ({ id, displayName: directory.departmentLabels?.[id] || id }));
    const found = classifyNote(noteInput.value, directory.recipients, departments);
    const filled = [];
    if (found.department && [...department.options].some(option => option.value === found.department)) {
      department.value = found.department; filled.push('department');
    }
    if (found.nameZh) { findName.value = found.nameZh; filled.push('name'); }
    if (found.employeeId) { findId.value = found.employeeId; filled.push('employee number'); }
    if (found.surname && !found.nameZh) { query.value = found.surname; filled.push('list narrowed by surname'); }
    render();
    if (found.departmentAmbiguous) { setText(findStatus, 'The note names more than one department; choose one.'); return; }
    setText(findStatus, () => filled.length
      ? `${t('Filled from the note')}: ${filled.map(item => t(item)).join(', ')}. ${t('Check, then press Find and select.')}`
      : t('Nothing in the note matched this authorization.'));
  });
  // Display order only. The text typed here is sent to this server for ranking and is not the note;
  // nobody is selected and the matching rule is not involved.
  rankButton.addEventListener('click', async () => {
    const requestGeneration = generation;
    const authorizationId = grantInput.value.trim();
    if (!directory) { setText(findStatus, 'Load authorized recipients'); return; }
    const text = rankInput.value.trim();
    if (!text) { rankOrder = null; render(); setText(findStatus, 'Fixed order restored.'); return; }
    const question = { authorizationId, text };
    if (department.value) question.department = department.value;
    rankButton.disabled = true;
    try {
      const result = await postJson('/api/directory/rank', question);
      if (generation !== requestGeneration || authorizationId !== grantInput.value.trim()) return;
      rankOrder = result.order;
      render();
      setText(findStatus, result.method === 'vector' ? 'Sorted by similarity (model on this machine).'
        : 'Similarity sorting is off or unavailable; showing the fixed order.');
    } catch (error) {
      if (generation === requestGeneration) setText(findStatus, error.message);
    } finally { rankButton.disabled = locked; }
  });
  findButton.addEventListener('click', async () => {
    const requestGeneration = generation;
    const authorizationId = grantInput.value.trim();
    findCandidates.replaceChildren();
    if (!directory || directory.authorizationId === undefined) { setText(findStatus, 'Load authorized recipients'); return; }
    const question = { authorizationId };
    if (findName.value.trim()) question.nameZh = findName.value.trim();
    if (findId.value.trim()) question.employeeId = findId.value.trim();
    if (department.value) question.department = department.value;
    findButton.disabled = true;
    try {
      const result = await postJson('/api/directory/resolve', question);
      if (generation !== requestGeneration || authorizationId !== grantInput.value.trim()) return;
      if (result.status === 'MATCHED') {
        const label = recipientLabel(result.person);
        // CONFIRM selects. Anything else (the name was not checked, or the second opinion disagreed)
        // leaves the choice to the sender, with the person shown and a button to take them.
        if (result.review?.final === 'CONFIRM') {
          selected.add(result.person.id);
          render(); renderCount(); onEdit();
          setText(findStatus, () => `${t('Selected')}: ${label}`);
          return;
        }
        setText(findStatus, () => `${t(result.nameVerified ? 'Please confirm this person' : 'Selected by employee number; the name on record is')}: ${label}`);
        const item = document.createElement('li');
        const take = document.createElement('button');
        take.type = 'button';
        take.className = 'button';
        setText(take, 'Select this person');
        take.addEventListener('click', () => {
          selected.add(result.person.id);
          render(); renderCount(); onEdit();
          findCandidates.replaceChildren();
          setText(findStatus, () => `${t('Selected')}: ${label}`);
        });
        item.append(take);
        findCandidates.append(item);
        return;
      }
      setText(findStatus, () => `${t(result.message)} (${t('Attempts left')}: ${result.attemptsLeft})`);
      for (const person of result.candidates) {
        const item = document.createElement('li');
        const choose = document.createElement('button');
        choose.type = 'button';
        choose.className = 'button';
        choose.textContent = recipientLabel(person);
        choose.addEventListener('click', () => { findId.value = person.id; findId.focus(); });
        item.append(choose);
        findCandidates.append(item);
      }
    } catch (error) {
      if (generation !== requestGeneration) return;
      setText(findStatus, error.message === 'MATCH_QUARANTINED' ? 'Matching is locked after repeated failures. Ask an administrator to unlock it.' : error.message);
    } finally { findButton.disabled = locked; }
  });
  return {
    setBusy(value) {
      locked = value;
      for (const control of [load, department, query, findName, findId, findButton, noteInput, readNote, rankInput, rankButton, ...list.querySelectorAll('input')]) control.disabled = value;
    },
    selection(grant) {
      if (!directory || directory.authorizationId !== grant.id || directory.authorizationVersion !== grant.version) {
        throw new Error('Reload authorized recipients');
      }
      const ids = [...selected].sort();
      if (!ids.length || ids.some(id => !grant.recipients.includes(id))) throw new Error('Select authorized recipients');
      return ids;
    }
  };
}
