// Minimal dependency-free web server for NEO App (web service).
// Serves static files and two dynamic, per-request endpoints that prove
// code executes on the server: /api/server-info (JSON) and /live (HTML).
const http = require('node:http');
const os = require('node:os');
const { readFile } = require('node:fs/promises');
const { join, normalize, extname } = require('node:path');

const root = __dirname;
const port = Number(process.env.PORT) || 8080;
const startedAt = Date.now();
let requestsTotal = 0;
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json', '.md': 'text/markdown; charset=utf-8' };

function serverInfo(req) {
  return {
    now: new Date().toISOString(),
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    pod: os.hostname(),
    node: process.version,
    pid: process.pid,
    requestsTotal,
    memoryRssBytes: process.memoryUsage().rss,
    method: req.method,
    path: req.url,
  };
}

function livePage(info) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Live from the server</title>
  <style>
    body { font-family: system-ui, sans-serif; display: grid; place-items: center; min-height: 100vh; margin: 0; background: #0f172a; color: #e2e8f0; }
    main { text-align: center; }
    h1 { font-size: 2.25rem; margin: 0 0 1rem; }
    dl { display: inline-grid; grid-template-columns: auto auto; gap: .35rem 1rem; text-align: left; }
    dt { color: #94a3b8; }
    dd { margin: 0; font-family: ui-monospace, monospace; }
    p { color: #94a3b8; }
    a { color: #7dd3fc; }
  </style>
</head>
<body>
  <main>
    <h1>Rendered by the server just now</h1>
    <dl>
      <dt>server time (UTC)</dt><dd>${info.now}</dd>
      <dt>uptime</dt><dd>${info.uptimeSeconds}s</dd>
      <dt>pod hostname</dt><dd>${info.pod}</dd>
      <dt>node</dt><dd>${info.node}</dd>
      <dt>requests served</dt><dd>${info.requestsTotal}</dd>
    </dl>
    <p>Reload and every value changes. Same data as JSON at <a href="/api/server-info">/api/server-info</a>.</p>
    <p><a href="/">&larr; Hello World</a></p>
  </main>
</body>
</html>`;
}

http.createServer(async (req, res) => {
  requestsTotal += 1;
  const path = (req.url || '/').split('?')[0];
  if (path === '/api/server-info') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(serverInfo(req), null, 2));
    return;
  }
  if (path === '/live') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(livePage(serverInfo(req)));
    return;
  }
  try {
    let p = decodeURIComponent(path);
    if (p.endsWith('/')) p += 'index.html';
    const file = join(root, normalize(p));
    if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
}).listen(port, () => console.log(`listening on ${port}`));
