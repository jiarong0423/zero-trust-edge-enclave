#!/usr/bin/env node
// Plays the demo video's storyboard on two real screens at once, so that a person only has to press Record. The manager's side runs in
// a clean Chrome window on this computer (no address bar, no browser branding) and the employee's side in Chrome on a phone connected
// with adb. Both talk to a local build with synthetic data: two employees named 劉文祥 told apart by employee number, and one called 劉慶龍.
// Each step shows an English caption (the narration), a red ring where the "mouse" goes, and then really does what it shows.
//
//   node scripts/demo-choreography.mjs --rehearse            run it once for checking: no countdown, a screenshot after every scene
//   node scripts/demo-choreography.mjs --countdown 10         start recording first; the window counts down, then the demo plays
//   Options: --no-phone (the employee side runs in a second window instead), --model local|synthetic (default: local if LM Studio answers)
//
// Only synthetic data and test tokens, on 127.0.0.1 / localhost. It never touches the hosted site.
import { spawn, execFileSync } from 'node:child_process';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { prepare } from './demo-local-same-name.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => { const i = process.argv.indexOf('--' + name); return i > -1 ? (process.argv[i + 1]?.startsWith('--') || process.argv[i + 1] === undefined ? true : process.argv[i + 1]) : fallback; };
const REHEARSE = process.argv.includes('--rehearse');
const COUNTDOWN = REHEARSE ? 0 : Number(arg('countdown', 20));
const NO_PHONE = process.argv.includes('--no-phone');
const PORT = 3344, MAC_CDP = 9340, PHONE_CDP = 9222;
const BASE = `http://127.0.0.1:${PORT}`, PHONE_BASE = `http://localhost:${PORT}`;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SAMPLE = path.join(root, 'docs/demo/samples/Q3-2026-Board-Financial-Summary.pdf');

// ---------- the storyboard: what is said, in order. Two promises run through it, and each scene says which one it is showing:
// BOUNDARY (fixed code decides who may receive; the AI never decides) and FLEXIBLE AI (the AI sits only where a bad answer is harmless, and
// where it runs is chosen by what is available: the local model first, Nebius Token Factory when the local one is not there).
export const CAPTIONS = {
  open: 'HR, finance and legal send confidential files to named employees every day. Send one to the wrong person and it is a breach.',
  roster: 'Here, two employees are both called 劉文祥. Two promises: fixed code keeps the boundary, and the AI sits only where a bad answer is harmless.',
  find: 'Boundary: the name plus the employee number picks the right person. Fixed code decides, and the AI never sees a name.',
  confirm: 'Boundary: the manager confirms twice, and only people on the approved list can be chosen. Nothing leaves before both.',
  ai: 'Flexible AI: Nemotron only proposes, from five coded fields and no names. The local Nano model answered first. For this demo the local server stops after one answer, so Nemotron Super on Nebius Token Factory takes the next call. Fixed code can overrule either.',
  phone: 'Now the employee, on their own phone. No shared sign-in: only their own token.',
  inbox: 'The inbox lists only what was approved for them: who it is from and when it expires, never a file name.',
  download: 'The file is decrypted inside the phone\'s browser and saved, byte for byte.',
  denied: 'The other 劉文祥 is signed in too, but was not picked: access denied.',
  card: 'Measured, and honest: not end-to-end encrypted, notices are simulated, and no claim that AI beats the rules.',
  end: 'Boundary sense, and flexible orchestration of the AI, on Nemotron and Nebius Token Factory.'
};
export const BADGES = { find: 'boundary', confirm: 'boundary', ai: 'flexible', phone: 'boundary', inbox: 'boundary', download: 'boundary', denied: 'boundary' };
export const BADGE_TEXT = { boundary: 'BOUNDARY \u00b7 fixed code decides', flexible: 'FLEXIBLE AI \u00b7 placed by what is available' };
export const CARD = ['812 tests pass', 'Stalled connections: 59.9 s \u2192 17 ms', 'AI: Nemotron 3 Nano on this computer, Nemotron 3 Super on Nebius Token Factory', 'Three cascade runs measured 2026-10-10: $0.000856 in all', 'Server holds the key: not end-to-end encryption',
  'Email and webhook notices are simulated', 'Same-name finder: local build; hosted demo shows the core flow'];
