#!/usr/bin/env node
// Plays the demo video's storyboard on two real screens at once, so that a person only has to press Record. The manager's side runs in
// a clean Chrome window on this computer (no address bar, no browser branding) and the employee's side in Chrome on a phone connected
// with adb. Both talk to a local build with synthetic data: two employees named 劉文祥 told apart by employee number, and one called 劉慶龍.
// Each step shows an English caption (the narration), then really does what it shows. On the computer the pointer is the real macOS pointer, moved
// and clicked by scripts/os-mouse.swift at the button's screen position (record with the cursor on); on the phone a red ring marks a press sent to the page as a real input event.
//
//   node scripts/demo-choreography.mjs --rehearse            run it once for checking: no countdown, a screenshot after every scene
//   node scripts/demo-choreography.mjs --countdown 10         start recording first; the window counts down, then the demo plays
//   Options: --no-phone (the employee side runs in a second window instead), --model local|synthetic (default: local if LM Studio answers),
//   --strict (stop with an ERROR the first time the real pointer cannot be moved to a button, instead of carrying on with a scripted click)
//
// Only synthetic data and test tokens, on 127.0.0.1 / localhost. It never touches the hosted site.
import { spawn, execFile, execFileSync } from 'node:child_process';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { prepare } from './demo-local-same-name.mjs';
import { ADVISER_PROVIDERS, ADVICE_KINDS } from '../file-adviser.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => { const i = process.argv.indexOf('--' + name); return i > -1 ? (process.argv[i + 1]?.startsWith('--') || process.argv[i + 1] === undefined ? true : process.argv[i + 1]) : fallback; };
const REHEARSE = process.argv.includes('--rehearse');
const COUNTDOWN = REHEARSE ? 0 : Number(arg('countdown', 20));
const NO_PHONE = process.argv.includes('--no-phone');
export const parseStrict = argv => argv.includes('--strict');
const STRICT = parseStrict(process.argv);
const PORT = 3344, MAC_CDP = 9340, PHONE_CDP = 9222;
// The computer window is asked to be full screen at this size; the region to record is read from the screen itself once it is full screen (see recordCommand).
const WIN = { x: 0, y: 0, w: 1920, h: 1080 };
const BASE = `http://127.0.0.1:${PORT}`, PHONE_BASE = `http://localhost:${PORT}`;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SAMPLE = path.join(root, 'docs/demo/samples/Q3-2026-Board-Financial-Summary.pdf');
// The phone saves the sample under this name when the employee downloads it. A copy left from an earlier run makes Chrome ask "download again?" and that dialog
// covers the download scene, so the one file the demo itself creates is removed before and after a run (nothing else on the phone is touched).
export const PHONE_DOWNLOAD = '/sdcard/Download/' + path.basename(SAMPLE);

// ---------- the storyboard: what is said, in order. Two promises run through it, and each scene says which one it is showing:
// BOUNDARY (fixed code decides who may receive; the AI never decides) and FLEXIBLE AI (the AI sits only where a bad answer is harmless, and
// where it runs is chosen by what is available: the local model first, Nebius Token Factory when the local one is not there).
export const CAPTIONS = {
  // The first 15 seconds carry the whole point: the risk, the two promises, and what it is built on.
  open: 'Zero trust for files. A wrong recipient is a breach. Two promises: fixed code decides who receives, and the AI sits only where a bad answer is harmless.',
  roster: 'Built on NVIDIA Nemotron and Nebius Token Factory. Here the manager picks the file, and two employees are both called 劉文祥.',
  find: 'Boundary: the name plus the employee number picks the right person. Fixed code decides, and the AI never sees a name.',
  confirm: 'Boundary: the manager confirms twice, and only people on the approved list can be chosen. Nothing leaves before both.',
  ai: 'Flexible AI: Nemotron only proposes, from five coded fields and no names. The local Nano model answered first. For this demo the local server stops after one answer, so Nemotron Super on Nebius Token Factory takes the next call. Fixed code can overrule either.',
  phone: 'Now the employee, on their own phone. No shared sign-in: only their own token.',
  inbox: 'The inbox lists only what was approved for them: who it is from and when it expires, never a file name.',
  download: 'The file is decrypted inside the phone\'s browser and checked before it is offered.',
  denied: 'The other 劉文祥 is signed in too, but was not picked: access denied.',
  card: 'Measured, and honest: not end-to-end encrypted, notices are simulated, and no claim that AI beats the rules.',
  end: 'Boundary sense, and flexible orchestration of the AI, on Nemotron and Nebius Token Factory.'
};
export const BADGES = { open: 'zero', roster: 'zero', find: 'boundary', confirm: 'boundary', ai: 'flexible', phone: 'boundary', inbox: 'boundary', download: 'boundary', denied: 'boundary' };
export const BADGE_TEXT = { zero: 'ZERO TRUST \u00b7 verify every step', boundary: 'BOUNDARY \u00b7 fixed code decides', flexible: 'FLEXIBLE AI \u00b7 local Nemotron first, then Nebius Token Factory' };
export const CARD = ['843 tests pass', 'Stalled connections: 59.9 s \u2192 17 ms', 'AI: Nemotron 3 Nano on this computer, Nemotron 3 Super on Nebius Token Factory', 'Three cascade runs measured 2026-10-10: $0.000856 in all', 'Server holds the key: not end-to-end encryption',
  'Email and webhook notices are simulated', 'Same-name finder: local build; hosted demo shows the core flow'];
