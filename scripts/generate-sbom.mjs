// Generates the CycloneDX 1.5 bill of materials on demand instead of tracking a static JSON file
// (the workspace commit gate treats tracked .json data files as mutable artifacts, and a generated
// document cannot drift from package.json the way a hand-kept one does).
//
//   node scripts/generate-sbom.mjs            -> CycloneDX JSON on stdout
//   node scripts/generate-sbom.mjs --check    -> exit 1 if package.json declares any dependency,
//                                                because this bill of materials accounts for none
//
// What is generated: the application entry (name, version, description, licence and engines from
// package.json), the third-party-package count, and the base commit when run inside a git checkout.
// What is maintained by hand in the template below: the Node.js runtime note and the two
// machine-learning-model entries, which carry only facts that appear in this repository's code.
// Not generated: signatures, vulnerability data, model weight hashes or licences (none are recorded
// in the repository). See docs/compliance/sbom.md.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
// Every package.json field that can pull in third-party code, not just the four usual ones: a check that
// only reads dependencies/devDependencies would pass a manifest that bundles or overrides packages.
function declaredMap(pkg) {
  const map = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}), ...(pkg.optionalDependencies || {}), ...(pkg.peerDependencies || {}),
    ...(pkg.overrides && typeof pkg.overrides === 'object' ? Object.fromEntries(Object.keys(pkg.overrides).map(name => [name, 'override'])) : {}) };
  for (const field of ['bundledDependencies', 'bundleDependencies']) {
    if (Array.isArray(pkg[field])) for (const name of pkg[field]) map[String(name)] = map[String(name)] ?? 'bundled';
  }
  const workspaces = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages;
  if (Array.isArray(workspaces)) for (const entry of workspaces) map[`workspace:${String(entry)}`] = 'workspace';
  return map;
}

