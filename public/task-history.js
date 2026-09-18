import { authenticatedFetch } from './auth.js';
import { setText, t } from './i18n.js';

export function initializeTaskHistory(onSelect, onRestore) {
  const refresh = document.querySelector('#refreshTasks');
  const select = document.querySelector('#taskHistory');
  const show = document.querySelector('#showTask');
  const resume = document.querySelector('#resumeTask');
  const restore = document.querySelector('#restoreDraft');
  const status = document.querySelector('#historyStatus');
  let entries = [];
  let generation = 0;
  const selected = () => entries[Number(select.value)];
  function update() {
    const entry = selected();
    show.disabled = !entry?.job;
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
  window.addEventListener('authenticationchange', reset);
  reset();
}
