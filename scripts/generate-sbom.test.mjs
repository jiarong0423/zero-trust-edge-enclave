import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildSbom, declaredDependencies } from './generate-sbom.mjs';

const script = path.resolve(import.meta.dirname, 'generate-sbom.mjs');

test('the bill of materials is generated from package.json and lists no third-party runtime packages', () => {
  const sbom = buildSbom({ commit: null });
  assert.equal(sbom.bomFormat, 'CycloneDX');
  assert.equal(sbom.specVersion, '1.5');
  assert.match(sbom.serialNumber, /^urn:uuid:[0-9a-f-]{36}$/);
  assert.equal(sbom.metadata.component.name, 'zero-trust-edge-enclave');
  const props = Object.fromEntries(sbom.metadata.component.properties.map(property => [property.name, property.value]));
  assert.equal(props['zte:thirdPartyRuntimePackages'], '0');
  assert.ok(!('zte:baseCommit' in props), 'no commit is recorded when none is given');
  const models = sbom.components.filter(component => component.type === 'machine-learning-model').map(component => component.name).sort();
  assert.deepEqual(models, ['nvidia-nemotron-3-nano-4b', 'nvidia/nemotron-3-super-120b-a12b']);
  assert.equal(sbom.components.find(component => component['bom-ref'] === 'nodejs-runtime').version, '>=20.11.0');
  assert.deepEqual(declaredDependencies(), []);
});

test('--check passes for this repository and fails when a dependency is declared', async t => {
  assert.equal(spawnSync(process.execPath, [script, '--check'], { encoding: 'utf8' }).status, 0);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sbom-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'package.json');
  await fs.writeFile(file, JSON.stringify({ name: 'x', version: '1.0.0', dependencies: { left: '^1.0.0' } }));
  const result = spawnSync(process.execPath, [script, '--check'], { encoding: 'utf8', env: { ...process.env, SBOM_PACKAGE_JSON: file } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /left/);
  const generated = buildSbom({ packageJsonPath: file, commit: null });
  assert.ok(generated.components.some(component => component.type === 'library' && component.name === 'left'));
});

test('the document is valid JSON on the command line', () => {
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).bomFormat, 'CycloneDX');
});

test('every package.json field that can pull in third-party code is checked, and the count is stated once', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sbom-fields-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const [field, value] of [['bundledDependencies', ['left']], ['bundleDependencies', ['left']], ['workspaces', ['packages/*']], ['overrides', { left: '1.0.0' }]]) {
    const file = path.join(dir, `${field}.json`);
    await fs.writeFile(file, JSON.stringify({ name: 'x', version: '1.0.0', [field]: value }));
    const result = spawnSync(process.execPath, [script, '--check'], { encoding: 'utf8', env: { ...process.env, SBOM_PACKAGE_JSON: file } });
    assert.equal(result.status, 1, field);
  }
  const file = path.join(dir, 'with-deps.json');
  await fs.writeFile(file, JSON.stringify({ name: 'x', version: '1.0.0', dependencies: { left: '^1.0.0' } }));
  const sbom = buildSbom({ packageJsonPath: file, commit: null });
  assert.equal(sbom.metadata.component.properties.filter(property => property.name === 'zte:thirdPartyRuntimePackages').length, 1);
  assert.equal(sbom.metadata.component.properties.find(property => property.name === 'zte:thirdPartyRuntimePackages').value, '1');
});

test('the services the model components point at exist in the document', () => {
  const sbom = buildSbom({ commit: null });
  const refs = new Set((sbom.services || []).map(service => service['bom-ref']));
  assert.ok(refs.has('service-nebius-token-factory') && refs.has('service-zeabur-hosting'));
  for (const component of sbom.components.filter(item => item.type === 'machine-learning-model')) {
    for (const property of component.properties || []) {
      const match = String(property.value).match(/service-[a-z-]+/);
      if (match) assert.ok(refs.has(match[0]), `${component.name} refers to ${match[0]}`);
    }
  }
});
