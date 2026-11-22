const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const node = process.execPath;
const cwd = __dirname;
function run(dir, code, ok = true) {
  const result = spawnSync(node, ['-e', code], { cwd, encoding: 'utf8', env: { ...process.env, NAUNG_DATA_DIR: dir } });
  if (ok) assert.equal(result.status, 0, result.stderr);
  return result;
}
function dir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'naung-persistence-test-')); }
const fakeProvider = `process.env.MIDTRANS_SERVER_KEY='unit-test-only';process.env.MIDTRANS_CLIENT_KEY='unit-test-only';global.fetch=async(url,opts)=>new Response(JSON.stringify({token:'fake',redirect_url:'https://example.test'}));`;
test('private state survives a completely new process with stable state id and private modes', () => {
  const d=dir();const first=run(d, `const s=require('./state-store');s.set('example',{x:7});console.log(s.id);`).stdout.trim();
  const second=run(d, `const s=require('./state-store');if(s.get('example',{}).x!==7)process.exit(1);console.log(s.id);`).stdout.trim();
  assert.equal(first,second);assert.equal(fs.statSync(d).mode&0o777,0o700);assert.equal(fs.statSync(path.join(d,'state.json')).mode&0o777,0o600);
});
test('corrupt or unsupported state fails closed without overwriting saved bytes',()=>{
 for(const raw of ['{broken',JSON.stringify({version:999,id:'x',values:{}})]) {
  const d=dir();fs.writeFileSync(path.join(d,'state.json'),raw);const r=run(d,`require('./pay')`,false);assert.notEqual(r.status,0);assert.equal(fs.readFileSync(path.join(d,'state.json'),'utf8'),raw);
 }
});
test('state inside the served source, including a symlink, is rejected',()=>{
 assert.notEqual(run(__dirname,`require('./state-store')`,false).status,0);
 const d=dir(),link=path.join(d,'link');fs.symlinkSync(__dirname,link);assert.notEqual(run(link,`require('./state-store')`,false).status,0);
});
test('custom listing, pending reservation, checkout token, paid stock and outbox survive process restart',()=>{
 const d=dir();
 run(d, fakeProvider+`(async()=>{const p=require('./pay');const x=await p.marketCommand('/sell Demo persisted item | 25000 | 2');const id=x.match(/listing-[0-9a-f]{6}/)[0];const o=await p.createOrder(id);require('./state-store').set('testOrder',o.orderId);})().catch(e=>{console.error(e);process.exitCode=1;});`);
 run(d, fakeProvider+`(async()=>{const p=require('./pay'),s=require('./state-store'),o=p.orders.get(s.get('testOrder',''));if(!o||o.token!=='fake')throw Error('lost order/token');const i=p.catalog().find(i=>i.id===o.itemId);if(i.stock!==2||i.available!==1)throw Error('lost reservation');const b={order_id:o.orderId,status_code:'200',gross_amount:'25000.00',transaction_status:'settlement'};b.signature_key=require('crypto').createHash('sha512').update(b.order_id+b.status_code+b.gross_amount+process.env.MIDTRANS_SERVER_KEY).digest('hex');p.handleNotification(b);let count=0;await p.drainPaidEvents(async()=>{count++;return false;});if(count!==1)throw Error('lost queued event');})().catch(e=>{console.error(e);process.exitCode=1;});`);
 run(d, fakeProvider+`(async()=>{const p=require('./pay'),s=require('./state-store'),o=p.orders.get(s.get('testOrder',''));const i=p.catalog().find(i=>i.id===o.itemId);if(o.state!=='paid'||!o.stockApplied||i.stock!==1||i.available!==1)throw Error('lost paid stock');let count=0;await p.drainPaidEvents(async()=>{count++;return true;});if(count!==1)throw Error('outbox not retried once');})().catch(e=>{console.error(e);process.exitCode=1;});`);
 run(d, fakeProvider+`(async()=>{const p=require('./pay');let count=0;await p.drainPaidEvents(async()=>{count++;return true;});if(count)throw Error('duplicate delivered event');})().catch(e=>{console.error(e);process.exitCode=1;});`);
 const state=JSON.parse(fs.readFileSync(path.join(d,'state.json')));assert.equal(state.values.shop.paidEvents[0][1].delivered,true);
});
test('interrupted checkout with no handed-off token releases reservation on recovery',()=>{
 const d=dir();run(d, fakeProvider+`const p=require('./pay');global.fetch=()=>new Promise(()=>{});p.createOrder('stark-holo');`);
 run(d, fakeProvider+`const p=require('./pay');if(p.catalog()[0].available!==24)throw Error('stuck reservation');if([...p.orders.values()][0].state!=='failed')throw Error('unfinished checkout not closed');`);
});
test('native group metadata and announcement dedup reload without creating a replacement group',()=>{
 const d=dir();run(d,`require('./state-store').set('bridge',{groupChatId:42,announcements:['payment:example']});`);
 run(d,`(async()=>{const b=require('./dc').bridge;b.groupName='Visitors #test';let creates=0;const dc={rpc:{getFullChatById:async()=>({chatType:'Group',name:'Visitors #test',selfInGroup:true}),createGroupChat:async()=>{creates++;return 99;}}};if(await b.ensureGroup(dc,1)!==42||creates!==0||!b.announcementRelays.has('payment:example'))throw Error('restoration failed');})().catch(e=>{console.error(e);process.exitCode=1;});`);
 run(d,`(async()=>{const b=require('./dc').bridge;let rejected=false;try{await b.ensureGroup({rpc:{getFullChatById:async()=>null,createGroupChat:async()=>{throw Error('must not create');}}},1);}catch{rejected=true;}if(!rejected)throw Error('bad group silently replaced');})().catch(e=>{console.error(e);process.exitCode=1;});`);
});

test('disk write failure stops instead of continuing with unsaved paid state',()=>{
 const d=dir();run(d,`require('./state-store').set('counter',1);`);
 const r=run(d,`const s=require('./state-store');require('node:fs').renameSync=()=>{const e=new Error('test-only');e.code='ENOSPC';throw e;};s.set('counter',2);`,false);
 assert.equal(r.status,74);assert.equal(JSON.parse(fs.readFileSync(path.join(d,'state.json'))).values.counter,1);
});
