const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
function room(){
 const relays=[],calls=[],keys=new Set();let audience=[],now=0;const resends=[];class TestDate extends Date{static now(){return now;}}
 const dc={ensureBoot:async()=>null,status:async()=>({configured:true,sharedGroupLinked:true,botAddress:'test123@example.test'}),fenrir:{enabled:()=>true,personaFor:t=>t.includes('Ironman')?'Ironman':t.includes('Deadpool')?'Deadpool':null,reply:async(t,h,p)=>{calls.push({t,h,p});return 'Test answer';}},bridge:{sendPublicHistoryToNewcomer:async()=>true,replayPublicHistory:async()=>{resends.push('public-history');return true;},publicAudience:async()=>audience,relayOnce:async(k,t,m)=>{if(!keys.has(k)){keys.add(k);relays.push({k,t,m});}return true;},relayToGroup:async (t,p)=>{relays.push({t,p});if(dc.failDelivery)throw Error('synthetic failure');return !dc.falseDelivery;}}};
 const pay={drainPaidEvents:async()=>{},marketCommand:async text=>text==='/shop'?'Six fictional wares':null,reconcilePending:async()=>{}};
 const fakeRequire=k=>k==='./dc'?dc:k==='./pay'?pay:k==='node:http'?{createServer:()=>({listen:()=>{}})}:require(k);
 const ctx=vm.createContext({require:fakeRequire,__dirname,process:{env:{}},setInterval:()=>({unref(){}}),console,URL,URLSearchParams,Buffer,Date:TestDate});
 vm.runInContext(fs.readFileSync(require.resolve('./server'),'utf8'),ctx);
 return {dc,calls,relays,resends,ctx,advance:ms=>{now+=ms;},audience:ids=>{audience=ids;},tick:()=>vm.runInContext('publishStartupShop()',ctx),messages:()=>vm.runInContext('visitorMessages',ctx)};
}
test('ordinary native-group question receives one AI reply without a character name',async()=>{
 const r=room();await r.dc.bridge.onPeerMessage({from:'Test participant',text:'What is your favorite fictional snack?'});assert.equal(r.calls.length,1);assert.equal(r.relays.length,1);assert.ok(r.messages().at(-1).text==='Test answer');
});
test('group and web share explicit character and every-third ordinary rotation without bot loops',async()=>{
 const r=room();await r.dc.bridge.onPeerMessage({from:'Test participant',text:'Ironman, hello'});assert.equal(r.calls[0].p,'Ironman');
 await r.dc.bridge.onPeerMessage({from:'Ironman (bot)',origin:'bot',text:'hello'});assert.equal(r.calls.length,1);
 for(let i=0;i<3;i++)await r.dc.bridge.onPeerMessage({from:'Test participant',text:'ordinary '+i});assert.equal(r.calls.length,4);assert.equal(r.calls[3].p,'Ironman');
 await vm.runInContext("publicReply('web ordinary', [])",r.ctx);assert.equal(r.calls.length,5);
 await r.dc.bridge.onPeerMessage({from:'Test participant',text:'/shop'});assert.equal(r.calls.length,5);
});
test('first and later arrivals resend original IDs after handshake grace without new group/web copies',async()=>{
 const r=room();await r.tick();assert.equal(r.relays.length,0);assert.equal(r.messages().length,3);
 r.audience([2]);await r.tick();assert.equal(r.relays.length,0);r.advance(5000);await r.tick();assert.equal(r.relays.length,3);assert.equal(r.resends.length,1);await r.tick();assert.equal(r.relays.length,3);
 r.audience([2,3]);await r.tick();assert.equal(r.resends.length,1);r.advance(5000);await r.tick();assert.equal(r.relays.length,3);assert.equal(r.messages().length,3);assert.equal(r.resends.length,2);
 await r.tick();assert.equal(r.resends.length,2);
});

test('human bot-like display names remain human and receive replies',async()=>{
 const r=room(); for(const from of ['Ironman (bot)','bot'])await r.dc.bridge.onPeerMessage({from,text:'hello'});
 assert.equal(r.calls.length,2);assert.equal(r.calls[1].h[0].origin,'human');
});
test('native send false or exception is awaited and recorded, not marked sent',async()=>{
 for(const flag of ['failDelivery','falseDelivery']){const r=room();r.dc[flag]=true;await r.dc.bridge.onPeerMessage({from:'Participant',text:'hello'});assert.equal(r.messages().at(-1).delivery,'failed');}
 const r=room();await r.dc.bridge.onPeerMessage({from:'Participant',text:'hello'});assert.equal(r.messages().at(-1).delivery,'sent');
});
