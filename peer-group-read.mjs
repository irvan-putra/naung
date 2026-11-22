const { startDeltaChat } = await import('@deltachat/stdio-rpc-server');
const dc = await startDeltaChat('/tmp/dc-peer');
const accs = await dc.rpc.getAllAccounts();
const id = accs[accs.length - 1].id;
await dc.rpc.startIo(id);
await new Promise(r => setTimeout(r, 10000));
const chats = await dc.rpc.getChatlistEntries(id, 0, null, null).catch(() => []);
let gid = 0, gname = '';
for (const cid of chats) {
  const c = await dc.rpc.getBasicChatInfo(id, cid).catch(() => null);
  if (c && c.name && c.name.startsWith('Visitors #') && cid > gid) { gid = cid; gname = c.name; }
}
console.log('current group:', gid, JSON.stringify(gname));
const ids = await dc.rpc.getMessageIds(id, gid, false, false);
for (const m of ids.slice(-8)) {
  const msg = await dc.rpc.getMessage(id, m);
  console.log(msg.fromId === 1 ? 'me:' : 'them:', JSON.stringify((msg.text || '').slice(0, 140)));
}
process.exit(0);
