# Package Reputation Evidence

Review date: 2026-09-07
Owner: project maintainer

## Dependency Review

Status: Node runtime dependency inventory only, not blanket supply-chain approval.

The current MVP uses native Node.js modules only and does not declare third-party runtime dependencies in `package.json`.

Optional browser acceptance uses separately installed Playwright and Chromium. Optional DOCX/PDF fixture rendering uses python-docx and reportlab. Architecture rendering may use Mermaid. These tools are not included in the runtime dependency claim and are not downloaded automatically by setup or npm test. Their installed versions and provenance require separate review before distributing a bundled toolchain.

## Registry Existence

No npm package dependency lookup is required for the current dependency set.

## Maintainer Or Publisher Review

No third-party package maintainer review is required for the current dependency set.

## Release Age

No third-party package release-age review is required for the current dependency set.

## Lockfile Diff

No package lockfile exists because there are no third-party dependencies.

## Accepted Residual Risk

Future additions such as email providers, KMS clients, auth providers, WebAuthn helpers, or UI frameworks must be reviewed as supply-chain changes before install or public release.
