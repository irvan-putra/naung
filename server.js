// Minimal dependency-free web server for NEO App (web service).
// Serves static files and two dynamic, per-request endpoints that prove
// code executes on the server: /api/server-info (JSON) and /live (HTML).
const http = require('node:http');
const os = require('node:os');
const { readFile } = require('node:fs/promises');
const { join, normalize, extname } = require('node:path');

const crypto = require('node:crypto');
const dc = require('./dc');

// HTTP Basic gate for Delta Chat messaging routes. Active only when the
// operator sets DC_DEMO_PASSWORD; any username is accepted. Standard-library
// constant-time comparison, no custom crypto.
function demoAuthOk(req) {
  const expected = process.env.DC_DEMO_PASSWORD;
  if (!expected) return true;
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  const pass = Buffer.from(header.slice(6), 'base64').toString('utf8').split(':').slice(1).join(':');
  const a = Buffer.from(pass);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 65536) req.destroy();
    });
    req.on('end', () => resolve(data));
    req.on('error', () => resolve(''));
  });
}

const visitorMessages = []; // public, in-memory, gone on restart (demo)
const visitorLastByIp = new Map();
dc.bridge.onPeerMessage = ({ from, text }) => {
  visitorMessages.push({ from, text, time: new Date().toTimeString().slice(0, 5) });
  if (visitorMessages.length > 100) visitorMessages.splice(0, visitorMessages.length - 100);
};

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
    <p>Time, uptime and request count are computed fresh on each request; reload to watch them change. Same data as JSON at <a href="/api/server-info">/api/server-info</a>.</p>
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
  if (path === '/deltachat' || path === '/api/deltachat/status') {
    try {
      const s = await dc.status();
      if (path === '/deltachat') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(dc.statusPage(s, null));
      } else {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(s, null, 2));
      }
    } catch (err) {
      if (path === '/deltachat') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(dc.statusPage(null, err));
      } else {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(err).slice(0, 200) }));
      }
    }
    return;
  }
  if (path === '/visitor/send') {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    const params = new URLSearchParams(await readBody(req));
    const text = String(params.get('text') || '').trim().slice(0, 500);
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
    const now = Date.now();
    if (text && now - (visitorLastByIp.get(ip) || 0) > 2000) {
      visitorLastByIp.set(ip, now);
      const at = new Date().toTimeString().slice(0, 5); // HH:MM
      visitorMessages.push({ from: 'visitor', text, time: at });
      dc.bridge.relayToGroup(`[visitor] ${text}`).catch(() => null);
      const ai = await dc.fenrir.reply(text).catch(() => null);
      const botText = ai
        || (dc.fenrir.enabled()
          ? `AI reply unavailable right now, echoing instead. You said: ${text}`
          : `You said: ${text}`);
      visitorMessages.push({ from: 'bot', text: botText, time: at });
      dc.bridge.relayToGroup(`[bot] ${botText}`).catch(() => null);
      if (visitorMessages.length > 100) visitorMessages.splice(0, visitorMessages.length - 100);
    }
    res.writeHead(303, { location: '/#visitor' });
    res.end();
    return;
  }
  if (path === '/deltachat/chats' || path === '/deltachat/chat' || path === '/deltachat/send') {
    if (process.env.DC_DEMO_PASSWORD && !process.env.DC_DEMO_PUBLIC && !demoAuthOk(req)) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="naung demo"', 'content-type': 'text/plain; charset=utf-8' });
      res.end('authentication required');
      return;
    }
    try {
      if (path === '/deltachat/chats') {
        const body = dc.chatsPage(await dc.listChats());
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(body);
      } else if (path === '/deltachat/chat') {
        const id = Number(new URL(req.url, 'http://x').searchParams.get('id')) || 0;
        const body = dc.chatPage(await dc.readChat(id));
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(body);
      } else {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
        const params = new URLSearchParams(await readBody(req));
        const out = await dc.sendText(Number(params.get('chat')) || 0, params.get('text') || '');
        if (out.ok) {
          const back = String(params.get('back') || '');
          const target = back.startsWith('/') && !back.startsWith('//') ? back : `/deltachat/chat?id=${Number(params.get('chat')) || 0}`;
          res.writeHead(303, { location: target });
          res.end();
        } else {
          const body = dc.chatPage({ disabled: out.error });
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
          res.end(body);
        }
      }
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`error: ${String(err).slice(0, 200)}`);
    }
    return;
  }
  if (path === '/live') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(livePage(serverInfo(req)));
    return;
  }
  if (path === '/') {
    try {
      const s = await dc.status();
      const visitorData = s.messagingEnabled ? { messages: visitorMessages.slice(-20).reverse() } : null; // newest first, nearest the top input (owner request 11:55)
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(dc.homePage(s, null, null, null, visitorData));
    } catch (err) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(dc.homePage(null, err));
    }
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

// Boot the Delta Chat bot in the background (creates its throwaway account on
// first run); failures surface on /deltachat, never crash the web server.
dc.ensureBoot().catch(() => null);
