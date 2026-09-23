import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { businessFixtures } from './business-fixtures.mjs';
import { validateAccess } from '../access-control.js';

const usage = 'Usage: setup-local.mjs DIRECTORY [--business] [--until ISO_TIME]';
const [directory, ...flags] = process.argv.slice(2);
let root = path.resolve(directory || 'data');
let untilValue = null;
let businessFlag = false;
for (let index = 0; index < flags.length; index += 1) {
  if (flags[index] === '--business' && !businessFlag) businessFlag = true;
  else if (flags[index] === '--until' && untilValue === null && flags[index + 1]) untilValue = flags[++index];
  else throw new Error(usage);
}
// A hosted demo outlives the default lifetimes, so every grant can be given one explicit end instead.
const until = untilValue === null ? null : Date.parse(untilValue);
if (until !== null && (!Number.isFinite(until) || until <= Date.now())) throw new Error('--until must be a future ISO time');
const expiry = hours => new Date(until ?? Date.now() + hours * 3600000).toISOString();
const business = businessFlag ? businessFixtures() : null;
const identities = business ? [...business.directory, { id: 'admin', kind: 'administrator', department: 'administration', displayName: 'Local Administrator' }]
  : [['operator', 'operator', 'sender'], ['recipient-a', 'recipient', 'cfo'], ['recipient-b', 'recipient', 'employee'], ['coordinator', 'coordinator', 'coordinator']]
    .map(([id, kind, role]) => ({ id, kind, role }));
await fs.mkdir(root, { recursive: true, mode: 0o700 });
if ((await fs.lstat(root)).isSymbolicLink() || (await fs.stat(root)).mode & 0o077) throw new Error('Private setup directory required');
root = await fs.realpath(root);
for (const name of ['access.json', ...identities.map(person => person.id + '.token')]) {
  try { await fs.access(path.join(root, name)); throw new Error('Registry already exists; refusing to replace credentials'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const principals = [];
for (const person of identities) {
  const token = crypto.randomBytes(32).toString('base64url');
  await fs.writeFile(path.join(root, `${person.id}.token`), token, { flag: 'wx', mode: 0o600 });
  principals.push({ ...person, tokenHash: crypto.createHash('sha256').update(token).digest('hex') });
}
const config = validateAccess(business ? { schemaVersion: 2, revision: 1,
  departments: [...new Set(principals.map(person => person.department))].map(id => ({ id, displayName: id, disabled: false })),
  principals, grants: business.scenarios.map(scenario => ({ id: scenario.id, version: 1,
    operatorId: scenario.senderId, coordinatorId: 'coordinator', recipients: scenario.selectableRecipients,
    channels: scenario.channels, expiresAt: expiry(scenario.ttlHours),
    maxAttempts: scenario.maxAttempts, maxOpens: 2, simulatedOutcomes: ['prepared'] })) }
  : { principals, grants: [{ id: 'local-review', version: 1, operatorId: 'operator', coordinatorId: 'coordinator', recipients: ['recipient-a'], channels: ['email'], expiresAt: expiry(24), maxAttempts: 3, maxOpens: 2, simulatedOutcomes: ['prepared'] }] });
await fs.writeFile(path.join(root, 'access.json'), JSON.stringify(config, null, 2), { flag: 'wx', mode: 0o600 });
console.log(business ? 'Business demo created: procurement and audit grants; separate admin identity. Token values were not printed.'
  : 'Local synthetic registry created. Token files are private; values were not printed.');
