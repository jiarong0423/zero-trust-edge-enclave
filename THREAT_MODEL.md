# Threat Model

Review date: 2026-09-08. Revised 2026-09-25 for answer validation, adviser retries, the evidence chain and identity shown apart from access. Revised 2026-09-18: a second adviser was added for delivery follow-up, with its own projection and validator, and group codes were added to the private mapping for the sender and receipt surfaces, and deliberately kept out of every adviser and coordinator projection. Current file workflow, not the legacy passphrase demo. A Traditional Chinese translation follows the English text.

## Assets

| Asset | Where it lives | Who may reach it |
| --- | --- | --- |
| Document plaintext | Sender and recipient browsers only | The two humans at each end |
| Ciphertext packet and wrapped key | Local backend store | Backend process; released to an authenticated recipient |
| Document key | local-key-vault.js, wrapped per task and version | Backend only; never an adviser, never a browser |
| Private mapping | Snapshot, covered by the snapshot hash | Backend only; the file adviser receives no part of it, and the legacy coordinator receives opaque aliases without group codes |
| Recipient identity, department, address | Access registry | Operator directory view and the dispatch gate |
| Bearer tokens and key tickets | Registry token hashes; one-use tickets | The holding principal |
| Audit trail | Append-only local store with archive overflow | Administrator read path |

Provider credentials and TOKEN_SIGNING_SECRET are environment-only and enter neither browser code nor model context.

## Trust Boundary

Sender and recipient browsers handle plaintext. The local backend is trusted for key custody, private mappings and authorization. AI and coordinator tools are outside the private-data boundary.

## Data Flow

Browser encryption precedes the first confirmation, which stages ciphertext and a wrapped key. Second confirmation approves the unchanged snapshot and creates its unique job. Two advisers exist, each with its own allowlisted five-field projection and its own validator. Routing receives taskAlias, snapshotVersion, channels, state and attempts, and answers ROUTE or PAUSE. Follow-up, which applies only to a REQUIRED_ACK delivery before its deadline, receives taskAlias, snapshotVersion, timeCode, nudgeCount and pickupCode, and answers WAIT, REMIND or ESCALATE. Neither is told anything about recipients — not their identifiers, not their group codes, not how many there are. timeCode is a position within the task's own window rather than a time, and pickupCode is an ordinal, never a count, so neither can be converted back into a clock value or a headcount. A reminder's targets are resolved by fixed code from receipts no adviser sees, and whoever already collected is passed over. Recipient selection is settled by human approval before the adviser is called, and the dispatch gate resolves recipients from the snapshot afterwards. Fixed code reloads authority before dispatch. Recipients authenticate and obtain ciphertext plus a separately validated key ticket, decrypt locally and report receipt.

Revised 2026-09-25. Every adviser answer is validated by fixed code before anything acts on it, and a refused answer's content is never stored: a refused routing answer pauses the job (ADVICE_INVALID); a refused follow-up answer is recorded and reconsidered later. An adviser that cannot be reached decided nothing; a first routing check (PENDING_CHECK) asks again up to three times, 30 seconds apart, then pauses for the sender, while a delivery already in RETRY_WAIT pauses at once; follow-up backs off. Once everyone has collected, follow-up asks nothing. Each adviser call is recorded with the projection sent, the validated answer or refusal code, and which outlet answered; the sender alone can open that evidence chain, and viewing it is audited, at most once per task per minute. A verified identity is shown apart from access: a recipient who is signed in but not on the snapshot is refused at download, and the refusal is audited against the task without naming them.

## Threats And Controls

