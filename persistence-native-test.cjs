// Local native-core restart proof with a fresh throwaway test account.
// Not a test of NEO volume retention, pricing, or deletion.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict'),{spawn}=require('node:child_process');
const d=fs.mkdtempSync(path.join(os.tmpdir(),'naung-native-persist-'));
const env={...process.env,NAUNG_DATA_DIR:path.join(d,'data'),PORT:'19369'};
for(const key of ['NODE_OPTIONS','FENRIR_API_KEY','MIDTRANS_SERVER_KEY','MIDTRANS_CLIENT_KEY'])delete env[key];
let active;
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function stop(p){if(p.exitCode!==null)return;const closed=new Promise(r=>p.once('exit',r));p.kill('SIGTERM');await closed;await wait(1000);}
async function start(){
 const log=fs.openSync(path.join(d,'native-test.log'),'a',0o600);
 const p=spawn(process.execPath,['scripts/start.cjs'],{cwd:__dirname,env,stdio:['ignore',log,log]});fs.closeSync(log);active=p;
 for(let i=0;i<90;i++){
  if(p.exitCode!==null)throw Error('local native process exited '+p.exitCode);
  try{const s=await(await fetch('http://127.0.0.1:19369/api/deltachat/status')).json();if(s.configured&&s.sharedGroupLinked)return {p,s};}catch{}
  await wait(1000);
 }
 throw Error('local native startup did not become configured within90seconds');
}
(async()=>{
 const first=await start();console.log('first native boot configured; group linked');
 await fetch('http://127.0.0.1:19369/visitor/send',{method:'POST',body:new URLSearchParams({text:'/sell Demo native restart | 26000 | 2'}),redirect:'manual'});
 await stop(first.p);
 const second=await start();
 assert.equal(second.s.botAddress,first.s.botAddress);assert.equal(second.s.invite,first.s.invite);
 const catalog=await(await fetch('http://127.0.0.1:19369/api/pay/catalog')).json();assert.ok(catalog.find(i=>i.name.includes('Demo native restart')&&i.stock===2));
 const msgs=await(await fetch('http://127.0.0.1:19369/api/visitor/messages')).json();assert.ok(msgs.messages.some(m=>m.text.includes('Demo native restart')));
 await stop(second.p);
 console.log('PASS: real local native account/address, exact group invite, public thread and custom stock survived a new process. No provider payments/AI used. Not NEO storage proof.');
})().catch(async e=>{console.error(e.message);if(active)await stop(active);process.exitCode=1;});
