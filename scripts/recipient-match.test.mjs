import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { resolveRecipient, normalizeZhName, MATCH_MESSAGES } from '../recipient-match.js';
import { normalizeDirectory } from '../registry-schema.js';
import { validateAccess } from '../access-control.js';
import { adminDirectory, changeDirectory } from '../directory-admin.js';
import { listRecipients } from '../recipient-directory.js';

// The owner's example: two people carry the same Chinese name, a third has another one, and two people
// share an English name while their Chinese names differ.
function directory() {
  const person = (id, nameZh, department, extra = {}) => ({ id, kind: 'recipient', department, nameZh, displayName: extra.displayName || id, ...extra });
  return {
    departments: ['sales', 'accounting', 'hr'].map(id => ({ id, displayName: id })),
    principals: [
      person('e1001', '劉文祥', 'sales', { displayName: 'Wen Liu', tags: { region: 'north', team: 'a' } }),
      person('e2044', '劉文祥', 'sales', { displayName: 'Wen Liu', tags: { region: 'south', team: 'b' } }),
      person('e3190', '劉慶龍', 'sales', { displayName: 'Wen Liu', tags: { region: 'north', team: 'b' } }),
      person('a0007', '劉文祥', 'accounting', { displayName: 'Wen Liu' }),
      person('h0001', '王小明', 'hr')
    ],
    grants: []
  };
}
const ask = (query, config = directory()) => resolveRecipient(config, query);

test('a Chinese name that is unique matches directly', () => {
  const result = ask({ nameZh: '劉慶龍' });
  assert.deepEqual([result.status, result.code, result.via, result.id, result.nameVerified], ['MATCHED', 'MATCH_BY_NAME', 'NAME', 'e3190', true]);
});

test('a Chinese name carried by two people is not guessed; the employee number decides', () => {
  const open = ask({ nameZh: '劉文祥' });
  assert.deepEqual([open.status, open.code, open.id], ['AMBIGUOUS', 'AMBIGUOUS_NEED_ID', null]);
  assert.deepEqual(open.candidates, ['a0007', 'e1001', 'e2044']);
  const decided = ask({ nameZh: '劉文祥', employeeId: 'e2044' });
  assert.deepEqual([decided.status, decided.code, decided.via, decided.id], ['MATCHED', 'MATCH_BY_ID', 'ID', 'e2044']);
});

test('the same name inside one department narrows to the right person, and a name that is unique in its department matches', () => {
  assert.equal(ask({ nameZh: '劉文祥', department: 'accounting' }).id, 'a0007');
  assert.equal(ask({ nameZh: '劉文祥', department: 'sales' }).status, 'AMBIGUOUS');
  assert.equal(ask({ nameZh: '劉文祥', department: 'sales', tags: { region: 'north' } }).id, 'e1001');
  assert.equal(ask({ nameZh: '劉文祥', department: 'sales', tags: { region: 'south', team: 'b' } }).id, 'e2044');
});

test('an employee number that is not one of the people sharing the name is refused', () => {
  const result = ask({ nameZh: '劉文祥', employeeId: 'e3190' });
  assert.deepEqual([result.status, result.code, result.id], ['NONE', 'NONE_ID_NOT_IN_NAME_SET', null]);
});

test('an employee number that points to someone other than the unique name match is a conflict, not a silent pick', () => {
  const result = ask({ nameZh: '劉慶龍', employeeId: 'e1001' });
  assert.deepEqual([result.status, result.code, result.id], ['CONFLICT', 'CONFLICT_ID_NAME', null]);
});

test('same English name with different Chinese names is told apart by the Chinese name', () => {
  const config = directory();
  const english = config.principals.filter(person => person.displayName === 'Wen Liu');
  assert.ok(english.length >= 3);
  assert.equal(ask({ nameZh: '劉慶龍' }, config).id, 'e3190');
});