| Threat | Control and limit |
| --- | --- |
| AI expansion or injection | Strict input/output projection plus current backend checks; prompt text is not the security boundary. |
| Identity leaking into a group code | Group codes appear in the sender UI, receipts and audit, never in adviser input. Codes are synthesized as letter plus position; source identifiers and department names are used as grouping keys only and are never emitted. Positions are reshuffled on every revision so a code cannot become a durable pseudonym. |
| Adviser steering the route | Channel choice is the adviser's only real influence, and it is bounded three times: validateFileAdvice accepts only a channel already in the snapshot, resolvePrivateRoute re-checks it against snapshot content, and advanceDelivery checks it again at dispatch. The snapshot channel set is itself re-validated against the current grant on every dispatch, so an adviser can pick among approved transports but can never introduce one. |
| Adviser withholding delivery | A PAUSE stops that attempt and is recorded with reason ADVICE_PAUSED; it never revokes authorization, deletes staged bytes or hides state. The operator sees the paused job and can resume it. Abstention can delay delivery but cannot destroy it or act as a silent denial. |
| Changed list or replay | Immutable version/mapping, fresh confirmation after edits, idempotent job creation. |
| Self-claimed role | Stored principals and grant membership, not user-entered claims. |
| Stolen token | Expiry, rotation and one-use tickets; bearer theft remains a risk. |
| Unknown delivery result | Bounded retries; ambiguous outcomes do not automatically resend. |
| Expired access | Current grant and TIME_LIMITED checks; released bytes/keys cannot be recalled. |
| Tool or log leakage | Allowlisted codes; no file content, address, key or credential fields. |
| Metadata inference | Pseudonymous codes still expose timing and frequency patterns to anyone who can read audit output. The file adviser sees no recipient field at all. The legacy coordinator projection carries one opaque alias per recipient, so it discloses the approved headcount, though not the departments involved or their sizes. |
| Storage failure | Fail-closed stores and durable audit overflow; not distributed or tamper-proof storage. |
| Compromised endpoint/backend | Outside prototype protection; no independent KMS, TEE or screenshot prevention. |

A prepared notice is not sent mail. Acknowledgement is not verified reading or a legal signature. Opaque ciphertext cannot be malware-scanned by these controls. Release scanners inspect source, not private document ingestion. Input rejection, model abstention and fixed-gate rejection are separate evidence.

See docs/agent/security-gate-summary.md for scoped review; tests are not a production penetration test or compliance assessment.

---

# 威脅模型（繁體中文）

檢視日期 2026-09-08。2026-09-18 修訂：新增投遞催促顧問，具備獨立投影與驗證器；私有映射表新增組別代號供發文者介面與收據使用，並刻意排除於所有顧問與協調投影之外。適用目前的檔案流程，非舊版通行碼展示。本節為上方英文內容的翻譯。

## 資產

| 資產 | 存放位置 | 可觸及者 |
| --- | --- | --- |
| 文件明文 | 僅寄件人與收件人瀏覽器 | 兩端的人 |
| 密文封包與封裝金鑰 | 本機後端儲存 | 後端程序；通過驗證的收件人 |
| 文件金鑰 | local-key-vault.js，依任務與版本分別封裝 | 僅後端，不進顧問模型與瀏覽器 |
| 私有映射表 | 快照內，受快照雜湊保護 | 僅後端；檔案顧問模型完全拿不到，legacy 協調端只拿到不含組別代號的不透明別名 |
| 收件人身分、部門、位址 | 存取名冊 | 發文者目錄檢視與投遞閘門 |
| Bearer token 與金鑰票券 | 名冊僅存雜湊；票券一次有效 | 持有該憑證的主體 |
| 稽核軌跡 | 唯附加本機儲存含封存溢位 | 管理員讀取路徑 |

供應商金鑰與 TOKEN_SIGNING_SECRET 僅存於環境變數，不進入瀏覽器程式碼，也不進入模型上下文。

## 信任邊界

寄件人與收件人瀏覽器處理明文。本機後端負責金鑰保管、私有映射與授權。AI 與協調工具位於私有資料邊界之外。

## 資料流

瀏覽器加密先於第一次確認，該次確認暫存密文與封裝金鑰。第二次確認核准未變動的快照並建立唯一工作。有兩個顧問模型，各自有獨立的五欄投影與獨立的驗證器。路由顧問收到 taskAlias、snapshotVersion、channels、state、attempts，回答 ROUTE 或 PAUSE。催促顧問只用於 REQUIRED_ACK 模式且期限未到的投遞，收到 taskAlias、snapshotVersion、timeCode、nudgeCount、pickupCode，回答 WAIT、REMIND 或 ESCALATE。兩者對收件人都一無所知 —— 不知道識別碼、不知道組別代號、也不知道有幾個人。timeCode 是該任務自身窗口內的相對位置而非時間，pickupCode 是序位而非數量，兩者都無法反推回時鐘值或人數。提醒要送給誰由固定程式從顧問看不到的收據還原，已經領取者直接跳過。收件人由人在呼叫模型之前核准決定，之後由投遞閘門從快照還原。固定程式在派送前重新載入授權。收件人通過驗證後取得密文與另行驗證的金鑰票券，在本地解密並回報收訖。

