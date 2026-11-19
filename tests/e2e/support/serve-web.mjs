// Owner: Agent H. Playwright webServer #2: serves the production web build (apps/web/dist) and proxies /api to
// the API, like Caddy does in production (same origin, so the session cookie and CSRF rules are the real ones).
import { createServer, request as httpRequest } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const dist = join(root, 'apps/web/dist');
const PORT = Number(process.env.E2E_WEB_PORT ?? 4300);
const API_PORT = Number(process.env.E2E_API_PORT ?? 3100);
if (!existsSync(join(dist, 'index.html'))) throw new Error('apps/web/dist missing: run `pnpm --filter @sms/web build` first');

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff', '.json': 'application/json', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    const up = httpRequest({ host: '127.0.0.1', port: API_PORT, path: req.url, method: req.method, headers: { ...req.headers, 'x-forwarded-proto': 'https' } }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on('error', (err) => { res.writeHead(502); res.end(`api unreachable: ${err.message}`); });
    req.pipe(up);
    return;
  }
  let file = normalize(join(dist, decodeURIComponent(url.pathname)));
  if (!file.startsWith(dist) || !existsSync(file) || statSync(file).isDirectory()) file = join(dist, 'index.html');
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
}).listen(PORT, '127.0.0.1', () => console.log(`[e2e] web on http://localhost:${PORT} (api :${API_PORT})`));
