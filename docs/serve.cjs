const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.zip': 'application/zip', '.json': 'application/json' };
http.createServer((req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const file = path.resolve(__dirname, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(__dirname + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end('Not found'); return; }
    const size = fs.statSync(file).size;
    const headers = { 'Content-Type': types[path.extname(file)] || 'text/plain', 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes' };
    // Match static hosting's byte-range behavior so video chapters can seek locally.
    if (req.headers.range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (!match || (!match[1] && !match[2])) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return; }
      const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
      const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
      if (start >= size || start > end) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return; }
      res.writeHead(206, { ...headers, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${size}` });
      if (req.method === 'HEAD') { res.end(); return; }
      const stream = fs.createReadStream(file, { start, end });
      res.on('close', () => stream.destroy());
      stream.pipe(res);
      return;
    }
    res.writeHead(200, { ...headers, 'Content-Length': size });
    if (req.method === 'HEAD') { res.end(); return; }
    const stream = fs.createReadStream(file);
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  } catch { res.writeHead(400); res.end('Bad request'); }
}).listen(Number(process.env.PORT || 4173), '127.0.0.1', () => console.log(`Cloak website: http://127.0.0.1:${process.env.PORT || 4173}`));
