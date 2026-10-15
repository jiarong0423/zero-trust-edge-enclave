#!/usr/bin/env node
// Walks the hosted demo end to end the way a judge would, by itself: a Chrome window on this computer is the manager (judge sign-in,
// manager token, a synthetic document, sales-a ticked, two confirmations), and the employee's phone, over adb, opens the recipient link
// with the sales-a token (inbox, download, receipt), then with the sales-b token (nothing waiting, ACCESS DENIED). At the end the task is
// revoked. Screenshots of every step go to a folder it prints.
//
// Run by the owner in their own terminal: it asks for the judge sign-in (the password is not shown) and reads the role tokens from the
// private token directory, so no credential passes through a chat. It prints no token, password or cookie. It makes one routing call to
// Nebius Token Factory (a fraction of a cent) and one delivery on the hosted site, which it revokes.
//
//   node scripts/hosted-walkthrough.mjs               computer + phone (the phone must be unlocked, awake and on adb)
//   node scripts/hosted-walkthrough.mjs --no-phone    the employee is a second Chrome window on this computer
//   node scripts/hosted-walkthrough.mjs --headless    the windows are not shown (with --no-phone: nothing appears on screen)
//   SMOKE_BASE_URL=http://127.0.0.1:3344 SMOKE_TOKEN_DIR=<dir> SMOKE_EXPECT_PROVIDER=synthetic_fixture node scripts/hosted-walkthrough.mjs --no-phone --headless
//                                                     a local server (no sign-in gate, no model) for trying the script itself
//
// Exit codes: 0 every step passed, 1 a step failed, 2 configuration or usage error.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { withDefaults, DEFAULT_TOKEN_DIR } from './hosted-wedge-probe.mjs';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const MAC_CDP = 9341, PHONE_CDP = 9342, SECOND_CDP = 9343;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const out = line => process.stdout.write(line + '\n');

export function parseArguments(argv) {
  const options = { phone: true, headless: false };
  for (const argument of argv) {
    if (argument === '--no-phone') options.phone = false;
    else if (argument === '--headless') options.headless = true;
    else throw Object.assign(new Error(`unknown argument: ${argument}`), { usage: true });
  }
  return options;
}

// One line per step; the run stops at the first failure (the later steps depend on it), and the summary says how far it got.
export function summarise(results) {
  const failed = results.filter(step => !step.ok);
  return failed.length ? `SUMMARY FAIL ${failed.length} of ${results.length}: ${failed.map(step => step.name).join(', ')}` : `SUMMARY PASS ${results.length} of ${results.length}`;
}

// ---------- a minimal Chrome DevTools client for one tab
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl); await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
  let n = 0; const pending = new Map(); let loads = 0;
  ws.addEventListener('message', event => { const m = JSON.parse(event.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } else if (m.method === 'Page.loadEventFired') loads += 1; });
  const send = (method, params = {}) => new Promise(resolve => { const id = ++n; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
  await send('Page.enable'); await send('Runtime.enable'); await send('DOM.enable');
  const ev = async (expression, timeout = 30000) => {
    const reply = await Promise.race([send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }), sleep(timeout).then(() => ({ timedOut: true }))]);
    if (reply.timedOut) throw new Error('timeout: ' + expression.slice(0, 40));
    if (reply.result?.exceptionDetails) throw new Error('page error: ' + (reply.result.exceptionDetails.exception?.description || reply.result.exceptionDetails.text).split('\n')[0]);
    return reply.result?.result?.value;
  };
  const page = { ev, send, close: () => ws.close() };
  page.go = async url => {
    const before = loads;
    await send('Page.navigate', { url });
    for (let i = 0; i < 300 && loads === before; i += 1) await sleep(50);
    for (let i = 0; i < 80; i += 1) { try { if (await ev('document.readyState === "complete"', 3000)) return; } catch { /* page busy */ } await sleep(250); }
  };
  page.waitFor = async (expression, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await ev(expression, 4000)) return true; } catch { /* page busy */ } await sleep(250); } return false; };
  // Hands a hidden file input a real file by its path, as if a person had picked it.
  page.setFile = async (selector, file) => {
    const root = await send('DOM.getDocument', { depth: 0 });
    const found = await send('DOM.querySelector', { nodeId: root.result.root.nodeId, selector });
    if (!found.result?.nodeId) throw new Error('no file input ' + selector);
    await send('DOM.setFileInputFiles', { files: [file], nodeId: found.result.nodeId });
  };
  page.shot = async file => { const r = await send('Page.captureScreenshot', { format: 'png' }); if (r.result?.data) await fs.writeFile(file, Buffer.from(r.result.data, 'base64')); };
  return page;
}
const listTabs = async port => (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).filter(tab => tab.type === 'page');
const firstTab = async port => { for (let i = 0; i < 60; i += 1) { const tabs = await listTabs(port).catch(() => []); if (tabs.length) return tabs[0]; await sleep(250); } throw new Error('Chrome did not open a tab on port ' + port); };

