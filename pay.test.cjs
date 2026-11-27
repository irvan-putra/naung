const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
process.env.MIDTRANS_SERVER_KEY = 'sandbox-unit-test-only';
process.env.MIDTRANS_CLIENT_KEY = 'sandbox-unit-test-only';
let status = 'pending';
const providerAmounts = new Map();
global.fetch = async (url, opts) => {
 if (String(url).includes('/snap/v1/')) {
   const tx=JSON.parse(opts.body).transaction_details;providerAmounts.set(tx.order_id,tx.gross_amount);
   return new Response(JSON.stringify({token:'fake-token',redirect_url:'https://example.test/sandbox'}), {status:200});
 }
 const id=decodeURIComponent(String(url).split('/v2/')[1].split('/status')[0]);
 return new Response(JSON.stringify({transaction_status:status,gross_amount:String(providerAmounts.get(id)||25000)+'.00',order_id:id,currency:'IDR'}),{status:200});
};
function fresh() { delete require.cache[require.resolve('./pay')]; return require('./pay'); }
function notify(pay, o, state) {
 const body = {order_id:o.orderId,status_code:'200',gross_amount:String(o.amount)+'.00',transaction_status:state};
 body.signature_key = crypto.createHash('sha512').update(body.order_id+body.status_code+body.gross_amount+process.env.MIDTRANS_SERVER_KEY).digest('hex');
 return pay.handleNotification(body);
}
test('stock 24 -> 23 only after verified success, duplicates and reload status do not decrement again',async()=>{
 const p=fresh(); const o=await p.createOrder('stark-holo');
 assert.equal(p.catalog()[0].stock,24); assert.equal(p.catalog()[0].available,23);
 notify(p,o,'pending');assert.equal(p.catalog()[0].stock,24);
 notify(p,o,'settlement');assert.equal(p.catalog()[0].stock,23);
 notify(p,o,'settlement');notify(p,o,'pending');notify(p,o,'cancel');
 await p.refreshStatus(o);await p.refreshStatus(o);
 assert.equal(p.catalog()[0].stock,23);assert.equal(p.catalog()[0].available,23);
 assert.equal(p.publicOrder(o).stockApplied,true);
});
test('failed, cancelled and expired release reservation without reducing stock',async()=>{
 for(const state of ['deny','cancel','expire']) {
 const p=fresh();const o=await p.createOrder('stark-holo');notify(p,o,state);
 assert.equal(p.catalog()[0].stock,24);assert.equal(p.catalog()[0].available,24);
 }
});
test('concurrent checkouts cannot reserve more stock than exists',async()=>{
 const p=fresh();const orders=await Promise.all(Array.from({length:25},()=>p.createOrder('stark-holo')));
 assert.equal(orders.filter(o=>!o.error).length,24);assert.equal(orders.filter(o=>o.error).length,1);
 assert.equal(p.catalog()[0].stock,24);assert.equal(p.catalog()[0].available,0);
 notify(p,orders.find(o=>!o.error),'cancel');assert.equal(p.catalog()[0].available,1);
 assert.equal((await p.createOrder('stark-holo')).error,undefined);
});
test('restart returns demo stock to 24 and no historical lookup decrements it',async()=>{
 const p=fresh();status='settlement';const recovered=await p.lookupProvider('NAUNGDEMO-123-abcdef');
 assert.equal(recovered.state,'paid');assert.equal(p.catalog()[0].stock,24);
});
test('server reconciliation settles paid mobile orders without an active browser poller',async()=>{
 const p=fresh();status='pending';const o=await p.createOrder('stark-lamp');assert.equal(p.catalog()[1].stock,12);
 status='settlement';await p.reconcilePending();assert.equal(p.catalog()[1].stock,11);
 await p.reconcilePending();assert.equal(p.catalog()[1].stock,11);
});
test('Snap payload enables GoPay-specific mobile return',async()=>{
 const original=global.fetch;let payload;
 global.fetch=async(url,opts)=>{payload=JSON.parse(opts.body);return new Response(JSON.stringify({token:'fake'}));};
 try { const p=fresh();await p.createOrder('stark-holo');assert.equal(payload.gopay.enable_callback,true);assert.equal(payload.gopay.callback_url,'https://irvan.app.neoapp.id/pay?order_id='+[...p.orders.keys()][0]);assert.ok(!payload.gopay.callback_url.includes('result=')); }
 finally {global.fetch=original;}
});
test('Pages checkout uses sandbox return URL without changing NEO checkout defaults',async()=>{
 const original=global.fetch,urls=[];global.fetch=async(url,opts)=>{urls.push(JSON.parse(opts.body));return new Response(JSON.stringify({token:'fake-token',redirect_url:'https://example.test/sandbox'}));};
 try {const p=fresh();await p.createOrder('stark-holo',{returnToPages:true});const payload=urls[0];assert.equal(payload.gopay.callback_url,'https://vanipy.com/naung/?order_id='+[...p.orders.keys()][0]);assert.ok(payload.callbacks.finish.startsWith('https://vanipy.com/naung/?order_id='));assert.equal(p.publicCheckoutConfig().sandbox,true);assert.ok(p.publicCheckoutConfig().snapJs.includes('app.sandbox.midtrans.com'));} finally {global.fetch=original;}
});
test('rendered page saves order before wallet leave and resumes saved order after plain return',async()=>{
 const vm=require('node:vm');const p=fresh();const js=p.payPage((t,b)=>b).match(/<script>\s*([\s\S]*?)<\/script>/)[1];
 const storage=new Map();const calls=[];let savedBeforeSnap=false,historyUrl;
 function context() {
 return {window:{location:{search:'',assign(){}},localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)},history:{replaceState(a,b,url){historyUrl=url;}},snap:{pay(){savedBeforeSnap=storage.has('naung-demo-last-order');}}},document:{getElementById(){return {appendChild(){}};},createElement(){return {appendChild(){}};}},URLSearchParams,encodeURIComponent,setInterval(){return 1;},clearInterval(){},fetch:async u=>{calls.push(u);return {ok:true,json:async()=>u.includes('catalog')?[]:({orderId:'NAUNGDEMO-123-abcdef',token:'fake',itemName:'Test',amount:50000,state:'awaiting_payment'})};}};
 }
 const c=context();vm.runInNewContext(js,c);c.window.buy('stark-lamp');await new Promise(r=>setTimeout(r,10));
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
test('paid announcement is queued once, retries delivery, and is not repeated by reads or duplicate notifications',async()=>{
 const p=fresh(),o=await p.createOrder('stark-holo');let calls=0,delivered=[];
 await p.drainPaidEvents(async()=>{calls++;return true;});assert.equal(calls,0);
 notify(p,o,'settlement');notify(p,o,'settlement');await p.refreshStatus(o);
 await p.drainPaidEvents(async e=>{calls++;assert.equal(e.stockRemaining,23);return false;});assert.equal(calls,1);
 await p.drainPaidEvents(async e=>{calls++;delivered.push(e.orderId);return true;});
 notify(p,o,'pending');await p.refreshStatus(o);await p.drainPaidEvents(async()=>{calls++;return true;});
 assert.equal(calls,2);assert.deepEqual(delivered,[o.orderId]);
});
test('pending, failed, cancelled, expired and historical recovery never announce paid',async()=>{
 const p=fresh();let calls=0;
 for(const state of ['pending','deny','cancel','expire']) {const o=await p.createOrder('stark-holo');notify(p,o,state);}
 status='settlement';await p.lookupProvider('NAUNGDEMO-123-abcdef');
 await p.drainPaidEvents(async()=>{calls++;return true;});assert.equal(calls,0);
});

