// Throwaway peer: onboards its own chatmail account, securejoins the bot's invite,
// sends a message, waits for the echo. Usage: node peer-test.js <invite-qr-text>
const { startDeltaChat } = await import("@deltachat/stdio-rpc-server");

const INVITE = process.argv[2];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const dc = await startDeltaChat('/tmp/dc-peer');
  let accs = await dc.rpc.getAllAccounts();
  if (!accs.length) { await dc.rpc.addAccount(); accs = await dc.rpc.getAllAccounts(); }
  const id = accs[accs.length - 1].id;
  if (!(await dc.rpc.isConfigured(id))) {
    await dc.rpc.batchSetConfig(id, { bot: '1', displayname: 'Naung peer test' });
    await dc.rpc.setConfigFromQr(id, 'dcaccount:https://nine.testrun.org/new');
  }
  for (let i = 0; i < 15 && !(await dc.rpc.isConfigured(id)); i++) await sleep(2000);
  if (!(await dc.rpc.isConfigured(id))) throw new Error('peer not configured in time');
  console.log('peer configured');
  await dc.rpc.startIo(id);

  const check = await dc.rpc.checkQr(id, INVITE);
  console.log('qr check:', check.kind);
  const chatId = await dc.rpc.secureJoin(id, INVITE);
  console.log('securejoin started, chat', chatId);
  let sent = false;
  for (let i = 0; i < 20 && !sent; i++) {
    await sleep(5000);
    try {
      await dc.rpc.miscSendTextMessage(id, chatId, 'hello from peer test');
      sent = true;
      console.log('peer sent');
    } catch (e) {
      if (!String((e && e.message) || e).includes('key is missing')) throw e;
    }
  }
  if (!sent) throw new Error('handshake never completed');
  for (let i = 0; i < 25; i++) {
    await sleep(3000);
    const ids = await dc.rpc.getMessageIds(id, chatId, false, false);
    for (const m of ids) {
      const msg = await dc.rpc.getMessage(id, m);
      if (msg.fromId !== 1 && (msg.text || '').includes('You said: hello from peer test')) {
        console.log('ECHO RECEIVED');
        process.exit(0);
      }
    }
  }
  console.log('no echo within 75s');
  process.exit(1);
})().catch((e) => { console.error('PEER ERROR:', JSON.stringify(e, Object.getOwnPropertyNames(e)).slice(0, 400)); process.exit(1); });
