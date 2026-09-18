const types = new Set(['PACKAGE_CREATED', 'EMAIL_DRY_RUN_PREPARED', 'TIMED_CREDENTIAL_ISSUED', 'DECODE_ATTEMPT', 'PACKAGE_REVOKED', 'SNAPSHOT_TRANSITION', 'REQUEST_REJECTED', 'DELIVERY_TRANSITION', 'DELIVERY_FOLLOWUP']);
const states = new Set(['DRAFT', 'LOCKED', 'INVALIDATED', 'APPROVED', 'REVOKED', 'PENDING_CHECK', 'RETRY_WAIT', 'DRY_RUN_PREPARED', 'PAUSED', 'OUTCOME_UNKNOWN']);
const results = new Set(['INFO', 'ALLOW', 'DENY']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const reasons = new Map([
  ['invalid credential format', 'INVALID_CREDENTIAL'],
  ['invalid credential signature', 'INVALID_SIGNATURE'],
  ['invalid credential type', 'INVALID_CREDENTIAL'],
  ['credential subject mismatch', 'SUBJECT_MISMATCH'],
  ['authorization version mismatch', 'VERSION_MISMATCH'],
  ['credential already used', 'REPLAY_REJECTED'],
  ['invalid credential expiry', 'INVALID_EXPIRY'],
  ['package revoked', 'REVOKED'],
  ['credential package mismatch', 'PACKAGE_MISMATCH'],
  ['credential package hash mismatch', 'INTEGRITY_MISMATCH'],
  ['credential policy hash mismatch', 'POLICY_MISMATCH'],
  ['credential revocation version mismatch', 'VERSION_MISMATCH'],
  ['credential expired', 'CREDENTIAL_EXPIRED'],
  ['policy expired', 'POLICY_EXPIRED'],
  ['open count limit reached', 'OPEN_LIMIT'],
  ['recipient role not allowed', 'RECIPIENT_DENIED'],
  ['managed device claim required', 'DEVICE_DENIED'],
  ['credential signature accepted', 'SIGNATURE_ACCEPTED'],
  ['recipient role accepted', 'RECIPIENT_ACCEPTED'],
  ['registered recipient accepted; no device attestation', 'REGISTERED_RECIPIENT'],
  ['time window accepted', 'TIME_ACCEPTED']
]);
const codes = new Set([...reasons.values(), 'UNCLASSIFIED', 'STATE_CHANGED', 'ACCESS_DENIED', 'INVALID_REQUEST', 'STATE_CONFLICT', 'SERVICE_UNAVAILABLE', 'DELIVERY_UPDATED', 'CLIENT_DOWNLOAD_REPORTED']);
for (const code of ['AUTHORIZATION_INVALID', 'ACTOR_DISABLED', 'SNAPSHOT_INVALID', 'PACKET_CHANGED',
  'RECIPIENT_ACKNOWLEDGED', 'CLIENT_FILE_VERIFIED', 'DELIVERY_OVERDUE',
  'ADVISER_UNAVAILABLE', 'ADVICE_INVALID', 'ADVICE_PAUSED', 'RECIPIENT_DISABLED',
  'DELIVERY_CONFIGURATION_INVALID', 'RETRY_EXHAUSTED', 'DELIVERY_WINDOW_CLOSED', 'OUTCOME_UNKNOWN', 'RESUME_VALIDATED',
  'FOLLOWUP_WAIT', 'FOLLOWUP_REMIND', 'FOLLOWUP_ESCALATE', 'FOLLOWUP_METADATA_INVALID']) codes.add(code);

// Construct a new record; never spread caller data into stored or exposed audit events.
export function auditProjection(event) {
  return {
    packageId: uuid.test(event.packageId) ? event.packageId : null,
    taskId: uuid.test(event.taskId) ? event.taskId : null,
    snapshotVersion: Number.isSafeInteger(event.snapshotVersion) && event.snapshotVersion > 0 ? event.snapshotVersion : null,
    previousState: states.has(event.previousState) ? event.previousState : null,
    nextState: states.has(event.nextState) ? event.nextState : null,
    attempts: Number.isSafeInteger(event.attempts) && event.attempts >= 0 && event.attempts <= 5 ? event.attempts : null,
    type: types.has(event.type) ? event.type : 'UNKNOWN_EVENT',
    result: results.has(event.result) ? event.result : 'DENY',
    reasons: [...new Set((Array.isArray(event.reasons) ? event.reasons : []).slice(0, 16)
      .map(value => reasons.get(value) || (codes.has(value) ? value : 'UNCLASSIFIED')))],
    createdAt: typeof event.createdAt === 'string' && Number.isFinite(Date.parse(event.createdAt))
      ? new Date(event.createdAt).toISOString() : null
  };
}
