import test from 'node:test';
import assert from 'node:assert/strict';
import { businessFixtures, validateFixtures, revisedProcurement } from './business-fixtures.mjs';

test('synthetic business fixtures reproduce and enforce amounts, dates and recipient separation', () => {
  const bundle = businessFixtures();
  assert.deepEqual(bundle, businessFixtures());
  assert.notDeepEqual(bundle.documents[0], businessFixtures(123).documents[0]);
  assert.equal(validateFixtures(bundle), true);
  assert.deepEqual(bundle.scenarios[0].selectedRecipients, ['sales-a']);
  assert.deepEqual(bundle.scenarios[1].selectedRecipients, ['auditor-a']);
  const revision = revisedProcurement(bundle);
  assert.equal(revision.version, 2);
  assert.equal(bundle.documents[0].version, 1);
  assert.equal(validateFixtures({ ...bundle, documents: [revision, bundle.documents[1]] }), true);
  for (const mutate of [
    b => b.documents[0].financials.totalMinor++,
    b => b.documents[1].differenceMinor++,
    b => b.scenarios[0].selectedRecipients.push('sales-c'),
    b => b.directory.push(b.directory[0]),
    b => b.documents[1].dueAt = '2020-01-01'
  ]) {
    const invalid = structuredClone(bundle);
    mutate(invalid);
    assert.throws(() => validateFixtures(invalid));
  }
  assert.throws(() => businessFixtures(-1));
});
