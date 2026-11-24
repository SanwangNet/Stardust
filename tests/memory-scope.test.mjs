import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { ConversationService } from '../apps/server/dist/conversation.js';
import { migrateMemoryScopes } from '../apps/server/dist/global-context.js';
import { ContextAccessPolicy } from '../apps/server/dist/context-access-policy.js';
import { qqKeys } from '../apps/server/dist/history-provenance.js';
import { createStardustServer } from '../apps/server/dist/app.js';
import { once } from 'node:events';

const qq = (group, id) => ({channelId:'qq-bot',identityAccountId:'bot',conversationType:'group',conversationId:group,senderId:'member',messageId:id,content:'群消息',timestamp:new Date().toISOString()});
const drop10 = `DROP TRIGGER global_context_scope_default; DROP TRIGGER global_context_source_removed;
 DROP TABLE global_context_message_sources; DROP TABLE global_context_revisions; DROP TABLE global_context_scope; PRAGMA user_version=9;`;
const until = async fn => { for(let i=0;i<300;i++){if(fn())return;await new Promise(r=>setTimeout(r,10));} throw Error('timeout'); };

test('schema 9 data, sources, pending jobs and legacy Web visibility survive upgrade and restart', async t => {
 const root=mkdtempSync(join(tmpdir(),'memory-migration-')),path=join(root,'db.sqlite'); let store;
 t.after(()=>{try{store?.close()}catch{} rmSync(root,{recursive:true,force:true});});
 const model={chatContext:async()=> '答复',synthesizeGlobalContext:async()=>'{"updates":[]}'};
 store=new ConversationService(model,path); const a=store.create(); await store.submit(a.id,randomUUID(),'原始消息');
 let db=new DatabaseSync(path);db.prepare("INSERT INTO global_context_entries(id,owner,topic,content,created_at,updated_at,version) VALUES(?,?,?,?,?,?,?)").run('old','web:default','猫','旧记忆','2020','2020',3);
 const job=db.prepare('SELECT * FROM synthesis_jobs').get();db.prepare('INSERT INTO global_context_sources VALUES(?,?,?,?,?)').run('old',job.id,a.id,job.start_sequence,job.end_sequence);
 db.close();store.close();store=undefined;db=new DatabaseSync(path);db.exec(drop10);db.close();
 store=new ConversationService(model,path);assert.equal(store.globalContext.entries('web:default')[0].id,'old');
 assert.equal(store.globalContext.entries('web:default')[0].content,'旧记忆');assert.equal(store.globalContext.entries('web:default')[0].version,3);
 assert.equal(store.globalContext.entries('web:default')[0].sources.length,1);assert.equal(store.globalContext.jobs('web:default').length,1);
 assert.equal(store.globalContext.memoryScope('old').visibility,'web_local');assert.equal(store.globalContext.memoryScope('old').subjectKind,'legacy');
 assert.deepEqual(store.globalContext.entries('web:default',{channelId:'qq-bot',conversationId:'other'}),[]);
 assert.deepEqual(store.globalContext.memorySources('old').map(x=>x.authorKind),['web_user','agent']);
 store.globalContext.start();await until(()=>store.globalContext.counts('web:default').done===1);store.close();store=new ConversationService(model,path);
 assert.equal(store.globalContext.entries('web:default')[0].content,'旧记忆');
 db=new DatabaseSync(path);assert.equal(db.prepare('PRAGMA user_version').get().user_version,11);migrateMemoryScopes(db);db.close();
});

test('scope migration rolls back transaction on collision', t=>{
 const root=mkdtempSync(join(tmpdir(),'memory-rollback-')),path=join(root,'db.sqlite'); const store=new ConversationService({chatContext:async()=>''},path);store.close();
 const db=new DatabaseSync(path);t.after(()=>{db.close();rmSync(root,{recursive:true,force:true});});db.exec(drop10+' CREATE TABLE global_context_scope(bad TEXT);');
 assert.throws(()=>migrateMemoryScopes(db));assert.equal(db.prepare('PRAGMA user_version').get().user_version,9);
 assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='global_context_revisions'").get().n,0);
});

