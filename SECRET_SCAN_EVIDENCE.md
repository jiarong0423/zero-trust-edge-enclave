# Secret Scan Evidence

Review date: 2026-09-08. Status: scoped finding review, not publication clearance.

The original candidate's four AI-scanner HIGH hits and two LocalGuard CRITICAL hits identify deliberate synthetic canaries in file-adviser.test.mjs and model-negative.test.mjs. Two entropy HIGH hits identify synthetic UUID fixtures in model-boundary-smoke.mjs and model-four-groups.mjs. These exact matches are not provider credentials and remain in tests.

This does not approve arbitrary credential-looking strings or runtime exports. See docs/agent/security-gate-summary.md for current scan results and review.

Environment secrets, runtime directories, credentials, private logs and raw provider evidence are excluded from the explicit export manifest. Git history has not been freshly cleared; no push is authorized.

## Current Scan Result

2026-09-18 `ai-security-rules rules-check` (secret scan scope): critical=0, high=5, medium=72. The five HIGH hits are synthetic canaries inside test files — file-adviser.test.mjs (2), model-negative.test.mjs (2) and local-adviser-outlet.test.mjs (1) — not provider credentials. The count moved from four to five when the loopback outlet test was added on 2026-09-15; no new credential class appeared. No HIGH or CRITICAL finding sits in runtime source, including the recipient group-code change of 2026-09-18.

The same run reports the design gate as fail with three blocking items. Two were governance-document wording gaps, closed by this section and by the threat-model Assets section. The third is the local untracked .env file: it is not in the Git index, does not appear in any commit tree across the full history, is matched by .gitignore, and build-release-candidate.mjs rejects any manifest path segment beginning with .env. That finding reflects a scan of the working directory, not export content. Passing this gate on a working directory is not export clearance; the export gate runs against the built candidate.

2026-09-18 .gitignore revision: `data/` and `output/` replaced the narrower `data/*.json`, `data/*.token` and `data/*.lock` rules. The previous rules could not cover the `data/private-keys` directory created by local-key-vault.js, nor the isolation fixture directory under `output/`. No tracked file was affected.

Scanner note: `is_binary_sample` in ai-security-rules classifies a file as binary when fewer than 70 percent of the first 4096 bytes are ASCII printable. A predominantly Traditional Chinese document falls below that threshold and is skipped entirely, including during secret scanning. Governance documents in this repository therefore keep English text first and the Chinese translation after it. This is a scanner limitation, not a property of the reviewed content.

## 本次掃描結果（繁體中文）

2026-09-18 執行 `ai-security-rules rules-check`（secret scan 範圍）：critical=0、high=5、medium=72。五筆 HIGH 全數為測試檔內的合成誘餌值，並非供應商憑證。筆數由四增為五，來自 2026-09-15 新增的 loopback 出口測試，未出現新的憑證型態。執行期原始碼中沒有任何 HIGH 或 CRITICAL，包含 2026-09-18 的收件人組別代號改動在內。

同一次執行的設計閘門判定為 fail，三項阻擋。兩項為治理文件用字缺口，已由本節與威脅模型的資產一節補上。第三項為本機未追蹤的 .env 檔：它不在 Git 索引內，全歷史所有 commit 的檔案樹中均未出現，受 .gitignore 匹配，且 build-release-candidate.mjs 會拒絕任何以 .env 開頭的清單路徑段。該項反映的是對工作目錄的掃描，而非匯出內容的風險。在工作目錄上通過此閘門不等於取得發布許可。

2026-09-18 .gitignore 修訂：以 `data/` 與 `output/` 取代原本較窄的規則，因舊規則無法涵蓋 local-key-vault.js 建立的 `data/private-keys` 目錄，也無法涵蓋 `output/` 底下的隔離測試資料目錄。無任何已追蹤檔案受影響。

掃描器限制：ai-security-rules 的 `is_binary_sample` 在前 4096 bytes 的 ASCII 可列印字元低於七成時，會將檔案判定為二進位並整份跳過，secret scan 亦然。中文為主的文件會落在門檻之下。因此本專案的治理文件一律英文在前、中文翻譯在後。這是掃描器的限制，不是被審查內容的性質。
