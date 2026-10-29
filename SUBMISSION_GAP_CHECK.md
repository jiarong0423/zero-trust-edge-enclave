# Submission Check

Updated: 2026-10-30 Asia/Taipei

## Current state

| Item | State | Evidence |
| --- | --- | --- |
| Repository | Public, MIT, GitHub `main` | `git ls-remote origin main`; 289 tracked files, equal to the manifest in `public-export-manifest.md` |
| Tests | 882 tests, all passing (`npm run test:all`, with `ffmpeg` installed); CI on Node 20 and 22 runs on pushes to `main` and on pull requests and skips the 6 composition tests that need `ffmpeg` | `package.json`, `.github/workflows/ci.yml` |
| Hosted demo | `https://enclave.jace0423.com` (self-hosted Coolify behind a Cloudflare edge since 2026-10-22), judge sign-in on the sender, audit and administration pages | `/api/health` shows the Nebius model, the USD 20 cap and the legacy hosted paths off |
| Demo video | https://youtu.be/U2Wym2BYu20, 178 s, public, uploaded 2026-10-29; the results card shows 882 tests | YouTube page and the Devpost video field |
| Judge access | Sign-in and role tokens are in `ZTE-Judges.zip` under Devpost "Additional info"; the no-sign-in route is `npm run setup:local` | `README.md`, `public/judge-login.html` |
| Secret and history scan | gitleaks over GitHub `main`: no findings (2026-10-30, 147 commits scanned) | `SECURITY_SCAN_EVIDENCE.md` |

## What was checked

- **Secrets and history:** the repository secret audit, the mutable-artifact audit and a gitleaks scan of the Git history find nothing (details in `SECURITY_SCAN_EVIDENCE.md`).
- **Public list:** the tracked files, the public list in `public-export-manifest.md` and the files on GitHub are the same set.
- **Test stability:** the main test file (`npm test`, 117 tests now) was run thirty consecutive times with no variation (when it had 115 tests); the full suite is `npm run test:all`.
- **Hosted instance:** `scripts/hosted-acceptance.mjs` and the preflight checks run against the judging instance; `/api/health` shows the model, the spending cap and that the legacy hosted paths are off.
- **Scenarios in the README ("Where This Applies"):** a price quote to two named account managers and a patient file to two clinicians, with two sources: ONC Data Brief No. 51 (about seven in 10 U.S. non-federal acute care hospitals used mail or fax for summary of care records in 2018; a 2018 figure) and NIST SP 800-53 AC-3 (via a third-party reference site).
- **Fuzz run:** 40,000 projections and 2,400 worker ticks with no invariant violation (2026-09-18); the same invariants are asserted in `scripts/delivery-followup*.test.mjs`.

Known limits of the hosted demo are listed in `SECURITY.md`.
