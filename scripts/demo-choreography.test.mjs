import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { CAPTIONS, SCENE_SECONDS, CARD, OVERLAY, BADGES, BADGE_TEXT, totalSeconds, bootSource, sceneBadge, receiptText, recordCommand, useRealClick, parseStrict, captionProblem, CAPTION_PROBE } from './demo-choreography.mjs';

// The storyboard is data: every scene has words and a time, the whole fits a three-minute video, and the words can be read aloud in the time.
test('every scene has a caption and a time, and nothing is left over', () => {
  assert.deepEqual(Object.keys(CAPTIONS).sort(), Object.keys(SCENE_SECONDS).sort());
  for (const [name, text] of Object.entries(CAPTIONS)) { assert.ok(text.length > 10, name); assert.ok(SCENE_SECONDS[name] >= 4, name); }
});

test('the demo fits in three minutes with room for the countdown to be cut, and the captions can be spoken at a calm pace', () => {
  assert.ok(totalSeconds() <= 165, `storyboard is ${totalSeconds()} s`);
  for (const [name, text] of Object.entries(CAPTIONS)) {
    const words = text.replace(/[一-鿿]+/g, 'Liu').split(/\s+/).filter(Boolean).length;
    assert.ok(words / SCENE_SECONDS[name] <= 3, `${name}: ${words} words in ${SCENE_SECONDS[name]} s is too fast`);
  }
});

test('the honesty card says what the video is not claiming', () => {
  const text = CARD.join(' ').toLowerCase();
  for (const phrase of ['not end-to-end', 'simulated', 'hosted demo shows the core flow']) assert.ok(text.includes(phrase), phrase);
});

test('every badge names one of the two promises, and the Token Factory is named aloud in the scene that shows it', async () => {
  const { BADGES, BADGE_TEXT } = await import('./demo-choreography.mjs');
  for (const [scene, kind] of Object.entries(BADGES)) { assert.ok(scene in CAPTIONS, scene); assert.ok(kind in BADGE_TEXT, kind); }
  assert.deepEqual(Object.keys(BADGE_TEXT).sort(), ['boundary', 'flexible', 'zero']);
  assert.equal(BADGES.open, 'zero'); assert.equal(BADGES.roster, 'zero');   // the theme is on screen from the first second
  assert.ok(Object.values(BADGES).includes('flexible'));
  assert.match(CAPTIONS.ai, /Nebius Token Factory/);
  assert.match(CAPTIONS.ai, /Nemotron/);
});

test('the first 15 seconds carry the point: the risk, both promises, and what it is built on', () => {
  assert.ok(SCENE_SECONDS.open <= 15);
  assert.match(CAPTIONS.open, /^Zero trust/);
  assert.match(CAPTIONS.open, /wrong recipient/);
  assert.match(CAPTIONS.open, /fixed code decides who receives/);
  assert.match(CAPTIONS.open, /AI sits only where a bad answer is harmless/);
  assert.match(CAPTIONS.roster, /^Built on NVIDIA Nemotron and Nebius Token Factory/);   // read in the 4 s of the second scene that fall inside 15 s
  assert.ok(CAPTIONS.roster.split(/(?<=\.)\s/)[0].split(/\s+/).length / (15 - SCENE_SECONDS.open) <= 3);
});

test('the Token Factory is named on screen in the scene that shows it: in the badge as well as the caption', async () => {
  const { BADGES, BADGE_TEXT } = await import('./demo-choreography.mjs');
  assert.equal(BADGES.ai, 'flexible');
  assert.match(BADGE_TEXT.flexible, /Nebius Token Factory/);
  assert.ok(SCENE_SECONDS.ai >= 26);
});

