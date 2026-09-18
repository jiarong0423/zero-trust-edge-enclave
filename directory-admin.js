import crypto from 'node:crypto';
import { exact, fail, validateAccess } from './access-control.js';
import { principalEnabled } from './registry-schema.js';

export function requireAdministrator(config, actor) {
  const current = config.principals.find(person => person.id === actor?.id);
  if (current?.kind !== 'administrator' || !principalEnabled(config, current)) fail('Administrator required');
}

export function adminDirectory(config, actor) {
  requireAdministrator(config, actor);
  return { revision: config.revision || 1, departments: config.departments,
    principals: config.principals.map(person => ({ id: person.id, kind: person.kind,
      department: person.department, displayName: person.displayName || person.id,
      email: person.email || null, disabled: Boolean(person.disabled) })),
    grants: config.grants.map(grant => ({ id: grant.id, version: grant.version, operatorId: grant.operatorId,
      coordinatorId: grant.coordinatorId, recipients: grant.recipients, channels: grant.channels,
      expiresAt: grant.expiresAt, maxAttempts: grant.maxAttempts, maxOpens: grant.maxOpens, revoked: Boolean(grant.revoked) })),
    events: config.directoryEvents || [] };
}

// Only explicit IDs are authorized. Department edits never expand a grant's recipient list.
export function changeDirectory(original, actor, input, now = Date.now()) {
  requireAdministrator(original, actor);
  exact(input, ['expectedRevision', 'operation', 'value']);
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision !== (original.revision || 1)) {
    fail('DIRECTORY_REVISION_CONFLICT', 409);
  }
  const next = structuredClone(original);
  next.schemaVersion = 2;
  next.revision = input.expectedRevision + 1;
  if (!Number.isSafeInteger(next.revision)) fail('DIRECTORY_REVISION_LIMIT', 409);
  const value = input.value;
  const changedPeople = new Set();
  const changedGrants = new Set();
  let credential = null;
  if (input.operation === 'department.create' || input.operation === 'department.update') {
    exact(value, ['id', 'displayName', 'disabled']);
    const index = next.departments.findIndex(item => item.id === value.id);
    if (input.operation === 'department.create') {
      if (index !== -1) fail('DEPARTMENT_EXISTS', 409);
      next.departments.push({ ...value, disabled: value.disabled ?? false });
    } else {
      if (index === -1) fail('DEPARTMENT_NOT_FOUND', 404);
      next.departments[index] = { ...next.departments[index], ...value };
      for (const person of next.principals) if (person.department === value.id) changedPeople.add(person.id);
    }
  } else if (['person.create', 'person.update', 'person.rotate'].includes(input.operation)) {
    exact(value, input.operation === 'person.create' ? ['id', 'kind', 'department', 'displayName', 'email', 'disabled']
      : input.operation === 'person.rotate' ? ['id'] : ['id', 'department', 'displayName', 'email', 'disabled']);
    const index = next.principals.findIndex(person => person.id === value.id);
    if (input.operation === 'person.create') {
      if (index !== -1) fail('PERSON_EXISTS', 409);
      if (!['operator', 'recipient', 'coordinator'].includes(value.kind)) fail('PERSON_KIND_REJECTED', 422);
      credential = crypto.randomBytes(32).toString('base64url');
      next.principals.push({ ...value, disabled: value.disabled ?? false,
        tokenHash: crypto.createHash('sha256').update(credential).digest('hex') });
    } else {
      if (index === -1) fail('PERSON_NOT_FOUND', 404);
      if (next.principals[index].kind === 'administrator') fail('BOOTSTRAP_ADMIN_PROTECTED');
      if (input.operation === 'person.rotate') {
        credential = crypto.randomBytes(32).toString('base64url');
        next.principals[index].tokenHash = crypto.createHash('sha256').update(credential).digest('hex');
      } else next.principals[index] = { ...next.principals[index], ...value };
      changedPeople.add(value.id);
    }
  } else if (input.operation === 'grant.create' || input.operation === 'grant.update') {
    exact(value, ['id', 'operatorId', 'coordinatorId', 'recipients', 'channels', 'expiresAt', 'maxAttempts', 'maxOpens', 'revoked']);
    const index = next.grants.findIndex(grant => grant.id === value.id);
    if (input.operation === 'grant.create') {
      if (index !== -1) fail('GRANT_EXISTS', 409);
      next.grants.push({ ...value, version: 1 });
    } else {
      if (index === -1) fail('GRANT_NOT_FOUND', 404);
      next.grants[index] = { ...next.grants[index], ...value };
      changedGrants.add(value.id);
    }
  } else fail('ADMIN_OPERATION_REJECTED', 422);
  for (const grant of next.grants) {
    if (changedGrants.has(grant.id) || [grant.operatorId, grant.coordinatorId, ...(Array.isArray(grant.recipients) ? grant.recipients : [])].some(id => changedPeople.has(id))) {
      grant.version++;
      changedGrants.add(grant.id);
    }
  }
  let validated;
  try { validated = validateAccess(next); }
  catch { fail('DIRECTORY_VALIDATION_REJECTED', 422); }
  if (!principalEnabled(validated, validated.principals.find(person => person.id === actor.id))) fail('ACTIVE_ADMIN_REQUIRED', 409);
  if (!validated.principals.some(person => person.kind === 'administrator' && principalEnabled(validated, person))) {
    fail('LAST_ADMIN_REQUIRED', 409);
  }
  if ((validated.directoryEvents || []).length >= 1000) fail('DIRECTORY_AUDIT_QUOTA', 507);
  const event = { id: crypto.randomUUID(), revision: validated.revision,
    code: input.operation.toUpperCase().replace('.', '_'), changedGrantCount: changedGrants.size,
    at: new Date(now).toISOString() };
  validated.directoryEvents = [...(validated.directoryEvents || []), event];
  return { config: validated, credential, event };
}