test('subjects, evidence and visibility remain separate, with conservative multi-source intersection', async t=>{
 const root=mkdtempSync(join(tmpdir(),'memory-scope-')),path=join(root,'db.sqlite');const store=new ConversationService({chatContext:async()=> '答复'},path);
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});const web=store.create(),other=store.create();await store.submit(web.id,randomUUID(),'Web 内容');
 const webMessage=store.messages(web.id)[0], a=qq('a','one'),b=qq('b','two');
 const observed=store.people.observeSpaceMember({space:{providerId:'qq',accountId:'bot',spaceType:'group',externalId:'a',observedAt:a.timestamp,source:'message'},identity:{identityType:'qq_group_member',scopeKind:'space',externalId:'member',observedAt:a.timestamp,source:'message'},membership:{observedAt:a.timestamp,source:'message'}});
 store.recordQQ(a);store.recordQQ(b);
 const aa=qqKeys(a).conversationId,bb=qqKeys(b).conversationId, am=store.messages(aa)[0],bm=store.messages(bb)[0];
 const repo=store.globalContext, create=(topic,subject,visibility,messageIds)=>repo.createMemory({owner:'web:default',topic,content:'内容',subject,visibility,messageIds});
 const person=create('人物',{kind:'person',id:observed.identity.personId},{kind:'conversation',conversationId:aa},[am.id]);
 const space=create('空间',{kind:'space',id:observed.space.id},{kind:'conversation',conversationId:aa},[am.id]);
 const conv=create('会话',{kind:'conversation',id:aa},{kind:'conversation',conversationId:aa},[am.id]);
 const global=create('全局',{kind:'global'},{kind:'none'},[webMessage.id]);
 const spaceVisible=create('空间可见',{kind:'space',id:observed.space.id},{kind:'space',spaceId:observed.space.id},[am.id]);
 assert.equal(repo.memoryScope(person).personId,observed.identity.personId);assert.equal(repo.memoryScope(space).spaceId,observed.space.id);assert.equal(repo.memoryScope(conv).conversationId,aa);assert.equal(repo.memoryScope(global).visibility,'none');
 assert.deepEqual(repo.listBySubjectForAdministration({kind:'person',id:observed.identity.personId}).map(x=>x.id),[person]);
 assert.equal(repo.memoryScope(spaceVisible).visibilitySpaceId,observed.space.id);
 assert.deepEqual(repo.entries('web:default',{channelId:'web',scopeId:'web:default',conversationId:other.id}),[]);
 assert.deepEqual(repo.entries('web:default',{channelId:'qq-bot',conversationId:bb}),[]);
 assert.equal(repo.entries('web:default',{channelId:'qq-bot',conversationId:aa}).length,3);
 assert.throws(()=>create('跨范围',{kind:'legacy'},{kind:'conversation',conversationId:aa},[am.id,bm.id]),/MEMORY_SCOPE_DENIED/);
 assert.throws(()=>create('跨渠道',{kind:'legacy'},{kind:'web_local'},[webMessage.id,am.id]),/MEMORY_SCOPE_DENIED/);
 assert.throws(()=>create('不存在',{kind:'person',id:randomUUID()},{kind:'none'},[am.id]),/FOREIGN KEY/);
 assert.equal(repo.memorySources(person)[0].conversationId,aa);assert.equal(repo.memorySources(person)[0].authorKind,'platform_user');
 const originalIdentity=repo.memorySources(person)[0].identityId;
 const second={...qq('a','second'),senderId:'second-member'};
 const secondObserved=store.people.observeSpaceMember({space:{providerId:'qq',accountId:'bot',spaceType:'group',externalId:'a',observedAt:a.timestamp,source:'message'},identity:{identityType:'qq_group_member',scopeKind:'space',externalId:'second-member',observedAt:a.timestamp,source:'message'},membership:{observedAt:a.timestamp,source:'message'}});
 store.people.reassignIdentity(secondObserved.identity.id,observed.identity.personId,0,'确认');store.recordQQ(second);
 const secondMessage=store.messages(aa).find(m=>m.requestId===qqKeys(second).eventKey);
 const multiple=create('多个来源',{kind:'person',id:observed.identity.personId},{kind:'conversation',conversationId:aa},[am.id,secondMessage.id]);
 assert.equal(repo.memoryScope(multiple).subjectStatus,'unchanged');
 const target=store.people.observeIdentity({providerId:'qq',accountId:'bot',identityType:'qq_c2c_user',scope:{kind:'account'},externalId:'another',observedAt:a.timestamp,source:'message'});
 store.people.reassignIdentity(originalIdentity,target.personId,0,'人工转移');
 assert.equal(repo.memorySources(person)[0].identityId,originalIdentity);assert.equal(repo.memoryScope(person).personId,observed.identity.personId);assert.equal(repo.memoryScope(person).visibilityConversationId,aa);
 assert.equal(repo.memoryScope(multiple).subjectStatus,'needs_review');assert.equal(repo.entries('web:default',{channelId:'qq-bot',conversationId:aa}).some(x=>x.id===multiple),false);
 const policy=new ContextAccessPolicy();assert.equal(policy.evaluateMemory({channelId:'qq-bot',conversationId:bb},{visibility:'conversation',visibilityConversationId:aa}),'deny');
 assert.equal(policy.evaluateMemory({channelId:'qq-bot',conversationId:aa},{visibility:'none'}),'deny');
 assert.equal(policy.evaluateMemory({channelId:'web',conversationId:aa},{visibility:'conversation',visibilityConversationId:aa,visibilityChannelId:'qq-bot'}),'deny');
 assert.equal(policy.evaluateMemory({channelId:'qq-bot',conversationId:aa},{visibility:'conversation',visibilityConversationId:aa,visibilityChannelId:'qq-bot'}),'allow');
 store.delete(aa);assert.equal(repo.memoryScope(person),undefined);assert.deepEqual(repo.entries('web:default',{channelId:'qq-bot',conversationId:aa}),[]);
});

