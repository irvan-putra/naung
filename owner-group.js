// The contact invite is configured privately from the owner's confirmed QR,
// never inferred from a display name. Encrypted groups need a key-contact.
async function addConfiguredOwner(rpc, accountId, groupChatId, contactInvite) {
  if (!contactInvite) return false;
  const u = new URL(contactInvite);
  const parts = u.hash.slice(1).split('&');
  const params = new URLSearchParams(parts.slice(1).join('&'));
  if (u.origin !== 'https://i.delta.chat' || !/^[A-F0-9]{40}$/i.test(parts[0]) || !params.get('a') || params.has('g')) throw new Error('Owner setup requires a contact QR link, not a group invite');
  const dmChatId = await rpc.secureJoin(accountId, contactInvite);
  const contacts = (await rpc.getChatContacts(accountId, dmChatId)).filter(id=>id !== 1);
  if (contacts.length !== 1) throw new Error('Owner contact QR did not resolve to one private contact');
  const id = contacts[0];
  for (let n = 0; n < 80; n++) {
    const c = await rpc.getContact(accountId, id);
    if (c.isKeyContact && c.e2eeAvail) break;
    if (n === 79) throw new Error('Owner key exchange is still pending');
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  const members = await rpc.getChatContacts(accountId, groupChatId);
  if (!members.includes(id)) await rpc.addContactToChat(accountId, groupChatId, id);
  if (!(await rpc.getChatContacts(accountId, groupChatId)).includes(id)) throw new Error('Owner group addition did not take effect');
  return true;
}
module.exports={addConfiguredOwner};