export const SCENE_SECONDS = { open: 10, roster: 13, find: 20, confirm: 28, ai: 26, phone: 11, inbox: 10, download: 16, denied: 14, card: 18, end: 8 };
export const totalSeconds = () => Object.values(SCENE_SECONDS).reduce((a, b) => a + b, 0);

// ---------- helpers that run inside each page: captions, the red ring, typing, clicking
const OVERLAY = `(() => {
  if (window.__demo) return;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const small = innerWidth < 700;
  // The site's content security policy refuses an injected <style> element, so every look is set through the element's own style object.
  const make = (id, css) => { const el = document.createElement('div'); el.id = id; el.style.cssText = css; document.documentElement.append(el); return el; };
  const font = (px) => 'font:600 ' + px + 'px/1.45 -apple-system,system-ui,sans-serif;';
  const cap = make('__cap', 'position:fixed;left:0;right:0;bottom:0;z-index:2147483646;background:rgba(10,22,19,.93);color:#fff;padding:14px 22px;text-align:center;display:none;' + font(small ? 15 : 24));
  const cur = make('__cur', 'position:fixed;left:0;top:0;width:30px;height:30px;margin:-15px 0 0 -15px;border:4px solid #e11d48;border-radius:50%;z-index:2147483647;pointer-events:none;box-shadow:0 0 0 3px rgba(255,255,255,.75);transition:transform .65s cubic-bezier(.4,0,.2,1);transform:translate(-100px,-100px)');
  const card = make('__card', 'position:fixed;left:0;right:0;top:0;bottom:0;z-index:2147483645;background:#0e1f1b;color:#e8f2ed;display:none;flex-direction:column;justify-content:center;align-items:flex-start;padding:6vw;box-sizing:border-box;' + font(small ? 18 : 32));
  const badge = make('__badge', 'position:fixed;z-index:2147483646;display:none;padding:' + (small ? '4px 10px' : '8px 16px') + ';border-radius:999px;color:#fff;letter-spacing:.04em;' + font(small ? 12 : 17) + (small ? 'right:8px;top:8px;' : 'left:22px;top:86px;'));
  const target = sel => typeof sel === 'string' ? document.querySelector(sel) : sel;
  window.__demo = {
    badge(text, color) { badge.textContent = text || ''; badge.style.background = color || '#0f766e'; badge.style.display = text ? 'block' : 'none'; },
    caption(text) { cap.textContent = text || ''; cap.style.display = text ? 'block' : 'none'; },
    card(title, lines) {
      if (!title) { card.style.display = 'none'; return; }
      card.replaceChildren();
      const h = document.createElement('div'); h.textContent = title; h.style.cssText = 'color:#6ee7b7;font-size:1.2em;margin-bottom:.7em'; card.append(h);
      for (const l of lines) { const li = document.createElement('div'); li.textContent = '\\u2713  ' + l; li.style.cssText = 'margin:.15em 0'; card.append(li); }
      card.style.display = 'flex';
    },
    async point(sel) {
      const el = target(sel); if (!el) throw new Error('missing ' + sel);
      el.scrollIntoView({ block: 'center', behavior: 'smooth' }); await sleep(500);
      const r = el.getBoundingClientRect(); cur.style.transform = 'translate(' + (r.left + Math.min(r.width / 2, 120)) + 'px,' + (r.top + r.height / 2) + 'px)'; await sleep(750); return el;
    },
    async pulse() {
      cur.animate([{ boxShadow: '0 0 0 3px rgba(255,255,255,.75), 0 0 0 0 rgba(225,29,72,.7)' }, { boxShadow: '0 0 0 3px rgba(255,255,255,.75), 0 0 0 28px rgba(225,29,72,0)' }], { duration: 450 });
      await sleep(220);
    },
    async click(sel) {
      const el = await this.point(sel); await this.pulse(); el.click(); await sleep(380);
    },
    async type(sel, text, delay = 85) {
      const el = await this.point(sel); el.focus(); el.value = '';
      for (const ch of text) { el.value += ch; el.dispatchEvent(new Event('input', { bubbles: true })); await sleep(delay); }
      el.dispatchEvent(new Event('change', { bubbles: true })); await sleep(250);
    },
    hide() { cur.style.transform = 'translate(-100px,-100px)'; }
  };
})()`;

