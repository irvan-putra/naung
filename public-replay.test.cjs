const test=require('node:test'),assert=require('node:assert/strict');
const {replayPublicOriginals}=require('./public-replay');
test('replay scans only explicit public chats, preserves original per-account IDs and skips human/private/info/pending',async()=>{
 const called=[],sent=[];
 const fixtures={
  '1:10':[{id:11,fromId:1,text:'web prompt',state:26,timestamp:1},{id:12,fromId:8,text:'native human',state:10,timestamp:2},{id:13,fromId:1,text:'private-looking info',state:26,isInfo:true},{id:14,fromId:1,text:'wait',state:20}],
  '2:20':[{id:21,fromId:1,text:'Ironman answer',state:28,timestamp:3}],
  '3:30':[{id:31,fromId:1,text:'Deadpool answer',state:26,timestamp:4}]
 };
 const rpc={getMessageIds:async(a,g)=>{called.push([a,g]);return fixtures[a+':'+g].map(m=>m.id);},getMessage:async(a,id)=>Object.values(fixtures).flat().find(m=>m.id===id),resendMessages:async(a,ids)=>sent.push([a,ids])};
 assert.equal(await replayPublicOriginals(rpc,[{accountId:1,chatId:10},{accountId:2,chatId:20},{accountId:3,chatId:30}]),false);
 assert.deepEqual(called,[[1,10],[2,20],[3,30]]);assert.deepEqual(sent,[[1,[11]],[2,[21]],[3,[31]]]);
});
test('current public replay is bounded to latest 100 original messages',async()=>{
 let sent;const rpc={getMessageIds:async()=>Array.from({length:130},(_,i)=>i+1),getMessage:async(a,id)=>({id,fromId:1,text:'public '+id,state:26,timestamp:id}),resendMessages:async(a,ids)=>{sent=ids;}};
 assert.equal(await replayPublicOriginals(rpc,[{accountId:1,chatId:10}]),true);assert.equal(sent.length,100);assert.equal(sent[0],31);
});
