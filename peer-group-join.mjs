// Direct group join test: securejoin a GROUP invite, confirm the joined chat
// is the shared group, and post one message into it. No 1:1, no AI calls.
const { startDeltaChat } = await import("@deltachat/stdio-rpc-server");
const INVITE = process.argv[2];
const MESSAGE = process.argv[3] || 'peer joined via the group QR';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const dc = await startDeltaChat('/tmp/dc-peer');
  const accs = await dc.rpc.getAllAccounts();
  const id = accs[accs.length - 1].id;
  await dc.rpc.startIo(id);
  const chatId = await dc.rpc.secureJoin(id, INVITE);
  console.log('securejoin returned chat', chatId);
  let info = null;
  for (let i = 0; i < 30; i++) {
    await sleep(3000);
    info = await dc.rpc.getFullChatById(id, chatId).catch(() => null);
    if (info && info.chatType === 'Group' && info.canSend) break;
    info = null;
  }
  if (!info) {
    const basic = await dc.rpc.getBasicChatInfo(id, chatId).catch(() => null);
    console.log('join not complete; basic info:', JSON.stringify(basic));
    process.exit(1);
  }
  console.log('joined group:', JSON.stringify({ id: chatId, name: info.name, chatType: info.chatType }));
  await dc.rpc.miscSendTextMessage(id, chatId, MESSAGE);
  console.log('group message sent:', JSON.stringify(MESSAGE));
  await sleep(5000);
  process.exit(0);
})().catch((e) => { console.error('PEER ERROR:', JSON.stringify(e, Object.getOwnPropertyNames(e)).slice(0, 400)); process.exit(1); });