// The phone shows a short version of the card: its page area is only about 720x1320 and long lines were cut off at the bottom.
export const PHONE_CARD = [CARD[0], 'Stalls: 59.9 s \u2192 17 ms', 'Boundary sense', 'Flexible AI orchestration', 'Not end-to-end encrypted'];
export const SCENE_SECONDS = { open: 11, roster: 14, find: 20, confirm: 28, ai: 28, phone: 10, inbox: 9, download: 14, denied: 12, card: 13, end: 6 };
// When the phone scenes play, in seconds after the countdown: the composing script enlarges the phone during this window (--focus-phone).
export function phoneWindow(seconds = SCENE_SECONDS) {
  let at = 0, start = null, end = null;
  for (const [name, length] of Object.entries(seconds)) { if (name === 'phone') start = at; at += length; if (name === 'denied') end = at; }
  return { start, end };
}
export const totalSeconds = () => Object.values(SCENE_SECONDS).reduce((a, b) => a + b, 0);
export const sceneBadge = name => BADGES[name] ? { text: BADGE_TEXT[BADGES[name]], color: BADGES[name] === 'flexible' ? '#7c3aed' : '#0f766e' } : null;
// The receipt is the server's spend LEDGER (what it estimated from token counts), not an amount billed by Nebius, and it says so.
export const receiptText = (before, after) => `Token Factory call recorded: spend ledger $${before.toFixed(6)} \u2192 $${after.toFixed(6)} (+$${(after - before).toFixed(6)})`;
// The region to record is the screen as the browser reports it, not a constant.
export const recordCommand = ({ width, height }) => `screencapture -v -C -R0,0,${width},${height} mac.mov`;
// A real click goes wherever the pointer is, so it is only made when the pointer was really moved to the button.
export const useRealClick = (realMouse, glided) => realMouse && glided;
// What the viewer sees at the end of a scene: one caption, with a height, saying this scene's words.
export const CAPTION_PROBE = `(() => { const all = document.querySelectorAll('#__cap'); const c = all[0]; return { count: all.length, display: c ? getComputedStyle(c).display : 'none', height: c ? c.getBoundingClientRect().height : 0, text: c ? c.textContent : '' }; })()`;
export const captionProblem = (seen, expected) => !seen ? 'could not be read' : seen.count !== 1 ? seen.count + ' caption elements' : !(seen.height > 0) ? 'height ' + seen.height : seen.text !== expected ? 'other words: ' + JSON.stringify(String(seen.text).slice(0, 40)) : '';

