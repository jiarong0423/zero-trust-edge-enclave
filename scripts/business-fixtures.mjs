import assert from 'node:assert/strict';

// Determinism belongs only to mock business data, never credentials or encryption.
export function businessFixtures(seed = 20260907) {
  assert.ok(Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff);
  let state = seed >>> 0;
  const next = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
  const createdAt = '2026-09-07T10:00:00Z';
  const base = { testFlag: 'MOCK_TEST_DATA_DO_NOT_USE', createdAt, version: 1 };
  const items = [{ name: 'MOCK component A', quantity: 10, unitPriceMinor: 10000 + next() % 10000 }];
  const subtotalMinor = items.reduce((sum, item) => sum + item.quantity * item.unitPriceMinor, 0);
  const taxMinor = Math.floor((subtotalMinor * 5 + 50) / 100);
  const procurement = { ...base, documentId: 'MOCK-PROCUREMENT-001',
    buyer: 'MOCK Buyer', seller: 'MOCK Supplier', currency: 'USD', items,
    financials: { subtotalMinor, testTaxPercent: 5, taxMinor, totalMinor: subtotalMinor + taxMinor },
    purpose: 'Synthetic purchase review only', deliveryDate: '2026-10-15',
    deliveryMethod: 'Synthetic warehouse', paymentTerms: 'Synthetic net 30 days',
    confidentiality: 'Only explicitly approved test recipients may access this document.',
    changeCondition: 'Changes require a new reviewed version.',
    breachHandling: 'Record a synthetic exception; no real contractual effect.',
    toCheck: ['items', 'prices', 'delivery date'], excludedActions: ['sign contract', 'authorize payment'] };
  const entries = [{ voucherId: 'MOCK-VOU-001', category: 'Synthetic travel', bookMinor: 120000, checkedMinor: 100000 },
    { voucherId: 'MOCK-VOU-002', category: 'Synthetic supplies', bookMinor: 50000, checkedMinor: 50000 }];
  const audit = { ...base, documentId: 'MOCK-AUDIT-001', currency: 'USD', auditPeriod: '2026-Q2', entries,
    differenceMinor: entries.reduce((sum, entry) => sum + entry.bookMinor - entry.checkedMinor, 0),
    missingDocuments: ['MOCK-VOU-001 receipt'], pendingItems: ['Explain synthetic travel difference'],
    scope: 'Synthetic expense reconciliation', dueAt: '2026-09-14T17:00:00Z',
    responsibility: 'Report discrepancies only; no payment or asset seizure authority.' };
  const directory = [
    ['manager-sender', 'operator', 'management'], ['accounting-sender', 'operator', 'accounting'],
    ['sales-a', 'recipient', 'sales'], ['sales-b', 'recipient', 'sales'], ['sales-c', 'recipient', 'sales'],
    ['auditor-a', 'recipient', 'audit'], ['coordinator', 'coordinator', 'automation']
  ].map(([id, kind, department]) => ({ id, kind, department, displayName: `MOCK ${id}`, email: `${id}@example.com` }));
  const scenarios = [
    { id: 'procurement', documentId: procurement.documentId, senderId: 'manager-sender',
      selectableRecipients: ['sales-a', 'sales-b'], selectedRecipients: ['sales-a'],
      deniedRecipients: ['sales-b', 'sales-c', 'auditor-a'], ttlHours: 24 },
    { id: 'audit', documentId: audit.documentId, senderId: 'accounting-sender',
      selectableRecipients: ['auditor-a'], selectedRecipients: ['auditor-a'],
      deniedRecipients: ['sales-a', 'sales-b', 'sales-c'], ttlHours: 4 }
  ].map(scenario => ({ ...scenario, channels: ['internal_queue', 'email'], maxAttempts: 3 }));
  const result = { schemaVersion: 1, seed, documents: [procurement, audit], directory, scenarios };
  validateFixtures(result);
  return result;
}

export function validateFixtures(bundle) {
  assert.equal(bundle.documents.length, 2);
  const identities = new Map(bundle.directory.map(person => [person.id, person]));
  assert.equal(identities.size, bundle.directory.length);
  assert.ok(bundle.directory.every(person => person.email.endsWith('@example.com')));
  assert.equal(new Set(bundle.documents.map(doc => doc.documentId)).size, 2);
  const [purchase, audit] = bundle.documents;
  for (const document of bundle.documents) {
    assert.equal(document.testFlag, 'MOCK_TEST_DATA_DO_NOT_USE');
    assert.ok(Number.isFinite(Date.parse(document.createdAt)));
  }
  assert.ok(purchase.items.every(item => Number.isSafeInteger(item.quantity) && item.quantity > 0 &&
    Number.isSafeInteger(item.unitPriceMinor) && item.unitPriceMinor > 0));
  const subtotal = purchase.items.reduce((sum, item) => sum + item.quantity * item.unitPriceMinor, 0);
  assert.equal(purchase.financials.subtotalMinor, subtotal);
  assert.equal(purchase.financials.taxMinor, Math.floor((subtotal * purchase.financials.testTaxPercent + 50) / 100));
  assert.equal(purchase.financials.totalMinor, subtotal + purchase.financials.taxMinor);
  assert.ok(Date.parse(purchase.deliveryDate) > Date.parse(purchase.createdAt));
  assert.ok(audit.entries.every(entry => Number.isSafeInteger(entry.bookMinor) && Number.isSafeInteger(entry.checkedMinor)));
  assert.equal(audit.differenceMinor, audit.entries.reduce((sum, entry) => sum + entry.bookMinor - entry.checkedMinor, 0));
  assert.ok(Date.parse(audit.dueAt) > Date.parse(audit.createdAt));
  for (const scenario of bundle.scenarios) {
    assert.equal(identities.get(scenario.senderId)?.kind, 'operator');
    assert.ok(scenario.selectedRecipients.length > 0);
    assert.ok(scenario.selectedRecipients.every(id => scenario.selectableRecipients.includes(id)));
    assert.ok(scenario.selectableRecipients.every(id => identities.get(id)?.kind === 'recipient'));
    assert.ok(scenario.deniedRecipients.every(id => !scenario.selectedRecipients.includes(id)));
    assert.ok(bundle.documents.some(doc => doc.documentId === scenario.documentId));
  }
  return true;
}

export function revisedProcurement(bundle) {
  const document = structuredClone(bundle.documents[0]);
  document.version += 1;
  document.items[0].unitPriceMinor += 100;
  const subtotalMinor = document.items.reduce((sum, item) => sum + item.quantity * item.unitPriceMinor, 0);
  const taxMinor = Math.floor((subtotalMinor * 5 + 50) / 100);
  document.financials = { subtotalMinor, testTaxPercent: 5, taxMinor, totalMinor: subtotalMinor + taxMinor };
  return document;
}
