import { exact, fail } from './access-control.js';
import { checkPrivateMapping } from './private-mapping.js';

// The adviser decides on state and attempts alone. Recipient codes exist in the mapping layer for
// the sender UI, receipts and audit, and are deliberately kept out of this projection: they would
// add nothing to the routing decision while revealing how many approved recipients each group holds.
export function fileRoutingMetadata(snapshot, job) {
  checkPrivateMapping(snapshot.privateMapping, snapshot.privateMapping.taskId, snapshot.version, snapshot.content);
  return { taskAlias: snapshot.privateMapping.taskAlias, snapshotVersion: snapshot.version,
    channels: [...snapshot.content.channels],
    state: ['PENDING_CHECK', 'RETRY_WAIT', 'DRY_RUN_PREPARED', 'PAUSED', 'OUTCOME_UNKNOWN'].includes(job.status)
      ? job.status : 'PAUSED',
    attempts: Number.isSafeInteger(job.attempts) && job.attempts >= 0 ? job.attempts : 0 };
}

export function validateFileAdvice(advice, metadata) {
  exact(advice, ['taskAlias', 'snapshotVersion', 'action', 'channel', 'reasonCode']);
  if (advice.taskAlias !== metadata.taskAlias || advice.snapshotVersion !== metadata.snapshotVersion ||
      !['ROUTE', 'PAUSE'].includes(advice.action) || !metadata.channels.includes(advice.channel) ||
      !['APPROVED_CHANNEL', 'RETRY_ALTERNATIVE', 'INSUFFICIENT_INFORMATION'].includes(advice.reasonCode)) {
    fail('FILE_ROUTE_ADVICE_REJECTED', 422);
  }
  return { taskAlias: advice.taskAlias, snapshotVersion: advice.snapshotVersion,
    action: advice.action, channel: advice.channel, reasonCode: advice.reasonCode };
}

// A deterministic local test adviser, not evidence of a model inference.
export function syntheticFileAdvice(metadata) {
  const retry = metadata.state === 'RETRY_WAIT';
  return { taskAlias: metadata.taskAlias, snapshotVersion: metadata.snapshotVersion,
    action: 'ROUTE', channel: metadata.channels[retry && metadata.channels.length > 1 ? 1 : 0],
    reasonCode: retry ? 'RETRY_ALTERNATIVE' : 'APPROVED_CHANNEL' };
}