// ---------- the local model as seen by the server: a pass-through that stops answering after `allowed` completions, exactly like a stopped local server
function limitedProxy(listenPort, targetPort, allowed) {
  const state = { seen: 0 };
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && /chat\/completions/.test(req.url) && (state.seen += 1) > allowed) { req.socket.destroy(); return; }
    const up = http.request({ host: '127.0.0.1', port: targetPort, path: req.url, method: req.method, headers: req.headers }, r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    up.on('error', () => req.socket.destroy()); req.pipe(up);
  });
  return new Promise(resolve => server.listen(listenPort, '127.0.0.1', () => resolve({ server, state })));
}

// ---------- a minimal Chrome DevTools client for one tab
async function connect(wsUrl, { overlay = true } = {}) {
  const ws = new WebSocket(wsUrl); await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
  let n = 0; const pending = new Map();
  const choosers = [];   // file choosers the page opened, waiting for a file
  ws.addEventListener('message', event => { const m = JSON.parse(event.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } else if (m.method === 'Page.fileChooserOpened') choosers.push(m.params); });
  const send = (method, params = {}) => new Promise(resolve => { const id = ++n; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
  await send('Page.enable'); await send('Runtime.enable'); await send('DOM.enable');
  await send('Page.setInterceptFileChooserDialog', { enabled: true });
  if (overlay) await send('Page.addScriptToEvaluateOnNewDocument', { source: OVERLAY });
  const ev = async (expression, timeout = 30000) => {
    const reply = await Promise.race([send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }), sleep(timeout).then(() => ({ timedOut: true }))]);
    if (reply.timedOut) throw new Error('timeout: ' + expression.slice(0, 70));
    if (reply.result?.exceptionDetails) throw new Error('page error: ' + (reply.result.exceptionDetails.exception?.description || reply.result.exceptionDetails.text).split('\n')[0]);
    return reply.result?.result?.value;
  };
  const page = { ev, send, close: () => ws.close() };
  page.ready = async () => { for (let i = 0; i < 40; i += 1) { try { if (await ev('document.readyState === "complete" && location.href !== "about:blank"', 3000)) { if (!(await ev('typeof __demo !== "undefined"'))) await ev(OVERLAY); return; } } catch { /* navigating */ } await sleep(250); } };
  page.go = async url => { await send('Page.navigate', { url }); await sleep(500); await page.ready(); };
  page.waitFor = async (expression, ms = 12000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await ev(expression, 4000)) return true; } catch { /* page busy */ } await sleep(200); } return false; };
  page.caption = text => ev(`__demo.caption(${JSON.stringify(text)})`).catch(() => {});
  page.click = sel => ev(`__demo.click(${JSON.stringify(sel)})`, 20000);
  page.type = (sel, text, delay) => ev(`__demo.type(${JSON.stringify(sel)}, ${JSON.stringify(text)}, ${delay ?? 85})`, 60000);
  // Presses a button that opens a file chooser (the "mouse" goes to it), then hands the chooser a real file by its path. The page behaves exactly as
  // if a person had picked that file; the system's own file window is not shown. Falls back to the given function if no chooser opens.
  page.chooseFile = async (buttonExpr, filePath, fallback) => {
    choosers.length = 0;
    // buttonExpr is either a CSS selector (quoted) or an expression that finds the button; tag it so the overlay can point at it.
    const sel = /^"/.test(buttonExpr) ? JSON.parse(buttonExpr) : (await ev(`(() => { const b = ${buttonExpr}; if (!b) return ''; b.setAttribute('data-demo-pick', '1'); return '[data-demo-pick]'; })()`)) ;
    if (!sel) { if (fallback) await fallback(); return false; }
    // A real mouse press (not el.click()): Chrome only opens a file chooser for a genuine user action.
    const at = await ev(`__demo.point(${JSON.stringify(sel)}).then(el => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })`, 20000);
    await ev('__demo.pulse()', 5000);
    for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 });
    for (let i = 0; i < 40 && !choosers.length; i += 1) await sleep(100);
    const opened = choosers.shift();
    if (opened) { await send('DOM.setFileInputFiles', { files: [filePath], backendNodeId: opened.backendNodeId }); await sleep(800);
      const unreadable = /\.token$/.test(filePath) && await ev(`/Invalid token file/.test(document.body.innerText)`);
      console.log('  picked file: ' + path.basename(filePath) + (unreadable ? ' (this browser could not read it; typed instead)' : ''));
      if (unreadable && fallback) await fallback();
      return true; }
    console.log('  no file chooser opened for ' + path.basename(filePath) + '; typed instead');
    if (fallback) await fallback();
    return false;
  };
  page.shot = async file => { const r = await send('Page.captureScreenshot', { format: 'png' }); if (r.result?.data) await fs.writeFile(file, Buffer.from(r.result.data, 'base64')); };
  return page;
}
const listTabs = async port => (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).filter(t => t.type === 'page');