// ---------- helpers that run inside each page: captions, the red ring, typing, clicking
export const OVERLAY = `(() => {
  if (window.__demo) return;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const small = innerWidth < 700, big = innerWidth >= 1400;
  // The site's content security policy refuses an injected <style> element, so every look is set through the element's own style object.
  // (A script that runs before a new page has its root element cannot attach yet; the heartbeat below attaches it a moment later.)
  const attach = el => { if (!el.isConnected && document.documentElement) document.documentElement.append(el); };
  const make = (id, css) => { const el = document.createElement('div'); el.id = id; el.style.cssText = css; attach(el); return el; };
  const font = (px) => 'font:600 ' + px + 'px/1.45 -apple-system,system-ui,sans-serif;';
  const cap = make('__cap', 'position:fixed;left:0;right:0;bottom:0;z-index:2147483646;background:rgba(10,22,19,.93);color:#fff;padding:14px 22px;text-align:center;display:none;pointer-events:none;' + font(small ? 15 : big ? 28 : 24));
  const cur = make('__cur', 'position:fixed;left:0;top:0;width:30px;height:30px;margin:-15px 0 0 -15px;border:4px solid #e11d48;border-radius:50%;z-index:2147483647;pointer-events:none;box-shadow:0 0 0 3px rgba(255,255,255,.75);transition:transform .65s cubic-bezier(.4,0,.2,1);transform:translate(-100px,-100px)');
  const card = make('__card', 'position:fixed;left:0;right:0;top:0;bottom:0;z-index:2147483645;background:#0e1f1b;color:#e8f2ed;display:none;flex-direction:column;justify-content:center;align-items:flex-start;padding:6vw;box-sizing:border-box;pointer-events:none;' + font(small ? 16 : big ? 40 : 32));
  const badge = make('__badge', 'position:fixed;z-index:2147483646;display:none;padding:' + (small ? '4px 10px' : '8px 16px') + ';border-radius:999px;color:#fff;letter-spacing:.04em;pointer-events:none;' + font(small ? 12 : big ? 20 : 17) + (small ? 'right:8px;top:8px;' : 'left:22px;top:86px;'));
  const target = sel => typeof sel === 'string' ? document.querySelector(sel) : sel;
  const state = { caption: '', badge: null };   // what the viewer should be reading now; the heartbeat below puts it back if the page removes it
  window.__demo = {
    badge(text, color) { state.badge = text ? { text, color } : null; badge.textContent = text || ''; badge.style.background = color || '#0f766e'; badge.style.display = text ? 'block' : 'none'; },
    caption(text) { state.caption = text || ''; cap.textContent = text || ''; cap.style.display = text ? 'block' : 'none'; },
    card(title, lines) {
      if (!title) { card.style.display = 'none'; return; }
      card.replaceChildren();
      const h = document.createElement('div'); h.textContent = title; h.style.cssText = 'color:#6ee7b7;font-size:1.2em;margin-bottom:.7em'; card.append(h);
      for (const l of lines) { const li = document.createElement('div'); li.textContent = '\\u2713  ' + l; li.style.cssText = 'margin:.15em 0'; card.append(li); }
      card.style.display = 'flex';
    },
    // Scrolls the element into view and says where it is: in the page (x, y) and on the screen (sx, sy). On the phone the ring goes there too;
    // on the computer nothing is drawn, because the real pointer will be moved there.
    async aim(sel) {
      const el = target(sel); if (!el) throw new Error('missing ' + sel);
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      // wait until the element has stopped moving, has a size, and its centre is inside what can be seen; never aim at a spot that is not on screen.
      // On the phone the soft keyboard shrinks the visual viewport but not innerHeight, so the visual viewport is the one to judge by.
      const seen = () => window.visualViewport?.height || innerHeight;
      let r, still = 0, last = '';
      for (let i = 0; i < 60 && still < 4; i += 1) {
        await sleep(100); r = el.getBoundingClientRect();
        const here = r.left + ',' + r.top + ',' + r.width + ',' + r.height;
        still = here === last && r.width > 0 && r.height > 0 && r.top + r.height / 2 > 0 && r.top + r.height / 2 < seen() ? still + 1 : 0; last = here;
      }
      if (still < 4) throw new Error('cannot aim at ' + sel + ' (rect ' + last + ', visible height ' + seen() + ')');
      const x = r.left + Math.min(r.width / 2, 120), y = r.top + r.height / 2;
      this.aimed = el; this.lastPath = null; this.at = { x, y };
      if (small) { cur.style.transform = 'translate(' + x + 'px,' + y + 'px)'; await sleep(750); }
      return { x, y, sx: window.screenX + x, sy: window.screenY + (outerHeight - innerHeight) + y };
    },
    // Did the click that was just made land on the element that was aimed at?
    hit() { return !!(this.aimed && this.lastPath && this.lastPath.includes(this.aimed)); },
    async pulse() {
      if (small) cur.animate([{ boxShadow: '0 0 0 3px rgba(255,255,255,.75), 0 0 0 0 rgba(225,29,72,.7)' }, { boxShadow: '0 0 0 3px rgba(255,255,255,.75), 0 0 0 28px rgba(225,29,72,0)' }], { duration: 450 });
      else if (this.at) { // a ripple where the real pointer clicks, so the press can be seen in the recording
        const ring = make('__ripple', 'position:fixed;left:' + (this.at.x - 18) + 'px;top:' + (this.at.y - 18) + 'px;width:36px;height:36px;border:4px solid #e11d48;border-radius:50%;z-index:2147483646;pointer-events:none');
        ring.animate([{ transform: 'scale(.3)', opacity: 1 }, { transform: 'scale(1.6)', opacity: 0 }], { duration: 500 }).onfinish = () => ring.remove();
      }
      await sleep(220);
    },
    async type(sel, text, delay = 85) {
      const el = target(sel); if (!el) throw new Error('missing ' + sel); el.focus(); el.value = '';
      for (const ch of text) { el.value += ch; el.dispatchEvent(new Event('input', { bubbles: true })); await sleep(delay); }
      el.dispatchEvent(new Event('change', { bubbles: true })); await sleep(250);
      if (small) el.blur();   // on the phone, let the soft keyboard go down so it does not cover the next button
    },
    hide() { cur.style.transform = 'translate(-100px,-100px)'; },
    // a mint outline around each element, to hold the eye on it; with dim, the rest of the page is darkened around them like a spotlight.
    // Both follow the elements while the page scrolls; unmark() removes them.
    mark(sels, dim) {
      this.unmark();
      const pairs = sels.map(sel => target(sel)).filter(Boolean).map(el => [el, make('__mark', 'position:fixed;left:0;top:0;box-sizing:border-box;border:4px solid #6ee7b7;border-radius:10px;box-shadow:0 0 18px rgba(110,231,183,.7);z-index:2147483644;pointer-events:none')]);
      const spot = dim ? make('__mark', 'position:fixed;left:0;top:0;box-sizing:border-box;border-radius:16px;z-index:2147483643;pointer-events:none;box-shadow:0 0 0 100vmax rgba(6,14,12,.66)') : null;
      const follow = () => {
        let l = 1e9, t = 1e9, r = -1e9, b = -1e9;
        for (const [el, box] of pairs) { const q = el.getBoundingClientRect(); box.style.left = (q.left - 6) + 'px'; box.style.top = (q.top - 4) + 'px'; box.style.width = (q.width + 12) + 'px'; box.style.height = (q.height + 8) + 'px'; l = Math.min(l, q.left); t = Math.min(t, q.top); r = Math.max(r, q.right); b = Math.max(b, q.bottom); }
        if (spot && pairs.length) { spot.style.left = (l - 16) + 'px'; spot.style.top = (t - 14) + 'px'; spot.style.width = (r - l + 32) + 'px'; spot.style.height = (b - t + 28) + 'px'; }
        this.markFrame = requestAnimationFrame(follow);
      };
      follow();
    },
    // a small line under the badge, e.g. the receipt of a real Token Factory call; receipt(null) removes it
    receipt(text) {
      let el = document.getElementById('__receipt');
      if (!text) { el?.remove(); return; }
      if (!el) el = make('__receipt', 'position:fixed;left:22px;top:' + (small ? 40 : 134) + 'px;z-index:2147483646;padding:' + (small ? '4px 10px' : '8px 16px') + ';border-radius:10px;background:rgba(10,22,19,.93);color:#6ee7b7;border:2px solid #6ee7b7;pointer-events:none;' + font(small ? 12 : big ? 20 : 17));
      el.textContent = text;
    },
    unmark() { cancelAnimationFrame(this.markFrame); document.querySelectorAll('#__mark').forEach(el => el.remove()); }
  };
  // folded sections ("What the system does and does not do", "Delivery options", "Technical details", "More") are opened and kept open
  const openAll = () => document.querySelectorAll('details').forEach(d => { if (!d.open) d.open = true; });
  document.addEventListener('DOMContentLoaded', openAll); window.addEventListener('load', openAll); setInterval(openAll, 700); openAll();
  // Chrome on a Chinese-language phone offers to translate an English page and puts a bar on top of it; the page says it is not to be translated.
  const noTranslate = () => { try {
    const root = document.documentElement;
    if (root && root.getAttribute('translate') !== 'no') root.setAttribute('translate', 'no');
    if (document.head && !document.querySelector('meta[name="google"][content="notranslate"]')) { const meta = document.createElement('meta'); meta.name = 'google'; meta.content = 'notranslate'; document.head.append(meta); }
  } catch { /* the overlay must never fail because of this */ } };
  document.addEventListener('DOMContentLoaded', noTranslate); window.addEventListener('load', noTranslate); setInterval(noTranslate, 700); noTranslate();
  // A page loaded in a scene starts with the words the script registered for it (window.__demoBoot); and every half second the caption and the badge
  // are attached again if the page's own code removed them or the document was rebuilt, with the words they should be showing.
  const boot = window.__demoBoot;
  if (boot) { window.__demo.caption(boot.caption); window.__demo.badge(boot.badge?.text, boot.badge?.color); }
  setInterval(() => { [cap, badge, cur, card].forEach(attach); window.__demo.caption(state.caption); window.__demo.badge(state.badge?.text, state.badge?.color); }, 500);
  // remember the path of a real click as it happens (the page may redraw the button afterwards), so the script can tell whether it hit the right element
  document.addEventListener('click', e => { window.__demo.lastPath = e.composedPath(); }, true);
})()`;
// What a new page runs first: the words of the scene on screen, then the overlay, so any page loaded in the scene starts with them.
export const bootSource = (caption, badge) => 'window.__demoBoot = ' + JSON.stringify({ caption: caption || '', badge: badge || null }) + ';\n' + OVERLAY;

