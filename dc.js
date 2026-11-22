// Delta Chat bot + web integration for the Naung demo.
// Runs a real Delta Chat core (chatmail/core; built from the encore fork when
// bin/deltachat-rpc-server is present, otherwise the npm prebuilt) inside this
// service and talks to it over the official JSON-RPC API.
//
// Account model: the bot creates its own throwaway chatmail account in its
// container on first boot (no password exists anywhere; the account keys live
// only in the container's data dir). Its address and invite QR are public by
// design so people can message it from their own Delta Chat. Message contents
// are never served publicly: the chats/read/send web routes stay disabled
// unless the operator sets DC_DEMO_PASSWORD (HTTP Basic gate, constant-time
// compare, Node stdlib only).
const { existsSync } = require('node:fs');
const { join } = require('node:path');
const { spawn } = require('node:child_process');

const state = {
  startedAt: Date.now(),
  accountId: null,
  configured: false,
  configuring: false,
  addr: null,
  invite: null,
  inviteSvg: null,
  coreVersion: null,
  echoed: 0,
  lastError: null,
};

// A dead RPC child must never kill the web process; record and degrade.
process.on('uncaughtException', (err) => {
  if (err && (err.code === 'EPIPE' || err.code === 'ECONNRESET' || err.code === 'ERR_IPC_CHANNEL_CLOSED')) {
    state.lastError = `rpc transport lost (${err.code})`;
    return;
  }
  throw err;
});

// Returns null when the binary starts and stays up (stdin held open),
// else a short reason. A healthy rpc server idles waiting for stdin.
function preflightBin(bin) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, [], { stdio: ['pipe', 'ignore', 'ignore'] });
    } catch (e) {
      return resolve(String(e).slice(0, 120));
    }
    let settled = false;
    const done = (reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch {}
      resolve(reason);
    };
    child.on('error', (e) => done(String(e.code || e)));
    child.on('exit', (code) => done(`exited immediately (code ${code})`));
    const timer = setTimeout(() => done(null), 2000);
  });
}

const localBin = join(__dirname, 'bin', 'deltachat-rpc-server');
let coreSource = 'npm prebuilt (chatmail/core)';

async function selectCoreBinary() {
  if (!existsSync(localBin) || process.env.DELTA_CHAT_RPC_SERVER) return;
  const bad = await preflightBin(localBin);
  if (bad) {
    state.lastError = `encore binary failed to start: ${bad}`;
    coreSource = `npm prebuilt fallback (encore binary failed: ${bad})`;
  } else {
    process.env.DELTA_CHAT_RPC_SERVER = localBin;
    coreSource = 'encore fork (local binary)';
  }
}

// @deltachat/stdio-rpc-server is ESM-only; Node 18 cannot require() it.
// Loaded lazily in boot() via dynamic import().

const CHATMAIL_NEW_ACCOUNT_QR = 'dcaccount:https://nine.testrun.org/new';
const DATA_DIR = '/tmp/deltachat-data';



let dcInstance = null;
let bootPromise = null;

async function boot() {
  await selectCoreBinary();
  const { startDeltaChat } = await import('@deltachat/stdio-rpc-server');
  const dc = await startDeltaChat(DATA_DIR);
  dcInstance = dc;
  const info = await dc.rpc.getSystemInfo();
  state.coreVersion = info.deltachat_core_version || 'unknown';

  let accounts = await dc.rpc.getAllAccounts();
  if (!accounts.length) {
    await dc.rpc.addAccount();
    accounts = await dc.rpc.getAllAccounts();
  }
  const acc = accounts[accounts.length - 1];
  state.accountId = acc.id;
  await dc.rpc.selectAccount(acc.id).catch(() => null);

  dc.on('IncomingMsg', (accountId, event) => {
    onIncoming(accountId, event).catch((err) => { state.lastError = String(err).slice(0, 200); });
  });

  state.configured = await dc.rpc.isConfigured(acc.id).catch(() => false);
  if (state.configured) {
    await dc.rpc.startIoForAllAccounts().catch(() => null);
  }
  if (!state.configured && !state.configuring) {
    state.configuring = true;
    (async () => {
      try {
        await dc.rpc.batchSetConfig(acc.id, {
          bot: '1',
          displayname: 'Naung demo bot',
          selfstatus: 'Demo bot running on NEO App. Say hi!',
        });
        await dc.rpc.setConfigFromQr(acc.id, CHATMAIL_NEW_ACCOUNT_QR);
        state.configured = await dc.rpc.isConfigured(acc.id).catch(() => false);
        if (state.configured) {
          await publishIdentity();
          await dc.rpc.startIoForAllAccounts().catch(() => null);
        }
      } catch (err) {
        state.lastError = String(err).slice(0, 200);
      } finally {
        state.configuring = false;
      }
    })();
  } else if (state.configured) {
    await publishIdentity();
  }
  return dc;
}

