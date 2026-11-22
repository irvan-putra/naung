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
          displayname: 'Naung',
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
  // Label from the actual identity (owner request 11:46): the first 6 chars
  // of the account address localpart, so every reset is self-labeling and no
  // manual counter can go stale. Must run BEFORE the QR/invite is generated.
  if (state.addr) {
    const tag = state.addr.split('@')[0].slice(0, 6);
    const label = `Naung #${tag}`;
    await dc.rpc.setConfig(state.accountId, 'displayname', label).catch(() => null);
    // The shared group carries the same identity tag (owner request 12:00),
    // with a short name (owner request 12:12) so phone headers show it whole.
    bridge.groupName = `Visitors #${tag}`;
    // The group is created eagerly at boot so the homepage QR can point
    // straight at it (owner request 12:00: direct group entry, no 1:1 detour).
    await bridge.ensureGroup(dc, state.accountId).catch(() => 0);
  }
  try {
    // Invite is the GROUP securejoin QR (joiners land directly in the shared
    // public group); fall back to the plain contact QR if no group exists.
    const [text, svg] = await dc.rpc.getChatSecurejoinQrCodeSvg(state.accountId, bridge.groupChatId || null);
    state.invite = text;
    state.inviteSvg = scaleQrSvg(svg);
  } catch {
    state.invite = null;
    state.inviteSvg = null;
  }
}


// Fenrir (OpenAI-compatible) reply path. Env-gated: without FENRIR_API_KEY and
// FENRIR_BASE_URL, callers fall back to plain echo. No key in the repo; the key
// lives in NEO App env as a secret.
const fenrir = {
  key: process.env.FENRIR_API_KEY || '',
  base: (process.env.FENRIR_BASE_URL || '').replace(/\/+$/, ''),
  model: process.env.FENRIR_MODEL || 'deepseek/deepseek-v4.1-flash',
  maxRequests: Number(process.env.FENRIR_MAX_REQUESTS || 200),
  used: 0,
  enabled() { return Boolean(this.key && this.base); },
  // Character bots for the shared room (owner request 12:20): they answer
  // only when a human names them, never each other or the main bot, so a
  // human message still costs at most one API call and no loop is possible.
  personaFor(text) {
    const t = ` ${String(text || '').toLowerCase()} `;
    if (/\b(deadpool|wade wilson)\b/.test(t)) return 'Deadpool';
    if (/\b(ironman|iron man|tony stark)\b/.test(t)) return 'Ironman';
    return null;
  },
  async reply(userText, history, persona) {
    if (!this.enabled() || this.used >= this.maxRequests) return null;
    this.used += 1;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      // Conversation context (owner request 12:18): the caller supplies the
      // last few messages of THE SAME conversation only. The public web
      // thread and private 1:1 chats are never mixed.
      const personaLine = persona === 'Deadpool'
        ? ' For this reply you are the character Deadpool, clearly labeled as a character bot in the room: chaotic, funny, light fourth-wall humor, always family-friendly, never rude to people. Never start your reply with your own name or label.'
        : persona === 'Ironman'
          ? ' For this reply you are the character Ironman (Tony Stark), clearly labeled as a character bot in the room: confident, witty, proud of your suits and tech. Never start your reply with your own name or label.'
          : '';
      const wares = require('./pay').catalog().filter(i => i.seller && (!persona || i.seller === persona))
        .map(i => i.seller + ': ' + i.name + ' | Rp' + i.price + ' | quantity ' + i.stock + ' | /buy ' + i.id).join('; ');
      const msgs = [
        { role: 'system', content: 'You are Naung, a friendly demo chatbot on a public NEO App demo page by Biznet Gio. Its Dimensional Marvel Stores are an unofficial fan sandbox: Ironman sells fictional harmless tech-style collectibles; Deadpool sells fictional goofy collectibles. These are pretend wares, not working technology, real merchandise, or an official Marvel store. Reply briefly, 1-3 sentences. Match the user language (Indonesian or English). This is a public demo; never ask for, accept, or repeat private information. Plain text only. You cannot list items, create orders, verify payments or move money. For the public sandbox marketplace, tell users to use /shop, /sell Item name | 25000 | 999, or /buy item-id. Only the deterministic Marketplace bot performs those commands. Never claim an item was listed, purchased or paid based on conversation alone. Use the recent conversation for context. In the public web thread several people share one conversation, so their messages may carry a "name: " prefix.' + personaLine + ' Current fictional catalog (use these exact names/prices; never invent availability or claim a sale): ' + wares },
      ];
      if (Array.isArray(history)) {
        for (const h of history.slice(-10)) {
          if (!h || typeof h.text !== 'string' || !h.text.trim()) continue;
          msgs.push({ role: h.role === 'assistant' ? 'assistant' : 'user', content: h.text.slice(0, 500) });
        }
      }
      msgs.push({ role: 'user', content: userText.slice(0, 1000) });
      const res = await fetch(`${this.base}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.key}` },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 300,
          temperature: 0.7,
          messages: msgs,
        }),
        signal: ctrl.signal,
      });
      if (!res.ok) return null;
      const data = await res.json();
      const out = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (typeof out !== 'string' || !out.trim()) return null;
      let text2 = out.trim();
      if (persona) text2 = text2.replace(new RegExp(`^${persona}( \\(bot\\))?\\s*[:\\-]\\s*`, 'i'), '');
      return text2.slice(0, 1500);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  },
};

