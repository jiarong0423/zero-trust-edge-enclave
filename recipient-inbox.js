// The deliveries that were approved for one recipient, so a person who has been approved can find them without
// having been handed a link. It is built only from state the server already holds and returns only what the
// recipient needs to open the delivery:
//  - nothing about the file (no name, no hash, no key material), and nothing about anyone else on the delivery;
//  - the sending department, not the sender's name;
//  - only deliveries whose approved snapshot lists this recipient.
// Read only. Opening a delivery still goes through the same checks as a link: the recipient must be on the
// snapshot, the delivery must be unrevoked and unexpired, and a key is released to that recipient alone.
export const INBOX_LIMIT = 50;

// A delivery stops being openable when its own expiry passes, and also when the authorization it was approved under has been
// changed (its version moved on), revoked or has itself expired: the file route refuses those, so the inbox must not offer them.
const stateOf = (snapshot, grant, received, now) => {
  if (snapshot.revokedAt) return 'REVOKED';
  if (Date.parse(snapshot.content.expiresAt) <= now) return 'EXPIRED';
  if (grant !== undefined && (!grant || grant.revoked || snapshot.grantVersion !== grant.version || Date.parse(grant.expiresAt) <= now)) return 'EXPIRED';
  if (received.acknowledged) return 'RECEIVED';
  if (received.downloaded) return 'DOWNLOADED';
  return 'WAITING';
};

export function buildInbox(tasks, config, principal, now = Date.now()) {
  if (principal.kind !== 'recipient') return [];
  const departments = new Map((config.departments || []).map(item => [item.id, item.displayName || item.id]));
  const owners = new Map(config.principals.map(person => [person.id, person]));
  const grants = Array.isArray(config.grants) ? new Map(config.grants.map(item => [item.id, item])) : null;
  const items = [];
  for (const task of tasks) {
    if (!task?.file) continue;
    const from = owners.get(task.ownerId)?.department;
    for (const snapshot of task.snapshots || []) {
      if (snapshot.status !== 'APPROVED' || !snapshot.content?.recipients?.includes(principal.id)) continue;
      const reported = code => (task.fileReceipts || []).some(entry => entry.version === snapshot.version &&
        entry.subject === principal.id && entry.code === code && entry.evidence === 'CLIENT_REPORTED');
      const released = (task.fileKeyReleases || []).some(entry => entry.version === snapshot.version && entry.subject === principal.id);
      items.push({ id: task.id, version: snapshot.version,
        fromDepartment: from ? departments.get(from) || from : null,
        approvedAt: snapshot.approvedAt || null, expiresAt: snapshot.content.expiresAt,
        state: stateOf(snapshot, grants ? grants.get(task.grantId) || null : undefined, { acknowledged: released && reported('ACKNOWLEDGED'),
          downloaded: released && (reported('DOWNLOAD_REQUESTED') || reported('FILE_VERIFIED')) }, now) });
    }
  }
  return items.sort((a, b) => String(b.approvedAt).localeCompare(String(a.approvedAt))).slice(0, INBOX_LIMIT);
}
