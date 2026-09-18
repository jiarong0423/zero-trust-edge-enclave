import { setText, t } from './i18n.js';

export function createRecipientPicker(postJson, onEdit) {
  const grantInput = document.querySelector('#authorizationId');
  const load = document.querySelector('#loadRecipients');
  const department = document.querySelector('#recipientDepartment');
  const query = document.querySelector('#recipientQuery');
  const list = document.querySelector('#recipientList');
  const status = document.querySelector('#recipientSelectionStatus');
  let directory = null;
  let selected = new Set();
  let generation = 0;
  let locked = false;
  function render() {
    list.replaceChildren();
    const needle = query.value.trim().toLowerCase();
    for (const person of directory?.recipients || []) {
      const row = document.createElement('label');
      row.className = 'recipient-row';
      row.hidden = Boolean((department.value && person.department !== department.value) ||
        (needle && ![person.id, person.displayName, person.email || ''].some(value => value.toLowerCase().includes(needle))));
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
      name.textContent = `${person.displayName}${person.email ? ` (${person.email})` : ''}`;
      row.append(check, name);
      list.append(row);
    }
  }
  function renderCount() { setText(status, () => `${t('Selected recipients')}: ${selected.size}`); }
  function reset() {
    generation++;
    directory = null;
    selected.clear();
    department.replaceChildren();
    const option = new Option(t('All departments'), '');
    option.dataset.i18n = 'All departments';
    department.append(option);
    render();
    setText(status, 'Load authorized recipients');
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
  return {
    setBusy(value) {
      locked = value;
      for (const control of [load, department, query, ...list.querySelectorAll('input')]) control.disabled = value;
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
