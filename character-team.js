// Managed app identities, all using the same native core and AI request guard.
const fs = require('node:fs');
const path = require('node:path');
const NAMES = ['Ironman', 'Deadpool'];
class CharacterTeam {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'naung-character-roles.json');
    this.document = { version: 1, mainAccountId: null, roles: {} };
    try {
      this.document = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (this.document.version !== 1 || !this.document.roles || typeof this.document.roles !== 'object' || Array.isArray(this.document.roles)) throw new Error('Invalid character-role state');
      const ids = [this.document.mainAccountId, ...Object.values(this.document.roles)].filter(id=>id != null);
      if (ids.some(id=>!Number.isSafeInteger(id)||id<1) || new Set(ids).size !== ids.length || Object.keys(this.document.roles).some(name=>!NAMES.includes(name))) throw new Error('Invalid character-role identities');
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    this.actors = new Map();
    this.ready = false;
  }
  save() {
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.dataDir, 0o700);
    const temp = this.file + '.tmp';
    const fd = fs.openSync(temp, 'w', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(this.document)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temp, this.file);
  }
  async setup(dc, mainAccountId, invite) {
    this.ready = false;
    this.document.mainAccountId = mainAccountId;
    this.save();
    for (const name of NAMES) {
      let all = await dc.rpc.getAllAccounts();
      let id = this.document.roles[name];
      if (id && !all.some(a => a.id === id)) throw new Error('Saved character account is missing');
      if (!id) {
        const before = new Set(all.map(a => a.id));
        await dc.rpc.addAccount();
        all = await dc.rpc.getAllAccounts();
        id = all.find(a => !before.has(a.id))?.id;
        if (!id) throw new Error('Character account was not created');
        this.document.roles[name] = id;
        this.save();
      }
      await dc.rpc.batchSetConfig(id, { bot: '1', displayname: name, selfstatus: 'Fictional character bot in an unofficial sandbox. No real merchandise or money.' });
      if (!await dc.rpc.isConfigured(id)) await dc.rpc.setConfigFromQr(id, 'dcaccount:https://nine.testrun.org/new');
      if (!await dc.rpc.isConfigured(id)) throw new Error('Character account is not configured');
      const transports = await dc.rpc.listTransports(id);
      const address = transports[0]?.addr;
      if (!address) throw new Error('Character account has no address');
      // Record ownership before joining, so no copies from our own actors can
      // be mistaken for human prompts while the second actor is setting up.
      const actor = { name, accountId: id, chatId: 0, address };
      this.actors.set(name, actor);
      await dc.rpc.startIoForAllAccounts();
      actor.chatId = await dc.rpc.secureJoin(id, invite);
      let joined = false;
      for (let n = 0; n < 80; n++) {
        const chat = await dc.rpc.getFullChatById(id, actor.chatId).catch(() => null);
        if (chat?.chatType === 'Group' && chat.canSend) { joined = true; break; }
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      if (!joined) throw new Error('Character group join did not finish');
    }
    this.ready = true;
  }
  forAccount(id) { return [...this.actors.values()].find(a => a.accountId === id) || null; }
  ownsAddress(address) { return [...this.actors.values()].some(a => a.address === address); }
  sender(persona, main) { return persona ? (this.ready ? this.actors.get(persona) || null : null) : main; }
  publicStatus() { return [...this.actors.values()].map(a => ({ name: a.name, address: a.address, ready: Boolean(a.chatId && this.ready) })); }
}
module.exports = { CharacterTeam };
