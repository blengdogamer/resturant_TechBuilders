const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 4173);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};

http.createServer((request, response) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(request.url, `http://${request.headers.host || 'localhost'}`).pathname); }
  catch { response.writeHead(400).end('Bad request'); return; }
  if (pathname === '/') pathname = '/index.html';
  if (pathname === '/admin') pathname = '/admin.html';
  const filePath = path.resolve(ROOT, `.${pathname}`);
  if (!filePath.startsWith(ROOT + path.sep) && filePath !== path.join(ROOT, 'index.html')) {
    response.writeHead(403).end('Forbidden'); return;
  }
  fs.readFile(filePath, (error, content) => {
    if (error) { response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found'); return; }
    response.writeHead(200, {
      'content-type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store'
    });
    response.end(content);
  });
}).listen(PORT, '0.0.0.0', () => {
  console.log(`TechBuilders preview: http://localhost:${PORT}`);
  console.log(`Admin page:           http://localhost:${PORT}/admin.html`);
  console.log('Preview is static only; Firebase must be configured for real menu data and orders.');
});