async function main() {
  const dir = path.join(os.homedir(), 'zte-local-demo');
  const info = await prepare(dir);
  const token = id => fs.readFile(path.join(dir, id + '.token'), 'utf8').then(text => text.trim());
  const shots = path.join(os.tmpdir(), 'demo-shots-' + Date.now()); await fs.mkdir(shots, { recursive: true });
  const cleanups = [];
  const stop = async () => { for (const fn of cleanups.reverse()) { try { await fn(); } catch { /* best effort */ } } };
  process.on('SIGINT', async () => { await stop(); process.exit(130); });
  try {
    // 1. the server (a real local model when LM Studio answers, else the synthetic adviser)
    const lm = await fetch('http://127.0.0.1:1234/v1/models', { signal: AbortSignal.timeout(1500) }).then(r => r.ok, () => false);
    const useModel = arg('model', lm ? 'local' : 'synthetic') === 'local' && lm;
    const hasKey = await fs.readFile(path.join(root, '.env'), 'utf8').then(text => /^NEBIUS_API_KEY=.+/m.test(text), () => false);
    const cascade = useModel && hasKey && arg('cloud', 'on') !== 'off';
    let proxy;
    if (cascade) {
      // warm the local model first (a cold first call can be slow enough to be given up on), then let the server see it through the proxy
      await fetch('http://127.0.0.1:1234/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'nvidia-nemotron-3-nano-4b', max_tokens: 4, messages: [{ role: 'user', content: 'ok' }] }), signal: AbortSignal.timeout(60000) }).catch(() => {});
      proxy = await limitedProxy(1235, 1234, 1); cleanups.push(() => proxy.server.close());
    }
    const server = spawn(process.execPath, ['server.js'], { cwd: root, stdio: 'ignore', env: { ...process.env, DATA_DIR: dir, PORT: String(PORT), HOST: '127.0.0.1',
      ...(cascade ? { LOCAL_ONLY: 'false', COORDINATOR_PROVIDER: 'local_then_nebius', LEGACY_HOSTED_ADVICE: 'off', NEBIUS_BUDGET_USD: '0.5', NEBIUS_PRICE_INPUT_PER_M: '0.30', NEBIUS_PRICE_OUTPUT_PER_M: '0.90', LOCAL_MODEL_BASE_URL: 'http://127.0.0.1:1235/v1' }
        : { LOCAL_ONLY: 'true', COORDINATOR_PROVIDER: useModel ? 'local_openai_compatible' : 'synthetic_fixture', LOCAL_MODEL_BASE_URL: 'http://127.0.0.1:1234/v1' }), LOCAL_MODEL_NAME: 'nvidia-nemotron-3-nano-4b' } });
    cleanups.push(() => server.kill());
    for (let i = 0; i < 40; i += 1) { if (await fetch(BASE + '/api/health').then(r => r.ok, () => false)) break; await sleep(250); }
    console.log(`server up (adviser: ${cascade ? 'Nemotron 3 Nano 4B on this machine, then Nemotron 3 Super on Nebius Token Factory' : useModel ? 'Nemotron 3 Nano 4B on this machine' : 'synthetic fixture'}); demo data in ${dir}${info.created ? ' (created)' : ''}`);

    // 2. the manager's window: clean, no address bar
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'demo-chrome-'));
    const chrome = spawn(CHROME, [`--user-data-dir=${profile}`, `--remote-debugging-port=${MAC_CDP}`, '--no-first-run', '--no-default-browser-check', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--window-size=1280,760', '--window-position=60,60', `--app=${BASE}/`], { stdio: 'ignore' });
    cleanups.push(() => { chrome.kill(); return fs.rm(profile, { recursive: true, force: true }); });
    let tabs = []; for (let i = 0; i < 40 && !tabs.length; i += 1) { tabs = await listTabs(MAC_CDP).catch(() => []); await sleep(250); }
    const mac = await connect(tabs[0].webSocketDebuggerUrl); await mac.ready();

    // 3. the employee's phone (or a second window)
    let phone;
    if (!NO_PHONE) {
      execFileSync('adb', ['reverse', `tcp:${PORT}`, `tcp:${PORT}`], { stdio: 'ignore' }); execFileSync('adb', ['forward', `tcp:${PHONE_CDP}`, 'localabstract:chrome_devtools_remote'], { stdio: 'ignore' });
      execFileSync('adb', ['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'], { stdio: 'ignore' });
      cleanups.push(() => { execFileSync('adb', ['reverse', '--remove-all'], { stdio: 'ignore' }); execFileSync('adb', ['forward', '--remove-all'], { stdio: 'ignore' }); });
      const before = new Set((await listTabs(PHONE_CDP)).map(t => t.id));
      execFileSync('adb', ['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', `${PHONE_BASE}/decode.html`, 'com.android.chrome'], { stdio: 'ignore' });
      let found; for (let i = 0; i < 60 && !found; i += 1) { found = (await listTabs(PHONE_CDP)).find(t => !before.has(t.id) && t.url.startsWith(PHONE_BASE)); await sleep(250); }
      if (!found) throw new Error('the phone did not open the page (is it unlocked and awake?)');
      cleanups.push(() => fetch(`http://127.0.0.1:${PHONE_CDP}/json/close/${found.id}`));
      phone = await connect(found.webSocketDebuggerUrl); await phone.ready();
    }

    // 4. the countdown, so recording can be started first
    // The countdown is dark on both screens and ends in the same instant: the composing script finds that moment in each recording and lines them up.
    if (COUNTDOWN) for (let s = COUNTDOWN; s > 0; s -= 1) { const text = `__demo.card('Recording starts in ${s}', ['Stay still; the demo plays by itself'])`; await Promise.all([mac.ev(text), phone ? phone.ev(text) : null]); await sleep(1000); }
    await Promise.all([mac.ev(`__demo.card(null)`), phone ? phone.ev(`__demo.card(null)`) : null]);
    console.log(`the Mac window is 1280x760 points at (60,60); record that region (QuickTime: New Screen Recording, drag a box around the window)`);
    const t0 = Date.now(); const scene = async (name, fn) => {
      const started = Date.now(); const budget = SCENE_SECONDS[name] * 1000;
      await mac.caption(CAPTIONS[name]); if (phone) await phone.caption(CAPTIONS[name]);
      const badge = BADGES[name] ? `__demo.badge(${JSON.stringify(BADGE_TEXT[BADGES[name]])}, ${JSON.stringify(BADGES[name] === 'flexible' ? '#7c3aed' : '#0f766e')})` : '__demo.badge(null)';
      await mac.ev(badge); if (phone) await phone.ev(badge);
      await fn();
      const left = budget - (Date.now() - started); if (left > 0) await sleep(left); else console.log(`  (scene ${name} ran ${(-left / 1000).toFixed(1)}s long)`);
      if (REHEARSE) { await mac.shot(path.join(shots, `${name}-mac.png`)); if (phone) await phone.shot(path.join(shots, `${name}-phone.png`)); }
      console.log(`scene ${name.padEnd(9)} done at ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    };

    const managerToken = await token('manager-sender');
    await scene('open', async () => {
      await mac.go(`${BASE}/`);
      await mac.chooseFile(`[...document.querySelectorAll('.token-file-row button')].find(b => /Choose token file/.test(b.textContent))`, path.join(dir, 'manager-sender.token'), () => mac.type('#accessToken', managerToken, 12));
      await mac.waitFor(`/IDENTITY VERIFIED/.test(document.body.innerText)`);
    });
    await scene('roster', async () => {
      const b64 = (await fs.readFile(SAMPLE)).toString('base64');
      await mac.chooseFile('"#chooseDocument"', SAMPLE, () => mac.ev(`(()=>{const bin=atob(${JSON.stringify(b64)});const u=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i);const dt=new DataTransfer();dt.items.add(new File([u],'Q3-2026-Board-Financial-Summary.pdf',{type:'application/pdf'}));const fi=document.getElementById('documentFile');fi.files=dt.files;fi.dispatchEvent(new Event('change',{bubbles:true}))})()`));
      await mac.waitFor(`document.querySelectorAll('#recipientList input[type=checkbox]').length >= 3`, 15000);
      await mac.ev(`__demo.point('#recipientList')`);
    });
    await scene('find', async () => {
      await mac.type('#findNameZh', '劉文祥');
      await mac.click('#findRecipient');
      await mac.waitFor(`/More than one person|不只一位|Enter the employee number/.test(document.querySelector('#recipientFind').innerText)`, 10000);
      await sleep(2200);
      await mac.type('#findEmployeeId', 'sales-b');
      await mac.click('#findRecipient');
      await mac.waitFor(`document.querySelectorAll('#recipientList input:checked').length === 1`, 10000);
    });
    let link = '';
    await scene('confirm', async () => {
      await mac.click('#sealBtn'); await mac.waitFor(`!document.getElementById('approveBtn').disabled`, 12000);
      await mac.click('#approveBtn'); await mac.waitFor(`/DRY_RUN_PREPARED/.test(document.getElementById('deliveryStatus').innerText)`, 25000);
      link = await mac.ev(`document.getElementById('recipientLink').href`);
      await mac.ev(`__demo.point('#recipientLink')`);
    });

    await scene('ai', async () => {
      await mac.go(`${BASE}/audit.html`); await mac.ev(`new Promise(r => { const t = setInterval(() => { if (document.getElementById('accessToken') && window.__demo) { clearInterval(t); r(1); } }, 100); setTimeout(() => { clearInterval(t); r(0); }, 8000); })`);
      await mac.chooseFile(`[...document.querySelectorAll('.token-file-row button')].find(b => /Choose token file/.test(b.textContent))`, path.join(dir, 'manager-sender.token'), () => mac.type('#accessToken', managerToken, 6));
      await mac.waitFor(`/IDENTITY VERIFIED/.test(document.body.innerText)`);
      await mac.ev(`[...document.querySelectorAll('button')].find(b=>/refresh/i.test(b.textContent))?.click()`); await sleep(1500);
      const thisTask = new URL(link, BASE).searchParams.get('id');
      await mac.ev(`(()=>{const s=document.getElementById('evidenceTask');if(s&&s.options.length){const at=[...s.options].findIndex(o=>o.value===${JSON.stringify(thisTask)});s.selectedIndex=at>=0?at:s.options.length-1;s.dispatchEvent(new Event('change',{bubbles:true}))}})()`);
      await mac.click('#evidenceBtn'); await mac.waitFor(`document.getElementById('evidenceChain').innerText.length > 40`, 10000);
      for (const i of [2, 3]) { await mac.ev(`document.getElementById('evidenceChain').children[${i}]?.scrollIntoView({behavior:'smooth',block:'center'})`); await sleep(4200); }
      const outlets = await mac.ev(`[...document.querySelectorAll('#evidenceChain *')].filter(e => e.children.length === 0 && /outlet|Token Factory|Nebius/i.test(e.textContent)).map(e => e.textContent.trim()).join(' | ')`);
      console.log('  model rows on the audit page: ' + outlets);
      if (cascade && !/Token Factory|Nebius/i.test(outlets)) console.log('  WARNING: no Token Factory answer appears on the audit page; check the cascade');
    });
    const second = phone || await (async () => { // without a phone, a second window plays the employee
      const w = spawn(CHROME, [`--user-data-dir=${profile}-b`, `--remote-debugging-port=${MAC_CDP + 1}`, '--no-first-run', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--window-size=420,780', '--window-position=1380,60', `--app=${BASE}/decode.html`], { stdio: 'ignore' });
      cleanups.push(() => { w.kill(); return fs.rm(`${profile}-b`, { recursive: true, force: true }); });
      let t = []; for (let i = 0; i < 40 && !t.length; i += 1) { t = await listTabs(MAC_CDP + 1).catch(() => []); await sleep(250); }
      const p = await connect(t[0].webSocketDebuggerUrl); await p.ready(); return p; })();
    const pickedToken = await token('sales-b'), otherToken = await token('sales-a');
    const where = id => phone ? `/sdcard/Download/demo/${id}.token` : path.join(dir, id + '.token');
    if (phone) { execFileSync('adb', ['shell', 'mkdir', '-p', '/sdcard/Download/demo'], { stdio: 'ignore' }); for (const id of ['sales-a', 'sales-b']) execFileSync('adb', ['push', path.join(dir, id + '.token'), where(id)], { stdio: 'ignore' }); cleanups.push(() => execFileSync('adb', ['shell', 'rm', '-rf', '/sdcard/Download/demo'], { stdio: 'ignore' })); }
    await scene('phone', async () => { await second.go(`${phone ? PHONE_BASE : BASE}/decode.html`); await second.chooseFile(`[...document.querySelectorAll('.token-file-row button')].find(b => /Choose token file/.test(b.textContent))`, where('sales-b'), () => second.type('#accessToken', pickedToken, 10)); await second.waitFor(`/IDENTITY VERIFIED/.test(document.body.innerText)`); });
    await scene('inbox', async () => { await second.waitFor(`document.querySelectorAll('#inboxList button').length >= 1`, 10000); await second.ev(`__demo.point('#inboxList li')`); });
    await scene('download', async () => {
      await second.click('#inboxList button');
      await second.waitFor(`/ACCESS APPROVED/.test(document.body.innerText)`, 15000); await sleep(1800);
      await second.waitFor(`!document.getElementById('acknowledgeFile').disabled`, 10000); await second.click('#acknowledgeFile');
    });
    await scene('denied', async () => {
      const here = link.replace(BASE, phone ? PHONE_BASE : BASE);
      await second.go(here); await second.chooseFile(`[...document.querySelectorAll('.token-file-row button')].find(b => /Choose token file/.test(b.textContent))`, where('sales-a'), () => second.type('#accessToken', otherToken, 10)); await second.waitFor(`/IDENTITY VERIFIED/.test(document.body.innerText)`);
      await second.click('#decodeBtn'); await second.waitFor(`/ACCESS DENIED/.test(document.body.innerText)`, 12000);
    });
    await scene('card', async () => { await mac.ev('__demo.hide()'); await mac.ev(`__demo.card('What was measured, and what was not', ${JSON.stringify(CARD)})`); if (phone) await phone.ev(`__demo.card('805 tests pass', ['Stalled connections: 59.9 s \\u2192 17 ms','Boundary sense,','flexible orchestration of the AI'])`); });
    await scene('end', async () => { await mac.ev(`__demo.card('github.com/jiarong0423/zero-trust-edge-enclave', ['Hosted demo: enclave.jace0423.com','MIT licence'])`); });
    console.log(`played in ${((Date.now() - t0) / 1000).toFixed(0)}s (budget ${totalSeconds()}s)${REHEARSE ? `; rehearsal screenshots in ${shots}` : ''}`);
    if (!REHEARSE) console.log('STOP RECORDING NOW (the windows stay open for a few more seconds)');
    await sleep(REHEARSE ? 1500 : 8000);
  } finally { await stop(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main().then(() => process.exit(0), error => { console.error('FAILED:', error.message); process.exit(1); });
