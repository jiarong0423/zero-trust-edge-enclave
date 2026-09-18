import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { normalizeDirectory, principalEnabled } from '../registry-schema.js';
import { authenticate } from '../access-control.js';
import { listRecipients } from '../recipient-directory.js';

function fixture() {
  return { schemaVersion: 2, revision: 1,
    departments: [{ id: 'management', displayName: 'Management' }, { id: 'sales', displayName: 'Sales' }],
    principals: [{ id: 'sender', kind: 'operator', department: 'management' },
      { id: 'sales-a', kind: 'recipient', department: 'sales', displayName: 'Synthetic Sales A', email: 'sales-a@example.com' }],
    grants: [{ id: 'grant', operatorId: 'sender', recipients: ['sales-a'], version: 1,
      expiresAt: new Date(Date.now() + 60000).toISOString() }] };
}

test('directory schema rejects malformed fields, ambiguous IDs and dangling department references', () => {
  for (const mutate of [
    c => { c.principals[1].department = 42; },
    c => { c.principals[1].department = 'x'.repeat(65); },
    c => { c.principals[1].department = 'unknown'; },
    c => { delete c.principals[1].department; },
    c => { c.principals[1].disabled = 'false'; },
    c => { c.principals[1].email = 'bad\n@example.com'; },
    c => { c.principals[1].displayName = 'x'.repeat(129); },
    c => { c.principals.push({ ...c.principals[0] }); },
    c => { c.departments.push({ ...c.departments[0] }); },
    c => { c.departments[0].disabled = 1; },
    c => { c.departments[0].displayName = ''; },
    c => { c.grants[0].revoked = 'false'; },
    c => { c.revision = 0; },
    c => { delete c.departments; },
    c => { c.schemaVersion = 99; }
  ]) {
    const config = fixture(); mutate(config);
    assert.throws(() => normalizeDirectory(config), error => error.status === 503);
  }
  assert.equal(normalizeDirectory(fixture()).principals[1].department, 'sales');
});

test('legacy normalization is read-only and disabled departments deny login and directory exposure', () => {
  const old = { principals: [{ id: 'old', kind: 'recipient' }], grants: [] };
  const original = structuredClone(old);
  const normalized = normalizeDirectory(old);
  assert.equal(normalized.principals[0].department, 'unassigned');
  assert.deepEqual(old, original);
  const config = normalizeDirectory(fixture());
  const syntheticBearer = 'a'.repeat(43);
  for (const person of config.principals) person.tokenHash = createHash('sha256').update(
    person.id === 'sales-a' ? syntheticBearer : 'b'.repeat(43)).digest('hex');
  assert.equal(authenticate(config, 'Bearer ' + syntheticBearer).id, 'sales-a');
  assert.equal(listRecipients(config, config.principals[0], 'grant').recipients.length, 1);
  config.departments[1].disabled = true;
  assert.equal(principalEnabled(config, config.principals[1]), false);
  assert.throws(() => authenticate(config, 'Bearer ' + syntheticBearer), error => error.status === 401);
  assert.equal(listRecipients(config, config.principals[0], 'grant').recipients.length, 0);
  config.departments[0].disabled = true;
  assert.throws(() => listRecipients(config, config.principals[0], 'grant'));
});