async function publishIdentity() {
  const dc = dcInstance;
  if (!dc || state.accountId == null) return;
  const transports = await dc.rpc.listTransports(state.accountId).catch(() => []);
  state.addr = (transports[0] && transports[0].addr) || null;
  try {
    const [text, svg] = await dc.rpc.getChatSecurejoinQrCodeSvg(state.accountId, null);
    state.invite = text;
    state.inviteSvg = scaleQrSvg(svg);
  } catch {
    state.invite = null;
    state.inviteSvg = null;
  }
}

async function onIncoming(accountId, event) {
  const dc = dcInstance;
  if (!dc || !state.configured) return;
  const msg = await dc.rpc.getMessage(accountId, event.msgId).catch(() => null);
  if (!msg || msg.fromId === 1) return; // never echo ourselves
  const text = (msg.text || '').trim();
  if (!text) return;
  const reply = `You said: ${text.slice(0, 500)}\n\n(Naung demo bot on NEO App. This is a public demo; please don't send anything private.)`;
  await dc.rpc.miscSendTextMessage(accountId, event.chatId, reply);
  await dc.rpc.markseenMsgs(accountId, [event.msgId]).catch(() => null);
  state.echoed += 1;
}

function ensureBoot() {
  if (!bootPromise) {
    bootPromise = boot().catch((err) => {
      state.lastError = String(err).slice(0, 200);
      bootPromise = null;
      throw err;
    });
  }
  return bootPromise;
}

