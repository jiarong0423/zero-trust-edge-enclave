# Software Bill Of Materials

Written 2026-10-08 against branch `improve/2026-10-08`. Re-verified against the code on 2026-10-08 (see `verification-log-2026-10-08.md`). The machine-readable file is
generated on demand by `node scripts/generate-sbom.mjs` (CycloneDX 1.5 JSON on stdout; `--check` fails if `package.json` declares any dependency). There is no tracked `sbom.cdx.json`: the workspace commit gate treats tracked `.json` data files as mutable artifacts, and the generated parts of the document cannot drift from `package.json`. Evidence is cited as file plus symbol or test title; if a symbol moved, `grep -rn '<symbol>' *.js` finds it.

> **Disclaimer.** An inventory of what the project is made of. Part of it is generated from `package.json`
> and the git checkout by `scripts/generate-sbom.mjs` (`buildSbom()`); the model, runtime, tooling and service entries are a hand-kept
> template in that script (`TEMPLATE`, `SERVICES`) and carry only facts present in this repository. It is not signed, not
> a vulnerability assessment and not a certificate. The project holds no certification.

## Summary

| Item | Value | How it was checked |
| --- | --- | --- |
| Application | `zero-trust-edge-enclave` 0.1.0, MIT, ES modules | `package.json`, `LICENSE` |
| Third-party runtime packages | **0** | `package.json` has no `dependencies` or `devDependencies` key (`Object.keys` of the parsed file: `name, version, description, license, type, main, scripts, engines`); no `node_modules` directory; no `package-lock.json`, `yarn.lock` or `pnpm-lock.yaml`; `node scripts/generate-sbom.mjs --check` (`declaredDependencies()` over `declaredMap()`, which counts `dependencies`, `devDependencies`, `optionalDependencies`, `peerDependencies`, `overrides`, `bundledDependencies`/`bundleDependencies` and `workspaces`; `scripts/generate-sbom.test.mjs` tests "--check passes for this repository and fails when a dependency is declared" and "every package.json field that can pull in third-party code is checked, and the count is stated once") |
| Imports | Only `node:` built-ins and relative paths; a search of every `.js` and `.mjs` file for bare-specifier `from '...'` imports found none. Two scripts load externally supplied tooling by path at run time (`PLAYWRIGHT_MODULE`, `MERMAID_DIST`). The `zte:nodeBuiltinModulesImported` property is a hand-kept list in the generator template and matched the built-ins found by that search on 2026-10-08 | `grep` over the tree |
| Runtime requirement | Node.js `>=20.11.0` | `package.json`, `engines.node`; copied into the generated `nodejs-runtime` component by `buildSbom()` |
| Browser code | `public/*.js`, same origin; no external script, style or font origin | a search for `http(s)://` in `public/` found only the text `http://127.0.0.1` inside an error message in `public/crypto-utils.js`; CSP is `default-src 'self'` (`http-helpers.js` `securityHeaders()`) |
| Model components | 2 (`machine-learning-model`), both optional | see below |
| Test-only tooling | Playwright, Chromium, python-docx, reportlab, Mermaid, listed with `scope: excluded` | `PACKAGE_REPUTATION_EVIDENCE.md`; `scripts/browser-file-workflow.mjs`, `scripts/render-architecture.mjs`, `scripts/generate-native-fixtures.py` |

Because the application is its own subject, it appears as `metadata.component` in the CycloneDX file, the
convention for the described product. The `components` array holds what it relies on or is run with.

## What Is Generated And What Is Hand-Kept

| Part of the document | Source |
| --- | --- |
| Application name, version, description, licence, `engines.node` | Generated from `package.json` (`buildSbom()`) |
| `zte:thirdPartyRuntimePackages` and `zte:packageJsonDependencies` | Generated: counts every name found by `declaredMap()` (the seven field kinds listed above), stated once, and adds each as a `library` component |
| `zte:baseCommit` | Generated from `git rev-parse HEAD` when run inside a git checkout; omitted otherwise |
| Serial number and timestamp | Generated on every run (`randomUUID()`, `new Date()`), so two runs never produce identical bytes |
| Model, runtime, test-tooling components, the built-in module list, the disclaimer | Hand-kept in the `TEMPLATE` constant of `scripts/generate-sbom.mjs` |
| `services` (Nebius Token Factory, Zeabur) | Hand-kept in the `SERVICES` constant of `scripts/generate-sbom.mjs` |
| Signature, vulnerability data, weight hashes, model licences | Not present anywhere |

