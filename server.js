require('./history-seed').bootstrap();
const { jakartaTime, messageView } = require('./chat-identity');
// Minimal dependency-free web server for NEO App (web service).
// Serves static files and two dynamic, per-request endpoints that prove
// code executes on the server: /api/server-info (JSON) and /live (HTML).
const http = require('node:http');
const os = require('node:os');
const { readFile } = require('node:fs/promises');
const { join, normalize, extname } = require('node:path');

const crypto = require('node:crypto');
const dc = require('./dc');
const pay = require('./pay');
const store = require('./state-store');
const { allowedPagesOrigin, visitorCorsHeaders, publicReadCorsHeaders, checkoutCorsHeaders, clientKey, createRateLimiter } = require('./public-api');

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

function readBody(req, maxBytes = 65536) {
  return new Promise((resolve) => {
    let data = '';
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) { tooLarge = true; return; }
      if (!tooLarge) data += chunk.toString('utf8');
    });
    req.on('end', () => resolve(tooLarge ? null : data));
    req.on('error', () => resolve(null));
  });
}

const savedPublic = store.get('publicThread', { messages: [], payments: [], startup: [] });
if (!Array.isArray(savedPublic.messages) || !Array.isArray(savedPublic.payments) || !Array.isArray(savedPublic.startup)) throw new Error('Invalid saved public thread');
const visitorMessages = savedPublic.messages.slice(-100);
const paymentWebAnnouncements = new Set(savedPublic.payments);
const startupWebMessages = new Set(savedPublic.startup);
function savePublic() { store.set('publicThread', { messages: visitorMessages, payments: [...paymentWebAnnouncements], startup: [...startupWebMessages] }); }
function appendPublic(message) {
  visitorMessages.push({ ...message, timestamp: message.timestamp || new Date().toISOString() });
  if (visitorMessages.length > 100) visitorMessages.splice(0, visitorMessages.length - 100);
  savePublic();
}
async function flushPaymentAnnouncements() {
  await pay.drainPaidEvents(async event => {
    const text = '[Payment ' + event.orderId + '] Sandbox payment received (verified ' + event.providerStatus + ').\n'
      + event.itemName + ' | ' + 'Rp' + Number(event.amount).toLocaleString('id-ID') + ' | 1 unit.\n'
      + 'Product status: paid (demo). Quantity remaining after this payment: ' + event.stockRemaining + '.\n'
      + 'No real money, delivery or seller payout.';
    if (!paymentWebAnnouncements.has(event.orderId)) {
      paymentWebAnnouncements.add(event.orderId);
      appendPublic({ from: 'Marketplace (bot)', origin: 'bot', speaker: 'Marketplace', text, time: jakartaTime() });
      if (visitorMessages.length > 100) visitorMessages.splice(0, visitorMessages.length - 100);
    }
    return dc.bridge.relayOnce('payment:' + event.orderId, text, '[Payment ' + event.orderId + ']');
  });
}
let startupDone = false, startupPublishing = false;
const welcomedContacts = new Set(store.get('publicHistoryRecipients', []));
async function welcomePublicHistory(arrivals) {
  const human = visitorMessages.filter(m=>m.nativeHuman).slice(-100);
  const text = 'Historical public-group messages, sent privately for context. These are quotes, not new messages from their authors. Display names are self-reported. Private 1:1 chats are never included.\n\n' + human.map(messageView).map(m=>m.time + ' | ' + m.from + ': ' + m.text).join('\n\n');
  for (const id of arrivals) {
    if (human.length && !await dc.bridge.sendPublicHistoryToNewcomer(id, text)) continue;
    welcomedContacts.add(id);
    store.set('publicHistoryRecipients', [...welcomedContacts]);
  }
}
const memberFirstSeen = new Map();
async function publishStartupShop() {
  if (startupPublishing) return;
  startupPublishing = true;
  try {
    const state = await dc.status();
    if (!state.configured || !state.sharedGroupLinked) return;
    const tag = String(state.botAddress || '').split('@')[0].slice(0, 6);
    const audience = await dc.bridge.publicAudience();
    for (const id of audience) if (!memberFirstSeen.has(id)) memberFirstSeen.set(id, Date.now());
    // Membership can appear before securejoin finishes. Give the handshake one
    // polling interval, then resend original IDs so old recipients deduplicate.
    const arrivals = audience.filter(id => !welcomedContacts.has(id) && Date.now() - memberFirstSeen.get(id) >= 4000);
    const keys = ['startup:shop:', 'startup:deadpool:', 'startup:ironman:'].map(k=>k+tag);
    if (startupDone) {
      if (arrivals.length && await dc.bridge.replayPublicHistory()) await welcomePublicHistory(arrivals);
      return;
    }
    const entries = [
      { key: 'startup:shop:' + tag, from: 'Marketplace (bot)', marker: '[Shop #' + tag + ']',
        text: '[Shop #' + tag + '] Opening inventory snapshot. Use /shop for current stock. ' + (store.enabled ? 'Private storage is configured for chat, stock and listings.\n' : 'Chat, stock and custom listings reset on server restart until persistence is added.\n') + await pay.marketCommand('/shop') },
      { key: 'startup:deadpool:' + tag, from: 'Deadpool (bot)', marker: '[Deadpool #' + tag + ']',
        text: '[Deadpool #' + tag + '] Welcome to my Fourth-Wall Gift Shop: taco tokens Rp10,000, rubber ducks Rp20,000, sticker packs Rp12,000. Fictional wares, real attitude. /shop. Sandbox only.' },
      { key: 'startup:ironman:' + tag, from: 'Ironman (bot)', marker: '[Ironman #' + tag + ']',
        text: '[Ironman #' + tag + '] Stark Dimensional Outlet is online: holo companions Rp25,000, reactor-style lamps Rp45,000, keychains Rp15,000. Premium fictional tech, sensible demo prices. /shop or /buy item-id. No real goods or payouts.' },
    ];
    for (const entry of entries) {
      if (!startupWebMessages.has(entry.key)) {
        startupWebMessages.add(entry.key);
        appendPublic({ from: entry.from, origin: 'bot', speaker: entry.from.split(' (')[0], text: entry.text, time: jakartaTime() });
      }
    }
    if (visitorMessages.length > 100) visitorMessages.splice(0, visitorMessages.length - 100);
    // A newly created group has no audience. Delta Chat does not replay these
    // old messages to future joiners, so wait for its first human member.
    if (!arrivals.length && !(welcomedContacts.size && audience.length)) return;
    for (const entry of entries) {
      if (!await dc.bridge.relayOnce(entry.key, entry.text, entry.marker, entry.from === 'Ironman (bot)' ? 'Ironman' : entry.from === 'Deadpool (bot)' ? 'Deadpool' : null)) return;
    }
    if (!await dc.bridge.replayPublicHistory()) return;
    startupDone = true;
    await welcomePublicHistory(arrivals);
  } finally { startupPublishing = false; }
}
const announcementTimer = setInterval(() => {
  flushPaymentAnnouncements().catch(() => {});
  publishStartupShop().catch(() => {});
}, 5000);
announcementTimer.unref();
// Bounded voice variety (owner request 12:20, scoped 12:29): every third
// ordinary visitor message is answered by a character instead of Naung -
// same single API call per human message, characters never speak unprompted.
let ordinaryCount = 0;
let charTurn = 0;
const visitorRateByIp = createRateLimiter({ maxRequests: 30, windowMs: 60 * 60 * 1000, minIntervalMs: 2000 });
const visitorGlobalRate = createRateLimiter({ maxRequests: 120, windowMs: 60 * 60 * 1000 });
const payLastByIp = new Map();
// Only explicit transport-origin metadata decides speaker identity. Legacy
// records without metadata are treated as quoted context, never assistant turns.
const toHist = list => list.map(m => ({ origin: m.nativeHuman ? 'human' : m.origin, speaker: m.speaker, from: m.from, text: m.text }));
async function publishAnswer(answer) {
  const record = { ...answer, origin: 'bot', speaker: answer.persona || (answer.from === 'Marketplace (bot)' ? 'Marketplace' : 'Naung'), time: jakartaTime(), timestamp: new Date().toISOString(), delivery: 'pending' };
  appendPublic(record);
  const saved = visitorMessages[visitorMessages.length - 1];
  try {
    saved.delivery = await dc.bridge.relayToGroup(`[${record.speaker === 'Naung' ? 'bot' : record.speaker}] ${answer.text}`, answer.persona || null) ? 'sent' : 'failed';
  } catch { saved.delivery = 'failed'; }
  if (saved.delivery === 'failed') console.warn('Native public reply delivery failed');
  savePublic();
  return saved.delivery;
}

