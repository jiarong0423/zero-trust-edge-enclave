import { promises as fs } from 'node:fs';
import path from 'node:path';
import { securityHeaders } from './http-helpers.js';

const mimeTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml']
]);

export function createStaticServer(publicDir) {
  return async function serveStatic(req, res, pathname) {
    const localizedPages = { '/zh-TW/': '/index.html', '/zh-TW/index.html': '/index.html', '/zh-TW/decode.html': '/decode.html', '/zh-TW/audit.html': '/audit.html', '/zh-TW/admin.html': '/admin.html' };
    if (pathname === '/zh-TW') { res.writeHead(302, { location: '/zh-TW/' }); res.end(); return; }
    if (pathname.startsWith('/zh-TW/') && !localizedPages[pathname]) { res.writeHead(404); res.end('Not found'); return; }
    const safePathname = localizedPages[pathname] || (pathname === '/' ? '/index.html' : pathname);
    const filePath = path.normalize(path.join(publicDir, safePathname));
    if (!filePath.startsWith(publicDir)) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }
    try {
      const data = await fs.readFile(filePath);
      const ext = path.extname(filePath);
      res.writeHead(200, {
        'content-type': mimeTypes.get(ext) || 'application/octet-stream',
        'cache-control': 'no-store',
        ...securityHeaders(req)
      });
      res.end(data);
    } catch {
      const fallback = await fs.readFile(path.join(publicDir, 'index.html'));
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        ...securityHeaders(req)
      });
      res.end(fallback);
    }
  };
}
