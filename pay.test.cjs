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