// One reply per human public message, shared across web and Delta Chat.
async function publicReply(text, hist) {
  let persona = dc.fenrir.personaFor(text);
  if (!persona) {
    ordinaryCount += 1;
    if (ordinaryCount % 3 === 0) persona = (charTurn++ % 2 === 0) ? 'Ironman' : 'Deadpool';
  }
  const ai = await dc.fenrir.reply(text, hist, persona).catch(() => null);
  const reply = ai || (dc.fenrir.enabled()
    ? `AI reply unavailable right now, echoing instead. You said: ${text}` : `You said: ${text}`);
  return { persona, from: persona ? `${persona} (bot)` : 'bot', text: reply };
}

dc.bridge.onPeerMessage = async ({ from, text, origin = 'human', speakerId }) => {
  if (origin !== 'human') return;
  appendPublic({ from, text, origin: 'human', speakerId, nativeHuman: true, time: jakartaTime() });
  if (visitorMessages.length > 100) visitorMessages.splice(0, visitorMessages.length - 100);
  // A character bot answers when a human in the group names it (owner
  // request 12:20); characters never react to bot/character messages, so
  // no bot-to-bot loop can start.
  const commerce = await pay.marketCommand(text);
  if (commerce) {
    await publishAnswer({ from: 'Marketplace (bot)', text: commerce });
    return;
  }
  const answer = await publicReply(text, toHist(visitorMessages.slice(-11, -1)));
  await publishAnswer(answer);
};