test('every helper the storyboard calls on the page exists in the overlay', async () => {
  const { OVERLAY } = await import('./demo-choreography.mjs');
  const source = await (await import('node:fs/promises')).readFile(new URL('./demo-choreography.mjs', import.meta.url), 'utf8');
  const called = new Set([...source.matchAll(/__demo\.([a-zA-Z]+)\(/g)].map(m => m[1]));
  for (const name of called) assert.match(OVERLAY, new RegExp(`(^|\\s)(async\\s+)?${name}\\(`, 'm'), `__demo.${name} is called but not defined in the overlay`);
});

// ---------- the page-side overlay, run against a small stand-in for the browser's document (no real browser here)
function fakeBrowser(source, { rootReady = true } = {}) {
  const timers = [], attached = [];
  const root = { append(el) { el.isConnected = true; if (!attached.includes(el)) attached.push(el); } };
  const document = {
    documentElement: rootReady ? root : null,
    createElement: () => ({ style: {}, isConnected: false, textContent: '', remove() { this.isConnected = false; }, animate: () => ({}), replaceChildren() {}, append() {} }),
    querySelectorAll: sel => sel === '#__cap' ? attached.filter(e => e.id === '__cap' && e.isConnected) : [],
    getElementById: id => attached.find(e => e.id === id && e.isConnected) || null,
    addEventListener() {}
  };
  const sandbox = { document, innerWidth: 1920, setInterval: fn => timers.push(fn), clearInterval() {}, cancelAnimationFrame() {}, requestAnimationFrame: () => 0, addEventListener() {}, getComputedStyle: el => ({ display: el.style.display }) };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return { sandbox, document, root, attached, beat: () => timers.forEach(fn => fn()), cap: () => attached.find(e => e.id === '__cap'), badge: () => attached.find(e => e.id === '__badge') };
}

test('a new page starts with the scene\'s words: the boot script carries them in front of the overlay (F1a)', () => {
  const badge = sceneBadge('ai');
  const source = bootSource(CAPTIONS.ai, badge);
  assert.ok(source.endsWith(OVERLAY));
  const prefix = source.slice(0, source.length - OVERLAY.length);
  assert.match(prefix, /^window\.__demoBoot = /);
  assert.deepEqual(JSON.parse(prefix.replace(/^window\.__demoBoot = /, '').replace(/;\n$/, '')), { caption: CAPTIONS.ai, badge });
  assert.deepEqual(JSON.parse(bootSource('', null).split(';\n')[0].replace('window.__demoBoot = ', '')), { caption: '', badge: null });
  const { cap, badge: shown } = fakeBrowser(source);
  assert.equal(cap().textContent, CAPTIONS.ai); assert.equal(cap().style.display, 'block');
  assert.equal(shown().textContent, BADGE_TEXT.flexible); assert.equal(shown().style.background, '#7c3aed');
  assert.ok(cap().isConnected);
});

test('the heartbeat puts the caption and badge back when the page removes them, or when the root element did not exist yet (F1b)', () => {
  const page = fakeBrowser(bootSource(CAPTIONS.denied, sceneBadge('denied')));
  page.cap().isConnected = false; page.badge().isConnected = false; page.cap().textContent = 'something else';
  page.beat();
  assert.ok(page.cap().isConnected); assert.ok(page.badge().isConnected);
  assert.equal(page.cap().textContent, CAPTIONS.denied);
  assert.equal(page.sandbox.document.querySelectorAll('#__cap').length, 1);
  // a script that runs before the page has a root element: nothing is attached, then the first heartbeat attaches it with the words already set
  const early = fakeBrowser(bootSource(CAPTIONS.inbox, sceneBadge('inbox')), { rootReady: false });
  assert.equal(early.attached.length, 0);
  early.sandbox.document.documentElement = early.root; early.beat();
  assert.equal(early.cap().textContent, CAPTIONS.inbox); assert.ok(early.cap().isConnected);
  // a caption set later by the script is the one kept
  early.sandbox.__demo.caption('next words'); early.cap().isConnected = false; early.beat();
  assert.equal(early.cap().textContent, 'next words');
});

test('the end-of-scene check tests what the viewer sees: one caption, with a height, saying the scene\'s words (F1d)', () => {
  const ok = { count: 1, display: 'block', height: 60, text: CAPTIONS.find };
  assert.equal(captionProblem(ok, CAPTIONS.find), '');
  assert.match(captionProblem({ ...ok, count: 0 }, CAPTIONS.find), /0 caption elements/);
  assert.match(captionProblem({ ...ok, count: 2 }, CAPTIONS.find), /2 caption elements/);
  assert.match(captionProblem({ ...ok, height: 0, display: 'none' }, CAPTIONS.find), /height 0/);
  assert.match(captionProblem({ ...ok, text: CAPTIONS.open }, CAPTIONS.find), /other words/);
  assert.match(captionProblem(null, CAPTIONS.find), /could not be read/);
  // the probe the page runs gives exactly those fields
  const page = fakeBrowser(bootSource(CAPTIONS.find, null));
  page.cap().getBoundingClientRect = () => ({ height: 57 });
  page.sandbox.document.querySelectorAll = sel => sel === '#__cap' ? [page.cap()] : [];
  const seen = vm.runInContext(CAPTION_PROBE, page.sandbox);
  assert.deepEqual({ ...seen }, { count: 1, display: 'block', height: 57, text: CAPTIONS.find });
});

test('every scene has a badge value the page can show, and the badge helper matches the tables (F1)', () => {
  for (const name of Object.keys(CAPTIONS)) {
    const badge = sceneBadge(name);
    if (BADGES[name]) assert.equal(badge.text, BADGE_TEXT[BADGES[name]]); else assert.equal(badge, null);
  }
  assert.equal(sceneBadge('ai').color, '#7c3aed'); assert.equal(sceneBadge('find').color, '#0f766e');
});

test('page.go waits for the load event with a polling fallback, and each scene replaces the boot script (F1c, F1a): checked in the source, since it needs a real browser', async () => {
  const source = await (await import('node:fs/promises')).readFile(new URL('./demo-choreography.mjs', import.meta.url), 'utf8');
  assert.match(source, /Page\.loadEventFired/);
  assert.match(source, /Page\.removeScriptToEvaluateOnNewDocument/);
  assert.match(source, /await mac\.arm\(\); if \(phone\) await phone\.arm\(\)/);
});

test('a pointer that did not arrive never makes a real click; --strict is read from the command line (F2)', async () => {
  assert.equal(useRealClick(true, true), true);
  assert.equal(useRealClick(true, false), false);
  assert.equal(useRealClick(false, true), false);   // the phone: never the real pointer
  assert.equal(parseStrict(['node', 'demo-choreography.mjs', '--strict']), true);
  assert.equal(parseStrict(['node', 'demo-choreography.mjs', '--rehearse']), false);
  const source = await (await import('node:fs/promises')).readFile(new URL('./demo-choreography.mjs', import.meta.url), 'utf8');
  assert.equal(source.match(/mouse\('click'\)/g).length, 2);                       // the only two real clicks: press and chooseFile
  assert.equal(source.match(/useRealClick\(realMouse, at\.glided\)/g).length, 2);   // and both are guarded
});

test('the phone types its token instead of picking a file, and puts the keyboard away (F5): checked in the source, since it needs a phone', async () => {
  const source = await (await import('node:fs/promises')).readFile(new URL('./demo-choreography.mjs', import.meta.url), 'utf8');
  assert.match(source, /if \(!realMouse\) \{ console\.log\('  phone: '[^\n]*await fallback\(\)/);
  assert.match(OVERLAY, /if \(small\) el\.blur\(\)/);
  assert.match(OVERLAY, /window\.visualViewport\?\.height \|\| innerHeight/);
  assert.match(source, /visual: \[\(visualViewport/);
  assert.match(source, /second\.point\('#accessBadge'\)/);
  const html = await (await import('node:fs/promises')).readFile(new URL('../public/decode.html', import.meta.url), 'utf8');
  assert.match(html, /id="accessBadge"/);
});

test('the record command is built from the screen the browser reports (F8)', () => {
  assert.equal(recordCommand({ width: 1920, height: 1080 }), 'screencapture -v -C -R0,0,1920,1080 mac.mov');
  assert.equal(recordCommand({ width: 2056, height: 1329 }), 'screencapture -v -C -R0,0,2056,1329 mac.mov');
});

test('the receipt says it is the spend ledger, not a billed amount (F9)', () => {
  assert.equal(receiptText(0.001234, 0.002), 'Token Factory call recorded: spend ledger $0.001234 \u2192 $0.002000 (+$0.000766)');
  assert.doesNotMatch(receiptText(0, 0.5), /Real call|billed/);
});

test('the download caption claims no more than the page shows (F12)', () => {
  assert.equal(CAPTIONS.download, 'The file is decrypted inside the phone\'s browser and checked before it is offered.');
  assert.doesNotMatch(CAPTIONS.download, /byte for byte/);
});

test('on the phone a typed field is told not to open the soft keyboard, which would cover the buttons below it', async () => {
  const source = await (await import('node:fs/promises')).readFile(new URL('./demo-choreography.mjs', import.meta.url), 'utf8');
  assert.match(source, /if \(!realMouse\) await ev\(`document\.querySelector\(\$\{JSON\.stringify\(sel\)\}\)\?\.setAttribute\('inputmode', 'none'\)`\)/);
});

test('the local model is warmed with the real routing request, and a run stops before the countdown if it is too slow', async () => {
  const { routingWarmupBody, warmLocalModel } = await import('./demo-choreography.mjs');
  const { FILE_ADVISER_BOUNDARY } = await import('../file-adviser.js');
  const body = routingWarmupBody('m');
  assert.equal(body.messages[0].content, FILE_ADVISER_BOUNDARY);            // the product's own boundary text, not a stand-in
  assert.equal(body.reasoning_effort, 'none'); assert.equal(body.temperature, 0); assert.ok(body.response_format);
  assert.deepEqual(Object.keys(JSON.parse(body.messages[1].content)).sort(), ['attempts', 'channels', 'snapshotVersion', 'state', 'taskAlias']);
  const clock = { t: 0 }, now = () => clock.t;
  const answer = (...ms) => { const queue = [...ms]; return async () => { const next = queue.shift(); clock.t += next < 0 ? 100 : next; return { ok: next >= 0 }; }; };
  assert.deepEqual(await warmLocalModel('http://x/v1', 'm', { request: answer(6000, 3000, 2500), now }), [6000, 3000, 2500]);   // slow, then two quick ones in a row
  assert.deepEqual(await warmLocalModel('http://x/v1', 'm', { request: answer(-1, 2000, 2000), now }), [-1, 2000, 2000]);       // a failure counts as slow
  await assert.rejects(warmLocalModel('http://x/v1', 'm', { request: answer(5000, 5000, 5000, 5000, 5000, 5000), now }), /did not answer a routing request within 4 s twice in a row/);
  await assert.rejects(warmLocalModel('http://x/v1', 'm', { request: answer(2000, 5000, 2000, 5000, 2000, 5000), now }), /twice in a row/);   // quick answers must be consecutive
});

test('an audit page without both model lines makes the take unusable instead of passing quietly', async () => {
  const source = await (await import('node:fs/promises')).readFile(new URL('./demo-choreography.mjs', import.meta.url), 'utf8');
  assert.match(source, /TAKE NOT USABLE/);
  assert.match(source, /if \(STRICT\) throw new Error\('ERROR \(--strict\): ' \+ why\)/);
});

test('the phone card is short enough to fit the phone page, and still carries the honesty line', async () => {
  const { PHONE_CARD, CARD } = await import('./demo-choreography.mjs');
  assert.equal(PHONE_CARD[0], CARD[0]);                                     // the same test count as the computer card
  assert.ok(PHONE_CARD.length <= 5);
  assert.ok(PHONE_CARD.every(line => line.length <= 28), 'a line wraps to two or three on a 360 px screen');
  assert.ok(PHONE_CARD.join(' ').toLowerCase().includes('not end-to-end'));
});

test('the phone carries no caption or badge, and the page is told not to be translated', async () => {
  const { OVERLAY, phoneWindow, SCENE_SECONDS } = await import('./demo-choreography.mjs');
  const source = await (await import('node:fs/promises')).readFile(new URL('./demo-choreography.mjs', import.meta.url), 'utf8');
  assert.match(source, /connect\(found\.webSocketDebuggerUrl, \{ words: false \}\)/);          // the phone
  assert.match(source, /if \(phone\?\.words\) await phone\.caption/);                           // and nothing is drawn on it
  assert.match(OVERLAY, /setAttribute\('translate', 'no'\)/);
  assert.match(OVERLAY, /meta\.name = 'google'; meta\.content = 'notranslate'/);
  // the phone scenes are the stretch from the start of 'phone' to the end of 'denied'
  const before = ['open', 'roster', 'find', 'confirm', 'ai'].reduce((sum, name) => sum + SCENE_SECONDS[name], 0);
  const during = ['phone', 'inbox', 'download', 'denied'].reduce((sum, name) => sum + SCENE_SECONDS[name], 0);
  assert.deepEqual(phoneWindow(), { start: before, end: before + during });
  assert.deepEqual(phoneWindow({ a: 5, phone: 10, denied: 4, z: 9 }), { start: 5, end: 19 });
});

test('the one file the demo downloads onto the phone is removed before and after a run, and nothing else is', async () => {
  const { PHONE_DOWNLOAD } = await import('./demo-choreography.mjs');
  const source = await (await import('node:fs/promises')).readFile(new URL('./demo-choreography.mjs', import.meta.url), 'utf8');
  assert.equal(PHONE_DOWNLOAD, '/sdcard/Download/Q3-2026-Board-Financial-Summary.pdf');
  assert.equal([...source.matchAll(/'shell', 'rm', '-f', PHONE_DOWNLOAD/g)].length, 2);                       // before, and in the cleanup
  assert.equal([...source.matchAll(/'shell', 'rm'/g)].length, 2);                                              // no other phone file is ever removed
  assert.match(source, /'exec-out', 'screencap', '-p'/);                                                       // the real phone screen is kept in a rehearsal
});
