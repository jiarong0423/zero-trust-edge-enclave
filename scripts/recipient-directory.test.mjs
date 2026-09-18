import test from 'node:test';
import assert from 'node:assert/strict';
import { listRecipients } from '../recipient-directory.js';
import { businessFixtures } from './business-fixtures.mjs';

test('private directory intersects authority before department and manual search', () => {
  const fixture = businessFixtures();
  const actor = fixture.directory.find(person => person.id === 'manager-sender');
  const config = { principals: fixture.directory, grants: [{ id: 'test', version: 1, operatorId: actor.id,
    recipients: ['sales-a', 'sales-b'], expiresAt: new Date(Date.now() + 60000).toISOString() }] };
  assert.deepEqual(listRecipients(config, actor, 'test').recipients.map(p => p.id), ['sales-a', 'sales-b']);
  assert.deepEqual(listRecipients(config, actor, 'test', 'sales', 'sales_a@example.com').recipients, []);
  assert.equal(listRecipients(config, actor, 'test', 'sales', 'sales-a@example.com').recipients[0].id, 'sales-a');
  assert.deepEqual(listRecipients(config, actor, 'test', '', 'sales-c').recipients, []);
  assert.deepEqual(listRecipients(config, actor, 'test', 'audit').recipients, []);
  for (const id of ['accounting-sender', 'sales-a', 'coordinator']) {
    assert.throws(() => listRecipients(config, fixture.directory.find(person => person.id === id), 'test'));
  }
  config.principals.find(person => person.id === 'sales-b').disabled = true;
  assert.equal(listRecipients(config, actor, 'test').recipients.length, 1);
  config.grants[0].revoked = true;
  assert.throws(() => listRecipients(config, actor, 'test'));
});