// Public shared conversation: the homepage QR is a direct securejoin invite
// to one shared "Naung visitors #<tag>" group. Web visitor messages are
// mirrored into the group, and any group member's messages appear on the
// public homepage visitor thread under their own display name (labels are
// self-asserted display names, not identity claims). 1:1 chats keep AI/echo.
const bridge = {
  groupName: 'Naung visitors', // default; publishIdentity rewrites with the identity tag
  groupChatId: 0,
  joined: new Set(),
  onPeerMessage: null, // set by server.js: ({from, text}) => void
  async ensureGroup(dc, accountId) {
    if (bridge.groupChatId) return bridge.groupChatId;
    const gid = await dc.rpc.createGroupChat(accountId, bridge.groupName, false).catch(() => 0);
    if (gid) {
      bridge.groupChatId = gid;
      await dc.rpc.miscSendTextMessage(accountId, gid,
        'This chat is bridged to the public web visitor thread at https://irvan.app.neoapp.id/ - everything you write here appears publicly on that page.').catch(() => null);
    }
    return bridge.groupChatId;
  },
  async hasPublicAudience() {
    if (!dcInstance || state.accountId == null || !bridge.groupChatId) return false;
    const contacts = await dcInstance.rpc.getChatContacts(state.accountId, bridge.groupChatId);
    return contacts.some(id => id !== 1);
  },
  announcementRelays: new Set(),
  async relayOnce(eventKey, text, marker) {
    if (bridge.announcementRelays.has(eventKey)) return true;
    if (!dcInstance || state.accountId == null || !bridge.groupChatId) return false;
    // Recover an ambiguous prior send before retrying. Only inspect our own
    // messages in this public group; no private conversation enters the outbox.
    const ids = await dcInstance.rpc.getMessageIds(state.accountId, bridge.groupChatId, false, false);
    for (const id of ids.slice(-100).reverse()) {
      const msg = await dcInstance.rpc.getMessage(state.accountId, id);
      if (msg && msg.fromId === 1 && (msg.text || '').includes(marker)) {
        bridge.announcementRelays.add(eventKey); return true;
      }
    }
    const mid = await dcInstance.rpc.miscSendTextMessage(state.accountId, bridge.groupChatId, text);
    if (!mid) return false;
    bridge.announcementRelays.add(eventKey);
    return true;
  },
  async relayToGroup(text) {
    if (!dcInstance || state.accountId == null || !bridge.groupChatId) return false;
    await dcInstance.rpc.miscSendTextMessage(state.accountId, bridge.groupChatId, text).catch(() => null);
    return true;
  },
};


async function contactName(dc, accountId, contactId) {
  const c = await dc.rpc.getContact(accountId, contactId).catch(() => null);
  return (c && (c.displayName || c.name)) || '';
}