test('wrong payment amount does not consume stock or announce receipt',async()=>{
 const p=fresh(),o=await p.createOrder('stark-holo');const original=global.fetch;
 global.fetch=async()=>new Response(JSON.stringify({transaction_status:'settlement',gross_amount:'1.00',order_id:o.orderId,currency:'IDR'}));
 try {await p.refreshStatus(o);assert.equal(o.state,'awaiting_payment');assert.equal(p.catalog()[0].stock,24);let announcements=0;await p.drainPaidEvents(async()=>{announcements++;return true;});assert.equal(announcements,0);}
 finally {global.fetch=original;}
});


test('dimensional catalog has two character stalls, sane demo pricing/stock and no old software products',async()=>{
 const p=fresh(),items=p.catalog();assert.equal(items.length,6);
 assert.equal(items.filter(i=>i.seller==='Ironman').length,3);assert.equal(items.filter(i=>i.seller==='Deadpool').length,3);
 for(const i of items){assert.ok(i.price>=10000&&i.price<=45000);assert.ok(i.stock>=12&&i.stock<=50);assert.ok(i.pitch.length>20);}
 for(const id of ['starter','support','pro'])assert.equal((await p.createOrder(id)).error,'unknown item');
 const shop=await p.marketCommand('/shop');for(const item of items){assert.ok(shop.includes(item.id));assert.ok(shop.includes(item.pitch));}
 assert.ok(shop.includes('Stark Dimensional Outlet'));assert.ok(shop.includes('Fourth-Wall Gift Shop'));assert.ok(shop.includes('unofficial fan sandbox'));
 const html=p.payPage((t,b)=>b);assert.ok(!/Naung Software|SaaS Starter|API Support Pack|Pro License/.test(html));assert.ok(html.includes('not affiliated with or endorsed by Marvel'));
 const response=await p.marketCommand('/buy pool-duck');assert.ok(response.startsWith('Deadpool (bot):'));assert.ok(response.includes('/pay?order_id='));
});
