// Delta Chat integration for the Naung demo: runs the official Delta Chat
// core (@deltachat/stdio-rpc-server, chatmail/core, MPL-2.0) next to the web
// server and talks to it over its official JSON-RPC API.
//
// Safety defaults:
// - No visitor credential forms. An account is only ever used when the
//   operator sets DC_ADDR / DC_MAIL_PW as server-side environment variables.
// - Messaging routes (chats/read/send) additionally require the operator to
//   set DC_DEMO_PASSWORD; the web server then gates them with HTTP Basic
//   auth. Without it, messaging stays disabled even if an account exists,
//   so an inbox can never be publicly exposed by accident.
const { startDeltaChat } = require('@deltachat/stdio-rpc-server');

let dcPromise = null;
function getDc() {
  if (!dcPromise) {
    dcPromise = (async () => startDeltaChat('/tmp/deltachat-data'))().catch((err) => {
      dcPromise = null;
      throw err;
    });
  }
  return dcPromise;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function selectedAccount(dc) {
  const accounts = await dc.rpc.getAllAccounts();
  const acc = accounts.find((a) => a.kind === 'Configured') || accounts[0] || null;
  if (!acc) return { account: null, configured: false };
  const configured = await dc.rpc.isConfigured(acc.id).catch(() => false);
  return { account: acc, configured };
}

async function status() {
  const dc = await getDc();
  const info = await dc.rpc.getSystemInfo();
  const { account, configured } = await selectedAccount(dc);
  let chatCount = 0;
  if (account && configured) {
    const chats = await dc.rpc.getChatlistEntries(account.id, 0, null, null).catch(() => []);
    chatCount = Array.isArray(chats) ? chats.length : 0;
  }
  return {
    coreVersion: info.deltachat_core_version || 'unknown',
    arch: info.arch || null,
    configured,
    chatCount,
    messagingEnabled: Boolean(process.env.DC_DEMO_PASSWORD),
  };
}

async function listChats() {
  if (!process.env.DC_DEMO_PASSWORD) {
    return { disabled: 'Messaging is disabled: the operator has not set an access password for this demo.' };
  }
  const dc = await getDc();
  const { account, configured } = await selectedAccount(dc);
  if (!account || !configured) {
    return { disabled: 'No account is configured on this demo, so there are no chats to show.' };
  }
  const entries = await dc.rpc.getChatlistEntries(account.id, 0, null, null).catch(() => []);
  const items = entries.length
    ? await dc.rpc.getChatlistItemsByEntries(account.id, entries).catch(() => ({}))
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
  const dc = await getDc();
  const { account, configured } = await selectedAccount(dc);
  if (!account || !configured) {
    return { disabled: 'No account is configured on this demo.' };
  }
  const info = await dc.rpc.getBasicChatInfo(account.id, chatId);
  const ids = await dc.rpc.getMessageIds(account.id, chatId, false, false).catch(() => []);
  const recent = ids.slice(-50);
  const messages = [];
  for (const id of recent) {
    const m = await dc.rpc.getMessage(account.id, id).catch(() => null);
    if (!m) continue;
    let from = `#${m.fromId}`;
    if (m.fromId === 1) from = 'me';
    else {
      const c = await dc.rpc.getContact(account.id, m.fromId).catch(() => null);
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
  const dc = await getDc();
  const { account, configured } = await selectedAccount(dc);
  if (!account || !configured) {
    return { error: 'No account is configured on this demo.' };
  }
  const msgId = await dc.rpc.miscSendTextMessage(account.id, chatId, text.trim());
  return { ok: true, msgId };
}

const STYLE = `<style>
  body { font-family: system-ui, sans-serif; margin: 0; background: #0f172a; color: #e2e8f0; }
  main { max-width: 38rem; margin: 0 auto; padding: 2rem 1rem; }
  h1 { font-size: 1.6rem; margin: 0 0 1rem; }
  dl { display: inline-grid; grid-template-columns: auto auto; gap: .35rem 1rem; text-align: left; }
  dt { color: #94a3b8; }
  dd { margin: 0; font-family: ui-monospace, monospace; }
  p, li { color: #94a3b8; }
  a { color: #7dd3fc; text-decoration: none; }
  ul.chats { list-style: none; padding: 0; }
  ul.chats li { border: 1px solid #1e293b; border-radius: .5rem; padding: .75rem 1rem; margin: .5rem 0; display: block; }
  ul.chats a { color: #e2e8f0; font-weight: 600; }
  .msg { border: 1px solid #1e293b; border-radius: .5rem; padding: .6rem .9rem; margin: .5rem 0; }
  .msg .meta { color: #64748b; font-size: .8rem; margin-bottom: .25rem; }
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
    : `<dt>core version</dt><dd>${esc(s.coreVersion)}</dd>
      <dt>architecture</dt><dd>${esc(s.arch || 'unknown')}</dd>
      <dt>configured</dt><dd>${s.configured ? 'yes' : 'no'}</dd>
      <dt>chats</dt><dd>${s.chatCount}</dd>
      <dt>messaging</dt><dd>${s.messagingEnabled ? 'password-gated' : 'disabled (no demo password set)'}</dd>`;
  return shell('Delta Chat on Naung', `
    <h1>Delta Chat core, live on this server</h1>
    <dl>${rows}</dl>
    <p>This page is rendered from the real Delta Chat core (chatmail/core) running inside this service, queried over its JSON-RPC API just now. Same data as JSON at <a href="/api/deltachat/status">/api/deltachat/status</a>.</p>
    <p>Chats: <a href="/deltachat/chats">/deltachat/chats</a> (gated; chat data needs an operator-configured demo account).</p>`);
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

module.exports = { status, statusPage, listChats, chatsPage, readChat, chatPage, sendText };
