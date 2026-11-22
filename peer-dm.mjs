// 1:1 context test: DM the bot two related messages, print both AI replies.
// Keys were already exchanged via the earlier group securejoin.
const { startDeltaChat } = await import('@deltachat/stdio-rpc-server');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ADDR = process.argv[2];
(async () => {
  const dc = await startDeltaChat('/tmp/dc-peer');
  const accs = await dc.rpc.getAllAccounts();
  const id = accs[accs.length - 1].id;
  await dc.rpc.startIo(id);
  const contact = await dc.rpc.createContact(id, ADDR, null);
  const chat = await dc.rpc.createChatByContactId(id, contact);
  console.log('1:1 chat', chat);
  const seen = new Set();
  const replies = [];
  async function waitReply() {
    for (let i = 0; i < 40; i++) {
      await sleep(3000);
      const ids = await dc.rpc.getMessageIds(id, chat, false, false);
      for (const m of ids) {
        if (seen.has(m)) continue;
        seen.add(m);
        const msg = await dc.rpc.getMessage(id, m).catch(() => null);
        if (msg && msg.fromId !== 1 && !msg.isInfo && (msg.text || '').trim()) return msg.text.trim();
      }
    }
    return null;
  }
  await dc.rpc.miscSendTextMessage(id, chat, 'my favorite hero is Ironman');
  const r1 = await waitReply();
  console.log('REPLY1:', JSON.stringify((r1 || 'NONE').slice(0, 200)));
  if (!r1) process.exit(1);
  await dc.rpc.miscSendTextMessage(id, chat, 'why do I like him?');
  const r2 = await waitReply();
  console.log('REPLY2:', JSON.stringify((r2 || 'NONE').slice(0, 300)));
  process.exit(r2 ? 0 : 1);
})().catch((e) => { console.error('PEER ERROR:', JSON.stringify(e, Object.getOwnPropertyNames(e)).slice(0, 400)); process.exit(1); });
