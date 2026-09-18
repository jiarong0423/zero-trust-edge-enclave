import test from 'node:test';
import assert from 'node:assert/strict';

test('locale routes and display translations preserve opaque data and English defaults', async () => {
  globalThis.location = { pathname: '/zh-TW/' };
  const zh = await import('../public/i18n.js?test=zh');
  assert.equal(zh.t('Choose token file'), '選擇身分憑據檔');
  assert.equal(zh.pagePath('/decode.html?id=opaque'), '/zh-TW/decode.html?id=opaque');
  const data = JSON.parse(zh.displayJson({ document: 'Finance', recipients: ['email'], channels: ['email'] }));
  assert.equal(data['文件'], 'Finance');
  assert.deepEqual(data['核准收件人'], ['email']);
  assert.deepEqual(data['允許渠道'], ['電子郵件']);
  globalThis.location = { pathname: '/' };
  const en = await import('../public/i18n.js?test=en');
  assert.equal(en.t('Choose token file'), 'Choose token file');
  assert.equal(en.pagePath('/audit.html'), '/audit.html');
  delete globalThis.location;
});

test('in-place locale changes update bound messages without navigation or input mutation', async () => {
  const previous = Object.fromEntries(['location', 'history', 'document', 'window', 'fetch'].map(key => [key, globalThis[key]]));
  try {
    const input = { value: 'UNTRANSLATED_TEST_INPUT' };
    const status = { isConnected: true, textContent: '', removeAttribute() {} };
    const snapshot = { isConnected: true, textContent: '', removeAttribute() {} };
    const switcher = { children: [], setAttribute() {} };
    let replacements = 0;
    let events = 0;
    globalThis.location = { pathname: '/decode.html', search: '?id=test-package', hash: '#view', origin: 'http://localhost' };
    globalThis.history = { state: { preserved: true }, replaceState(state, unused, path) {
      assert.equal(state.preserved, true);
      const next = new URL(path, 'http://localhost');
      Object.assign(globalThis.location, { pathname: next.pathname, search: next.search, hash: next.hash });
      replacements += 1;
    } };
    globalThis.document = { body: { querySelectorAll: () => [] }, documentElement: {},
      querySelectorAll: () => [], querySelector: () => switcher };
    globalThis.window = { dispatchEvent(event) { assert.equal(event.type, 'languagechange'); events += 1; } };
    globalThis.fetch = () => { throw new Error('Language switch must not fetch'); };
    const i18n = await import('../public/i18n.js?test=instant');
    i18n.setText(status, 'No token file loaded');
    i18n.setJson(snapshot, { document: 'Finance', version: 1 });
    i18n.setLanguage(true);
    assert.equal(status.textContent, '尚未載入憑據檔');
    assert.equal(JSON.parse(snapshot.textContent)['文件'], 'Finance');
    assert.equal(globalThis.location.pathname, '/zh-TW/decode.html');
    i18n.setLanguage(false);
    assert.equal(status.textContent, 'No token file loaded');
    assert.equal(JSON.parse(snapshot.textContent).version, 1);
    assert.equal(globalThis.location.pathname, '/decode.html');
    assert.equal(globalThis.location.search, '?id=test-package');
    assert.equal(globalThis.location.hash, '#view');
    assert.equal(input.value, 'UNTRANSLATED_TEST_INPUT');
    assert.equal(replacements, 2);
    assert.equal(events, 2);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  }
});
