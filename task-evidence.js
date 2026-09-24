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
export function taskEvidence(task, version = task.jobs.at(-1)?.version) {
  const job = task.jobs.find(item => item.version === version);
  const snapshot = task.snapshots.find(item => item.version === version);
  if (!job || !snapshot?.privateMapping) return null;
  const { content, privateMapping: mapping } = snapshot;
  const real = [task.id, content.documentHash, ...content.recipients,
    ...mapping.recipients.map(entry => entry.groupCode)].filter(Boolean);
  const trail = (job.adviceTrail || []).map(entry => {
    const sent = JSON.stringify(entry.input);
    return { kind: entry.kind, at: entry.at, input: entry.input,
      answer: entry.answer || null, refusal: entry.refusal || null,
      realValuesInInput: real.filter(value => sent.includes(JSON.stringify(value))).length };
  });
  const channel = [...trail].reverse().find(entry => entry.kind === 'route' && entry.answer)?.answer.channel
    || content.channels[0];
  return {
    taskId: task.id, version, status: job.status, reasonCode: job.reasonCode || null,
    approved: { recipients: content.recipients, channels: content.channels, deliveryMode: content.deliveryMode,
      deliveryDeadline: content.deliveryDeadline, documentHash: content.documentHash },
    mapping: { taskAlias: mapping.taskAlias,
      recipients: mapping.recipients.map(entry => ({ recipientId: entry.recipientId, groupCode: entry.groupCode })) },
    trail,
    mappedBack: { channel, recipients: resolvePrivateRoute(mapping, content, channel)
      .map(route => ({ recipientId: route.recipientId, groupCode: route.groupCode })) },
    keyReleases: (task.fileKeyReleases || []).filter(entry => entry.version === version)
      .map(entry => ({ recipientId: entry.subject, at: entry.at })),
    receipts: (task.fileReceipts || []).filter(entry => entry.version === version)
      .map(entry => ({ recipientId: entry.subject, code: entry.code, at: entry.reportedAt }))
  };
}
