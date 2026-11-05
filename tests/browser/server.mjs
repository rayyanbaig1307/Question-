import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(fileURLToPath(new URL('../../.qa/web/', import.meta.url)));
const siteRoot = path.resolve(fileURLToPath(new URL('../../website/', import.meta.url)));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.ttf': 'font/ttf', '.ico': 'image/x-icon' };
http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    const isSite = url.pathname.startsWith('/site/');
    const root = isSite ? siteRoot : appRoot;
    const relative = decodeURIComponent(isSite ? url.pathname.slice(6) : url.pathname).replace(/^\/+/, '');
    const requested = path.resolve(root, relative || 'index.html');
    if (requested !== root && !requested.startsWith(root + path.sep)) {
      res.writeHead(403).end(); return;
    }
    let file = requested;
    let body;
    try { body = await readFile(file); }
    catch {
      file = path.join(root, isSite ? '404.html' : 'index.html'); body = await readFile(file);
      if (isSite) { res.writeHead(404, { 'Content-Type': 'text/html' }); res.end(body); return; }
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch { res.writeHead(500).end('Local test server error'); }
}).listen(4173, '127.0.0.1');