// Whatever the page or the browser says is cleaned of the secrets this run holds before it is printed.
export function scrubber(secrets) {
  const list = secrets.filter(value => typeof value === 'string' && value.length >= 6);
  return text => list.reduce((line, secret) => line.split(secret).join('***'), String(text));
}

export async function walkthrough({ origin, gate, tokens, phone, headless = false, expect = 'nebius_token_factory', write: rawWrite = out }) {
  const write = line => rawWrite(scrubber([gate?.password, tokens.value('manager-sender'), tokens.value('sales-a'), tokens.value('sales-b')])(line));
  const results = []; const cleanups = []; let taskId = null; let version = null; let manager = null;
  const shots = await fs.mkdtemp(path.join(os.tmpdir(), 'hosted-walkthrough-'));
  const stop = async () => { for (const fn of cleanups.reverse()) { try { await fn(); } catch { /* best effort */ } } };
  const step = async (name, fn) => {
    try { const note = await fn(); results.push({ name, ok: true }); write(`PASS ${name}${note ? ': ' + note : ''}`); return true; }
    catch (error) { results.push({ name, ok: false }); write(`FAIL ${name}: ${String(error?.message || error).slice(0, 220)}`); return false; }
  };
  const must = (condition, message) => { if (!condition) throw new Error(message); };
  const setToken = (page, token) => page.ev(`(() => { const f = document.querySelector('#accessToken'); f.value = ${JSON.stringify(token)}; f.dispatchEvent(new Event('input', { bubbles: true })); f.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  try {
    // ----- the manager's window
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'hosted-walkthrough-chrome-'));
    const launch = (port, dir, position) => spawn(CHROME, [`--user-data-dir=${dir}`, `--remote-debugging-port=${port}`, '--no-first-run', '--no-default-browser-check', ...(headless ? ['--headless=new'] : []), `--window-position=${position},40`, '--window-size=900,950', 'about:blank'], { stdio: 'ignore' });
    const chrome = launch(MAC_CDP, profile, 0);
    cleanups.push(() => { chrome.kill(); return fs.rm(profile, { recursive: true, force: true }); });
    manager = await connect((await firstTab(MAC_CDP)).webSocketDebuggerUrl); cleanups.push(() => manager.close());

    if (!await step('judge sign-in', async () => {
      if (!gate) return 'this server has no sign-in gate';
      await manager.go(`${origin}/judge-login.html`);
      await manager.ev(`(() => { const set = (id, value) => { const f = document.getElementById(id); f.value = value; f.dispatchEvent(new Event('input', { bubbles: true })); }; set('gateUser', ${JSON.stringify(gate.user)}); set('gatePassword', ${JSON.stringify(gate.password)}); document.getElementById('gateForm').requestSubmit(); })()`);
      must(await manager.waitFor(`location.pathname !== '/judge-login.html'`, 15000), 'the sign-in was not accepted (wrong user or password?)');
      await manager.shot(path.join(shots, '01-signed-in.png'));
    })) return finish();

    if (!await step('manager token', async () => {
      await manager.go(`${origin}/`);
      await manager.waitFor(`!!document.querySelector('input[type=file][accept=".token"]')`, 10000);
      await manager.setFile('input[type=file][accept=".token"]', tokens.file('manager-sender'));
      must(await manager.waitFor(`/IDENTITY VERIFIED/.test(document.body.innerText)`, 15000), 'the manager token was not verified');
      await manager.shot(path.join(shots, '02-manager-verified.png'));
    })) return finish();

    if (!await step('synthetic document encrypted in the browser', async () => {
      const csv = path.join(shots, 'board-report-demo.csv');
      await fs.writeFile(csv, 'item,amount\nQ3 board summary (synthetic demo data),0\n');
      await manager.setFile('#documentFile', csv);
      must(await manager.waitFor(`/Encrypted locally/.test(document.getElementById('fileStatus').innerText)`, 15000), 'the document was not encrypted');
    })) return finish();

    if (!await step('recipients load; the same-name pair is flagged', async () => {
      await manager.ev(`document.getElementById('loadRecipients').click()`);
      must(await manager.waitFor(`document.querySelectorAll('#recipientList .recipient-row').length >= 2`, 15000), 'the recipient list did not load');
      const flagged = await manager.ev(`[...document.querySelectorAll('#recipientList .recipient-row')].filter(r => r.innerText.includes('劉文祥') && /Same name|同名/.test(r.innerText)).length`);
      must(flagged === 2, `expected two 劉文祥 rows with the same-name warning, found ${flagged}`);
      await manager.shot(path.join(shots, '03-same-name.png'));
      return 'two 劉文祥 with the warning';
    })) return finish();

    if (!await step('sales-a ticked alone, both confirmations', async () => {
      const ticked = await manager.ev(`(() => { const rows = [...document.querySelectorAll('#recipientList .recipient-row')]; const row = rows.find(r => r.innerText.includes('sales-a@')); if (!row) return 0; const box = row.querySelector('input[type=checkbox]'); if (!box.checked) box.click(); return rows.filter(r => r.querySelector('input').checked).length; })()`);
      must(ticked === 1, `expected exactly sales-a ticked, ${ticked} are`);
      await manager.ev(`document.getElementById('sealBtn').click()`);
      must(await manager.waitFor(`!document.getElementById('approveBtn').disabled`, 20000), 'Confirm 2 never became available');
      await manager.ev(`document.getElementById('approveBtn').click()`);
      must(await manager.waitFor(`!document.getElementById('recipientLink').hidden && !!document.getElementById('recipientLink').getAttribute('href')`, 60000), 'no recipient link appeared');
      const link = await manager.ev(`document.getElementById('recipientLink').getAttribute('href')`);
      const url = new URL(link, origin); taskId = url.searchParams.get('id'); version = Number(url.searchParams.get('version'));
      must(/^[a-f0-9-]{36}$/.test(taskId) && version >= 1, 'the recipient link has no task id');
      write(`INFO delivery ${taskId} v${version}`);
      must(await manager.waitFor(`/DRY_RUN_PREPARED/.test(document.body.innerText)`, 30000), 'the delivery was not prepared');
      await manager.shot(path.join(shots, '04-delivery-prepared.png'));
    })) return finish();

    await step(expect === 'nebius_token_factory' ? 'Token Factory answered the routing advice' : `the routing advice came from ${expect}`, async () => {
      let body = '', trail = [], source;
      for (let i = 0; i < 12; i += 1) {   // the worker records the advice a moment after the delivery is prepared
        body = await manager.ev(`fetch('/api/tasks/${taskId}/evidence', { headers: { authorization: 'Bearer ' + ${JSON.stringify(tokens.value('manager-sender'))} } }).then(async r => r.status + ' ' + await r.text())`, 30000);
        must(body.startsWith('200'), 'evidence answered HTTP ' + body.slice(0, 3));
        trail = (() => { try { const parsed = JSON.parse(body.slice(4)); return Array.isArray(parsed.evidence?.trail) ? parsed.evidence.trail : []; } catch { return []; } })();
        source = trail.filter(entry => entry.kind === 'route').at(-1)?.source;
        if (source) break;
        await sleep(2500);
      }
      if (!source) write(`INFO evidence: HTTP ${body.slice(0, 3)}, ${trail.length} adviser call(s) on record, kinds ${JSON.stringify(trail.map(entry => entry.kind))}, top-level keys ${JSON.stringify((() => { try { return Object.keys(JSON.parse(body.slice(4))); } catch { return []; } })())}`);
      must(!trail.some(entry => entry.realValuesInInput !== 0), 'an adviser input carried a real identifier');
      must(source === expect, `the advice was answered by ${source || 'nobody'}, not ${expect}`);
      return `answered by ${source} (adviser calls=${trail.length}), no real identifier in any input`;
    });

    // ----- the employee: the phone, or a second window
    let employee;
    const link = `${origin}/decode.html?id=${taskId}&version=${version}`;
    if (!await step(phone ? 'the phone opens the recipient link' : 'a second window opens the recipient link', async () => {
      if (phone) {
        execFileSync('adb', ['forward', `tcp:${PHONE_CDP}`, 'localabstract:chrome_devtools_remote'], { stdio: 'ignore' });
        execFileSync('adb', ['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'], { stdio: 'ignore' });
        cleanups.push(() => execFileSync('adb', ['forward', '--remove-all'], { stdio: 'ignore' }));
        const before = new Set((await listTabs(PHONE_CDP).catch(() => [])).map(tab => tab.id));
        execFileSync('adb', ['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', link, 'com.android.chrome'], { stdio: 'ignore' });
        let found; for (let i = 0; i < 80 && !found; i += 1) { found = (await listTabs(PHONE_CDP).catch(() => [])).find(tab => !before.has(tab.id) && tab.url.startsWith(origin)); await sleep(250); }
        must(found, 'the phone did not open the page (is it unlocked, awake and on adb?)');
        cleanups.push(() => fetch(`http://127.0.0.1:${PHONE_CDP}/json/close/${found.id}`));
        employee = await connect(found.webSocketDebuggerUrl);
      } else {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hosted-walkthrough-chrome-b-'));
        const second = launch(SECOND_CDP, dir, 920);
        cleanups.push(() => { second.kill(); return fs.rm(dir, { recursive: true, force: true }); });
        employee = await connect((await firstTab(SECOND_CDP)).webSocketDebuggerUrl); await employee.go(link);
      }
      cleanups.push(() => employee.close());
      must(await employee.waitFor(`!!document.querySelector('#accessToken')`, 20000), 'the employee page did not load');
      must(!(await employee.ev(`location.pathname.includes('judge-login')`)), 'the employee page asked for the judge sign-in');
      await employee.shot(path.join(shots, '05-employee-page.png'));
      return 'no judge sign-in asked for';
    })) return finish();

    await step('sales-a: inbox, download, receipt', async () => {
      await setToken(employee, tokens.value('sales-a'));
      must(await employee.waitFor(`/IDENTITY VERIFIED/.test(document.body.innerText)`, 15000), 'the sales-a token was not verified');
      must(await employee.waitFor(`document.querySelectorAll('#inboxList button').length >= 1`, 20000), 'the inbox shows nothing waiting for sales-a');
      const leaked = await employee.ev(`/board-report-demo/i.test(document.getElementById('inboxList').innerText)`);
      must(!leaked, 'the inbox shows the file name');
      await employee.shot(path.join(shots, '06-inbox.png'));
      await employee.ev(`document.querySelector('#inboxList button').click()`);
      must(await employee.waitFor(`/ACCESS APPROVED/.test(document.body.innerText)`, 30000), 'ACCESS APPROVED did not appear');
      await employee.ev(`document.getElementById('accessBadge').scrollIntoView({ block: 'center' })`).catch(() => {}); await sleep(400);
      await employee.shot(path.join(shots, '07-access-approved.png'));
      must(await employee.waitFor(`!document.getElementById('acknowledgeFile').disabled`, 20000), 'the receipt button never became available');
      await employee.ev(`document.getElementById('acknowledgeFile').click()`); await sleep(2500);
      await employee.shot(path.join(shots, '08-receipt.png'));
      return 'file decrypted in the browser, receipt confirmed, file name not shown in the inbox';
    });

    await step('sales-b: not picked, ACCESS DENIED', async () => {
      await employee.go(link);
      must(await employee.waitFor(`!!document.querySelector('#accessToken')`, 20000), 'the employee page did not reload');
      await setToken(employee, tokens.value('sales-b'));
      must(await employee.waitFor(`/IDENTITY VERIFIED/.test(document.body.innerText)`, 15000), 'the sales-b token was not verified');
      await sleep(2500);
      write(`INFO sales-b's inbox has ${await employee.ev(`document.querySelectorAll('#inboxList button').length`)} item(s) waiting (any earlier delivery to sales-b would show; this one must not open for sales-b)`);
      await employee.ev(`document.getElementById('decodeBtn').click()`);
      must(await employee.waitFor(`/ACCESS DENIED/.test(document.body.innerText)`, 20000), 'ACCESS DENIED did not appear');
      await employee.ev(`document.getElementById('accessBadge').scrollIntoView({ block: 'center' })`).catch(() => {}); await sleep(400);
      await employee.shot(path.join(shots, '09-denied.png'));
      return 'signed in, not picked, refused';
    });
  } catch (error) {
    results.push({ name: 'setup', ok: false }); write(`FAIL setup: ${String(error?.message || error).slice(0, 220)}`);
  }
  return finish();

  async function finish() {
    if (taskId && manager) {
      await step('the test delivery is revoked', async () => {
        const status = await manager.ev(`fetch('/api/tasks/${taskId}/revoke', { method: 'POST', headers: { authorization: 'Bearer ' + ${JSON.stringify(tokens.value('manager-sender'))}, 'content-type': 'application/json' }, body: JSON.stringify({ version: ${version} }) }).then(r => r.status)`, 30000);
        must(status === 200, 'revoke answered HTTP ' + status);
      });
    }
    await stop();
    write(summarise(results));
    write(`INFO screenshots: ${shots}`);
    return results.every(step => step.ok) ? 0 : 1;
  }
}

