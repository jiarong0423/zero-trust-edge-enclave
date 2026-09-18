import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

if (!process.env.PLAYWRIGHT_MODULE || !process.env.MERMAID_DIST) throw new Error('PLAYWRIGHT_MODULE and MERMAID_DIST required');
const { chromium } = await import(pathToFileURL(path.resolve(process.env.PLAYWRIGHT_MODULE)).href);
const dist = await fs.realpath(process.env.MERMAID_DIST);
const root = path.resolve(import.meta.dirname, '..');
const markdown = await fs.readFile(path.join(root, 'docs/agent/approved-delivery-architecture.md'), 'utf8');
const diagrams = [...markdown.matchAll(/```mermaid\n([\s\S]*?)```/g)].map(match => match[1]);
assert.ok(diagrams.length);
const output = path.join(root, 'output/isolation/current_runs/20260907_business_pipeline/architecture-preview');
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://diagram.local') return route.abort();
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<html><body style="margin:24px;background:white"><main id="diagram"></main></body></html>' });
    const file = path.resolve(dist, '.' + url.pathname);
    if (!file.startsWith(dist + path.sep)) return route.abort();
    try { await route.fulfill({ contentType: 'text/javascript', body: await fs.readFile(file) }); }
    catch { await route.abort(); }
  });
  await page.goto('http://diagram.local/');
  for (const [index, source] of diagrams.entries()) {
    await page.evaluate(async ({ source, index }) => {
      const { default: mermaid } = await import('/mermaid.esm.min.mjs');
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral',
        flowchart: { htmlLabels: false }, fontFamily: 'Arial, sans-serif' });
      const { svg } = await mermaid.render('architecture' + index, source);
      document.querySelector('#diagram').innerHTML = svg;
    }, { source, index });
    const svg = page.locator('#diagram svg');
    assert.ok(await svg.locator('g.node').count() > 0);
    await svg.screenshot({ path: path.join(output, 'diagram-' + (index + 1) + '.png') });
    console.log('Rendered Mermaid diagram ' + (index + 1));
  }
} finally { await browser.close(); }
