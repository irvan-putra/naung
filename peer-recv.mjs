const { startDeltaChat } = await import('@deltachat/stdio-rpc-server');
const dc = await startDeltaChat('/tmp/dc-peer');
const accs = await dc.rpc.getAllAccounts();
const id = accs[accs.length - 1].id;
await dc.rpc.startIo(id);
await new Promise(r => setTimeout(r, 12000));
const ids = await dc.rpc.getMessageIds(id, 14, false, false);
let found = false;
for (const m of ids.slice(-10)) {
  const msg = await dc.rpc.getMessage(id, m);
  if ((msg.text || '').includes('web UI send test')) { found = true; console.log('PEER RECEIVED bot web-UI message, fromId', msg.fromId); }
}
console.log(found ? 'SEND PATH VERIFIED END-TO-END' : 'not yet received');
process.exit(found ? 0 : 1);
