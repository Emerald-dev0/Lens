#!/usr/bin/env node
/**
 * Static server for the Lens demo application.
 *
 * Zero dependencies on purpose: `lens`'s own test suite and the README quick start
 * must run without installing anything else. It serves `fixtures/demo-app/public`
 * and exposes a tiny in-memory-ish JSON API backed by the browser's localStorage,
 * so a demo can show real data being created.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

/**
 * Parse a request target defensively. `new URL()` rejects protocol-relative forms
 * such as `//`, and a demo server must not throw on a malformed request line.
 */
function parseRequestUrl(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return new URL('http://localhost/');
  const value = raw.startsWith('//') ? raw.slice(1) : raw.startsWith('/') ? raw : `/${raw}`;
  try {
    return new URL(value, 'http://localhost');
  } catch {
    return new URL('/', 'http://localhost');
  }
}

export function createDemoServer(options = {}) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(options.dir ?? path.join(here, 'public'));
  const wantedPort = options.port ?? Number(process.env.DEMO_PORT ?? 4173);

  const server = http.createServer((req, res) => {
    const url = parseRequestUrl(req.url);
    const route = url.pathname;

    if (route === '/api/health') return json(res, 200, { ok: true, service: 'lens-demo-app', time: new Date().toISOString() });

    if (route === '/api/metrics') {
      // A deliberately flaky endpoint so `lens network` has something to complain about.
      if (url.searchParams.get('mode') === 'fail') return json(res, 500, { error: 'metrics_backend_unavailable' });
      return json(res, 200, {
        range: url.searchParams.get('range') ?? '30d',
        series: [
          { label: 'Mon', value: 42 },
          { label: 'Tue', value: 58 },
          { label: 'Wed', value: 51 },
          { label: 'Thu', value: 73 },
          { label: 'Fri', value: 96 },
          { label: 'Sat', value: 31 },
          { label: 'Sun', value: 27 },
        ],
      });
    }

    if (route === '/api/create-project' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > 1e6) req.destroy();
      });
      req.on('end', () => {
        try {
          const payload = JSON.parse(body || '{}');
          if (!payload.name) return json(res, 422, { error: 'name_required' });
          return json(res, 201, { id: `prj_${Math.random().toString(36).slice(2, 8)}`, name: payload.name, createdAt: new Date().toISOString() });
        } catch {
          return json(res, 400, { error: 'invalid_json' });
        }
      });
      return undefined;
    }

    let filePath = route === '/' ? '/index.html' : route;
    filePath = path.join(root, filePath.replace(/^\/+/, ''));
    if (!filePath.startsWith(root)) {
      res.writeHead(403).end('forbidden');
      return undefined;
    }
    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) filePath = path.join(filePath, 'index.html');
    if (!fs.existsSync(filePath)) {
      // SPA fallback: unknown non-asset paths render the app shell.
      const fallback = path.join(root, 'index.html');
      if (!path.extname(filePath) && fs.existsSync(fallback)) {
        res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
        res.end(fs.readFileSync(fallback));
        return undefined;
      }
      res.writeHead(404, { 'content-type': 'text/plain' }).end(`404 Not Found: ${route}`);
      return undefined;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(fs.readFileSync(filePath));
    return undefined;
  });

  return {
    root,
    listen(port = wantedPort) {
      return new Promise((resolve, reject) => {
        const onError = (err) => reject(err);
        server.once('error', onError);
        server.listen(port, '127.0.0.1', () => {
          server.off('error', onError);
          const address = server.address();
          const actual = typeof address === 'object' && address ? address.port : port;
          resolve({ url: `http://127.0.0.1:${actual}`, port: actual, close: () => new Promise((r) => server.close(() => r())) });
        });
      });
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function json(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(payload));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createDemoServer();
  server.listen().then(({ url, port }) => {
    process.stdout.write(`Lens demo app listening on ${url}  (try: node bin/lens.mjs open ${url})\n`);
    process.stdout.write(`Defect mode for reviewer tests: ${url}/?defects=1\n`);
    void port;
  });
}