async function onIncoming(accountId, event) {
  const dc = dcInstance;
  if (!dc || !state.configured) return;
  const msg = await dc.rpc.getMessage(accountId, event.msgId).catch(() => null);
  if (!msg || msg.fromId === 1) return; // never echo ourselves
  const text = (msg.text || '').trim();
  if (!text) return;

  // A participant speaking in the shared group -> public web thread, no AI.
  if (bridge.groupChatId && event.chatId === bridge.groupChatId) {
    if (typeof bridge.onPeerMessage === 'function') {
      const name = await contactName(dc, accountId, msg.fromId);
      Promise.resolve(bridge.onPeerMessage({ from: name || 'someone', text: text.slice(0, 500) })).catch(() => null);
    }
    await dc.rpc.markseenMsgs(accountId, [event.msgId]).catch(() => null);
    state.echoed += 1;
    return;
  }

  // 1:1 message: make sure the shared group exists and they are in it, then
  // give the normal AI/echo reply.
  const gid = await bridge.ensureGroup(dc, accountId);
  if (gid && !bridge.joined.has(msg.fromId)) {
    await dc.rpc.addContactToChat(accountId, gid, msg.fromId).catch(() => null);
    bridge.joined.add(msg.fromId);
  }

  // Private 1:1: history comes ONLY from this same chat (owner privacy rule:
  // 1:1 context never mixes with the public web thread or other chats).
  const hist = [];
  try {
    const ids = await dc.rpc.getMessageIds(accountId, event.chatId, false, false);
    for (const mid of ids.slice(-11, -1)) {
      const mm = await dc.rpc.getMessage(accountId, mid).catch(() => null);
      if (!mm || mm.isInfo || !(mm.text || '').trim()) continue;
      hist.push({ role: mm.fromId === 1 ? 'assistant' : 'user', text: mm.text.slice(0, 500) });
    }
  } catch { /* history is best-effort */ }
  const ai = await fenrir.reply(text, hist).catch(() => null);
  const reply = ai
    || (fenrir.enabled()
      ? `AI reply unavailable right now, echoing instead. You said: ${text.slice(0, 500)}`
      : `You said: ${text.slice(0, 500)}`);
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
    inviteSvg: state.inviteSvg,
    chatCount,
    echoed: state.echoed,
    uptimeSeconds: Math.round((Date.now() - state.startedAt) / 1000),
    messagingEnabled: Boolean(process.env.DC_DEMO_PASSWORD || process.env.DC_DEMO_PUBLIC),
    publicMode: Boolean(process.env.DC_DEMO_PUBLIC),
    fenrirEnabled: fenrir.enabled(),
    sharedGroupLinked: Boolean(bridge.groupChatId),
    lastError: state.lastError,
  };
}

async function listChats() {
  if (!process.env.DC_DEMO_PASSWORD && !process.env.DC_DEMO_PUBLIC) {
    return { disabled: 'Messaging is disabled: the operator has not enabled the messaging UI for this demo.' };
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
      if (!item || item.kind !== 'ChatListItem') return null;
      const preview = [item.summaryText1, item.summaryText2].filter(Boolean).join(' ');
      return { id, name: item.name || `Chat ${id}`, preview };
    })
    // Only the shared public group is listed: 1:1 chats are private and
    // never appear on any web page.
    .filter((c) => c && c.id === bridge.groupChatId);
  return { chats };
}

