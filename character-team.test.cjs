const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {CharacterTeam}=require('./character-team');
test('real character sender selection has separate accounts, role continuity and no idle identity fallback',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'naung-team-unit-')),accounts=[{id:1}],configured=new Set([1]),names=new Map();let creates=0;
 const dc={rpc:{getAllAccounts:async()=>accounts,addAccount:async()=>{creates++;accounts.push({id:accounts.length+1});},batchSetConfig:async(id,c)=>names.set(id,c.displayname),isConfigured:async id=>configured.has(id),setConfigFromQr:async id=>configured.add(id),listTransports:async id=>[{addr:'test'+id+'@example.test'}],startIoForAllAccounts:async()=>{},secureJoin:async id=>100+id,getFullChatById:async()=>({chatType:'Group',canSend:true})}};
 const t=new CharacterTeam(dir);assert.equal(t.sender('Ironman',{accountId:1}),null);await t.setup(dc,1,'test-invite');assert.equal(creates,2);assert.equal(t.sender('Ironman',{}).accountId,2);assert.equal(t.sender('Deadpool',{}).accountId,3);assert.equal(names.get(2),'Ironman');assert.equal(names.get(3),'Deadpool');assert.equal(t.sender(null,{accountId:1}).accountId,1);assert.equal(t.sender('Unknown',{}),null);
 assert.equal(t.ownsAddress('test2@example.test'),true);assert.equal(t.ownsAddress('human@example.test'),false);assert.equal(t.forAccount(3).name,'Deadpool');
 const again=new CharacterTeam(dir);await again.setup(dc,1,'test-invite');assert.equal(creates,2);assert.equal(again.sender('Ironman',{}).accountId,2);assert.equal(fs.statSync(path.join(dir,'naung-character-roles.json')).mode&0o777,0o600);
});
test('missing saved character identity fails instead of silently substituting an account',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'naung-team-unit-'));fs.writeFileSync(path.join(dir,'naung-character-roles.json'),JSON.stringify({version:1,mainAccountId:1,roles:{Ironman:9}}));const t=new CharacterTeam(dir);await assert.rejects(()=>t.setup({rpc:{getAllAccounts:async()=>[{id:1}]}},1,'test-invite'),/missing/);assert.equal(t.ready,false);
});
