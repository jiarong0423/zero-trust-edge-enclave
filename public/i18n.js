export let isChinese = location.pathname.startsWith('/zh-TW/');
export const labels = {
  'Model and responsibilities': '模型狀態與權責',
  'Model status unavailable': '模型狀態尚未確認，不能視為真實呼叫。',
  'Local simulation; no real model call': '目前：本機模擬，沒有呼叫真實模型。',
  'Provider configured; successful model call not verified': '已載入模型服務設定；不代表已成功呼叫，須以任務執行證據確認。',
  'Provider not configured; no verified model call': '模型服務未就緒；尚無已驗證的真實呼叫。',
  'Configured model (not execution evidence)': '設定的模型（不代表已執行）',
  'Human approves recipients and delivery limits twice.': '人：指定收件名單與交付限制，兩次確認後核准。',
  'AI proposes an approved route, or whether to remind; it cannot read files or grant access.': 'AI：在已核准的渠道中提出路由，或判斷是否催促；不能看文件、金鑰或憑據，也不能擴權。',
  'Browser encrypts files; backend validates authority, releases keys and records receipts.': '固定程式：瀏覽器加密；後端驗證授權、控制取鑰與保存回報。加密不是 AI 執行。',
  'Delivery is simulated; no real email is sent.': '投遞：目前只模擬通知，沒有寄出真實 email。',
  'Status': '狀態', 'Reasons': '原因',
  'Retention inventory': '文件與金鑰留存盤點', 'Check retention': '檢查留存',
  'Inventory only; no automatic deletion': '只做盤點，不會自動刪除；稽核與收件紀錄繼續保留',
  RETAIN: '必須保留', CLEANUP_CANDIDATE: '可清理候選（需另行審核）',
  KEEP_NON_FILE_RECORD: '非文件紀錄', KEEP_DRAFT: '仍有草稿', KEEP_UNAPPROVED: '尚未核准',
  KEEP_UNRESOLVED_JOB: '任務尚未解決', KEEP_UNDELIVERED: '尚未完整交付', KEEP_ACTIVE_ACCESS: '仍在取用期限',
  KEEP_ACTIVE_CREDENTIAL: '仍有有效憑證', KEEP_PENDING_AUDIT: '稽核紀錄尚待寫入', KEEP_UNKNOWN_STATE: '狀態不足，保守保留',
  'Review staged file again': '接續密件審核', 'Staged encrypted file': '已暫存的加密文件',
  'Staged file restored; select recipients again': '已接回密件，請重新選取收件名單並確認兩次',
  'Refresh history before restoring': '任務版本已變更，請重新載入歷史紀錄',
  'Delivery mode': '交付模式', 'Designated recipient acknowledgement': '指定人下載並回覆確認',
  'Time-limited download': '限時下載', 'Download window minutes': '下載有效分鐘數',
  deliveryMode: '交付模式', downloadUntil: '下載截止時間',
  REQUIRED_ACK: '指定人下載並回覆確認', TIME_LIMITED: '限時下載',
  NO_DOWNLOAD_CUTOFF: '未另設下載截止（仍須有效授權）', WINDOW_OPEN: '下載期限內', WINDOW_CLOSED: '下載期限已截止',
  INVALID_DOWNLOAD_CUTOFF: '下載截止時間不正確', DOWNLOAD_WINDOW_CLOSED: '下載期限已到，停止下載',
  'Delivery deadline minutes': '希望幾分鐘內完成交付', 'Invalid delivery deadline': '交付期限不正確',
  'Acknowledged recipients': '已確認收件人數', 'AWAITING_ACKNOWLEDGEMENT': '等待收件確認',
  'ESCALATION_REQUIRED': '交付逾時，需要負責人介入', 'ACKNOWLEDGED': '收件人已確認收到',
  'Confirm complete receipt': '我已確認完整收到文件', 'Receipt acknowledged': '已回報完整收件確認',
  'Acknowledgement unconfirmed': '收件確認尚未送達，請重試',
  'Retry receipt report': '重試收件回報', 'Refresh receipt status': '查詢收件確認',
  'Receipt status unavailable': '無法取得收件確認狀態，請重試', 'File verified; confirm receipt': '已保存文件驗證紀錄，請確認完整收到',
  'Administration': '管理', 'Directory administration': '部門與人員管理', 'Load directory': '載入管理資料',
  'Download credential': '下載新身分憑據', 'Category': '類別', 'Record': '項目', 'New record': '新增項目',
  'Departments': '部門', 'People': '人員', 'Authorizations': '授權', 'Save changes': '儲存變更',
  'Rotate credential': '換發身分憑據', 'Code': '代碼', 'Name': '名稱', 'Disabled': '停用',
  'Identity type': '身分類型', 'Email': '電子郵件', 'Sender': '發文者', 'Coordinator': '協作端',
  'Channels': '允許渠道', 'Authorization expiry UTC': '授權到期時間 UTC',
  'Maximum attempts': '重試次數上限', 'Maximum key releases': '取鑰次數上限', 'Revoked': '撤銷',
  'Registry revision': '名單版本', 'Changes saved': '變更已儲存', 'Administration unavailable': '管理服務無法使用',
  'Administrator required': '需要管理員身分', 'DIRECTORY_REVISION_CONFLICT': '名單版本已更新，請重新載入',
  'DIRECTORY_VALIDATION_REJECTED': '欄位不符合名單規格', 'ACTIVE_ADMIN_REQUIRED': '不能停用目前管理員',
  'operator': '發文者', 'recipient': '收件者', 'coordinator': '協作端', 'administrator': '管理員',
  'Yes': '是', 'No': '否',
  'Refresh delivery status': '更新投遞與回執',
  'Key recipients': '已取得金鑰人數',
  'Client download reports': '收件端下載回報數',
  'Not proof of reading': '不代表已閱讀',
  CLIENT_DOWNLOAD_REPORTED: '收件端回報已請求下載（不代表已閱讀）',
  'Download requested; receipt unconfirmed': '已請求下載，回執尚未確認',
  'Delivery status unavailable': '暫時無法取得投遞狀態',
  'Status tracking stopped; backend continues': '畫面追蹤已停止，後端仍繼續處理',
  'Download original file': '下載原始文件',
  'Original file download requested': '已請求下載原始文件',
  'Identity changed; try again': '身分已變更，請重新驗證',
  'Invalid task or version': '任務代碼或版本不正確',
  'File access failed': '無法取得文件',
  'File unavailable': '文件不存在或無法取得',
  'File delivery not prepared': '文件尚未完成模擬投遞',
  'File integrity rejected': '文件完整性檢查未通過',
  'File key release limit reached': '已達金鑰取得次數上限',
  'File credential rejected': '存取憑證已失效或已使用',
  'Too many pending credentials': '待使用憑證過多，請稍後再試',
  'Select document': '選擇文件', 'Choose document': '選擇文件檔案', 'No document selected': '尚未選擇文件',
  'Encrypting locally': '正在本機加密', 'Encrypted locally': '已在本機加密',
  'File must be between 1 byte and 5 MiB': '檔案大小須介於 1 位元組與 5 MiB',
  'Approved; delivery pending': '已核准，等待投遞（尚未寄送）',
  'Choose the file again for another authorization': '切換授權名單後，請重新選擇檔案',
  'Recipients': '收件名單', 'Department': '部門', 'All departments': '全部部門',
  'Search name or email': '搜尋姓名或電子郵件', 'Selected recipients': '已選收件人',
  'Load authorized recipients': '載入授權名單', 'Reload authorized recipients': '請重新載入授權名單',
  'Select authorized recipients': '請勾選獲授權的收件人',
  'Task history': '任務紀錄', 'Refresh tasks': '載入任務', 'Show status': '查看狀態',
  'Request resume': '申請恢復執行', 'No tasks loaded': '尚未載入任務',
  'Task history loaded': '任務已載入', 'Task history unavailable': '無法載入任務',
  'Resume rejected; refresh task': '恢復遭拒，請重新載入任務',
  'AUTHORIZATION_INVALID': '授權失效', 'ACTOR_DISABLED': '發文身分已停用',
  'SNAPSHOT_INVALID': '核准版本失效', 'PACKET_CHANGED': '密文完整性驗證失敗',
  'ADVISER_UNAVAILABLE': '顧問模型無法使用', 'ADVICE_INVALID': '建議格式不合規', 'FOLLOWUP_WAIT': '判定為繼續等待', 'FOLLOWUP_REMIND': '判定為再次提醒', 'FOLLOWUP_ESCALATE': '判定為交付人工處理', 'FOLLOWUP_METADATA_INVALID': '催促投影不合規',
  'ADVICE_PAUSED': '建議暫停', 'RECIPIENT_DISABLED': '收件身分已停用',
  'DELIVERY_CONFIGURATION_INVALID': '投遞設定不合規', 'RETRY_EXHAUSTED': '重試額度已用完',
  'Loading authorizations': '正在載入授權', 'Authorizations loaded': '授權已載入',
  'No active authorizations': '目前沒有可用授權', 'Refresh authorizations': '重新載入授權',
  'procurement': '採購合約投遞',
  'unassigned': '未設定部門', 'sales': '業務部', 'accounting': '會計室',
  'management': '經理室', 'audit': '稽核室',
  'Non-content policy metadata': '非內容政策標籤', 'finance': '財務', 'cfo': '財務主管',
  'credential signature accepted': '憑證簽章通過', 'recipient role accepted': '收件角色通過',
  'registered recipient accepted; no device attestation': '收件人已驗證（未驗證硬體裝置）',
  'time window accepted': '有效期限內', 'credential already used': '憑證已使用',
  'mask customer identifiers for non-cfo roles': '非財務主管角色遮蔽客戶識別資料（建議）',
  'mask unreleased revenue figures for non-cfo roles': '非財務主管角色遮蔽未公開營收（建議）',
  INVALID_CREDENTIAL: '憑證格式不符', INVALID_SIGNATURE: '簽章不符', SUBJECT_MISMATCH: '身分不符',
  VERSION_MISMATCH: '授權版本不符', REPLAY_REJECTED: '重複使用已拒絕', INVALID_EXPIRY: '期限格式不符',
  PACKAGE_MISMATCH: '密件不符', INTEGRITY_MISMATCH: '完整性檢查未通過', POLICY_MISMATCH: '政策不符',
  CREDENTIAL_EXPIRED: '憑證已到期', POLICY_EXPIRED: '政策已到期', OPEN_LIMIT: '已達開啟上限',
  RECIPIENT_DENIED: '收件人未獲授權', DEVICE_DENIED: '裝置未獲授權', UNCLASSIFIED: '未分類原因',
  SIGNATURE_ACCEPTED: '簽章通過', RECIPIENT_ACCEPTED: '收件人通過', REGISTERED_RECIPIENT: '已登記收件人', TIME_ACCEPTED: '有效期限內',
  'Choose token file': '選擇身分憑據檔', 'No token file loaded': '尚未載入憑據檔',
  'Token file loaded': '身分憑據已載入', 'Invalid token file': '憑據檔格式不符',
  'Zero-Trust Edge Enclave': '零信任密件傳輸',
  'Nebius x NVIDIA Hackathon MVP': 'Nebius × NVIDIA 黑客松本地原型',
  'Sender Enclave': '寄件工作區', 'Recipient Decode Gate': '收件與解密', 'SOC Audit Dashboard': '操作稽核',
  'Primary navigation': '主要導覽', 'Seal internal data before it leaves the browser': '準備密件與確認交付',
  'Authorization id': '授權名單代碼', 'Document name': '文件名稱', 'Sender role': '寄件角色標籤',
  'Intended recipient role': '預期角色標籤（不代表實際授權）', 'Finance': '財務', 'CFO Office': '財務主管室',
  'Manager': '經理', 'Marketing': '行銷', 'Data category': '資料類別', 'Legal': '法務', 'HR': '人事', 'Engineering': '工程',
  'Confidentiality': '機密等級', 'Confidential': '機密', 'Restricted': '限閱', 'Internal': '內部',
  'Business purpose': '處理目的', 'Approval': '核准', 'Review': '審閱', 'Archive': '歸檔',
  'Requested expiry': '申請有效期限', '1 hour': '1 小時', '4 hours': '4 小時', '24 hours': '24 小時',
  'Device policy': '裝置政策建議', 'Managed device only': '僅受管理裝置', 'Registered device': '已登記裝置',
  'Any authenticated device': '已驗證身分的裝置', 'Open limit': '開啟次數建議', 'Single use': '單次', 'Limited use': '有限次數',
  'Internal payload': '文件內容（限測試資料）',
  'Payload content is encrypted locally. AI receives only the non-content policy metadata above.': '文件在本機加密；AI 不接收文件內容。',
  'Ask Nemotron for policy': '取得 AI 政策建議', 'Confirm 1: Lock draft': '第一次確認：固定草稿',
  'Confirm 2: Approve delivery': '第二次確認：核准交付', 'No confirmed draft.': '尚未確認草稿。',
  'Policy Control Plane': '政策建議區', 'AI recommendation': 'AI 建議', 'Checking runtime...': '檢查執行環境中',
  'No policy requested yet.': '尚未取得政策建議。', 'Sealed Delivery': '密件交付', 'Package result': '密件處理結果',
  'Create a policy and seal a package to generate a one-way delivery link.': '尚未建立已核准密件。',
  'No delivery task.': '尚無投遞任務。', 'Local access token': '本機身分憑據', 'Token file': '載入身分憑據檔',
  'Recipient Runtime': '收件端', 'Access Claim': '存取驗證', 'Authorized recipient access': '授權收件人驗證',
  'Package id': '密件代碼', 'Local passphrase': '本機解密密碼', 'Request decode': '驗證並解密',
  'Protected View': '受控檢視', 'Local browser memory render': '本機解密結果', 'No decode attempt yet.': '尚未嘗試解密。',
  'No timed credential issued.': '尚未取得短效憑證。', 'Approved content renders here after policy checks pass.': '尚無已通過驗證的內容。',
  'Paste or open a sealed link': '輸入密件代碼或開啟密件連結',
  'Security Operations': '安全紀錄', 'Runtime': '執行環境', 'Checking': '檢查中', 'Allowed': '允許', 'Denied': '拒絕',
  'Audit Events': '稽核事件', 'Access Events': '存取與投遞紀錄', 'Refresh audit': '更新紀錄', 'Time': '時間',
  'Result': '結果', 'Type': '事件', 'Snapshot version': '版本', 'Attempts': '嘗試次數', 'Task code': '任務代碼', 'Reason': '原因',
  'No audit events loaded.': '尚未載入紀錄。', 'No audit events yet.': '尚無紀錄。',
  'Draft changed. Confirm again.': '內容已修改，請重新確認。', 'Requesting policy recommendation...': '正在取得政策建議',
  'Invalidation not confirmed. Reconnect and reload task before continuing.': '尚未確認舊版失效，暫停核准；請恢復連線後檢查任務。',
  'Pending invalidation must be resolved': '必須先確認舊版失效', 'Policy required': '請先取得政策建議',
  'Authorization unavailable': '無法取得授權名單', 'Authentication required': '請先載入身分憑據',
  'Authentication failed': '身分驗證失敗', 'SNAPSHOT_REJECTED': '版本已失效、未核准或已撤銷',
  'Approved snapshot required': '需要已核准版本', 'Recipient outside approved snapshot': '收件人不在核准名單內',
  'Snapshot document mismatch': '文件與核准版本不一致', 'Stale task revision': '版本已更新，請重新確認',
  'Package id': '密件代碼', 'Ciphertext hash': '密文指紋', 'One-way delivery link': '密件存取連結',
  'Recipient passphrase for demo': '示範解密密碼（僅測試）',
  'Issuing timed access credential...': '正在申請短效存取憑證', 'Waiting for policy decision.': '等待權限驗證。',
  'Checking signed credential against decode policy...': '正在驗證憑證與存取權限',
  'Ciphertext was not released to this decode path.': '驗證未通過，未提供密文。',
  DRY_RUN_PREPARED: '通知已備妥（未寄信，仍在追蹤）', RETRY_WAIT: '等待有限重試', OUTCOME_UNKNOWN: '結果未知，停止自動重送',
  PAUSED: '嘗試次數用盡，已停止', PENDING_CHECK: '等待檢查', APPROVED: '已核准', DRAFT: '草稿', LOCKED: '已固定草稿',
  INVALIDATED: '舊版失效', REVOKED: '已撤銷', ALLOW: '允許', DENY: '拒絕', INFO: '紀錄',
  synthetic_fixture: '合成測試建議（非真實模型呼叫）', demo_fallback: '本機示範', Demo: '本機示範',
  CAPABILITY_MATCH: '符合允許的傳輸能力', STATE_CHANGED: '狀態已變更', STATE_CONFLICT: '版本或狀態衝突',
  ACCESS_DENIED: '未通過權限驗證', INVALID_REQUEST: '要求格式不符', SERVICE_UNAVAILABLE: '服務暫時不可用',
  DELIVERY_UPDATED: '投遞狀態更新', REQUEST_REJECTED: '要求被拒絕', SNAPSHOT_TRANSITION: '版本狀態變更',
  DELIVERY_TRANSITION: '投遞狀態變更', DELIVERY_FOLLOWUP: '催促決策', PACKAGE_CREATED: '密件已建立', TIMED_CREDENTIAL_ISSUED: '已發行短效憑證',
  DECODE_ATTEMPT: '解密驗證', PACKAGE_REVOKED: '密件已撤銷',
  document: '文件', taskId: '任務代碼', version: '版本', recipients: '核准收件人', channels: '允許渠道',
  expiresAt: '到期時間', commitment: '版本指紋', policy: '政策建議', envelopePreview: '封裝預覽',
  provider: '建議來源', model: '模型', riskLevel: '風險等級', classification: '分類', summary: '建議說明',
  allowedRoles: '建議角色', ttlMinutes: '有效分鐘', maxOpens: '開啟上限', deviceBindingRequired: '裝置限制建議',
  redactionRules: '遮蔽建議（非安全保證）', watermarkRequired: '浮水印建議', warnings: '提醒',
  high: '高', medium: '中', low: '低', email: '電子郵件', internal_queue: '內部佇列',
  'internal_confidential': '內部機密', createdAt: '建立時間', packageHash: '密文指紋', fileName: '文件名稱',
  senderRole: '寄件角色', aiRecommendation: 'AI 建議', signature: '完整性參照',
  credentialId: '憑證代碼', packageId: '密件代碼', role: '驗證角色', deviceClaim: '装置驗證方式', maxUses: '使用上限', policyHash: '政策指紋',
  'local-token-no-attestation': '本機憑據；未驗證硬體',
  'Demo fallback was used because NEBIUS_API_KEY is not configured. This is not hackathon submission evidence.': '未使用 Nebius API，目前為本機示範，不能當作比賽模型呼叫證據。',
  'Non-content metadata requests a high-control route for a confidential internal package.': '依非內容標籤建議較嚴格的傳輸條件。'
};
export function t(value) { return isChinese ? labels[value] || value : value; }
export function pagePath(path) { return isChinese && path.startsWith('/') ? `/zh-TW${path}` : path; }
export function displayJson(value) {
  if (!isChinese) return JSON.stringify(value, null, 2);
  const literal = new Set(['document', 'fileName', 'taskId', 'packageId', 'credentialId', 'recipients', 'commitment', 'packageHash', 'policyHash', 'signature', 'model']);
  function view(item, field) {
    if (Array.isArray(item)) return item.map(child => view(child, field));
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, child]) => [t(key), view(child, key)]));
    return typeof item === 'string' && !literal.has(field) ? t(item) : item;
  }
  return JSON.stringify(view(value), null, 2);
}
export function localize(root = document.body) {
  for (const node of root.querySelectorAll('[data-i18n]')) node.textContent = t(node.dataset.i18n);
  for (const attribute of ['placeholder', 'aria-label']) {
    for (const node of root.querySelectorAll(`[data-i18n-${attribute}]`)) {
      node.setAttribute(attribute, t(node.getAttribute(`data-i18n-${attribute}`)));
    }
  }
}
const bindings = new Map();
export function clearLocalizedText(element) { bindings.delete(element); element.removeAttribute('data-i18n'); }
export function setText(element, source) {
  element.removeAttribute('data-i18n');
  const render = typeof source === 'function' ? source : () => t(source);
  bindings.set(element, render);
  element.textContent = render();
}
export function setJson(element, value) { setText(element, () => displayJson(value)); }
let englishTitle;
function renderLanguage() {
  document.documentElement.lang = isChinese ? 'zh-Hant' : 'en';
  localize();
  for (const [element, render] of bindings) {
    if (!element.isConnected) { bindings.delete(element); continue; }
    element.textContent = render();
  }
  for (const link of document.querySelectorAll('nav a, [data-localized-link]')) {
    const original = link.getAttribute('href').replace(/^\/zh-TW(?=\/)/, '');
    link.setAttribute('href', pagePath(original));
    if (link.hasAttribute('data-localized-link')) link.textContent = location.origin + pagePath(original);
  }
  const switcher = document.querySelector('.language-switch');
  switcher.setAttribute('aria-checked', String(isChinese));
  switcher.setAttribute('aria-label', isChinese ? '切換為英文' : 'Switch to Traditional Chinese');
  switcher.title = isChinese ? '切換為英文' : 'Switch to Traditional Chinese';
  for (const segment of switcher.children) segment.classList.toggle('selected', segment.dataset.lang === (isChinese ? 'zh' : 'en'));
  document.title = isChinese ? '零信任密件傳輸｜本地測試' : englishTitle;
  window.dispatchEvent(new Event('languagechange'));
}
export function setLanguage(chinese) {
  isChinese = Boolean(chinese);
  const base = location.pathname.replace(/^\/zh-TW(?=\/)/, '');
  history.replaceState(history.state, '', pagePath(base) + location.search + location.hash);
  renderLanguage();
}
export function initializeLanguage() {
  englishTitle = document.title;
  const switcher = document.createElement('button');
  switcher.type = 'button';
  switcher.setAttribute('role', 'switch');
  switcher.className = 'language-switch';
  for (const [name, lang] of [['中', 'zh'], ['EN', 'en']]) {
    const segment = document.createElement('span');
    segment.textContent = name;
    segment.dataset.lang = lang;
    switcher.append(segment);
  }
  switcher.addEventListener('click', () => setLanguage(!isChinese));
  document.querySelector('.topbar').append(switcher);
  window.addEventListener('popstate', () => { isChinese = location.pathname.startsWith('/zh-TW/'); renderLanguage(); });
  renderLanguage();
}