async function readChat(chatId) {
  if (!process.env.DC_DEMO_PASSWORD && !process.env.DC_DEMO_PUBLIC) {
    return { disabled: 'Messaging is disabled: the operator has not enabled the messaging UI for this demo.' };
  }
  await ensureBoot();
  const { account, configured } = await selectedAccount();
  if (!account || !configured) {
    return { disabled: 'The bot account is still being set up; try again in a moment.' };
  }
  if (!bridge.groupChatId || chatId !== bridge.groupChatId) {
    return { disabled: 'That chat is private. Only the shared public visitors chat is shown on the web.' };
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
  if (!process.env.DC_DEMO_PASSWORD && !process.env.DC_DEMO_PUBLIC) {
    return { error: 'Messaging is disabled: the operator has not enabled the messaging UI for this demo.' };
  }
  if (!text || !text.trim()) return { error: 'Message text is empty.' };
  await ensureBoot();
  const { account, configured } = await selectedAccount();
  if (!account || !configured) {
    return { error: 'The bot account is still being set up; try again in a moment.' };
  }
  if (!bridge.groupChatId || chatId !== bridge.groupChatId) {
    return { error: 'That chat is private. Only the shared public visitors chat is writable from the web.' };
  }
  const msgId = await dcInstance.rpc.miscSendTextMessage(account.id, chatId, text.trim());
  return { ok: true, msgId };
}

const STYLE = `<style>
  body { font-family: system-ui, sans-serif; margin: 0; background: #0f172a; color: #e2e8f0; }
  main { max-width: 38rem; margin: 0 auto; padding: 2rem 1rem; }
  h1 { font-size: 1.6rem; margin: 0 0 1rem; }
  h2 { font-size: 1.2rem; margin: 1.5rem 0 .75rem; }
  .chatlink a { font-weight: 700; }
  dl { display: inline-grid; grid-template-columns: auto auto; gap: .35rem 1rem; text-align: left; }
  dt { color: #94a3b8; }
  dd { margin: 0; font-family: ui-monospace, monospace; word-break: break-all; }
  p, li { color: #94a3b8; }
  a { color: #7dd3fc; text-decoration: none; }
  ul.chats { list-style: none; padding: 0; }
  ul.chats li { border: 1px solid #1e293b; border-radius: .5rem; padding: .75rem 1rem; margin: .5rem 0; display: block; }
  ul.chats a { color: #e2e8f0; font-weight: 600; }
  .msg { border: 1px solid #1e293b; border-radius: .5rem; padding: .6rem .9rem; margin: .5rem 0; }
  .message-text { white-space: pre-wrap; overflow-wrap: anywhere; }
  input[type=text] { min-width: 0; }
  .msg .meta { color: #64748b; font-size: .8rem; margin-bottom: .25rem; }
  .qr { background: #fff; padding: 1rem; border-radius: .5rem; display: inline-block; }
  .qr svg { display: block; width: 260px; height: auto; }
  form { margin-top: 1rem; display: flex; gap: .5rem; }
  input[type=text] { flex: 1; padding: .6rem; border-radius: .5rem; border: 1px solid #334155; background: #1e293b; color: #e2e8f0; }
  button { padding: .6rem 1rem; border-radius: .5rem; border: 0; background: #0ea5e9; color: #0f172a; font-weight: 700; }
</style>`;

function shell(title, body, noBack) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  ${STYLE}
</head>
<body><main>${body}${noBack ? '' : '<p><a href="/">&larr; Dimensional chat</a></p>'}</main></body>
</html>`;
}

function statusPage(s, err) {
  const rows = err
    ? `<dt>core</dt><dd>failed to start: ${esc(String(err).slice(0, 120))}</dd>`
    : `<dt>core</dt><dd>${esc(s.coreVersion)} (${esc(s.coreSource)})</dd>
      <dt>bot</dt><dd>${s.configured ? esc(s.botAddress) : s.configuring ? 'setting up its account, refresh in a few seconds' : 'not configured'}</dd>
      <dt>chats</dt><dd>${s.chatCount}</dd>
      <dt>echoed</dt><dd>${s.echoed}</dd>
      <dt>messaging UI</dt><dd>${s.publicMode ? 'public demo (no password)' : s.messagingEnabled ? 'password-gated' : 'disabled (messaging UI not enabled)'}</dd>
      ${s.lastError ? `<dt>last error</dt><dd>${esc(s.lastError)}</dd>` : ''}`;
  const invite = s.configured && state.inviteSvg
    ? `<p>Join the public Delta Chat group:</p><p class="qr"><a href="${esc(state.invite)}">${state.inviteSvg}</a></p><p><a href="${esc(state.invite)}">${esc(s.botAddress)}</a></p>`
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
    ? result.messages.map((m) => `<div class="msg"><div class="meta">${esc(m.from)} &middot; ${esc(m.time)}</div><div class="message-text">${publicMessageHtml(m)}</div></div>`).join('\n')
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


function publicMessageHtml(m) {
  const escaped = esc(m.text);
  if (m.from !== 'Marketplace (bot)') return escaped;
  return escaped.replace(/https:\/\/irvan\.app\.neoapp\.id\/pay\?order_id=NAUNGDEMO-[0-9]+-[0-9a-f]+&amp;checkout=1/g,
    url => '<a href="' + url + '">Open sandbox checkout</a>');
}

function homePage(s, err, _chatsData, _chatData, visitorData) {
  const note = err
    ? `<p>The demo bot failed to start: ${esc(String(err).slice(0, 120))}</p>`
    : s.configured ? '' : '<p>The bot is setting up its account; refresh in a few seconds.</p>';
  const inviteSvg = s.inviteSvg || state.inviteSvg;
  const inviteUrl = s.invite || state.invite;
  const invite = !err && s.configured && inviteSvg
    ? `<p>Join the public Delta Chat group from your app:</p><p class="qr"><a href="${esc(inviteUrl)}">${inviteSvg}</a></p><p><a href="${esc(inviteUrl)}">${esc(s.botAddress)}</a></p>`
    : '';
  let visitorBlock = '';
  if (visitorData) {
    const vmsgs = visitorData.messages.length
      ? visitorData.messages.map((m) => `<div class="msg"><div class="meta">${esc(m.from)} &middot; ${esc(m.time)}</div><div class="message-text">${publicMessageHtml(m)}</div></div>`).join('\n')
      : '<p>No messages yet. Be the first.</p>';
    visitorBlock = `<h2 id="visitor">Web visitor chat</h2>
    <p>Type here and the bot answers with AI right on this page, no app or account needed. This thread is shared: it is the same conversation as the Delta Chat group below, so anyone there can read it and reply too. Character bots Ironman and Deadpool listen in too - mention them by name and they jump in.</p>
    <form method="post" action="/visitor/send">
      <input type="text" name="text" placeholder="Type a message" autocomplete="off" maxlength="500">
      <button type="submit">Send</button>
    </form>
    <p>Dimensional Marvel Stores, unofficial fan sandbox: <code>/shop</code>, <code>/sell Item name | 25000 | 999</code>, <code>/buy item-id</code>. Public pretend listings only, no real goods or seller payouts. Payments open Midtrans; never put card or wallet details in chat.</p>
    <div id="vmsgs">${vmsgs}</div>
    <script>
(function () {
  // Poll the public thread and re-render only the message list, so incoming
  // messages appear without a manual reload (owner request 12:11). The form
  // is outside #vmsgs, so typed text and focus are never touched.
  var box = document.getElementById('vmsgs');
  if (!box || !window.fetch) return;
  var last = '';
  function render(list) {
    var sig = JSON.stringify(list);
    if (sig === last) return;
    last = sig;
    box.textContent = '';
    if (!list.length) {
      var p = document.createElement('p');
      p.textContent = 'No messages yet. Be the first.';
      box.appendChild(p);
      return;
    }
    for (var i = 0; i < list.length; i++) {
      var d = document.createElement('div');
      d.className = 'msg';
      var meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = list[i].from + ' \u00b7 ' + list[i].time;
      var body = document.createElement('div');
      body.className = 'message-text';
      var text = list[i].text;
      var link = list[i].from === 'Marketplace (bot)' && text.match(/https:\\/\\/irvan\\.app\\.neoapp\\.id\\/pay\\?order_id=NAUNGDEMO-[0-9]+-[0-9a-f]+&checkout=1/);
      if (link) {
        var at = text.indexOf(link[0]);
        body.appendChild(document.createTextNode(text.slice(0, at)));
        var a = document.createElement('a'); a.href = link[0]; a.textContent = 'Open sandbox checkout';
        body.appendChild(a); body.appendChild(document.createTextNode(text.slice(at + link[0].length)));
      } else body.textContent = text;
      d.appendChild(meta);
      d.appendChild(body);
      box.appendChild(d);
    }
  }
  function poll() {
    if (document.hidden) return;
    fetch('/api/visitor/messages', { cache: 'no-store' }).then(function (r) {
      return r.ok ? r.json() : null;
    }).then(function (data) {
      if (data && data.messages) render(data.messages);
    }).catch(function () {});
  }
  setInterval(poll, 5000);
})();
</script>`;
  }
  return shell('Dimensional Marvel Stores', `
    <p class="muted">Built with <a href="https://www.biznetgio.com/product/neo-app-platform">NEO App by Biznet Gio</a> (hosting), <a href="https://delta.chat/">Delta Chat</a> via the <a href="https://nine.testrun.org/">nine.testrun.org</a> chatmail relay (messaging), <a href="https://fenrir.lio.id/">Fenrir AI</a> (AI replies), <a href="https://midtrans.com/">Midtrans</a> (sandbox payments) and <a href="https://instinct.com/">Instinct</a>. Source: <a href="https://github.com/irvan-putra/naung">github.com/irvan-putra/naung</a>.</p>
    ${note}
    ${visitorBlock}
    ${invite}
    <p>This is a public demo: the visitor chat above and the Delta Chat group behind the QR are one public conversation, so don't send anything private. Private 1:1 chats with the bot stay in your Delta Chat app. Technical details: <a href="/deltachat">bot status</a> &middot; <a href="/live">live server</a>.</p>
    <p><strong><a href="/pay">Demo store (Midtrans sandbox checkout)</a></strong>: Ironman and Deadpool sell fictional themed wares. No real charges or merchandise; not affiliated with Marvel.</p>`, true);
}

module.exports = {
  fenrir, bridge, ensureBoot, status, statusPage, homePage, listChats, chatsPage, readChat, chatPage, sendText, shell };