## Components In The Generated Document

| bom-ref | Type | Scope | Notes |
| --- | --- | --- | --- |
| `zero-trust-edge-enclave@0.1.0` | application (`metadata.component`) | n/a | The subject. Property `zte:thirdPartyRuntimePackages` is `0` |
| `nodejs-runtime` | platform | required | `version` holds the minimum constraint `>=20.11.0`, not an installed version. The installed release is not recorded by the repository |
| `model-nemotron-3-super-120b-a12b` | machine-learning-model | optional | `nvidia/nemotron-3-super-120b-a12b`, the hosted adviser, reached as a service through Nebius Token Factory. Name as used in code. No weight hash, provider version or licence text is recorded in the repository |
| `model-nemotron-3-nano-4b` | machine-learning-model | optional | `nvidia-nemotron-3-nano-4b`, the local adviser, run on the same host through a loopback OpenAI-compatible runtime. Name as used in code. No weight hash, quantisation or licence text is recorded |
| `lm-studio-llama-cpp-runtime` | application | optional | Version 2.46.0, as reported by the operator for the 2026-10-08 measurement; the only runtime the repository records as tested |
| `playwright-test-tooling`, `chromium-test-tooling` | library, application | excluded | Supplied externally (`PLAYWRIGHT_MODULE`, optional `BROWSER_EXECUTABLE`); versions not recorded |
| `python-docx-fixture-tooling`, `reportlab-fixture-tooling` | library | excluded | Used only by `scripts/generate-native-fixtures.py`; versions not recorded |
| `mermaid-diagram-tooling` | library | excluded | Supplied through `MERMAID_DIST` for `scripts/render-architecture.mjs`; version not recorded |

Services listed (CycloneDX `services`, hand-kept in `SERVICES`): `service-nebius-token-factory` (the only Nebius service the project
uses, `README.md`) and `service-zeabur-hosting` (the hosted demo platform). The `zte:access` property of the hosted model component names
`service-nebius-token-factory`; `scripts/generate-sbom.test.mjs` test "the services the model components point at exist in the document" checks that every
`service-...` reference resolves.

## Facts Deliberately Not Stated

The file does not state model parameter counts beyond what is in the names used by the code, model
licences, weight hashes, training data or model versions, because the repository does not record them.
`docs/agent/nvidia-model-provenance.md` is a separate research note by another contributor and was not
verified by this index.

## Reproducing The Checks

Run from the repository root:

```bash
node -e "const p=JSON.parse(require('fs').readFileSync('package.json','utf8')); console.log(p.dependencies, p.devDependencies, p.engines)"
ls node_modules package-lock.json yarn.lock pnpm-lock.yaml
grep -rhoE "from '[^'.][^']*'" --include='*.js' --include='*.mjs' . | grep -v "from 'node:"
node scripts/generate-sbom.mjs --check
node scripts/generate-sbom.mjs | node -e "JSON.parse(require('fs').readFileSync(0,'utf8')); console.log('valid JSON')"
```

Expected: `undefined undefined { node: '>=20.11.0' }`; `ls` reports each path as missing; the `grep`
prints nothing; `--check` prints `sbom check ok: zero third-party packages declared`; the last line prints `valid JSON`.

## Limits

- **GAP:** the model, runtime, tooling and service entries, the built-in module list and the version `2.46.0` are
  hand-kept in the generator template and unsigned; the generator keeps only the `package.json`-derived parts in step with the code. Update the template with any
  change to the outlet rules or the default model names.
- **GAP:** the optional tools are unpinned and their provenance is not reviewed (`PACKAGE_REPUTATION_EVIDENCE.md`
  says so). A bundled toolchain would need its own review.
- **GAP:** no check validates the file against the CycloneDX 1.5 JSON schema in this repository; only
  JSON well-formedness is tested (`scripts/generate-sbom.test.mjs` test "the document is valid JSON on the command line").
- The hosted instance runs on a platform this repository does not control (Zeabur); its base image and
  Node.js release are not recorded.