// ---------- warming the local model with the request the product really sends (a routing decision), and checking it answers quickly
// The scene says the local model answered first; if its first real call overran the cascade's local share (7.5 s) the cloud would answer instead and the
// words would be untrue. So the model is asked the same question until two answers in a row come back within `limitMs`, and the run stops before the
// countdown if that never happens.
export function routingWarmupBody(model) {
  const kind = ADVICE_KINDS.route, provider = ADVISER_PROVIDERS.local_openai_compatible;
  const metadata = { taskAlias: 'warm-up', snapshotVersion: 1, channels: ['email', 'internal_queue'], state: 'PENDING_CHECK', attempts: 0 };
  return { model, max_tokens: provider.maxTokens ?? 512, ...provider.shape(metadata, kind),
    messages: [{ role: 'system', content: kind.boundary }, { role: 'user', content: JSON.stringify(metadata) }] };
}
export async function warmLocalModel(baseUrl, model, { limitMs = 4000, attempts = 6, request = fetch, now = () => Date.now() } = {}) {
  let quick = 0; const took = [];
  for (let i = 0; i < attempts && quick < 2; i += 1) {
    const started = now();
    const ok = await request(baseUrl + '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(routingWarmupBody(model)), signal: AbortSignal.timeout(60000) }).then(r => r.ok, () => false);
    const ms = now() - started; took.push(ok ? ms : -1);
    quick = ok && ms <= limitMs ? quick + 1 : 0;
  }
  if (quick < 2) throw new Error(`ERROR the local model did not answer a routing request within ${limitMs / 1000} s twice in a row (answers in ms, -1 = failed: ${took.join(', ')}); the scene would not show the local model answering first. Close other heavy programs and run again.`);
  return took;
}

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

// ---------- the real pointer: scripts/os-mouse.swift, compiled once into the temp folder
const MOUSE_BIN = path.join(os.tmpdir(), 'zte-os-mouse');
async function buildMouse() {
  const source = path.join(root, 'scripts/os-mouse.swift');
  const [src, bin] = await Promise.all([fs.stat(source), fs.stat(MOUSE_BIN).catch(() => null)]);
  if (!bin || bin.mtimeMs < src.mtimeMs) execFileSync('swiftc', ['-O', source, '-o', MOUSE_BIN], { stdio: 'inherit' });
}
const mouse = (...args) => new Promise((resolve, reject) => execFile(MOUSE_BIN, args.map(String), (error, out, err) => error ? reject(new Error((err || error.message).trim())) : resolve(out.trim())));

// ---------- a minimal Chrome DevTools client for one tab
// realMouse: this tab is a window on this computer, so the real pointer is moved to the element and clicks it; otherwise (the phone) a real input event is sent to the page.
// words: whether this screen carries the scene's caption and badge. The phone does not: the computer's caption is the one the viewer reads.
async function connect(wsUrl, { overlay = true, realMouse = false, words = true } = {}) {
  const ws = new WebSocket(wsUrl); await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
  let n = 0; const pending = new Map();
  const choosers = [];   // file choosers the page opened, waiting for a file
  let loads = 0;         // how many times the page has finished loading
  ws.addEventListener('message', event => { const m = JSON.parse(event.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } else if (m.method === 'Page.fileChooserOpened') choosers.push(m.params); else if (m.method === 'Page.loadEventFired') loads += 1; });
  const send = (method, params = {}) => new Promise(resolve => { const id = ++n; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
  await send('Page.enable'); await send('Runtime.enable'); await send('DOM.enable');
  await send('Page.setInterceptFileChooserDialog', { enabled: true });
  // The script every new document runs first. It carries the words of the scene on screen, so it is replaced at the start of each scene (see arm).
  let bootId;
  const arm = async () => {
    if (!overlay) return;
    if (bootId) await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: bootId });
    bootId = (await send('Page.addScriptToEvaluateOnNewDocument', { source: bootSource(words ? SCENE.caption : '', words ? SCENE.badge : null) })).result?.identifier;
  };
  await arm();
  const ev = async (expression, timeout = 30000) => {
    const reply = await Promise.race([send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }), sleep(timeout).then(() => ({ timedOut: true }))]);
    if (reply.timedOut) throw new Error('timeout: ' + expression.slice(0, 70));
    if (reply.result?.exceptionDetails) throw new Error('page error: ' + (reply.result.exceptionDetails.exception?.description || reply.result.exceptionDetails.text).split('\n')[0]);
    return reply.result?.result?.value;
  };
  const page = { ev, send, arm, words, close: () => ws.close() };
  page.ready = async () => { for (let i = 0; i < 40; i += 1) { try { if (await ev('document.readyState === "complete" && location.href !== "about:blank"', 3000)) { if (!(await ev('typeof __demo !== "undefined"'))) await ev(bootSource(words ? SCENE.caption : '', words ? SCENE.badge : null)); return; } } catch { /* navigating */ } await sleep(250); } };
  // Waits for the page's own load event; if it does not come (or came before it was listened for), falls back to polling the page's state.
  page.go = async url => {
    const before = loads;
    await send('Page.navigate', { url });
    for (let i = 0; i < 300 && loads === before; i += 1) await sleep(50);
    if (loads === before) await sleep(500);
    await page.ready();
    if (overlay && words && SCENE.caption) { await page.caption(SCENE.caption); await page.badge(SCENE.badge); }
  };
  page.waitFor = async (expression, ms = 12000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await ev(expression, 4000)) return true; } catch { /* page busy */ } await sleep(200); } return false; };
  page.caption = text => ev(`__demo.caption(${JSON.stringify(text)})`).catch(() => {});
  page.badge = badge => ev(`__demo.badge(${JSON.stringify(badge?.text ?? null)}, ${JSON.stringify(badge?.color ?? null)})`).catch(() => {});
  // Moves to the element and presses it the way a person would. Falls back to a scripted click, and says so, if the real one did not land.
  const press = async at => {
    if (useRealClick(realMouse, at.glided)) { await mouse('click'); return; }   // a pointer that did not arrive must not click wherever it happens to be
    for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 });
  };
  // true when the pointer really moved to the element (or there is no real pointer to move); false, with a WARNING, when it did not. With --strict that stops the run.
  const glide = async at => {
    if (!realMouse) return true;
    try { await mouse('glide', Math.round(at.sx), Math.round(at.sy), 650); return true; }
    catch (error) {
      if (STRICT) throw new Error('ERROR (--strict): the real pointer could not be moved to screen ' + Math.round(at.sx) + ',' + Math.round(at.sy) + ': ' + error.message);
      console.log('  WARNING: ' + error.message + '; no real click will be made here'); return false;
    }
  };
  page.point = async sel => { const at = await ev(`__demo.aim(${JSON.stringify(sel)})`, 20000); at.glided = await glide(at); return at; };
  page.click = async sel => {
    if (realMouse) await send('Page.bringToFront');   // the real pointer clicks whatever window is on top at that spot, so make sure it is this one
    const at = await page.point(sel);
    await ev('__demo.pulse()', 5000); await press(at); await sleep(250);
    if (!(await ev('__demo.hit()'))) {
      const why = await ev(`JSON.stringify({ focus: document.hasFocus(), visible: document.visibilityState, under: (document.elementFromPoint(${at.x}, ${at.y}) || {}).id || (document.elementFromPoint(${at.x}, ${at.y}) || {}).tagName, window: [screenX, screenY, outerWidth, outerHeight, innerHeight], visual: [(visualViewport || {}).height, (visualViewport || {}).offsetTop] })`).catch(() => '?');
      console.log(`  WARNING: the ${realMouse ? 'mouse' : 'input'} click on ${sel} did not land (${why}; aimed at screen ${Math.round(at.sx)},${Math.round(at.sy)}${realMouse ? ', pointer now at ' + await mouse('where').catch(() => '?') : ''}); clicked it by script`);
      await ev('__demo.aimed.click()'); }
    await sleep(380);
  };
  // On the phone the soft keyboard would cover the lower half of the page and shrink the visible area, so the field is told not to open it.
  page.type = async (sel, text, delay) => { if (!realMouse) await ev(`document.querySelector(${JSON.stringify(sel)})?.setAttribute('inputmode', 'none')`).catch(() => {}); await page.click(sel); await ev(`__demo.type(${JSON.stringify(sel)}, ${JSON.stringify(text)}, ${delay ?? 85})`, 60000); };
  // Presses a button that opens a file chooser (the pointer goes to it), then hands the chooser a real file by its path. The page behaves exactly as
  // if a person had picked that file; the system's own file window is not shown. Falls back to the given function if no chooser opens.
  page.chooseFile = async (buttonExpr, filePath, fallback) => {
    choosers.length = 0;
    // The phone's browser cannot read the token files (it would only show "Invalid token file"), so there the token is typed, without opening a chooser.
    if (!realMouse) { console.log('  phone: ' + path.basename(filePath) + ' typed instead of picked'); if (fallback) await fallback(); return false; }
    // buttonExpr is either a CSS selector (quoted) or an expression that finds the button; tag it so the overlay can point at it.
    const sel = /^"/.test(buttonExpr) ? JSON.parse(buttonExpr) : (await ev(`(() => { const b = ${buttonExpr}; if (!b) return ''; b.setAttribute('data-demo-pick', '1'); return '[data-demo-pick]'; })()`)) ;
    if (!sel) { if (fallback) await fallback(); return false; }
    const at = await page.point(sel);
    await ev('__demo.pulse()', 5000);
    // Chrome only opens a file chooser for a genuine user action: the real pointer on the computer (a protocol mouse press if the pointer did not arrive).
    if (useRealClick(realMouse, at.glided)) await mouse('click');
    else for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 });
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
// What the scene on screen says. A scene may load another page, and a new page starts without the caption or the badge, so go() puts them back.
const SCENE = { caption: '', badge: null };
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
      // warm the local model with the real routing request until it answers quickly, then let the server see it through the proxy
      const took = await warmLocalModel('http://127.0.0.1:1234/v1', 'nvidia-nemotron-3-nano-4b');
      console.log('  local model warm: routing answers in ' + took.map(ms => ms < 0 ? 'failed' : ms + ' ms').join(', '));
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
    const chrome = spawn(CHROME, [`--user-data-dir=${profile}`, `--remote-debugging-port=${MAC_CDP}`, '--no-first-run', '--no-default-browser-check', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', `--window-size=${WIN.w},${WIN.h}`, `--window-position=${WIN.x},${WIN.y}`, '--start-fullscreen', `--app=${BASE}/`], { stdio: 'ignore' });
    cleanups.push(() => { chrome.kill(); return fs.rm(profile, { recursive: true, force: true }); });
    let tabs = []; for (let i = 0; i < 40 && !tabs.length; i += 1) { tabs = await listTabs(MAC_CDP).catch(() => []); await sleep(250); }
    await buildMouse();
    const mac = await connect(tabs[0].webSocketDebuggerUrl, { realMouse: true }); await mac.ready(); await mac.send('Page.bringToFront');
    // full screen: asked for at launch, and again through the browser if the window did not take it; the real pointer is only used once it has
    if (!(await mac.waitFor('innerWidth >= 1800 && innerHeight >= 1000', 4000))) {
      const win = await mac.send('Browser.getWindowForTarget');
      if (win.result?.windowId) await mac.send('Browser.setWindowBounds', { windowId: win.result.windowId, bounds: { windowState: 'fullscreen' } });
    }
    if (!(await mac.waitFor('innerWidth >= 1800 && innerHeight >= 1000', 6000))) throw new Error('the computer window did not go full screen (it is ' + await mac.ev('innerWidth + "x" + innerHeight') + ')');
    await sleep(1200);   // let the full-screen animation finish before anything is aimed at
    const screenSize = await mac.ev('({ width: screen.width, height: screen.height })');
    if (!(screenSize?.width > 0 && screenSize?.height > 0)) throw new Error('could not read the screen size from the browser (' + JSON.stringify(screenSize) + ')');

    // 3. the employee's phone (or a second window)
    let phone;
    if (!NO_PHONE) {
      execFileSync('adb', ['reverse', `tcp:${PORT}`, `tcp:${PORT}`], { stdio: 'ignore' }); execFileSync('adb', ['forward', `tcp:${PHONE_CDP}`, 'localabstract:chrome_devtools_remote'], { stdio: 'ignore' });
      execFileSync('adb', ['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'], { stdio: 'ignore' });
      execFileSync('adb', ['shell', 'rm', '-f', PHONE_DOWNLOAD], { stdio: 'ignore' });
      cleanups.push(() => { execFileSync('adb', ['shell', 'rm', '-f', PHONE_DOWNLOAD], { stdio: 'ignore' }); execFileSync('adb', ['reverse', '--remove-all'], { stdio: 'ignore' }); execFileSync('adb', ['forward', '--remove-all'], { stdio: 'ignore' }); });
      // Chrome on the phone opens its debugging socket only once a page is open, so a refused connection here means "no tabs yet".
      const before = new Set((await listTabs(PHONE_CDP).catch(() => [])).map(t => t.id));
      execFileSync('adb', ['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', `${PHONE_BASE}/decode.html`, 'com.android.chrome'], { stdio: 'ignore' });
      let found; for (let i = 0; i < 60 && !found; i += 1) { found = (await listTabs(PHONE_CDP).catch(() => [])).find(t => !before.has(t.id) && t.url.startsWith(PHONE_BASE)); await sleep(250); }
      if (!found) throw new Error('the phone did not open the page (is it unlocked and awake?)');
      cleanups.push(() => fetch(`http://127.0.0.1:${PHONE_CDP}/json/close/${found.id}`));
      phone = await connect(found.webSocketDebuggerUrl, { words: false }); await phone.ready();
      // A phone that drops off adb mid-demo would leave this script waiting forever; stop loudly instead.
      const watch = setInterval(() => execFile('adb', ['get-state'], (error, out) => { if (error || out.trim() !== 'device') { clearInterval(watch); console.error('ERROR the phone is no longer connected to adb; stopping'); stop().finally(() => process.exit(1)); } }), 3000);
      cleanups.push(() => clearInterval(watch));
    }

    // 4. the countdown, so recording can be started first
    // The countdown is dark on both screens and ends in the same instant: the composing script finds that moment in each recording and lines them up.
    if (COUNTDOWN) for (let s = COUNTDOWN; s > 0; s -= 1) { const text = `__demo.card('Recording starts in ${s}', ['Stay still; the demo plays by itself'])`; await Promise.all([mac.ev(text), phone ? phone.ev(text) : null]); await sleep(1000); }
    await Promise.all([mac.ev(`__demo.card(null)`), phone ? phone.ev(`__demo.card(null)`) : null]);
    console.log(`the Mac window is full screen, ${screenSize.width}x${screenSize.height} points; record that region: ${recordCommand(screenSize)}`);
    const t0 = Date.now(); const scene = async (name, fn) => {
      const started = Date.now(); const budget = SCENE_SECONDS[name] * 1000;
      SCENE.caption = CAPTIONS[name]; SCENE.badge = sceneBadge(name);
      await mac.arm(); if (phone) await phone.arm();   // any page loaded from here on starts with this scene's words
      await mac.caption(CAPTIONS[name]); if (phone?.words) await phone.caption(CAPTIONS[name]);
      await mac.badge(SCENE.badge); if (phone?.words) await phone.badge(SCENE.badge);
      await fn();
      // the viewer must be reading this scene's words on every screen when it ends: one caption, with a height, saying the scene's words
      for (const [label, page] of [['computer', mac], ['phone', phone]]) {
        if (!page?.words) continue;
        const seen = await page.ev(CAPTION_PROBE).catch(() => null);
        if (REHEARSE) console.log(`  caption on the ${label} screen: ${seen ? `count ${seen.count}, display ${seen.display}, height ${Math.round(seen.height)}` : 'could not be read'}`);
        const problem = captionProblem(seen, CAPTIONS[name]);
        if (problem) console.log(`  WARNING: the caption for scene ${name} is not showing on the ${label} screen (${problem})`);
      }
      const left = budget - (Date.now() - started); if (left > 0) await sleep(left); else console.log(`  (scene ${name} ran ${(-left / 1000).toFixed(1)}s long)`);
      if (REHEARSE) {
        await mac.shot(path.join(shots, `${name}-mac.png`)); if (phone) await phone.shot(path.join(shots, `${name}-phone.png`));
        // the phone's real screen, with Chrome's own bars, banners and dialogs, which the page picture above cannot show
        if (phone) await fs.writeFile(path.join(shots, `${name}-phone-screen.png`), execFileSync('adb', ['exec-out', 'screencap', '-p'], { maxBuffer: 64 * 1024 * 1024 })).catch(() => {});
      }
      console.log(`scene ${name.padEnd(9)} done at ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    };

    // the receipt of a real call: the Token Factory spend as the server itself reports it, before the demo and again when the answer is shown
    const spend = () => mac.ev(`fetch('/api/health').then(r => r.json()).then(h => h.nebiusBudget?.spentUsd ?? null).catch(() => null)`);
    const spentBefore = await spend();
    if (cascade && !Number.isFinite(spentBefore)) console.log('  WARNING: the first Token Factory spend reading is not a number (' + spentBefore + '); no receipt can be shown, so check nebiusBudget.spentUsd in /api/health');
    const managerToken = await token('manager-sender');
    await scene('open', async () => {
      await mac.go(`${BASE}/`);
      await mac.chooseFile(`[...document.querySelectorAll('.token-file-row button')].find(b => /Choose token file/.test(b.textContent))`, path.join(dir, 'manager-sender.token'), () => mac.type('#accessToken', managerToken, 12));
      await mac.waitFor(`/IDENTITY VERIFIED/.test(document.body.innerText)`);
    });
    await scene('roster', async () => {
      const b64 = (await fs.readFile(SAMPLE)).toString('base64');
      await mac.chooseFile('"#chooseDocument"', SAMPLE, () => mac.ev(`(()=>{const bin=atob(${JSON.stringify(b64)});const u=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i);const dt=new DataTransfer();dt.items.add(new File([u],'Q3-2026-Board-Financial-Summary.pdf',{type:'application/pdf'}));const fi=document.getElementById('documentFile');fi.files=dt.files;fi.dispatchEvent(new Event('change',{bubbles:true}))})()`));
      const loaded = await mac.waitFor(`document.querySelectorAll('#recipientList input[type=checkbox]').length >= 3`, 15000);
      if (!loaded) console.log('  WARNING: the recipient list did not appear after choosing the document: ' + JSON.stringify(await mac.ev(`({ list: document.getElementById('recipientList')?.innerText.slice(0, 160), files: document.getElementById('documentFile')?.files.length, status: [...document.querySelectorAll('[role=status]')].map(e => e.innerText.slice(0, 120)).filter(Boolean), identity: /IDENTITY VERIFIED/.test(document.body.innerText) })`)));
      // the case itself, on screen before the 24 s mark: the two rows with the same name, outlined, the pointer on each in turn
      const rows = await mac.ev(`(() => [...document.querySelectorAll('#recipientList label, #recipientList li')].filter(e => e.children.length && e.innerText.includes('劉文祥')).slice(0, 2).map((e, i) => { e.setAttribute('data-demo-same', i); return '[data-demo-same="' + i + '"]'; }))()`);
      if (rows?.length === 2) { await mac.ev(`__demo.mark(${JSON.stringify(rows)}, true)`); await mac.point(rows[0]); await sleep(900); await mac.point(rows[1]); }
      else { console.log('  WARNING: the two 劉文祥 rows were not found in the list; pointed at the list instead'); await mac.point('#recipientList'); }
    });
    await scene('find', async () => {
      await mac.ev('__demo.unmark()');
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
      await mac.point('#recipientLink');
    });

    await scene('ai', async () => {
      await mac.go(`${BASE}/audit.html`); await mac.ev(`new Promise(r => { const t = setInterval(() => { if (document.getElementById('accessToken') && window.__demo) { clearInterval(t); r(1); } }, 100); setTimeout(() => { clearInterval(t); r(0); }, 8000); })`);
      await mac.chooseFile(`[...document.querySelectorAll('.token-file-row button')].find(b => /Choose token file/.test(b.textContent))`, path.join(dir, 'manager-sender.token'), () => mac.type('#accessToken', managerToken, 6));
      await mac.waitFor(`/IDENTITY VERIFIED/.test(document.body.innerText)`);
      await mac.ev(`[...document.querySelectorAll('button')].find(b=>/refresh/i.test(b.textContent))?.click()`); await sleep(1500);
      const thisTask = new URL(link, BASE).searchParams.get('id');
      await mac.ev(`(()=>{const s=document.getElementById('evidenceTask');if(s&&s.options.length){const at=[...s.options].findIndex(o=>o.value===${JSON.stringify(thisTask)});s.selectedIndex=at>=0?at:s.options.length-1;s.dispatchEvent(new Event('change',{bubbles:true}))}})()`);
      await mac.click('#evidenceBtn'); await mac.waitFor(`document.getElementById('evidenceChain').innerText.length > 40`, 10000);
      // The Token Factory answer is the point of this scene: outline the line for the local model and the line for Token Factory, hold on the first,
      // then move the pointer to the Token Factory line and stay there.
      const lines = await mac.ev(`(() => { const leaf = [...document.querySelectorAll('#evidenceChain *')].filter(e => e.children.length === 0); const out = [];
        [/Local model outlet/, /Token Factory/].forEach((re, i) => { const e = leaf.find(item => re.test(item.textContent)); if (e) { e.setAttribute('data-demo-outlet', i); out.push('[data-demo-outlet="' + i + '"]'); } }); return out; })()`);
      if (lines?.length === 2) { await mac.ev(`document.querySelectorAll('[data-demo-outlet]').forEach(e => { e.style.fontSize = '24px'; e.style.fontWeight = '700'; })`); await mac.point(lines[0]); await mac.ev(`__demo.mark(${JSON.stringify(lines)}, true)`); await sleep(2200); const spentAfter = await spend();
        if (cascade && Number.isFinite(spentBefore) && Number.isFinite(spentAfter)) {
          const delta = spentAfter - spentBefore;
          if (delta > 0) await mac.ev(`__demo.receipt(${JSON.stringify(receiptText(spentBefore, spentAfter))})`);
          else console.log('  WARNING: the Token Factory spend did not change (' + spentBefore + ' -> ' + spentAfter + '); no receipt shown, so check that the call was real');
        }
        await mac.point(lines[1]); await sleep(2000);
        if (REHEARSE) await mac.shot(path.join(shots, 'ai-tokenfactory-mac.png'));   // what the viewer sees while the pointer rests on the Token Factory line
        await sleep(2800); await mac.ev('__demo.unmark(); __demo.receipt(null)'); }
      else for (const i of [2, 3]) { await mac.ev(`document.getElementById('evidenceChain').children[${i}]?.scrollIntoView({behavior:'smooth',block:'center'})`); await sleep(4200); }
      const outlets = await mac.ev(`[...document.querySelectorAll('#evidenceChain *')].filter(e => e.children.length === 0 && /outlet|Token Factory|Nebius/i.test(e.textContent)).map(e => e.textContent.trim()).join(' | ')`);
      console.log('  model rows on the audit page: ' + outlets);
      if (cascade && !/Token Factory|Nebius/i.test(outlets)) console.log('  WARNING: no Token Factory answer appears on the audit page; check the cascade');
      if (cascade && lines?.length !== 2) {
        const why = 'TAKE NOT USABLE: the audit page does not show both the local model line and the Token Factory line, so the caption (the local model answered first, then Token Factory) would not be true. Model rows seen: ' + outlets;
        console.log('  ERROR ' + why); if (STRICT) throw new Error('ERROR (--strict): ' + why);
      }
    });
    const second = phone || await (async () => { // without a phone, a second window plays the employee
      const w = spawn(CHROME, [`--user-data-dir=${profile}-b`, `--remote-debugging-port=${MAC_CDP + 1}`, '--no-first-run', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--window-size=420,780', '--window-position=1380,60', `--app=${BASE}/decode.html`], { stdio: 'ignore' });
      cleanups.push(() => { w.kill(); return fs.rm(`${profile}-b`, { recursive: true, force: true }); });
      let t = []; for (let i = 0; i < 40 && !t.length; i += 1) { t = await listTabs(MAC_CDP + 1).catch(() => []); await sleep(250); }
      const p = await connect(t[0].webSocketDebuggerUrl, { realMouse: true }); await p.ready(); return p; })();
    const pickedToken = await token('sales-b'), otherToken = await token('sales-a');
    const where = id => path.join(dir, id + '.token');   // the phone types its token (chooseFile), so nothing is copied onto it
    await scene('phone', async () => { await second.go(`${phone ? PHONE_BASE : BASE}/decode.html`); await second.chooseFile(`[...document.querySelectorAll('.token-file-row button')].find(b => /Choose token file/.test(b.textContent))`, where('sales-b'), () => second.type('#accessToken', pickedToken, 10)); await second.waitFor(`/IDENTITY VERIFIED/.test(document.body.innerText)`); });
    await scene('inbox', async () => { await second.waitFor(`document.querySelectorAll('#inboxList button').length >= 1`, 10000); await second.point('#inboxList li'); });
    await scene('download', async () => {
      await second.click('#inboxList button');
      await second.waitFor(`/ACCESS APPROVED/.test(document.body.innerText)`, 15000); await sleep(1800);
      await second.waitFor(`!document.getElementById('acknowledgeFile').disabled`, 10000); await second.click('#acknowledgeFile');
    });
    await scene('denied', async () => {
      const here = link.replace(BASE, phone ? PHONE_BASE : BASE);
      await second.go(here); await second.chooseFile(`[...document.querySelectorAll('.token-file-row button')].find(b => /Choose token file/.test(b.textContent))`, where('sales-a'), () => second.type('#accessToken', otherToken, 10)); await second.waitFor(`/IDENTITY VERIFIED/.test(document.body.innerText)`);
      await second.click('#decodeBtn');
      if (await second.waitFor(`/ACCESS DENIED/.test(document.body.innerText)`, 12000)) await second.point('#accessBadge');   // the result badge, scrolled into view and not cut off
      else console.log('  WARNING: ACCESS DENIED did not appear');
    });
    await scene('card', async () => { await mac.ev('__demo.hide()'); await mac.ev(`__demo.card('What was measured, and what was not', ${JSON.stringify(CARD)})`); if (phone) await phone.ev(`__demo.card(${JSON.stringify(PHONE_CARD[0])}, ${JSON.stringify(PHONE_CARD.slice(1))})`); });
    await scene('end', async () => { await mac.ev(`__demo.card('github.com/jiarong0423/zero-trust-edge-enclave', ['Hosted demo: enclave.jace0423.com','MIT licence'])`); });
    { const w = phoneWindow(); console.log(`when composing: --focus-phone ${w.start}:${w.end} --hide-inset ${w.end}:174   (the phone is enlarged while it plays, and left out over the end cards)`); }
    console.log(`played in ${((Date.now() - t0) / 1000).toFixed(0)}s (budget ${totalSeconds()}s)${REHEARSE ? `; rehearsal screenshots in ${shots}` : ''}`);
    if (!REHEARSE) console.log('STOP RECORDING NOW (the windows stay open for a few more seconds)');
    await sleep(REHEARSE ? 1500 : 8000);
  } finally { await stop(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main().then(() => process.exit(0), error => { console.error('FAILED:', error.message); process.exit(1); });
