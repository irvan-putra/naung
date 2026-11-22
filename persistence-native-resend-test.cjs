// Real local core/HTTP restart, original message IDs, and later-member resend.
// No AI, payments, user messages, or NEO resources are used.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict'),{spawn}=require('node:child_process');
const d=fs.mkdtempSync(path.join(os.tmpdir(),'naung-native-resend-persist-'));
const env={...process.env,NAUNG_DATA_DIR:path.join(d,'data'),PORT:'19371'};
for(const key of ['NODE_OPTIONS','FENRIR_API_KEY','MIDTRANS_SERVER_KEY','MIDTRANS_CLIENT_KEY'])delete env[key];
const wait=ms=>new Promise(r=>setTimeout(r,ms));let active;const clients=[];
async function stop(p){if(!p||p.exitCode!==null)return;const closed=new Promise(r=>p.once('exit',r));p.kill('SIGTERM');await closed;await wait(700);}
async function start(){
 const log=fs.openSync(path.join(d,'local-test.log'),'a',0o600),p=spawn(process.execPath,['scripts/start.cjs'],{cwd:__dirname,env,stdio:['ignore',log,log]});fs.closeSync(log);active=p;
 for(let n=0;n<80;n++){if(p.exitCode!==null)throw Error('local server exit '+p.exitCode);try{const s=await(await fetch('http://127.0.0.1:19371/api/deltachat/status')).json();if(s.configured&&s.sharedGroupLinked)return {p,s};}catch{}await wait(500);}throw Error('local server startup timeout');
}
async function peer(dir,invite){const {startDeltaChat}=await import('@deltachat/stdio-rpc-server');const c=await startDeltaChat(dir);clients.push(c);const aa=await c.rpc.getAllAccounts(),a=aa.at(-1).id;await c.rpc.startIo(a);const g=await c.rpc.secureJoin(a,invite);for(let n=0;n<40;n++){if((await c.rpc.getFullChatById(a,g).catch(()=>null))?.canSend)return {c,a,g};await wait(500);}throw Error('local peer join timeout');}
async function count(p,tag){let n=0;for(const id of await p.c.rpc.getMessageIds(p.a,p.g,false,false)){const m=await p.c.rpc.getMessage(p.a,id);if(['[Shop #'+tag+']','[Deadpool #'+tag+']','[Ironman #'+tag+']'].some(x=>(m.text||'').includes(x)))n++;}return n;}
async function three(p,tag){for(let n=0;n<50;n++){if(await count(p,tag)===3)return;await wait(500);}throw Error('local peer did not receive3 originals');}
(async()=>{
 const first=await start(),tag=first.s.botAddress.split('@')[0].slice(0,6),a=await peer('/tmp/dc-peer',first.s.invite);await three(a,tag);
 const before=JSON.parse(fs.readFileSync(path.join(env.NAUNG_DATA_DIR,'state.json')));assert.equal(before.values.bridge.messageIds.filter(([key])=>key.startsWith('startup:')).length,3);for(const [key,ref] of before.values.bridge.messageIds){assert.ok(Number.isSafeInteger(ref.accountId)&&Number.isSafeInteger(ref.chatId)&&Number.isSafeInteger(ref.id),'original ref retains account, chat, message identity');}
 await stop(first.p);const second=await start();assert.equal(second.s.botAddress,first.s.botAddress);assert.equal(second.s.invite,first.s.invite);assert.deepEqual(second.s.characters,first.s.characters,'actual character addresses/readiness survive restart');
 const b=await peer('/tmp/dc-peer-second',first.s.invite);await three(b,tag);await wait(5500);assert.equal(await count(a,tag),3);assert.equal(await count(b,tag),3);
 const after=JSON.parse(fs.readFileSync(path.join(env.NAUNG_DATA_DIR,'state.json')));assert.deepEqual(after.values.bridge.messageIds,before.values.bridge.messageIds);
 const publicMessages=await(await fetch('http://127.0.0.1:19371/api/visitor/messages')).json();assert.equal(publicMessages.messages.filter(m=>/\[(Shop|Deadpool|Ironman) #/.test(m.text)).length,3);
 await stop(second.p);console.log('PASS: real native restart preserved exact invite and original welcome IDs; later member received3, existing member stayed3, web stayed3. Local only, not NEO volume proof.');
})().catch(e=>{console.error(e.message);process.exitCode=1;}).finally(async()=>{await stop(active);for(const c of clients)c.close();});
