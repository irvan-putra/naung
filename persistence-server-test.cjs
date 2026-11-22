// Local integration proof only. No native account is created or contacted.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict'),{spawn}=require('node:child_process');
const d=fs.mkdtempSync(path.join(os.tmpdir(),'naung-server-persist-'));
const preload=path.join(d,'preload.cjs');
fs.writeFileSync(preload, `const dc=require(${JSON.stringify(path.join(__dirname,'dc.js'))});dc.ensureBoot=async()=>null;dc.status=async()=>({configured:true,charactersReady:true});dc.fenrir.reply=async()=>null;`);
const env={...process.env,NAUNG_DATA_DIR:path.join(d,'data'),NODE_OPTIONS:'--require '+preload,PORT:'19367'};
let active;
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function start(){const p=spawn(process.execPath,['scripts/start.cjs'],{cwd:__dirname,env,stdio:['ignore','pipe','pipe']});let log='';p.stderr.on('data',b=>log+=b);p.stdout.on('data',b=>log+=b);for(let i=0;i<100;i++){if(p.exitCode!==null)throw Error('start failed: '+log);try{const r=await fetch('http://127.0.0.1:19367/api/server-info');if(r.ok){active=p;return p;}}catch{}await wait(30);}p.kill('SIGTERM');throw Error('server timeout');}
async function stop(p){const closed=new Promise(r=>p.once('exit',r));p.kill('SIGTERM');await closed;}
(async()=>{
 console.log('starting first instance');let p=await start();console.log('first instance ready');
 console.log('checking initial info');const before=await(await fetch('http://127.0.0.1:19367/api/server-info')).json();assert.equal(before.storageConfigured,true);
 // A concurrent second process must not start or touch the state snapshot.
 const duplicate=spawn(process.execPath,['scripts/start.cjs'],{cwd:__dirname,env:{...env,PORT:'19368'},stdio:['ignore','ignore','pipe']});let log='';duplicate.stderr.on('data',b=>log+=b);const code=await new Promise(r=>duplicate.once('exit',r));assert.equal(code,73,log);
 console.log('writer lock checked; posting listing');await fetch('http://127.0.0.1:19367/visitor/send',{method:'POST',body:new URLSearchParams({text:'/sell Demo durable widget | 27000 | 3'}),redirect:'manual'});
 const messages=await(await fetch('http://127.0.0.1:19367/api/visitor/messages')).json();assert.ok(messages.messages.some(m=>m.text.includes('Demo durable widget')));
 console.log('stopping first instance');await stop(p);console.log('restarting');p=await start();console.log('second instance ready');
 const after=await(await fetch('http://127.0.0.1:19367/api/server-info')).json();assert.equal(after.stateId,before.stateId);assert.notEqual(after.pid,before.pid);
 const restored=await(await fetch('http://127.0.0.1:19367/api/visitor/messages')).json();assert.deepEqual(restored,messages);
 const catalog=await(await fetch('http://127.0.0.1:19367/api/pay/catalog')).json();assert.ok(catalog.find(i=>i.name.includes('Demo durable widget')&&i.stock===3));
 for(const url of ['/state.json','/data/state.json','/%2e%2e/state.json'])assert.notEqual((await fetch('http://127.0.0.1:19367'+url)).status,200);
 await stop(p);console.log('PASS: actual process restart restored public thread/catalog/state id; duplicate writer exit73; state URLs not served. Native RPC mocked, not a native-redeploy proof.');
})().catch(async e=>{console.error(e);if(active&&active.exitCode===null)await stop(active);process.exitCode=1;});
