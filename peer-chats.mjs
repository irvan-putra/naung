const { startDeltaChat } = await import("@deltachat/stdio-rpc-server");
(async () => {
  const dc = await startDeltaChat('/tmp/dc-peer');
  const accs = await dc.rpc.getAllAccounts();
  const id = accs[accs.length - 1].id;
  const chats = await dc.rpc.getChatlistEntries(id, 0, null, null);
  for (const cid of chats) {
    const c = await dc.rpc.getBasicChatInfo(id, cid).catch(() => null);
    if (c) console.log(cid, '|', c.name, '|', c.chatType);
  }
  process.exit(0);
})().catch((e) => { console.error('ERR', String(e).slice(0,200)); process.exit(1); });
