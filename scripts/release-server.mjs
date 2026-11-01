import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const roots = {
  'release-a': path.resolve('dist-release-a'),
  'release-b': path.resolve('dist-release-b'),
};
let rootName = 'release-a';
const port = 4188;

const types = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.webmanifest', 'application/manifest+json'],
]);

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
  if (url.pathname === '/__control') {
    if (req.method === 'GET') {
      send(res, 200, rootName);
      return;
    }
    if (req.method !== 'POST') {
      send(res, 405, 'method');
      return;
    }
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const next = JSON.parse(Buffer.concat(chunks).toString('utf8')).root;
        if (!Object.hasOwn(roots, next)) {
          send(res, 400, 'unknown release');
          return;
        }
        rootName = next;
        send(res, 200, rootName);
      } catch {
        send(res, 400, 'bad control');
      }
    });
    return;
  }

  const root = roots[rootName];
  let pathname = decodeURIComponent(url.pathname);
  if (pathname.endsWith('/')) pathname += 'index.html';
  const file = path.resolve(root, `.${pathname}`);
  if (!file.startsWith(`${root}${path.sep}`)) {
    send(res, 403, 'forbidden');
    return;
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    send(res, 404, 'missing');
    return;
  }
  send(res, 200, fs.readFileSync(file), types.get(path.extname(file)) ?? 'application/octet-stream');
});

server.listen(port, '127.0.0.1');
