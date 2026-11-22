// Bridge test: securejoin the #7 invite, get a 1:1 AI reply, then find the
// shared "Naung web visitors" group and post into it.
const { startDeltaChat } = await import("@deltachat/stdio-rpc-server");
const INVITE = process.argv[2];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const dc = await startDeltaChat('/tmp/dc-peer');
  const accs = await dc.rpc.getAllAccounts();
  const id = accs[accs.length - 1].id;
  await dc.rpc.startIo(id);
  const chatId = await dc.rpc.secureJoin(id, INVITE);
  console.log('securejoin chat', chatId);
  let sent = false;
  for (let i = 0; i < 20 && !sent; i++) {
    await sleep(5000);
    try { await dc.rpc.miscSendTextMessage(id, chatId, 'hello bridge peer'); sent = true; console.log('1:1 sent'); }
    catch (e) { if (!String((e && e.message) || e).includes('key is missing')) throw e; }
  }
  if (!sent) throw new Error('handshake never completed');
  let aiReply = '';
  for (let i = 0; i < 25 && !aiReply; i++) {
    await sleep(3000);
    const ids = await dc.rpc.getMessageIds(id, chatId, false, false);
    for (const m of ids) {
      const msg = await dc.rpc.getMessage(id, m);
      if (msg.fromId !== 1 && msg.text && !msg.text.includes('hello bridge peer')) aiReply = msg.text.slice(0, 120);
    }
  }
  console.log('1:1 AI reply:', aiReply || 'NONE');
  let groupId = 0;
  for (let i = 0; i < 25 && !groupId; i++) {
    await sleep(3000);
    const chats = await dc.rpc.getChatlistEntries(id, 0, null, null).catch(() => []);
    for (const cid of chats) {
      const c = await dc.rpc.getBasicChatInfo(id, cid).catch(() => null);
      if (c && c.name && c.name.startsWith('Visitors #')) groupId = cid;
    }
  }
  console.log('group chat id:', groupId || 'NOT FOUND');
  if (groupId) {
    await dc.rpc.miscSendTextMessage(id, groupId, 'peer says hi to the public thread');
    console.log('group message sent');
  }
  process.exit(0);
})().catch((e) => { console.error('PEER ERROR:', JSON.stringify(e, Object.getOwnPropertyNames(e)).slice(0, 400)); process.exit(1); });
