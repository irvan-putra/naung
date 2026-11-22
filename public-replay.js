// Native original replay is deliberately restricted to SELF-authored messages
// in the explicitly supplied public group chats. Never scan private chats.
async function replayPublicOriginals(rpc, senders, limit = 100) {
  const originals = [];
  let pending = false;
  for (const sender of senders) {
    if (!sender?.accountId || !sender.chatId) continue;
    const ids = await rpc.getMessageIds(sender.accountId, sender.chatId, false, false);
    for (const id of ids.slice(-200)) {
      const m = await rpc.getMessage(sender.accountId, id);
      if (!m || m.fromId !== 1 || m.isInfo || !m.text?.trim()) continue;
      // Official core constants: delivered 26, read 28. Drafts, failed and
      // pending messages are not resendable; pending originals retry next tick.
      if (m.state === 20) { pending = true; continue; }
      if (m.state !== 26 && m.state !== 28) continue;
      originals.push({ accountId: sender.accountId, chatId: sender.chatId, id,
        timestamp: Number(m.sortTimestamp || m.timestamp || 0) });
    }
  }
  originals.sort((a,b)=>a.timestamp-b.timestamp || a.accountId-b.accountId || a.id-b.id);
  const batches = new Map();
  for (const ref of originals.slice(-limit)) {
    const key = ref.accountId + ':' + ref.chatId;
    if (!batches.has(key)) batches.set(key, { accountId: ref.accountId, ids: [] });
    batches.get(key).ids.push(ref.id);
  }
  for (const batch of batches.values()) await rpc.resendMessages(batch.accountId, batch.ids);
  return !pending;
}
module.exports = { replayPublicOriginals };
