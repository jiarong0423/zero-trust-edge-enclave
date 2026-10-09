import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Consecutive failed recipient matches, counted per (sender, authorization). After `limit` in a row
// the pair is quarantined: matching is refused until an administrator unlocks it, so a run of wrong
// guesses stops at a person instead of continuing as a search through the directory. A match that
// succeeds resets the count. Fixed code counts and decides; no model is involved.
//
// The state lives in its own small file and is not part of the all-or-nothing array store: a data
// directory made before this file existed keeps starting normally (a missing file means "no entries").
// A file that exists but cannot be read or understood stops matching altogether (fail closed).
export const MATCH_FAILURE_LIMIT = 3;
const unavailable = () => Object.assign(new Error('MATCH_GUARD_UNAVAILABLE'), { status: 503 });
const keyOf = (operatorId, grantId) => `${operatorId}|${grantId}`;

export function createMatchGuard(file, limit = MATCH_FAILURE_LIMIT) {
  async function load() {
    let text;
    try { text = await fs.readFile(file, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return new Map(); throw unavailable(); }
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw unavailable(); }
    if (!Array.isArray(parsed)) throw unavailable();
    const entries = new Map();
    for (const item of parsed) {
      if (!item || typeof item.operatorId !== 'string' || typeof item.grantId !== 'string' ||
          !Number.isSafeInteger(item.fails) || item.fails < 0 || typeof item.quarantined !== 'boolean') throw unavailable();
      entries.set(keyOf(item.operatorId, item.grantId), { operatorId: item.operatorId, grantId: item.grantId,
        fails: item.fails, quarantined: item.quarantined, since: typeof item.since === 'string' ? item.since : null });
    }
    return entries;
  }

  async function save(entries) {
    const temp = path.join(path.dirname(file), '.' + path.basename(file) + '.' + crypto.randomUUID() + '.tmp');
    try {
      await fs.writeFile(temp, JSON.stringify([...entries.values()], null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      await fs.rename(temp, file);
    } catch { await fs.rm(temp, { force: true }).catch(() => {}); throw unavailable(); }
  }

  return {
    limit,
    async status(operatorId, grantId) {
      const entry = (await load()).get(keyOf(operatorId, grantId));
      return { fails: entry?.fails || 0, quarantined: Boolean(entry?.quarantined) };
    },
    // Call once per answered match attempt. Returns the state after it and whether this very call
    // tipped the pair into quarantine.
    async record(operatorId, grantId, success, now = Date.now()) {
      const entries = await load();
      const key = keyOf(operatorId, grantId);
      const before = entries.get(key) || { operatorId, grantId, fails: 0, quarantined: false, since: null };
      if (before.quarantined) return { fails: before.fails, quarantined: true, justQuarantined: false };
      if (success) {
        if (before.fails) { entries.delete(key); await save(entries); }
        return { fails: 0, quarantined: false, justQuarantined: false };
      }
      const fails = before.fails + 1;
      const quarantined = fails >= limit;
      entries.set(key, { operatorId, grantId, fails, quarantined, since: quarantined ? new Date(now).toISOString() : null });
      await save(entries);
      return { fails, quarantined, justQuarantined: quarantined };
    },
    async unlock(operatorId, grantId) {
      const entries = await load();
      const existed = entries.get(keyOf(operatorId, grantId))?.quarantined === true;
      if (entries.delete(keyOf(operatorId, grantId))) await save(entries);
      return existed;
    },
    // For the administrator's view: only pairs that carry a count or a lock.
    async list() {
      return [...(await load()).values()].map(({ operatorId, grantId, fails, quarantined, since }) =>
        ({ operatorId, grantId, fails, quarantined, since }));
    }
  };
}