test('a surname with an honorific matches nobody by name; with an employee number it resolves but says the name was not verified', () => {
  const alone = ask({ nameZh: '劉先生' });
  assert.deepEqual([alone.status, alone.code], ['NONE', 'NONE_NOT_FOUND']);
  const withId = ask({ nameZh: '劉先生', employeeId: 'e1001' });
  assert.deepEqual([withId.status, withId.code, withId.id, withId.nameVerified], ['MATCHED', 'MATCH_BY_ID_NAME_UNLISTED', 'e1001', false]);
});

test('the employee number alone is enough and must match exactly', () => {
  assert.equal(ask({ employeeId: 'e2044' }).id, 'e2044');
  assert.equal(ask({ employeeId: 'E2044' }).status, 'NONE');
  assert.equal(ask({ employeeId: 'e204' }).status, 'NONE');
});

test('white space and full-width forms do not change the name; Simplified spelling does not match by name', () => {
  assert.equal(normalizeZhName(' 劉　文 祥​'), '劉文祥');
  assert.equal(ask({ nameZh: ' 劉　慶 龍 ' }).id, 'e3190');
  // Version 1 does not unify Traditional and Simplified: a variant falls to the employee number.
  assert.equal(ask({ nameZh: '刘庆龙' }).status, 'NONE');
  assert.equal(ask({ nameZh: '刘庆龍', employeeId: 'e3190' }).id, 'e3190');
});

test('disabled people and disabled departments are never matched', () => {
  const config = directory();
  config.principals.find(person => person.id === 'e3190').disabled = true;
  assert.equal(ask({ nameZh: '劉慶龍' }, config).status, 'NONE');
  const second = directory();
  second.departments.find(entry => entry.id === 'accounting').disabled = true;
  assert.equal(ask({ nameZh: '劉文祥' }, second).candidates.includes('a0007'), false);
});

test('uniqueness is counted over the whole directory, whatever any grant lists', () => {
  const config = directory();
  config.grants = [{ id: 'g', recipients: ['e1001'] }];
  assert.equal(ask({ nameZh: '劉文祥' }, config).status, 'AMBIGUOUS');
});

test('malformed questions are refused with one code and the same fixed text', () => {
  for (const query of [{}, { nameZh: '' }, { employeeId: 'bad id' }, { nameZh: 42 }, { employeeId: 7 }, { nameZh: '劉', tags: { colour: 'red' } },
    { nameZh: '劉', tags: { region: 'x'.repeat(40) } }, { nameZh: '劉', department: 5 }, null, 'text']) {
    const result = ask(query);
    assert.deepEqual([result.status, result.code], ['INVALID', 'INVALID_INPUT'], JSON.stringify(query));
  }
  const failing = ['NONE_NOT_FOUND', 'NONE_ID_NOT_IN_NAME_SET', 'CONFLICT_ID_NAME', 'INVALID_INPUT'];
  assert.equal(new Set(failing.map(code => MATCH_MESSAGES[code])).size, 1);
});

test('the answer never carries a name, only ids and codes', () => {
  for (const query of [{ nameZh: '劉慶龍' }, { nameZh: '劉文祥' }, { nameZh: '劉文祥', employeeId: 'e1001' }, { nameZh: '無此人' }]) {
    const text = JSON.stringify(ask(query));
    assert.equal(/劉|王|Wen/.test(text), false, text);
  }
});

test('a registry without Chinese names or tags behaves as before', () => {
  const legacy = normalizeDirectory({ principals: [{ id: 'sales-a', kind: 'recipient', department: 'sales', displayName: 'Sales A' }], grants: [] });
  assert.equal(resolveRecipient(legacy, { employeeId: 'sales-a' }).id, 'sales-a');
  assert.equal(resolveRecipient(legacy, { nameZh: '劉慶龍' }).status, 'NONE');
  const operator = { id: 'op', kind: 'operator', department: 'sales' };
  const config = { principals: [...legacy.principals, operator],
    grants: [{ id: 'g', version: 1, operatorId: 'op', recipients: ['sales-a'], expiresAt: new Date(Date.now() + 60000).toISOString() }] };
  const listed = listRecipients(config, operator, 'g').recipients;
  assert.deepEqual(Object.keys(listed[0]).sort(), ['department', 'displayName', 'email', 'id']);
});

