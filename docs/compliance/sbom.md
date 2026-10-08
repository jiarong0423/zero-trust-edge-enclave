# Software Bill Of Materials

Written 2026-10-08 against branch `improve/2026-10-08`. The machine-readable file is
generated on demand by `node scripts/generate-sbom.mjs` (CycloneDX 1.5 JSON on stdout; `--check` fails if `package.json` declares any dependency). The JSON is not tracked in git: the workspace commit gate treats tracked `.json` data files as mutable artifacts, and a generated document cannot drift from `package.json`.

> **Disclaimer.** An inventory of what the project is made of, written by hand. It is not generated or
> signed by tooling, not a vulnerability assessment and not a certificate. The project holds no
> certification.

## Summary

| Item | Value | How it was checked |
| --- | --- | --- |
| Application | `zero-trust-edge-enclave` 0.1.0, MIT, ES modules | `package.json`, `LICENSE` |
| Third-party runtime packages | **0** | `package.json` has no `dependencies` or `devDependencies` key (`Object.keys` of the parsed file: `name, version, description, license, type, main, scripts, engines`); no `node_modules` directory; no `package-lock.json`, `yarn.lock` or `pnpm-lock.yaml` |
| Imports | Only `node:` built-ins and relative paths; a search of every `.js` and `.mjs` file for bare-specifier `from '...'` imports found none. Two scripts load externally supplied tooling by path at run time (`PLAYWRIGHT_MODULE`, `MERMAID_DIST`) | `grep` over the tree |
| Runtime requirement | Node.js `>=20.11.0` | `package.json`, `engines.node` |
| Browser code | `public/*.js`, same origin; no external script, style or font origin | search for `http(s)://` in `public/` found only a message string; CSP is `default-src 'self'` (`http-helpers.js:12`) |
| Model components | 2 (`machine-learning-model`), both optional | see below |
| Test-only tooling | Playwright, Chromium, python-docx, reportlab, Mermaid, listed with `scope: excluded` | `PACKAGE_REPUTATION_EVIDENCE.md`; `scripts/browser-file-workflow.mjs`, `scripts/render-architecture.mjs`, `scripts/generate-native-fixtures.py` |

Because the application is its own subject, it appears as `metadata.component` in the CycloneDX file, the
convention for the described product. The `components` array holds what it relies on or is run with.

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

Services listed (CycloneDX `services`): `service-nebius-token-factory` (the only Nebius service the project
uses, `README.md`) and `service-zeabur-hosting` (the hosted demo platform).

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
node scripts/generate-sbom.mjs | node -e "JSON.parse(require('fs').readFileSync(0,'utf8')); console.log('valid JSON')"
```

Expected: `undefined undefined { node: '>=20.11.0' }`; `ls` reports each path as missing; the `grep`
prints nothing; the last line prints `valid JSON`.

## Limits

- **GAP:** hand-maintained and unsigned; no generator keeps it in step with the code. Update it with any
  change to `package.json`, the outlet rules or the default model names.
- **GAP:** the optional tools are unpinned and their provenance is not reviewed (`PACKAGE_REPUTATION_EVIDENCE.md`
  says so). A bundled toolchain would need its own review.
- **GAP:** no check validates the file against the CycloneDX 1.5 JSON schema in this repository; only
  JSON well-formedness was checked.
- The hosted instance runs on a platform this repository does not control (Zeabur); its base image and
  Node.js release are not recorded.
