import { authenticatedFetch } from './auth.js';
import { setText, t } from './i18n.js';

export function initializeTaskHistory(onSelect, onRestore) {
  const refresh = document.querySelector('#refreshTasks');
  const select = document.querySelector('#taskHistory');
  const show = document.querySelector('#showTask');
  const resume = document.querySelector('#resumeTask');
  const check = document.querySelector('#checkTask');
  const restore = document.querySelector('#restoreDraft');
  const status = document.querySelector('#historyStatus');
  let entries = [];
  let generation = 0;
  const selected = () => entries[Number(select.value)];
  function update() {
    const entry = selected();
    show.disabled = !entry?.job;
    check.disabled = !entry?.job;
    resume.disabled = !entry?.job?.canRequestResume;
    restore.disabled = !entry?.task.hasFile || entry.snapshot.version !== entry.task.snapshots.at(-1).version;
  }
  function reset() {
    generation++; entries = []; select.replaceChildren(); update();
    setText(status, 'No tasks loaded');
  }
  async function reload() {
    reset();
    const current = generation;
    refresh.disabled = true;
    try {
      const response = await authenticatedFetch('/api/tasks');
      const body = await response.json();
      if (current !== generation) return;
      if (!response.ok) throw Error('Task history unavailable');
      for (const task of body.tasks) for (const snapshot of task.snapshots) {
        const job = task.jobs.find(item => item.version === snapshot.version);
        entries.push({ task, snapshot, job });
        const option = new Option('', String(entries.length - 1));
        setText(option, () => `${task.authorizationId} | ${task.id} | v${snapshot.version} | ${t(job?.status || snapshot.status)}`);
        select.append(option);
      }
      setText(status, entries.length ? 'Task history loaded' : 'No delivery task.'); update();
    } catch { if (current === generation) setText(status, 'Task history unavailable'); }
    finally { refresh.disabled = false; }
  }
  refresh.addEventListener('click', reload);
  select.addEventListener('change', update);
  show.addEventListener('click', () => { const entry = selected(); if (entry?.job) onSelect(entry.task.id, entry.snapshot.version); });
  restore.addEventListener('click', async () => {
    const entry = selected();
    if (!entry || restore.disabled) return;
    restore.disabled = true;
    try { await onRestore(entry.task.id, entry.snapshot.version); }
    catch (error) { setText(status, error.message); }
    finally { update(); }
  });
  resume.addEventListener('click', async () => {
    const entry = selected();
    if (!entry?.job?.canRequestResume) return;
    const current = generation; resume.disabled = true;
    try {
      const response = await authenticatedFetch('/api/tasks/' + entry.task.id + '/resume', { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: entry.snapshot.version, expectedRevision: entry.job.revision }) });
      if (current !== generation) return;
      if (!response.ok) throw Error('Resume rejected; refresh task');
      await reload();
      if (current + 1 === generation) onSelect(entry.task.id, entry.snapshot.version);
    } catch { if (current === generation) setText(status, 'Resume rejected; refresh task'); }
  });
  // Read only. The level and the sentence come from a fixed table, by code.
  check.addEventListener('click', async () => {
    const entry = selected();
    if (!entry?.job) return;
    const current = generation; check.disabled = true;
    try {
      const response = await authenticatedFetch('/api/tasks/status-check', { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ taskId: entry.task.id }) });
      const body = await response.json();
      if (current !== generation) return;
      if (!response.ok) throw Error('Status check unavailable');
      const mine = body.checks.find(item => item.version === entry.snapshot.version);
      if (!mine) throw Error('Status check unavailable');
      setText(status, () => `${t(mine.severity)}: ${t(mine.message)}`);
    } catch { if (current === generation) setText(status, 'Status check unavailable'); }
    finally { if (current === generation) update(); }
  });
  window.addEventListener('authenticationchange', reset);
  reset();
}
