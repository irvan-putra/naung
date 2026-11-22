// Delta Chat integration for the Naung demo: runs the official Delta Chat
// core (@deltachat/stdio-rpc-server, chatmail/core, MPL-2.0) next to the web
// server and answers status questions over its JSON-RPC API.
// No visitor credential entry: an account is only used when the operator
// sets DC_ADDR / DC_MAIL_PW as environment variables (server-side secret).
const { startDeltaChat } = require('@deltachat/stdio-rpc-server');

let dcPromise = null;
function getDc() {
  if (!dcPromise) {
    dcPromise = (async () => {
      const dc = await startDeltaChat('/tmp/deltachat-data');
      return dc;
    })().catch((err) => { dcPromise = null; throw err; });
  }
  return dcPromise;
}

async function status() {
  const dc = await getDc();
  const info = await dc.rpc.getSystemInfo();
  const accounts = await dc.rpc.getAllAccounts();
  const selected = accounts.find((a) => a.kind === 'Configured') || accounts[0] || null;
  let configured = false;
  let chatCount = 0;
  if (selected) {
    configured = await dc.rpc.isConfigured(selected.id).catch(() => false);
    if (configured) {
      const chats = await dc.rpc.getChatlistEntries(selected.id, 0, null, null).catch(() => []);
      chatCount = Array.isArray(chats) ? chats.length : 0;
    }
  }
  return {
    coreVersion: info.deltachat_core_version || info.sqlite_version || 'unknown',
    arch: info.arch || null,
    accounts: accounts.length,
    configured,
    chatCount,
    operatorAccountEnv: Boolean(process.env.DC_ADDR),
  };
}

function page(s, err) {
  const rows = err
    ? `<dt>core</dt><dd>failed to start: ${String(err).slice(0, 120)}</dd>`
    : `<dt>core version</dt><dd>${s.coreVersion}</dd>
      <dt>architecture</dt><dd>${s.arch || 'unknown'}</dd>
      <dt>accounts</dt><dd>${s.accounts}</dd>
      <dt>configured</dt><dd>${s.configured ? 'yes' : 'no'}</dd>
      <dt>chats</dt><dd>${s.chatCount}</dd>`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Delta Chat on Naung</title>
  <style>
    body { font-family: system-ui, sans-serif; display: grid; place-items: center; min-height: 100vh; margin: 0; background: #0f172a; color: #e2e8f0; }
    main { text-align: center; max-width: 34rem; padding: 0 1rem; }
    h1 { font-size: 2rem; margin: 0 0 1rem; }
    dl { display: inline-grid; grid-template-columns: auto auto; gap: .35rem 1rem; text-align: left; }
    dt { color: #94a3b8; }
    dd { margin: 0; font-family: ui-monospace, monospace; }
    p { color: #94a3b8; }
    a { color: #7dd3fc; }
  </style>
</head>
<body>
  <main>
    <h1>Delta Chat core, live on this server</h1>
    <dl>${rows}</dl>
    <p>This page is rendered from the real Delta Chat core (chatmail/core) running inside this service, queried over its JSON-RPC API just now.</p>
    <p>Chat stays disabled in this public demo: no account is configured and there is no login form by design. Same data as JSON at <a href="/api/deltachat/status">/api/deltachat/status</a>.</p>
    <p><a href="/">&larr; Hello World</a></p>
  </main>
</body>
</html>`;
}

module.exports = { status, page };