const root = __dirname;
const port = Number(process.env.PORT) || 8080;
const startedAt = Date.now();
let requestsTotal = 0;
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json', '.md': 'text/markdown; charset=utf-8' };

function serverInfo(req) {
  return {
    now: new Date().toISOString(),
    storageConfigured: store.enabled,
    stateId: store.enabled ? store.id : null,
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
  const visitorApi = path === '/api/visitor/messages' || path === '/api/visitor/send';
  const pagesReadApi = ['/api/pay/catalog', '/api/deltachat/status', '/api/server-info', '/api/history'].includes(path);
  const checkoutApi = ['/api/pay/create', '/api/pay/checkout', '/api/pay/status'].includes(path);
  // Keep the NEO host as the API and bot backend, but send public browser pages
  // to their Pages equivalents. Preserve /pay query parameters so existing
  // Midtrans return links can resume on the Pages checkout UI.
  const pagesRedirects = {
    '/': 'https://vanipy.com/naung/',
    '/pay': 'https://vanipy.com/naung/#shop-title',
    '/pay/': 'https://vanipy.com/naung/#shop-title',
    '/deltachat': 'https://vanipy.com/naung/#group-title',
    '/deltachat/': 'https://vanipy.com/naung/#group-title',
    '/deltachat/chats': 'https://vanipy.com/naung/#group-title',
    '/deltachat/chat': 'https://vanipy.com/naung/#group-title',
    '/history': 'https://vanipy.com/naung/#history-title',
    '/history/': 'https://vanipy.com/naung/#history-title',
    '/live': 'https://vanipy.com/naung/#server-title',
    '/live/': 'https://vanipy.com/naung/#server-title',
  };
  if (req.method === 'GET' && Object.hasOwn(pagesRedirects, path)) {
    const destination = new URL(pagesRedirects[path]);
    if (path === '/pay' || path === '/pay/') destination.search = new URL(req.url, 'http://x').search;
    res.writeHead(301, { location: destination.href, 'cache-control': 'public, max-age=86400' });
    res.end();
    return;
  }
  if (checkoutApi) {
    const cors = checkoutCorsHeaders(req.headers.origin, path === '/api/pay/create' ? 'POST' : 'GET');
    if (cors) { for (const [name, value] of Object.entries(cors)) if (value) res.setHeader(name, value); }
    if (req.method === 'OPTIONS') {
      if (!cors) { res.writeHead(403, { 'content-type': 'application/json', 'vary': 'Origin' }); res.end(JSON.stringify({ error: 'origin not allowed' })); return; }
      res.writeHead(204, cors); res.end(); return;
    }
    if (req.headers.origin && !cors) { res.writeHead(403, { 'content-type': 'application/json', 'vary': 'Origin' }); res.end(JSON.stringify({ error: 'origin not allowed' })); return; }
  }
  const publicHtmlRead = path === '/history';
  if (visitorApi) {
    const cors = visitorCorsHeaders(req.headers.origin);
    if (cors) for (const [name, value] of Object.entries(cors)) res.setHeader(name, value);
    if (req.method === 'OPTIONS') {
      if (!cors) { res.writeHead(403, { 'content-type': 'application/json', 'vary': 'Origin' }); res.end(JSON.stringify({ error: 'origin not allowed' })); return; }
      res.writeHead(204, cors); res.end(); return;
    }
    if (req.headers.origin && !cors) {
      res.writeHead(403, { 'content-type': 'application/json', 'vary': 'Origin' }); res.end(JSON.stringify({ error: 'origin not allowed' })); return;
    }
  }
  if (pagesReadApi || publicHtmlRead) {
    const cors = publicReadCorsHeaders(req.headers.origin);
    if (cors) for (const [name, value] of Object.entries(cors)) res.setHeader(name, value);
    if (req.method === 'OPTIONS') {
      if (!cors) { res.writeHead(403, { 'content-type': 'application/json', 'vary': 'Origin' }); res.end(JSON.stringify({ error: 'origin not allowed' })); return; }
      res.writeHead(204, cors); res.end(); return;
    }
    if (req.headers.origin && !cors) {
      res.writeHead(403, { 'content-type': 'application/json', 'vary': 'Origin' }); res.end(JSON.stringify({ error: 'origin not allowed' })); return;
    }
    if ((pagesReadApi || publicHtmlRead) && req.method !== 'GET') { res.writeHead(405, { 'allow': 'GET, OPTIONS' }); res.end(); return; }
  }
  if (path === '/api/history') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(store.get('historicalArchive', null) || { capturedAt: null, records: [] }));
    return;
  }
  if (path === '/history') {
    const html = dc.shell('Historical public chat', require('./history-seed').render(store.get('historicalArchive',null)));
    res.writeHead(200, { 'content-type':'text/html; charset=utf-8', 'cache-control':'no-store', ...(req.headers.origin ? publicReadCorsHeaders(req.headers.origin) : {}) });
    res.end(html);
    return;
  }
  if (path === '/api/server-info') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(serverInfo(req), null, 2));
    return;
  }
  if (path === '/api/deltachat/status') {
    try {
      const s = await dc.status();
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(s, null, 2));
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(err).slice(0, 200) }));
    }
    return;
  }
  if (path === '/deltachat') {
    try {
      const s = await dc.status();
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(dc.statusPage(s, null));
    } catch (err) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(dc.statusPage(null, err));
    }
    return;
  }
  if (path === '/pay') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(pay.payPage(dc.shell));
    return;
  }
  if (path === '/api/pay/create') {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    const params = new URLSearchParams(await readBody(req));
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
    const now = Date.now();
    if (now - (payLastByIp.get(ip) || 0) < 2000) {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'slow down' }));
      return;
    }
    payLastByIp.set(ip, now);
    const order = await pay.createOrder(String(params.get('item') || ''), { returnToPages: params.get('return') === 'pages' });
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(order.error
      ? { error: order.error }
      : { ...pay.publicOrder(order), token: order.token, redirectUrl: order.redirectUrl, ...pay.publicCheckoutConfig() }));
    return;
  }
  if (path === '/api/pay/catalog') {
    // Read-only public catalog endpoint; never reconcile or query payment providers here.
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(pay.catalog()));
    return;
  }
  if (path === '/api/pay/checkout') {
    if (req.method !== 'GET') { res.writeHead(405, { 'allow': 'GET, OPTIONS' }); res.end(); return; }
    const id = String(new URL(req.url, 'http://x').searchParams.get('id') || '');
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    const order = pay.checkoutOrder(id);
    res.end(JSON.stringify(order.error ? order : { ...order, ...pay.publicCheckoutConfig() }));
    return;
  }
  if (path === '/api/pay/status') {
    if (req.method !== 'GET') { res.writeHead(405, { 'allow': 'GET, OPTIONS' }); res.end(); return; }
    const id = String(new URL(req.url, 'http://x').searchParams.get('id') || '');
    const order = pay.orders.get(id);
    if (order) {
      await pay.refreshStatus(order);
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(pay.publicOrder(order)));
      return;
    }
    // Local record gone (server restart): recover provider-verified state so
    // confirmation links survive resets. Read-only provider lookup, demo ids only.
    const recovered = await pay.lookupProvider(id);
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(recovered || { error: 'unknown order' }));
    return;
  }
  if (path === '/api/pay/notification') {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    let body = {};
    try { body = JSON.parse(await readBody(req) || '{}'); } catch { /* keep {} */ }
    const out = pay.handleNotification(body);
    res.writeHead(out.ok ? 200 : 401, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out));
    return;
  }
  if (path === '/api/visitor/messages') {
    if (req.method !== 'GET') { res.writeHead(405, { 'allow': 'GET, OPTIONS' }); res.end(); return; }
    // Same public thread the Pages frontend polls; no private 1:1 content.
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ messages: visitorMessages.slice(-20).reverse().map(messageView) }));
    return;
  }
  if (path === '/api/visitor/send') {
    if (req.method !== 'POST') { res.writeHead(405, { 'allow': 'POST, OPTIONS' }); res.end(); return; }
    if (!allowedPagesOrigin(req.headers.origin)) { res.writeHead(403, { 'content-type': 'application/json', 'vary': 'Origin' }); res.end(JSON.stringify({ error: 'origin not allowed' })); return; }
    if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/x-www-form-urlencoded')) {
      res.writeHead(415, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'use form-urlencoded data' })); return;
    }
    const length = Number(req.headers['content-length'] || 0);
    if (length > 4096) { res.writeHead(413, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'message is too large' })); return; }
    if (!(await dc.status()).configured) { res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '4' }); res.end(JSON.stringify({ error: 'The bot team is still setting up. Please retry shortly.' })); return; }
    const rawBody = await readBody(req, 4096);
    if (rawBody === null) { res.writeHead(413, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'message is too large' })); return; }
    const params = new URLSearchParams(rawBody);
    const text = String(params.get('text') || '').trim();
    if (!text || text.length > 500) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'write a message of 1 to 500 characters' })); return; }
    const ipKey = clientKey(req, process.env.NAUNG_TRUST_PROXY_XFF === 'true');
    const globalLimit = visitorGlobalRate('all');
    const ipLimit = visitorRateByIp(ipKey);
    if (!globalLimit.allowed || !ipLimit.allowed) {
      const retryAfter = Math.max(globalLimit.retryAfter, ipLimit.retryAfter);
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': String(retryAfter) });
      res.end(JSON.stringify({ error: 'slow down before posting again', retryAfter })); return;
    }
    const at = jakartaTime();
    const hist = toHist(visitorMessages.slice(-10));
    appendPublic({ from: 'visitor', origin: 'human', text, time: at, delivery: 'pending' });
    const visitorRecord = visitorMessages[visitorMessages.length - 1];
    try { visitorRecord.delivery = await dc.bridge.relayToGroup(`[visitor] ${text}`) ? 'sent' : 'failed'; } catch { visitorRecord.delivery = 'failed'; }
    savePublic();
    const commerce = await pay.marketCommand(text);
    if (commerce) await publishAnswer({ from: 'Marketplace (bot)', text: commerce });
    else await publishAnswer(await publicReply(text, hist));
    if (visitorMessages.length > 100) visitorMessages.splice(0, visitorMessages.length - 100);
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: true, messages: visitorMessages.slice(-20).reverse().map(messageView) }));
    return;
  }
  if (path === '/visitor/send') {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    if (!(await dc.status()).configured) { res.writeHead(503, { 'content-type': 'text/plain', 'retry-after': '4' }); res.end('The bot team is still setting up. Please retry shortly.'); return; }
    const params = new URLSearchParams(await readBody(req));
    const text = String(params.get('text') || '').trim().slice(0, 500);
    const ip = clientKey(req, process.env.NAUNG_TRUST_PROXY_XFF === 'true');
    if (text && visitorRateByIp(ip).allowed) {
      const at = jakartaTime(); // HH:MM WIB
      // Public-thread context (owner request 12:18): only this public
      // thread's own recent messages; private 1:1 content never enters.
      const hist = toHist(visitorMessages.slice(-10));
      appendPublic({ from: 'visitor', origin: 'human', text, time: at, delivery: 'pending' });
      const visitorRecord = visitorMessages[visitorMessages.length - 1];
      try { visitorRecord.delivery = await dc.bridge.relayToGroup(`[visitor] ${text}`) ? 'sent' : 'failed'; } catch { visitorRecord.delivery = 'failed'; }
      savePublic();
      const commerce = await pay.marketCommand(text);
      if (commerce) {
        await publishAnswer({ from: 'Marketplace (bot)', text: commerce });
        if (visitorMessages.length > 100) visitorMessages.splice(0, visitorMessages.length - 100);
        res.writeHead(303, { location: '/#visitor' }); res.end(); return;
      }
      const answer = await publicReply(text, hist);
      await publishAnswer(answer);
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
      const visitorData = s.messagingEnabled ? { messages: visitorMessages.slice(-20).reverse().map(messageView) } : null; // newest first, nearest the top input (owner request 11:55)
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