test('the registry loader rejects a malformed Chinese name or tags and a repeated employee number', () => {
  const base = () => ({ schemaVersion: 2, revision: 1, departments: [{ id: 'sales', displayName: 'Sales' }],
    principals: [{ id: 'e1', kind: 'recipient', department: 'sales' }, { id: 'e2', kind: 'recipient', department: 'sales' }], grants: [] });
  for (const mutate of [
    c => { c.principals[0].nameZh = ''; },
    c => { c.principals[0].nameZh = '   '; },
    c => { c.principals[0].nameZh = 'x'.repeat(65); },
    c => { c.principals[0].nameZh = 'a\nb'; },
    c => { c.principals[0].nameZh = 12; },
    c => { c.principals[0].tags = []; },
    c => { c.principals[0].tags = { colour: 'red' }; },
    c => { c.principals[0].tags = { region: 'a b' }; },
    c => { c.principals[0].tags = { region: 5 }; },
    c => { c.principals[1].id = 'e1'; }
  ]) {
    const config = base(); mutate(config);
    assert.throws(() => normalizeDirectory(config), error => error.status === 503);
  }
  const good = base();
  good.principals[0].nameZh = '劉慶龍';
  good.principals[0].tags = { region: '北區', team: 'a', role: 'sales-rep' };
  assert.equal(normalizeDirectory(good).principals[0].nameZh, '劉慶龍');
});

test('the administrator can set a Chinese name and tags, and the listing returns them', () => {
  const tokens = ['admin', 'sender', 'r1', 'coordinator'].map(() => crypto.randomBytes(32).toString('base64url'));
  const hash = token => crypto.createHash('sha256').update(token).digest('hex');
  const config = validateAccess({ schemaVersion: 2, revision: 1,
    departments: ['ops', 'sales'].map(id => ({ id, displayName: id })),
    principals: [{ id: 'admin', kind: 'administrator', department: 'ops', tokenHash: hash(tokens[0]) },
      { id: 'sender', kind: 'operator', department: 'ops', tokenHash: hash(tokens[1]) },
      { id: 'r1', kind: 'recipient', department: 'sales', tokenHash: hash(tokens[2]) },
      { id: 'coordinator', kind: 'coordinator', department: 'ops', tokenHash: hash(tokens[3]) }],
    grants: [{ id: 'grant', version: 1, operatorId: 'sender', coordinatorId: 'coordinator', recipients: ['r1'], channels: ['email'],
      expiresAt: new Date(Date.now() + 60000).toISOString(), maxAttempts: 3, maxOpens: 2 }] });
  const admin = config.principals[0];
  const created = changeDirectory(config, admin, { expectedRevision: 1, operation: 'person.update',
    value: { id: 'r1', nameZh: '劉慶龍', tags: { region: '北區', role: 'rep' } } });
  const shown = adminDirectory(created.config, admin).principals.find(person => person.id === 'r1');
  assert.deepEqual([shown.nameZh, shown.tags], ['劉慶龍', { region: '北區', role: 'rep' }]);
  assert.equal(JSON.stringify(adminDirectory(created.config, admin)).includes('tokenHash'), false);
  for (const value of [{ id: 'r1', tags: { colour: 'red' } }, { id: 'r1', nameZh: '' }]) {
    assert.throws(() => changeDirectory(config, admin, { expectedRevision: 1, operation: 'person.update', value }), error => error.status === 422);
  }
});

