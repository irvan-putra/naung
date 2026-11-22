const { startDeltaChat } = await import("@deltachat/stdio-rpc-server");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const dc = await startDeltaChat('/tmp/dc-peer');
  const accs = await dc.rpc.getAllAccounts();
  const id = accs[accs.length - 1].id;
  await dc.rpc.startIo(id);
  await sleep(4000);
  let groupId = 0;
  const chats = await dc.rpc.getChatlistEntries(id, 0, null, null);
  for (const cid of chats) {
    const c = await dc.rpc.getBasicChatInfo(id, cid).catch(() => null);
    // pick the HIGHEST matching id: stale groups from dead bot identities linger
    if (c && c.name && c.name.startsWith('Visitors #') && cid > groupId) groupId = cid;
  }
  if (!groupId) { console.log('group NOT FOUND'); process.exit(1); }
  const mid = await dc.rpc.miscSendTextMessage(id, groupId, process.argv[2] || 'peer says hi to the public thread');
  console.log('sent msg', mid, 'in group', groupId);
  for (let i = 0; i < 20; i++) {
    await sleep(3000);
    const m = await dc.rpc.getMessage(id, mid).catch(() => null);
    const st = m && m.state;
    console.log('state:', st);
    if (st && !/Pending/i.test(String(st))) break;
  }
  process.exit(0);
})().catch((e) => { console.error('ERR:', JSON.stringify(e, Object.getOwnPropertyNames(e)).slice(0, 300)); process.exit(1); });