export async function main(env = process.env, argv = process.argv.slice(2), options = {}) {
  const write = options.write || out;
  let parsed;
  try { parsed = parseArguments(argv); } catch (error) { write(`ERROR ${error.message}`); return 2; }
  const filled = await withDefaults(env, options.prompts || {});
  const origin = String(filled.SMOKE_BASE_URL || '').replace(/\/$/, '');
  let local = false;
  try {
    const url = new URL(origin); local = url.protocol === 'http:' && url.hostname === '127.0.0.1';
    if ((url.protocol !== 'https:' && !local) || url.pathname !== '/' || url.search || url.hash || url.username) throw new Error();
  } catch { write('ERROR SMOKE_BASE_URL must be an https origin'); return 2; }
  if (!local && (!filled.SMOKE_GATE_USER || !filled.SMOKE_GATE_PASSWORD)) { write('ERROR the judge sign-in is needed (run this in a terminal)'); return 2; }
  const dir = path.resolve(filled.SMOKE_TOKEN_DIR || DEFAULT_TOKEN_DIR);
  const values = {};
  for (const id of ['manager-sender', 'sales-a', 'sales-b']) {
    const text = await fs.readFile(path.join(dir, id + '.token'), 'utf8').then(raw => raw.trim(), () => null);
    if (!text || !/^[A-Za-z0-9_-]{32,256}$/.test(text)) { write(`ERROR the ${id} token file was not found or does not look like a token`); return 2; }
    values[id] = text;
  }
  const tokens = { value: id => values[id], file: id => path.join(dir, id + '.token') };
  write(parsed.phone ? 'MODE computer + phone' : 'MODE computer + a second window');
  return walkthrough({ origin, gate: local ? null : { user: filled.SMOKE_GATE_USER, password: filled.SMOKE_GATE_PASSWORD }, tokens, phone: parsed.phone, headless: parsed.headless, expect: filled.SMOKE_EXPECT_PROVIDER || 'nebius_token_factory', write });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) process.exit(await main());