test('real Web model request loads only allowed memories through the handle', async t=>{
 const root=mkdtempSync(join(tmpdir(),'memory-web-')),path=join(root,'db.sqlite'),calls=[];
 const model={chatContext:async()=> '答复',chatWithTools:async messages=>{calls.push(structuredClone(messages));return {content:'答复',toolCalls:[]};}};
 const store=new ConversationService(model,path),src=store.create(),target=store.create();await store.submit(src.id,randomUUID(),'猫的来源');
 const messageId=store.messages(src.id)[0].id;
 for (const [topic,content,visibility] of [['猫的公开范围','猫的 Web 可用内容',{kind:'web_local'}],['猫的私有范围','猫的私有会话内容',{kind:'conversation',conversationId:src.id}]])
   store.globalContext.createMemory({owner:'web:default',topic,content,subject:{kind:'legacy'},visibility,messageIds:[messageId]});
 const extensions={restore:async()=>{},shutdown:async()=>{},availableTools:()=>[],availableTargets:()=>[]};
 const server=createStardustServer({setupService:{getInitializationState:()=>({initialized:true})},extensionManager:extensions,modelService:model,conversationService:store});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));rmSync(root,{recursive:true,force:true});});
 const origin=`http://127.0.0.1:${server.address().port}`;
 const response=await fetch(`${origin}/api/v1/conversations/${target.id}/messages`,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({requestId:randomUUID(),content:'猫之前怎么说的'})});
 assert.equal(response.status,200);const text=JSON.stringify(calls[0]);assert.match(text,/猫的 Web 可用内容/);assert.doesNotMatch(text,/猫的私有会话内容/);
 assert.ok(calls[0].some(m=>m.role==='assistant' && m.content.includes('不可信')));assert.ok(!calls[0].some(m=>m.role==='system' && m.content.includes('猫的 Web 可用内容')));
});

test('synthesis preserves revisions and cannot overwrite a differently scoped topic',async t=>{
 const root=mkdtempSync(join(tmpdir(),'memory-revisions-')),path=join(root,'db.sqlite');let count=0;
 const model={chatContext:async()=> '答复',synthesizeGlobalContext:async()=>JSON.stringify({updates:[{topic:count++<2?'猫':'私密',content:`版本${count}`}]})};
 const store=new ConversationService(model,path);t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});const a=store.create(),b=store.create();store.globalContext.start();
 await store.submit(a.id,randomUUID(),'猫一');await until(()=>store.globalContext.counts('web:default').done===1);
 await store.submit(a.id,randomUUID(),'猫二');await until(()=>store.globalContext.counts('web:default').done===2);
 const entry=store.globalContext.entries('web:default').find(x=>x.topic==='猫');assert.equal(entry.version,2);assert.equal(store.globalContext.memorySources(entry.id).length,4);
 const db=new DatabaseSync(path);assert.equal(db.prepare('SELECT content FROM global_context_revisions WHERE entry_id=? AND version=1').get(entry.id).content,'版本1');db.close();
 const msg=store.messages(a.id)[0];const privateId=store.globalContext.createMemory({owner:'web:default',topic:'私密',content:'原有私密内容',subject:{kind:'legacy'},visibility:{kind:'conversation',conversationId:a.id},messageIds:[msg.id]});
 await store.submit(b.id,randomUUID(),'私密');await until(()=>store.globalContext.counts('web:default').done===3);
 const matches=store.globalContext.entries('web:default').filter(x=>x.topic==='私密');assert.equal(matches.length,2);assert.equal(matches.find(x=>x.id===privateId).content,'原有私密内容');
 assert.equal(store.globalContext.entries('web:default',{channelId:'web',scopeId:'web:default',conversationId:b.id}).some(x=>x.id===privateId),false);
});