test('an alias matches only when nobody carries the formal name, and is never marked as a verified name', () => {
  const config = directory();
  Object.assign(config.principals.find(p => p.id === 'e3190'), { aliases: ['小龍', 'Dragon Liu'] });
  Object.assign(config.principals.find(p => p.id === 'h0001'), { aliases: ['小龍'] });
  const unique = ask({ nameZh: 'Dragon Liu' }, config);
  assert.deepEqual([unique.status, unique.code, unique.via, unique.id, unique.nameVerified], ['MATCHED', 'MATCH_BY_ALIAS', 'ALIAS', 'e3190', false]);
  const shared = ask({ nameZh: '小龍' }, config);
  assert.deepEqual([shared.status, shared.code, shared.candidates], ['AMBIGUOUS', 'AMBIGUOUS_NEED_ID', ['e3190', 'h0001']]);
  const decided = ask({ nameZh: '小龍', employeeId: 'h0001' }, config);
  assert.deepEqual([decided.code, decided.id, decided.nameVerified], ['MATCH_BY_ID_NAME_UNLISTED', 'h0001', false]);
  assert.equal(ask({ nameZh: '小龍', employeeId: 'e1001' }, config).code, 'NONE_ID_NOT_IN_NAME_SET');
  assert.equal(ask({ nameZh: 'Dragon Liu', employeeId: 'e1001' }, config).code, 'CONFLICT_ID_NAME');
  // The formal name wins: an alias that equals someone else's formal name is never consulted.
  Object.assign(config.principals.find(p => p.id === 'h0001'), { aliases: ['劉慶龍'] });
  assert.deepEqual([ask({ nameZh: '劉慶龍' }, config).code, ask({ nameZh: '劉慶龍' }, config).id], ['MATCH_BY_NAME', 'e3190']);
});

test('the narrowing code says whether the department or tags decided it', () => {
  assert.equal(ask({ nameZh: '劉慶龍' }).narrow, 'NARROW_NOT_USED');
  assert.equal(ask({ nameZh: '劉慶龍', department: 'sales' }).narrow, 'NARROW_NOT_DECISIVE');
  assert.equal(ask({ nameZh: '劉文祥', department: 'accounting' }).narrow, 'NARROW_DECISIVE');
  assert.equal(ask({ nameZh: '劉文祥', department: 'sales', tags: { region: 'north' } }).narrow, 'NARROW_DECISIVE');
  assert.equal(ask({ nameZh: '劉文祥', department: 'sales' }).narrow, 'NARROW_NOT_DECISIVE');   // still two people in sales
  assert.equal(ask({ nameZh: '劉文祥' }).narrow, 'NARROW_NOT_USED');
  assert.equal(ask({ nameZh: '無此人', department: 'sales' }).narrow, 'NARROW_NOT_USED');
});

test('title and aliases are validated at load and by the administrator', () => {
  const base = () => ({ schemaVersion: 2, revision: 1, departments: [{ id: 'sales', displayName: 'Sales' }],
    principals: [{ id: 'e1', kind: 'recipient', department: 'sales' }], grants: [] });
  for (const mutate of [c => { c.principals[0].title = ''; }, c => { c.principals[0].title = 'x'.repeat(65); }, c => { c.principals[0].title = 5; },
    c => { c.principals[0].aliases = 'x'; }, c => { c.principals[0].aliases = ['a', ' a ']; }, c => { c.principals[0].aliases = Array.from({ length: 9 }, (_, i) => `n${i}`); },
    c => { c.principals[0].aliases = ['']; }, c => { c.principals[0].aliases = [3]; }]) {
    const config = base(); mutate(config);
    assert.throws(() => normalizeDirectory(config), error => error.status === 503);
  }
  const good = base(); Object.assign(good.principals[0], { title: '業務代表', aliases: ['小劉', 'Liu'] });
  assert.deepEqual(normalizeDirectory(good).principals[0].aliases, ['小劉', 'Liu']);
});