const TEMPLATE = {
  "components": [
    {
      "type": "platform",
      "bom-ref": "nodejs-runtime",
      "name": "Node.js",
      "version": ">=20.11.0",
      "scope": "required",
      "description": "Runtime requirement from package.json engines.node (>=20.11.0). The value in the version field is a minimum constraint, not an installed version; the repository does not record which Node.js release runs a given deployment. The application imports only Node.js built-in modules.",
      "properties": [
        {
          "name": "zte:versionSemantics",
          "value": "minimum supported version"
        },
        {
          "name": "zte:source",
          "value": "package.json engines.node"
        }
      ]
    },
    {
      "type": "machine-learning-model",
      "bom-ref": "model-nemotron-3-super-120b-a12b",
      "name": "nvidia/nemotron-3-super-120b-a12b",
      "supplier": {
        "name": "NVIDIA"
      },
      "scope": "optional",
      "description": "NVIDIA Nemotron 3 Super 120B-A12B, the hosted adviser model (default value of NEBIUS_MODEL in server.js). Served by Nebius Token Factory; called through its OpenAI-compatible chat completions API. Optional: the default COORDINATOR_PROVIDER=synthetic_fixture issues no model request.",
      "properties": [
        {
          "name": "zte:nameAsUsedInCode",
          "value": "nvidia/nemotron-3-super-120b-a12b"
        },
        {
          "name": "zte:role",
          "value": "routing and delivery follow-up adviser; proposes only, fixed code validates (file-adviser.js, file-routing.js, delivery-followup.js)"
        },
        {
          "name": "zte:access",
          "value": "hosted service via bom-ref service-nebius-token-factory; the weights are not distributed with or run by this application"
        },
        {
          "name": "zte:outletRule",
          "value": "https, host api.tokenfactory.nebius.com, no port, backend API key present, model name starts with nvidia/ (ADVISER_PROVIDERS.nebius.accepts)"
        },
        {
          "name": "zte:inputToModel",
          "value": "five pseudonymous fields per decision (see docs/compliance/ai-governance.md)"
        },
        {
          "name": "zte:weightsHashOrProviderVersion",
          "value": "not recorded in the repository"
        },
        {
          "name": "zte:licenceOfWeights",
          "value": "not recorded in the repository"
        },
        {
          "name": "zte:evaluationEvidence",
          "value": "docs/agent/followup-adviser-comparison-2026-10-08.md; scripts/bench-adviser.mjs"
        }
      ]
    },
    {
      "type": "machine-learning-model",
      "bom-ref": "model-nemotron-3-nano-4b",
      "name": "nvidia-nemotron-3-nano-4b",
      "supplier": {
        "name": "NVIDIA"
      },
      "scope": "optional",
      "description": "NVIDIA Nemotron 3 Nano 4B, the local adviser model (default value of LOCAL_MODEL_NAME in server.js), run on the same machine as the backend through any OpenAI-compatible runtime bound to a loopback address. Optional: edge mode only.",
      "properties": [
        {
          "name": "zte:nameAsUsedInCode",
          "value": "nvidia-nemotron-3-nano-4b"
        },
        {
          "name": "zte:role",
          "value": "routing and delivery follow-up adviser in edge mode; proposes only, fixed code validates"
        },
        {
          "name": "zte:access",
          "value": "local runtime on loopback only (ADVISER_PROVIDERS.local_openai_compatible.accepts); no data leaves the host"
        },
        {
          "name": "zte:runtimeTested",
          "value": "LM Studio llama.cpp runtime 2.46.0 on one Mac, as reported by the operator (docs/agent/followup-adviser-comparison-2026-10-08.md). Not run on a Jetson or any other NVIDIA edge device."
        },
        {
          "name": "zte:requestShape",
          "value": "json_schema response format, reasoning_effort none, temperature 0"
        },
        {
          "name": "zte:weightsHashOrQuantisation",
          "value": "not recorded in the repository"
        },
        {
          "name": "zte:licenceOfWeights",
          "value": "not recorded in the repository"
        },
        {
          "name": "zte:evaluationEvidence",
          "value": "docs/agent/followup-adviser-comparison-2026-10-08.md; scripts/bench-adviser.mjs"
        }
      ]
    },
    {
      "type": "application",
      "bom-ref": "lm-studio-llama-cpp-runtime",
      "name": "LM Studio llama.cpp runtime",
      "version": "2.46.0",
      "scope": "optional",
      "description": "Local OpenAI-compatible runtime used to serve the Nano 4B model in edge mode during the 2026-10-08 measurement. Any loopback OpenAI-compatible runtime is accepted by the code; this one is the only runtime the repository records as tested.",
      "properties": [
        {
          "name": "zte:versionSource",
          "value": "reported by the operator; the comparison result file does not record it"
        }
      ]
    },
    {
      "type": "library",
      "bom-ref": "playwright-test-tooling",
      "name": "playwright",
      "scope": "excluded",
      "description": "Browser acceptance tooling for scripts/browser-file-workflow.mjs and scripts/render-architecture.mjs. Not installed by the repository; supplied externally through the PLAYWRIGHT_MODULE environment variable. Excluded from the runtime inventory.",
      "properties": [
        {
          "name": "zte:version",
          "value": "not recorded; supplied externally"
        },
        {
          "name": "zte:usedBy",
          "value": "scripts/browser-file-workflow.mjs, scripts/render-architecture.mjs"
        },
        {
          "name": "zte:source",
          "value": "PACKAGE_REPUTATION_EVIDENCE.md; docs/agent/local-workflow.md"
        }
      ]
    },
    {
      "type": "application",
      "bom-ref": "chromium-test-tooling",
      "name": "Chromium",
      "scope": "excluded",
      "description": "Browser launched by Playwright for the acceptance scripts; an alternative executable may be named with BROWSER_EXECUTABLE. Not part of the application.",
      "properties": [
        {
          "name": "zte:version",
          "value": "not recorded; supplied externally"
        }
      ]
    },
    {
      "type": "library",
      "bom-ref": "python-docx-fixture-tooling",
      "name": "python-docx",
      "scope": "excluded",
      "description": "Used only by scripts/generate-native-fixtures.py to render synthetic DOCX test fixtures. Not downloaded by setup or npm test.",
      "properties": [
        {
          "name": "zte:version",
          "value": "not recorded; supplied externally"
        }
      ]
    },
    {
      "type": "library",
      "bom-ref": "reportlab-fixture-tooling",
      "name": "reportlab",
      "scope": "excluded",
      "description": "Used only by scripts/generate-native-fixtures.py to render synthetic PDF test fixtures. Not downloaded by setup or npm test.",
      "properties": [
        {
          "name": "zte:version",
          "value": "not recorded; supplied externally"
        }
      ]
    },
    {
      "type": "library",
      "bom-ref": "mermaid-diagram-tooling",
      "name": "mermaid",
      "scope": "excluded",
      "description": "Diagram rendering for scripts/render-architecture.mjs, supplied as a local distribution through the MERMAID_DIST environment variable. Not part of the application.",
      "properties": [
        {
          "name": "zte:version",
          "value": "not recorded; supplied externally"
        }
      ]
    }
  ],
  "metadataComponentStatic": {
    "type": "application",
    "externalReferences": [
      {
        "type": "vcs",
        "url": "https://github.com/jiarong0423/zero-trust-edge-enclave"
      }
    ],
    "properties": [
      {
        "name": "zte:thirdPartyRuntimePackages",
        "value": "0"
      },
      {
        "name": "zte:nodeBuiltinModulesImported",
        "value": "node:http, node:https, node:fs, node:fs/promises, node:path, node:crypto, node:net, node:url, node:async_hooks, node:os, node:child_process, node:events, node:util, node:stream, node:readline (plus node:test and node:assert/strict in tests)"
      },
      {
        "name": "zte:browserCode",
        "value": "public/*.js, same-origin only, no external script, style or font origin"
      }
    ]
  },
  "topProperties": [
    {
      "name": "zte:disclaimer",
      "value": "Inventory only. Not a certificate, audit result or vulnerability assessment."
    }
  ]
};

