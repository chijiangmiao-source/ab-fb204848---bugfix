// src/server.js
// 纯内置模块的静态服务器：可配置宿主端口，提供页面与 /healthz。
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const WEB_DIR = join(ROOT, 'web');
const LIB_DIR = join(ROOT, 'lib');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

function safeResolve(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const base = decoded.startsWith('/lib/') ? LIB_DIR : WEB_DIR;
  const rel = decoded.startsWith('/lib/') ? decoded.slice('/lib/'.length) : decoded;
  const abs = normalize(join(base, rel));
  const inside = (dir) => abs === dir || abs.startsWith(dir + sep);
  if (inside(WEB_DIR) || inside(LIB_DIR)) {
    return abs;
  }
  return null;
}

async function serveStatic(req, res) {
  let abs;
  if (req.url === '/' || req.url === '/index.html') {
    abs = join(WEB_DIR, 'index.html');
  } else {
    abs = safeResolve(req.url);
  }
  if (!abs) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  let body;
  try {
    body = await readFile(abs);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not Found');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[extname(abs)] || 'application/octet-stream' });
  res.end(body);
}

export function createApp() {
  return createServer((req, res) => {
    if (req.method === 'GET' && req.url.split('?')[0] === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Method Not Allowed');
      return;
    }
    serveStatic(req, res);
  });
}

export function start(port, host = '0.0.0.0') {
  const server = createApp();
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT || 8080);
  const host = process.env.HOST || '0.0.0.0';
  start(port, host)
    .then((server) => {
      const address = server.address();
      console.log(`辐照见证台账已启动: http://${host}:${address.port}`);
    })
    .catch((err) => {
      console.error('启动失败:', err.message);
      process.exit(1);
    });
}