// The core's QR SVG draws 1-unit modules inside a translate() meant for a
// 400-unit-wide matrix but emits no scale, leaving an unscannable ~45px QR.
// Measure the matrix size from the path data and inject the missing scale.
function scaleQrSvg(svg) {
  if (!svg || svg.includes('scale(')) return svg;
  let size = 0;
  const re = /M(\d+),(\d+)h1/g;
  let m;
  while ((m = re.exec(svg))) {
    size = Math.max(size, Number(m[1]) + 1, Number(m[2]) + 1);
  }
  if (!size) return svg;
  const k = (400 / size).toFixed(4);
  return svg.replace(/<g(\s+)transform="translate\(([^)]+)\)"(\s*)>/, `<g$1transform="translate($2) scale(${k})"$3>`);
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function selectedAccount() {
  if (state.accountId == null) return { account: null, configured: false };
  return { account: { id: state.accountId }, configured: state.configured };
}

async function status() {
  await ensureBoot().catch(() => null);
  let chatCount = 0;
  if (dcInstance && state.configured && state.accountId != null) {
    const chats = await dcInstance.rpc.getChatlistEntries(state.accountId, 0, null, null).catch(() => []);
    chatCount = Array.isArray(chats) ? chats.length : 0;
  }
  return {
    coreVersion: state.coreVersion,
    coreSource,
    configuring: state.configuring,
    configured: state.configured,
    botAddress: state.addr,
    invite: state.invite,
    chatCount,
    echoed: state.echoed,
    uptimeSeconds: Math.round((Date.now() - state.startedAt) / 1000),
    messagingEnabled: Boolean(process.env.DC_DEMO_PASSWORD),
    lastError: state.lastError,
  };
}

async function listChats() {
  if (!process.env.DC_DEMO_PASSWORD) {
    return { disabled: 'Messaging is disabled: the operator has not set an access password for this demo.' };
  }
  await ensureBoot();
  const { account, configured } = await selectedAccount();
  if (!account || !configured) {
    return { disabled: 'The bot account is still being set up; try again in a moment.' };
  }
  const entries = await dcInstance.rpc.getChatlistEntries(account.id, 0, null, null).catch(() => []);
  const items = entries.length
    ? await dcInstance.rpc.getChatlistItemsByEntries(account.id, entries).catch(() => ({}))
    : {};
  const chats = entries
    .map((id) => {
      const item = items[id];
      if (!item || item.kind !== 'Chat') return null;
      return { id, name: item.name || `Chat ${id}`, preview: (item.lastMessage && item.lastMessage.text) || '' };
    })
    .filter(Boolean);
  return { chats };
}

async function readChat(chatId) {
  if (!process.env.DC_DEMO_PASSWORD) {
    return { disabled: 'Messaging is disabled: the operator has not set an access password for this demo.' };
  }
  await ensureBoot();
  const { account, configured } = await selectedAccount();
  if (!account || !configured) {
    return { disabled: 'The bot account is still being set up; try again in a moment.' };
  }
  const info = await dcInstance.rpc.getBasicChatInfo(account.id, chatId);
  const ids = await dcInstance.rpc.getMessageIds(account.id, chatId, false, false).catch(() => []);
  const recent = ids.slice(-50);
  const messages = [];
  for (const id of recent) {
    const m = await dcInstance.rpc.getMessage(account.id, id).catch(() => null);
    if (!m) continue;
    let from = `#${m.fromId}`;
    if (m.fromId === 1) from = 'bot';
    else {
      const c = await dcInstance.rpc.getContact(account.id, m.fromId).catch(() => null);
      if (c) from = c.displayName || c.authName || c.addr || from;
    }
    messages.push({
      id: m.id,
      from,
      text: m.text || '',
      time: m.timestamp ? new Date(m.timestamp * 1000).toISOString() : '',
    });
  }
  return { chat: { id: chatId, name: info.name || `Chat ${chatId}`, encrypted: Boolean(info.isEncrypted) }, messages };
}

async function sendText(chatId, text) {
  if (!process.env.DC_DEMO_PASSWORD) {
    return { error: 'Messaging is disabled: the operator has not set an access password for this demo.' };
  }
  if (!text || !text.trim()) return { error: 'Message text is empty.' };
  await ensureBoot();
  const { account, configured } = await selectedAccount();
  if (!account || !configured) {
    return { error: 'The bot account is still being set up; try again in a moment.' };
  }
  const msgId = await dcInstance.rpc.miscSendTextMessage(account.id, chatId, text.trim());
  return { ok: true, msgId };
}

const STYLE = `<style>
  body { font-family: system-ui, sans-serif; margin: 0; background: #0f172a; color: #e2e8f0; }
  main { max-width: 38rem; margin: 0 auto; padding: 2rem 1rem; }
  h1 { font-size: 1.6rem; margin: 0 0 1rem; }
  dl { display: inline-grid; grid-template-columns: auto auto; gap: .35rem 1rem; text-align: left; }
  dt { color: #94a3b8; }
  dd { margin: 0; font-family: ui-monospace, monospace; word-break: break-all; }
  p, li { color: #94a3b8; }
  a { color: #7dd3fc; text-decoration: none; }
  ul.chats { list-style: none; padding: 0; }
  ul.chats li { border: 1px solid #1e293b; border-radius: .5rem; padding: .75rem 1rem; margin: .5rem 0; display: block; }
  ul.chats a { color: #e2e8f0; font-weight: 600; }
  .msg { border: 1px solid #1e293b; border-radius: .5rem; padding: .6rem .9rem; margin: .5rem 0; }
  .msg .meta { color: #64748b; font-size: .8rem; margin-bottom: .25rem; }
  .qr { background: #fff; padding: 1rem; border-radius: .5rem; display: inline-block; }
  .qr svg { display: block; width: 260px; height: auto; }
  form { margin-top: 1rem; display: flex; gap: .5rem; }
  input[type=text] { flex: 1; padding: .6rem; border-radius: .5rem; border: 1px solid #334155; background: #1e293b; color: #e2e8f0; }
  button { padding: .6rem 1rem; border-radius: .5rem; border: 0; background: #0ea5e9; color: #0f172a; font-weight: 700; }
</style>`;

function shell(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  ${STYLE}
</head>
<body><main>${body}<p><a href="/">&larr; Hello World</a></p></main></body>
</html>`;
}

function statusPage(s, err) {
  const rows = err
    ? `<dt>core</dt><dd>failed to start: ${esc(String(err).slice(0, 120))}</dd>`
    : `<dt>core</dt><dd>${esc(s.coreVersion)} (${esc(s.coreSource)})</dd>
      <dt>bot</dt><dd>${s.configured ? esc(s.botAddress) : s.configuring ? 'setting up its account, refresh in a few seconds' : 'not configured'}</dd>
      <dt>chats</dt><dd>${s.chatCount}</dd>
      <dt>echoed</dt><dd>${s.echoed}</dd>
      <dt>messaging UI</dt><dd>${s.messagingEnabled ? 'password-gated' : 'disabled (no demo password set)'}</dd>
      ${s.lastError ? `<dt>last error</dt><dd>${esc(s.lastError)}</dd>` : ''}`;
  const invite = s.configured && state.inviteSvg
    ? `<p>Message the bot from your Delta Chat:</p><p class="qr"><a href="${esc(state.invite)}">${state.inviteSvg}</a></p><p><a href="${esc(state.invite)}">${esc(s.botAddress)}</a></p>`
    : '';
  return shell('Delta Chat bot on Naung', `
    <h1>Delta Chat bot, live on this server</h1>
    <dl>${rows}</dl>
    ${invite}
    <p>Rendered from the real Delta Chat core running inside this service, queried over its JSON-RPC API just now. Message contents are never shown here; only the bot's address and counters are public. Same data as JSON at <a href="/api/deltachat/status">/api/deltachat/status</a>.</p>`);
}

function chatsPage(result) {
  if (result.disabled) {
    return shell('Delta Chat chats', `<h1>Chats</h1><p>${esc(result.disabled)}</p>`);
  }
  const items = result.chats.length
    ? result.chats.map((c) => `<li><a href="/deltachat/chat?id=${c.id}">${esc(c.name)}</a><br><span>${esc(c.preview.slice(0, 120))}</span></li>`).join('\n')
    : '<li>No chats yet.</li>';
  return shell('Delta Chat chats', `<h1>Chats</h1><ul class="chats">${items}</ul>`);
}

function chatPage(result) {
  if (result.disabled) {
    return shell('Delta Chat', `<h1>Chat</h1><p>${esc(result.disabled)}</p>`);
  }
  const msgs = result.messages.length
    ? result.messages.map((m) => `<div class="msg"><div class="meta">${esc(m.from)} &middot; ${esc(m.time)}</div><div>${esc(m.text)}</div></div>`).join('\n')
    : '<p>No messages yet.</p>';
  return shell(`Chat: ${result.chat.name}`, `
    <h1>${esc(result.chat.name)}${result.chat.encrypted ? ' &#128274;' : ''}</h1>
    ${msgs}
    <form method="post" action="/deltachat/send">
      <input type="hidden" name="chat" value="${result.chat.id}">
      <input type="text" name="text" placeholder="Type a message" autocomplete="off">
      <button type="submit">Send</button>
    </form>
    <p><a href="/deltachat/chats">&larr; all chats</a></p>`);
}

module.exports = { ensureBoot, status, statusPage, listChats, chatsPage, readChat, chatPage, sendText };