2026-09-25 修訂：每個顧問回答都先經固定程式驗證才會被採用，被拒的回答內容不落地：路由回答被拒讓工作暫停（ADVICE_INVALID）；催促回答被拒只記錄、稍後再考慮。連不上的顧問等於沒有做決定：首次路由檢查（PENDING_CHECK）以 30 秒間隔最多再問 3 次，仍不可用才暫停交給發文者；已在 RETRY_WAIT 的投遞則直接暫停；催促則逐步拉長間隔。全員都已領取後，催促不再詢問模型。每次顧問呼叫都記錄送出的投影、通過驗證的回答或拒絕碼、以及由哪個出口回答；只有發文者能開啟這條證據鏈，查看會寫入稽核（同一任務每分鐘最多一筆）。身分驗證與存取授權分開顯示：已登入但不在快照名單上的收件人，下載時被拒，拒絕記錄綁定任務、不寫名字。

## 威脅與控制

| 威脅 | 控制與限制 |
| --- | --- |
| AI 擴權或注入 | 嚴格輸入輸出投影加上後端即時檢查；提示詞不是安全邊界。 |
| 真實身分洩入組別代號 | 組別代號只出現在發文者介面、收據與稽核，不進入顧問模型的輸入。代號由字母加序號合成；來源識別碼與部門名稱僅作分組鍵，從不輸出。序號每次改版重洗，代號無法成為長期假名。 |
| 顧問模型操縱路由選擇 | 渠道選擇是顧問模型唯一的實質影響力，並受三重限制：validateFileAdvice 只接受快照內既有的渠道，resolvePrivateRoute 對快照內容再查一次，advanceDelivery 於派送時第三次檢查。快照渠道集合本身在每次派送時對當前授權重新驗證，因此顧問模型只能在已核准的傳輸方式之間選擇，無法引入新的。 |
| 顧問模型拒絕投遞 | PAUSE 只中止該次嘗試並以 ADVICE_PAUSED 記錄；不撤銷授權、不刪除已暫存的位元組、不隱藏狀態。發文者看得到暫停的工作並可恢復。棄權能延遲投遞，但無法銷毀它，也不構成無聲的阻斷。 |
| 清單變動或重放 | 版本與映射不可變，編輯後須重新確認，工作建立具冪等性。 |
| 自稱身分 | 以既存主體與授權成員為準，不採使用者自述。 |
| token 遭竊 | 具期限、輪替與一次性票券；bearer 遭竊仍是風險。 |
| 投遞結果不明 | 有限重試；結果不明不自動重送。 |
| 存取過期 | 即時授權與 TIME_LIMITED 檢查；已釋出的位元組與金鑰無法收回。 |
| 工具或日誌洩漏 | 僅允許代碼欄位；無檔案內容、位址、金鑰或憑證。 |
| 中介資料推論 | 對讀得到稽核輸出的人而言，假名代號仍會暴露時間與頻率特徵。檔案顧問模型完全看不到收件人欄位。legacy 協調投影每位收件人一個不透明別名，因此會暴露核准人數，但不暴露涉及哪些部門或各部門人數。 |
| 儲存失效 | 失效即關閉並保留稽核溢位；非分散式或防竄改儲存。 |
| 端點或後端遭入侵 | 超出原型保護範圍；無獨立 KMS、TEE 或截圖防護。 |

已備妥的通知不等於已寄出的郵件。收訖回報不等於已驗證的閱讀或法律簽署。這些控制無法對不透明密文做惡意程式掃描。發布掃描器檢查的是原始碼，不是私有文件的攝入。輸入拒絕、模型棄權與固定閘門拒絕屬於三份各自獨立的證據。

範圍性審查見 docs/agent/security-gate-summary.md；測試不等於正式滲透測試或合規評估。
