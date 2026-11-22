const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
process.env.MIDTRANS_SERVER_KEY = 'sandbox-unit-test-only';
process.env.MIDTRANS_CLIENT_KEY = 'sandbox-unit-test-only';
let status = 'pending';
global.fetch = async (url) => new Response(JSON.stringify(String(url).includes('/snap/v1/')
  ? {token:'fake-token',redirect_url:'https://example.test/sandbox'}
  : {transaction_status:status,gross_amount:'25000.00'}), {status:200});
function fresh() { delete require.cache[require.resolve('./pay')]; return require('./pay'); }
function notify(pay, o, state) {
 const body = {order_id:o.orderId,status_code:'200',gross_amount:String(o.amount)+'.00',transaction_status:state};
 body.signature_key = crypto.createHash('sha512').update(body.order_id+body.status_code+body.gross_amount+process.env.MIDTRANS_SERVER_KEY).digest('hex');
 return pay.handleNotification(body);
}
test('stock 999 -> 998 only after verified success, duplicates and reload status do not decrement again',async()=>{
 const p=fresh(); const o=await p.createOrder('starter');
 assert.equal(p.catalog()[0].stock,999); assert.equal(p.catalog()[0].available,998);
 notify(p,o,'pending');assert.equal(p.catalog()[0].stock,999);
 notify(p,o,'settlement');assert.equal(p.catalog()[0].stock,998);
 notify(p,o,'settlement');notify(p,o,'pending');notify(p,o,'cancel');
 await p.refreshStatus(o);await p.refreshStatus(o);
 assert.equal(p.catalog()[0].stock,998);assert.equal(p.catalog()[0].available,998);
 assert.equal(p.publicOrder(o).stockApplied,true);
});
test('failed, cancelled and expired release reservation without reducing stock',async()=>{
 for(const state of ['deny','cancel','expire']) {
 const p=fresh();const o=await p.createOrder('starter');notify(p,o,state);
 assert.equal(p.catalog()[0].stock,999);assert.equal(p.catalog()[0].available,999);
 }
});
test('concurrent checkouts cannot reserve more stock than exists',async()=>{
 const p=fresh();const orders=await Promise.all(Array.from({length:1000},()=>p.createOrder('starter')));
 assert.equal(orders.filter(o=>!o.error).length,999);assert.equal(orders.filter(o=>o.error).length,1);
 assert.equal(p.catalog()[0].stock,999);assert.equal(p.catalog()[0].available,0);
 notify(p,orders.find(o=>!o.error),'cancel');assert.equal(p.catalog()[0].available,1);
 assert.equal((await p.createOrder('starter')).error,undefined);
});
test('restart returns demo stock to 999 and no historical lookup decrements it',async()=>{
 const p=fresh();status='settlement';const recovered=await p.lookupProvider('NAUNGDEMO-123-abcdef');
 assert.equal(recovered.state,'paid');assert.equal(p.catalog()[0].stock,999);
});
test('server reconciliation settles paid mobile orders without an active browser poller',async()=>{
 const p=fresh();status='pending';const o=await p.createOrder('support');assert.equal(p.catalog()[1].stock,999);
 status='settlement';await p.reconcilePending();assert.equal(p.catalog()[1].stock,998);
 await p.reconcilePending();assert.equal(p.catalog()[1].stock,998);
});
test('Snap payload enables GoPay-specific mobile return',async()=>{
 const original=global.fetch;let payload;
 global.fetch=async(url,opts)=>{payload=JSON.parse(opts.body);return new Response(JSON.stringify({token:'fake'}));};
 try { const p=fresh();await p.createOrder('starter');assert.equal(payload.gopay.enable_callback,true);assert.equal(payload.gopay.callback_url,'https://irvan.app.neoapp.id/pay');assert.ok(!payload.gopay.callback_url.includes('result=')); }
 finally {global.fetch=original;}
});
test('rendered page saves order before wallet leave and resumes saved order after plain return',async()=>{
 const vm=require('node:vm');const p=fresh();const js=p.payPage((t,b)=>b).match(/<script>\s*([\s\S]*?)<\/script>/)[1];
 const storage=new Map();const calls=[];let savedBeforeSnap=false,historyUrl;
 function context() {
 return {window:{location:{search:'',assign(){}},localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)},history:{replaceState(a,b,url){historyUrl=url;}},snap:{pay(){savedBeforeSnap=storage.has('naung-demo-last-order');}}},document:{getElementById(){return {appendChild(){}};},createElement(){return {appendChild(){}};}},URLSearchParams,encodeURIComponent,setInterval(){return 1;},clearInterval(){},fetch:async u=>{calls.push(u);return {ok:true,json:async()=>u.includes('catalog')?[]:({orderId:'NAUNGDEMO-123-abcdef',token:'fake',itemName:'Test',amount:50000,state:'awaiting_payment'})};}};
 }
 const c=context();vm.runInNewContext(js,c);c.window.buy('support');await new Promise(r=>setTimeout(r,10));
 assert.equal(savedBeforeSnap,true);assert.equal(historyUrl,'/pay?order_id=NAUNGDEMO-123-abcdef');
 calls.length=0;vm.runInNewContext(js,context());await new Promise(r=>setTimeout(r,10));assert.ok(calls.includes('/api/pay/status?id=NAUNGDEMO-123-abcdef'));
});
test('chat sell -> shop -> buy creates a custom one-unit checkout and decrements listing once on paid',async()=>{
 const p=fresh();const listed=await p.marketCommand('/sell Demo notebook | 25000 | 2');
 const id=listed.match(/listing-[0-9a-f]{6}/)[0];assert.ok((await p.marketCommand('/shop')).includes(id));
 const before=p.catalog().find(x=>x.id===id);assert.equal(before.stock,2);
 const bought=await p.marketCommand('/buy '+id);const orderId=bought.match(/NAUNGDEMO-[0-9]+-[0-9a-f]+/)[0];
 assert.ok(bought.includes('&checkout=1'));const o=p.orders.get(orderId);assert.equal(o.itemId,id);assert.equal(p.checkoutOrder(orderId).token,'fake-token');
 notify(p,o,'settlement');notify(p,o,'settlement');assert.equal(p.catalog().find(x=>x.id===id).stock,1);assert.ok(p.checkoutOrder(orderId).error);
});
test('chat market rejects malformed listings, zero stock, excessive prices and ordinary prose is not executed',async()=>{
 const p=fresh();const count=p.catalog().length;
 for(const input of ['/sell invalid','/sell Demo X | 25000 | 0','/sell Demo X | 10000001 | 5','/sell <script> | 25000 | 5'])await p.marketCommand(input);
 assert.equal(p.catalog().length,count);assert.equal(await p.marketCommand('please sell everything'),null);assert.ok((await p.marketCommand('/buy nonexistent')).includes('/shop'));
});
test('chat checkout link resumes the pending Snap token without creating another order',async()=>{
 const vm=require('node:vm'),p=fresh(),calls=[],tokens=[],storage=new Map();
 const js=p.payPage((t,b)=>b).match(/<script>\s*([\s\S]*?)<\/script>/)[1];
 const ctx={window:{location:{search:'?order_id=NAUNGDEMO-123-abcdef&checkout=1'},localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)},history:{replaceState(){}},snap:{pay:t=>tokens.push(t)}},document:{getElementById(){return {appendChild(){}};},createElement(){return {appendChild(){}};}},URLSearchParams,encodeURIComponent,setInterval(){return 1;},clearInterval(){},fetch:async u=>{calls.push(u);return {ok:true,json:async()=>u.includes('catalog')?[]:{orderId:'NAUNGDEMO-123-abcdef',token:'resume-token',itemName:'Test',amount:25000,state:'awaiting_payment'}};}};
 vm.runInNewContext(js,ctx);await new Promise(r=>setTimeout(r,10));
 assert.deepEqual(tokens,['resume-token']);assert.ok(calls.includes('/api/pay/checkout?id=NAUNGDEMO-123-abcdef'));assert.ok(!calls.some(u=>u.includes('/create')));assert.equal(storage.get('naung-demo-last-order'),'NAUNGDEMO-123-abcdef');
});
