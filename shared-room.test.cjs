const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
function room(){
 const relays=[],calls=[],keys=new Set();let audience=[];
 const dc={ensureBoot:async()=>null,status:async()=>({configured:true,sharedGroupLinked:true,botAddress:'test123@example.test'}),fenrir:{enabled:()=>true,personaFor:t=>t.includes('Ironman')?'Ironman':t.includes('Deadpool')?'Deadpool':null,reply:async(t,h,p)=>{calls.push({t,h,p});return 'Test answer';}},bridge:{publicAudience:async()=>audience,relayOnce:async(k,t,m)=>{if(!keys.has(k)){keys.add(k);relays.push({k,t,m});}return true;},relayToGroup:async t=>{relays.push({t});return true;}}};
 const pay={drainPaidEvents:async()=>{},marketCommand:async text=>text==='/shop'?'Six fictional wares':null,reconcilePending:async()=>{}};
 const fakeRequire=k=>k==='./dc'?dc:k==='./pay'?pay:k==='node:http'?{createServer:()=>({listen:()=>{}})}:require(k);
 const ctx=vm.createContext({require:fakeRequire,__dirname,process:{env:{}},setInterval:()=>({unref(){}}),console,URL,URLSearchParams,Buffer});
 vm.runInContext(fs.readFileSync(require.resolve('./server'),'utf8'),ctx);
 return {dc,calls,relays,ctx,audience:ids=>{audience=ids;},tick:()=>vm.runInContext('publishStartupShop()',ctx),messages:()=>vm.runInContext('visitorMessages',ctx)};
}
test('ordinary native-group question receives one AI reply without a character name',async()=>{
 const r=room();await r.dc.bridge.onPeerMessage({from:'Test participant',text:'What is your favorite fictional snack?'});assert.equal(r.calls.length,1);assert.equal(r.relays.length,1);assert.ok(r.messages().at(-1).text==='Test answer');
});
test('group and web share explicit character and every-third ordinary rotation without bot loops',async()=>{
 const r=room();await r.dc.bridge.onPeerMessage({from:'Test participant',text:'Ironman, hello'});assert.equal(r.calls[0].p,'Ironman');
 await r.dc.bridge.onPeerMessage({from:'Ironman (bot)',text:'hello'});assert.equal(r.calls.length,1);
 for(let i=0;i<3;i++)await r.dc.bridge.onPeerMessage({from:'Test participant',text:'ordinary '+i});assert.equal(r.calls.length,4);assert.equal(r.calls[3].p,'Ironman');
 await vm.runInContext("publicReply('web ordinary', [])",r.ctx);assert.equal(r.calls.length,5);
 await r.dc.bridge.onPeerMessage({from:'Test participant',text:'/shop'});assert.equal(r.calls.length,5);
});
test('first joiner and a second later joiner each get welcome trio, without polling duplicates or fake restart',async()=>{
 const r=room();await r.tick();assert.equal(r.relays.length,0);assert.equal(r.messages().length,3);
 r.audience([2]);await r.tick();assert.equal(r.relays.length,3);assert.equal(r.messages().length,3);await r.tick();assert.equal(r.relays.length,3);
 r.audience([2,3]);await r.tick();assert.equal(r.relays.length,6);assert.equal(r.messages().length,6);
 assert.ok(r.relays[3].t.includes('Welcome, new arrival'));assert.ok(!r.relays[3].t.includes('New sandbox session'));await r.tick();assert.equal(r.relays.length,6);
});
