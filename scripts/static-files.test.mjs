import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createStaticServer } from '../static-files.js';

test('a sibling directory that merely starts with the public directory name is never served', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'static-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const publicDir = path.join(root, 'public');
  await fs.mkdir(publicDir);
  await fs.writeFile(path.join(publicDir, 'index.html'), '<p>index</p>');
  await fs.writeFile(path.join(publicDir, 'a.html'), '<p>inside</p>');
  await fs.writeFile(path.join(root, 'public-secret.html'), '<p>SIBLING-SECRET</p>');
  const serve = createStaticServer(publicDir);
  // The raw request path is passed on purpose: serveStatic must be safe on its own, not only because a
  // URL parser upstream happens to collapse `..`.
  const server = http.createServer((req, res) => serve(req, res, req.url.split('?')[0]).catch(() => { res.writeHead(500); res.end(); }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const get = pathname => new Promise((resolve, reject) => {
    // http.get sends the path as written; fetch() would normalise `..` away before it left the client.
    http.get({ host: '127.0.0.1', port: server.address().port, path: pathname }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve(body));
    }).on('error', reject);
  });
  assert.match(await get('/a.html'), /inside/);
  for (const attempt of ['/../public-secret.html', '/./../public-secret.html', '//../public-secret.html']) {
    assert.ok(!(await get(attempt)).includes('SIBLING-SECRET'), attempt);
  }
});
