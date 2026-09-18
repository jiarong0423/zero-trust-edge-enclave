const code = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max) => typeof value === 'string' && value.trim().length > 0 &&
  value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const optionalBoolean = value => value === undefined || typeof value === 'boolean';
const invalid = () => { throw Object.assign(new Error('Invalid directory registry'), { status: 503 }); };

// Legacy registries normalize in memory only. Managed registries declare their department catalog.
export function normalizeDirectory(config) {
  if (!object(config) || !Array.isArray(config.principals) || !Array.isArray(config.grants) ||
      (config.schemaVersion !== undefined && ![1, 2].includes(config.schemaVersion))) invalid();
  if (config.schemaVersion === 2 && (!Number.isSafeInteger(config.revision) || config.revision < 1 ||
      !Array.isArray(config.departments))) invalid();
  const ids = new Set();
  for (const person of config.principals) {
    if (!object(person) || !code(person.id) || ids.has(person.id) ||
        !optionalBoolean(person.disabled) ||
        (person.department !== undefined && !code(person.department)) ||
        (person.displayName !== undefined && !text(person.displayName, 128)) ||
        (person.email !== undefined && person.email !== null &&
          (!text(person.email, 254) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(person.email)))) invalid();
    ids.add(person.id);
  }
  const departments = config.departments === undefined
    ? [...new Set(config.principals.map(person => person.department || 'unassigned'))]
      .map(id => ({ id, displayName: id, disabled: false }))
    : config.departments;
  if (!Array.isArray(departments)) invalid();
  const departmentIds = new Set();
  for (const department of departments) {
    if (!object(department) || !code(department.id) || departmentIds.has(department.id) ||
        !text(department.displayName, 128) || !optionalBoolean(department.disabled)) invalid();
    departmentIds.add(department.id);
  }
  const principals = config.principals.map(person => {
    const department = person.department || 'unassigned';
    if (!departmentIds.has(department)) invalid();
    return { ...person, department };
  });
  for (const grant of config.grants) {
    if (!object(grant) || !optionalBoolean(grant.revoked)) invalid();
  }
  return { ...config, departments: departments.map(entry => ({ ...entry })), principals };
}

export function principalEnabled(config, principal) {
  if (!principal || principal.disabled) return false;
  if (!config.departments) return true;
  const department = config.departments.find(entry => entry.id === (principal.department || 'unassigned'));
  return Boolean(department && !department.disabled);
}

// Recipient group membership for the private mapping layer. Never exposed to an adviser
// directly: it only decides which group letter a code belongs to.
export function departmentMap(config) {
  return Object.fromEntries(config.principals
    .filter(person => person.kind === 'recipient')
    .map(person => [person.id, person.department || 'unassigned']));
}
