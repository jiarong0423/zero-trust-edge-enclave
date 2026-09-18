import { activeGrant, fail } from './access-control.js';
import { principalEnabled } from './registry-schema.js';

// This is an operator-only private view, never coordinator/model metadata.
export function listRecipients(config, actor, grantId, department = '', query = '') {
  const grant = activeGrant(config, grantId);
  if (actor.kind !== 'operator' || !principalEnabled(config, actor) || grant.operatorId !== actor.id) fail('Directory access denied');
  if (typeof department !== 'string' || typeof query !== 'string' || department.length > 64 || query.length > 128) {
    fail('Invalid directory query', 422);
  }
  const candidates = config.principals.filter(person => person.kind === 'recipient' && principalEnabled(config, person) && grant.recipients.includes(person.id));
  const departments = [...new Set(candidates.map(person => person.department || 'unassigned'))].sort();
  const needle = query.trim().toLowerCase();
  const recipients = candidates.filter(person => (!department || (person.department || 'unassigned') === department) &&
    (!needle || [person.id, person.displayName, person.email].some(value => typeof value === 'string' && value.toLowerCase().includes(needle))))
    .map(person => ({ id: person.id, displayName: person.displayName || person.id,
      department: person.department || 'unassigned', email: person.email || null }));
  const departmentLabels = Object.fromEntries(departments.map(id =>
    [id, config.departments?.find(entry => entry.id === id)?.displayName || id]));
  return { authorizationId: grant.id, authorizationVersion: grant.version, departments, departmentLabels, recipients };
}
