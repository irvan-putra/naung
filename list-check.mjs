const { startDeltaChat } = await import('@deltachat/stdio-rpc-server');
const dc = await startDeltaChat('/tmp/dc-peer');
const accs = await dc.rpc.getAllAccounts();
const id = accs[accs.length - 1].id;
await dc.rpc.startIo(id).catch(() => null);
const entries = await dc.rpc.getChatlistEntries(id, 0, null, null).catch(() => []);
const items = entries.length ? await dc.rpc.getChatlistItemsByEntries(id, entries).catch(() => ({})) : {};
const chats = entries.map((cid) => {
  const item = items[cid];
  if (!item || item.kind !== 'ChatListItem') return null;
  const preview = [item.summaryText1, item.summaryText2].filter(Boolean).join(' ');
  return { id: cid, name: item.name || `Chat ${cid}`, preview };
}).filter(Boolean);
console.log('entries:', entries.length, 'visible chats:', JSON.stringify(chats, null, 1));
process.exit(0);