// Services the application talks to or is hosted on, with only facts present in this repository
// (the outlet host is pinned in file-adviser.js; the hosted address is in README.md).
const SERVICES = [
  { 'bom-ref': 'service-nebius-token-factory', name: 'Nebius Token Factory', provider: { name: 'Nebius' },
    endpoints: ['https://api.tokenfactory.nebius.com/v1'], authenticated: true, 'x-trust-boundary': true,
    description: 'Hosted OpenAI-compatible inference API used only in hosted mode (COORDINATOR_PROVIDER=nebius, LOCAL_ONLY=false, a key present). The adviser outlet accepts no other host.' },
  { 'bom-ref': 'service-zeabur-hosting', name: 'Zeabur', provider: { name: 'Zeabur' },
    endpoints: ['https://zero-trust-edge-enclave.zeabur.app'], authenticated: true,
    description: 'Hosts the judge demo instance only; it is not Nebius compute and is not part of the application.' },
];

export function buildSbom({ packageJsonPath = process.env.SBOM_PACKAGE_JSON || path.join(root, 'package.json'), now = new Date(), commit } = {}) {
  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  const declared = declaredMap(pkg);
  const names = Object.keys(declared);
  let head = commit;
  if (head === undefined) {
    try { head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
    catch { head = null; }
  }
  const properties = [...TEMPLATE.metadataComponentStatic.properties.filter(property => property.name !== 'zte:thirdPartyRuntimePackages'),
    { name: 'zte:thirdPartyRuntimePackages', value: String(names.length) },
    { name: 'zte:packageJsonDependencies', value: names.length ? `declared: ${names.join(', ')}` : 'none declared (no dependencies or devDependencies key)' },
    ...(head ? [{ name: 'zte:baseCommit', value: head }] : []),
    { name: 'zte:provenance', value: 'Generated by scripts/generate-sbom.mjs from package.json; model and runtime entries are maintained by hand and carry only facts present in this repository. Not signed.' }];
  const libraries = names.map(name => ({ type: 'library', 'bom-ref': `pkg:${name}`, name, version: String(declared[name]), scope: 'required' }));
  const { properties: ignored, ...staticComponent } = TEMPLATE.metadataComponentStatic;
  return {
    bomFormat: 'CycloneDX', specVersion: '1.5', serialNumber: `urn:uuid:${randomUUID()}`, version: 1,
    metadata: {
      timestamp: now.toISOString(),
      component: {
        type: 'application', 'bom-ref': `${pkg.name}@${pkg.version}`, name: pkg.name, version: pkg.version,
        description: `${pkg.description} Single Node.js process, ES modules; third-party runtime packages: ${names.length}.`,
        licenses: pkg.license ? [{ license: { id: pkg.license } }] : [],
        ...staticComponent, properties,
      },
      properties: TEMPLATE.topProperties,
    },
    services: SERVICES,
    components: [...TEMPLATE.components.map(component => component['bom-ref'] === 'nodejs-runtime'
      ? { ...component, version: pkg.engines?.node ?? component.version } : component), ...libraries],
  };
}

export function declaredDependencies(packageJsonPath = process.env.SBOM_PACKAGE_JSON || path.join(root, 'package.json')) {
  return Object.keys(declaredMap(JSON.parse(readFileSync(packageJsonPath, 'utf8'))));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--check')) {
    const names = declaredDependencies();
    if (names.length) { console.error(`ERROR package.json declares ${names.length} dependencies that this bill of materials does not account for: ${names.join(', ')}`); process.exit(1); }
    console.log('sbom check ok: zero third-party packages declared');
  } else console.log(JSON.stringify(buildSbom(), null, 2));
}
