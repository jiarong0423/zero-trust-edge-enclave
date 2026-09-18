// Synthetic v4 UUIDs; group 1/4 are scenario pairs, group 2/3 change one field.
export const fourGroupCases = [
  ['1-A', 'scenario', '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d', 1, ['email', 'internal_queue'], 'PENDING_CHECK', 0, 'ROUTE'],
  ['1-B', 'scenario', '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d', 1, ['email', 'internal_queue'], 'RETRY_WAIT', 1, 'PAUSE'],
  ['2-A', 'channel-order', '11a2b3c4-4d5e-4f7a-8b9c-0d1e2f3a4b5c', 2, ['email', 'internal_queue'], 'PENDING_CHECK', 0, 'ROUTE'],
  ['2-B', 'channel-order', '11a2b3c4-4d5e-4f7a-8b9c-0d1e2f3a4b5c', 2, ['internal_queue', 'email'], 'PENDING_CHECK', 0, 'ROUTE'],
  ['3-A', 'version-only', 'ffffffff-ffff-4fff-afff-ffffffffffff', 5, ['internal_queue', 'email'], 'PENDING_CHECK', 0, 'ROUTE'],
  ['3-B', 'version-only', 'ffffffff-ffff-4fff-afff-ffffffffffff', 9999, ['internal_queue', 'email'], 'PENDING_CHECK', 0, 'ROUTE'],
  ['4-A', 'scenario', '3c7a8d9e-0b1c-4d3e-8f5a-6b7c8d9e0f1a', 3, ['email', 'internal_queue'], 'PAUSED', 0, 'PAUSE'],
  ['4-B', 'scenario', '3c7a8d9e-0b1c-4d3e-8f5a-6b7c8d9e0f1a', 3, ['email', 'internal_queue'], 'OUTCOME_UNKNOWN', 2, 'PAUSE']
].map(([id, comparison, taskAlias, snapshotVersion, channels, state, attempts, expected]) => ({
  id, comparison, input: { taskAlias, snapshotVersion, channels, state, attempts }, expected,
  expectedOutput: { taskAlias, snapshotVersion, action: expected, channel: channels[0],
    reasonCode: expected === 'ROUTE' ? 'APPROVED_CHANNEL' : 'INSUFFICIENT_INFORMATION' }
}));
