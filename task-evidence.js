import { resolvePrivateRoute } from './private-mapping.js';

/**
 * The sender's evidence chain for one delivery: what they approved, the private mapping that stands
 * between them and the adviser, what each adviser call was actually given and what came of it, and
 * how fixed code mapped the outcome back to real recipients, keys and receipts.
 *
 * Every adviser input is checked here against the task's real identifiers, so the claim that the
 * model never sees them is computed from the stored inputs rather than asserted. Endpoint ids and
 * recipient aliases are left out: the sender does not need them to follow the chain.
 */
/**
 * How many real identifiers appear anywhere in an adviser input: in any key or string value, ignoring
 * case, whether whole or embedded in a longer string. Values shorter than six characters (group
 * codes, one-letter test ids) are only counted as whole strings, since a short value embedded in a
 * UUID or hash would be a coincidence rather than a leak. Vocabulary strings the projection is
 * meant to carry (the approved channel names) are only compared whole, so an id such as "internal"
 * is not counted inside "internal_queue".
 */
export function countRealValues(input, real, vocabulary = []) {
  const fixed = new Set(vocabulary.map(value => String(value).toLowerCase()));
  const seen = [];
  const collect = value => {
    if (typeof value === 'string' || typeof value === 'number') seen.push(String(value).toLowerCase());
    else if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) { seen.push(key.toLowerCase()); collect(item); }
    }
  };
  collect(input);
  return [...new Set(real.map(value => String(value).toLowerCase()))].filter(value =>
    seen.some(text => text === value || (value.length >= 6 && !fixed.has(text) && text.includes(value)))).length;
}

export function taskEvidence(task, version = task.jobs.at(-1)?.version) {
  const job = task.jobs.find(item => item.version === version);
  const snapshot = task.snapshots.find(item => item.version === version);
  if (!job || !snapshot?.privateMapping) return null;
  const { content, privateMapping: mapping } = snapshot;
  const real = [task.id, task.ownerId, task.grantId, content.documentHash, ...content.recipients,
    ...mapping.recipients.map(entry => entry.groupCode)].filter(Boolean);
  const trail = (job.adviceTrail || []).map(entry => ({ kind: entry.kind, at: entry.at, source: entry.source || null,
    input: entry.input, answer: entry.answer || null, refusal: entry.refusal || null,
    realValuesInInput: countRealValues(entry.input, real, content.channels) }));
  // Mapped back from the delivery fixed code actually prepared, not from the adviser's answer: a
  // ROUTE can still be stopped afterwards (authority reloaded, recipient disabled), and tasks
  // created before the trail existed have a delivery record but no trail.
  const channel = job.delivery?.status === 'DRY_RUN_PREPARED' ? job.delivery.channel : null;
  return {
    taskId: task.id, version, status: job.status, reasonCode: job.reasonCode || null,
    approved: { recipients: content.recipients, channels: content.channels, deliveryMode: content.deliveryMode,
      deliveryDeadline: content.deliveryDeadline, documentHash: content.documentHash },
    mapping: { taskAlias: mapping.taskAlias,
      recipients: mapping.recipients.map(entry => ({ recipientId: entry.recipientId, groupCode: entry.groupCode })) },
    trail,
    mappedBack: { channel, recipients: channel ? resolvePrivateRoute(mapping, content, channel)
      .map(route => ({ recipientId: route.recipientId, groupCode: route.groupCode })) : [] },
    keyReleases: (task.fileKeyReleases || []).filter(entry => entry.version === version)
      .map(entry => ({ recipientId: entry.subject, at: entry.at })),
    receipts: (task.fileReceipts || []).filter(entry => entry.version === version)
      .map(entry => ({ recipientId: entry.subject, code: entry.code, at: entry.reportedAt }))
  };
}
