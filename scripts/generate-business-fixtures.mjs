import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { businessFixtures, revisedProcurement } from './business-fixtures.mjs';

const root = path.resolve(import.meta.dirname, '..', 'output/isolation/current_runs/20260907_business_pipeline/fixtures');
const bundle = businessFixtures();
const files = new Map([
  ['audit.csv', [['MOCK_TEST_DATA_DO_NOT_USE', 'category', 'book_minor', 'checked_minor'],
    ...bundle.documents[1].entries.map(entry => [entry.voucherId, entry.category, entry.bookMinor, entry.checkedMinor])]
    .map(row => row.map(value => '"' + String(value).replaceAll('"', '""') + '"').join(',')).join('\r\n') + '\r\n'],
  ['procurement.txt', JSON.stringify(bundle.documents[0], null, 2) + '\n'],
  ['audit.txt', JSON.stringify(bundle.documents[1], null, 2) + '\n'],
  ['procurement-revised.txt', JSON.stringify(revisedProcurement(bundle), null, 2) + '\n'],
  ['directory-and-scenarios.json', JSON.stringify({ directory: bundle.directory, scenarios: bundle.scenarios }, null, 2) + '\n']
]);
// Validate all existing destinations before writing; reruns are identical or fail closed.
await fs.mkdir(root, { recursive: true, mode: 0o700 });
if (await fs.realpath(root) !== root) throw new Error('Fixture output must not use a symbolic-link path');
const missing = [];
for (const [name, content] of files) {
  try {
    const target = path.join(root, name);
    if (!(await fs.lstat(target)).isFile()) throw new Error('Unexpected fixture target');
    if (await fs.readFile(target, 'utf8') !== content) throw new Error('Existing fixture differs; refusing overwrite');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    missing.push([name, content]);
  }
}
for (const [name, content] of missing) await fs.writeFile(path.join(root, name), content, { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ mode: 'isolation_only', created: missing.length, unchanged: files.size - missing.length,
  seed: bundle.seed, documents: bundle.documents.length, identities: bundle.directory.length,
  artifacts: [...files].map(([name, content]) => ({ name, sha256: createHash('sha256').update(content).digest('hex') })) }));
