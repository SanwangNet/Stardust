import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { ConversationService } from '../apps/server/dist/conversation.js';
import { migrateMemoryIdentity } from '../apps/server/dist/global-context.js';
import { qqKeys } from '../apps/server/dist/history-provenance.js';

const event=(group,id,sender='member')=>({channelId:'qq-bot',identityAccountId:'bot',conversationType:'group',conversationId:group,senderId:sender,messageId:id,content:`${group} 消息`,timestamp:'2025-01-01T00:00:00.000Z'});
const observe=(store,e)=>store.people.observeSpaceMember({space:{providerId:'qq',accountId:'bot',spaceType:'group',externalId:e.conversationId,observedAt:e.timestamp,source:'test'},identity:{identityType:'qq_group_member',scopeKind:'space',externalId:e.senderId,observedAt:e.timestamp,source:'test'},membership:{observedAt:e.timestamp,source:'test'}});
const until=async f=>{for(let i=0;i<400;i++){if(f())return;await new Promise(r=>setTimeout(r,10));}throw Error('timeout');};

test('same owner and topic remain independent across conversations, spaces, persons and visibility',async t=>{
 const root=mkdtempSync(join(tmpdir(),'memory-id-')),path=join(root,'db.sqlite'),store=new ConversationService({chatContext:async()=> '答复'},path);
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 const a=event('group-a','a'),b=event('group-b','b');const oa=observe(store,a),ob=observe(store,b);store.recordQQ(a);store.recordQQ(b);
 const ca=qqKeys(a).conversationId,cb=qqKeys(b).conversationId,ma=store.messages(ca)[0].id,mb=store.messages(cb)[0].id,repo=store.globalContext;
 const create=(subject,visibility,message,content)=>repo.createMemory({owner:'web:default',topic:'常玩的游戏',content,subject,visibility,messageIds:[message]});
 const ids=[
  create({kind:'conversation',id:ca},{kind:'conversation',conversationId:ca},ma,'会话 A'),
  create({kind:'conversation',id:cb},{kind:'conversation',conversationId:cb},mb,'会话 B'),
  create({kind:'space',id:oa.space.id},{kind:'space',spaceId:oa.space.id},ma,'群 A'),
  create({kind:'space',id:ob.space.id},{kind:'space',spaceId:ob.space.id},mb,'群 B'),
  create({kind:'person',id:oa.identity.personId},{kind:'conversation',conversationId:ca},ma,'人物 A'),
  create({kind:'person',id:ob.identity.personId},{kind:'conversation',conversationId:cb},mb,'人物 B'),
  create({kind:'legacy'},{kind:'conversation',conversationId:ca},ma,'旧会话 A'),
  create({kind:'legacy'},{kind:'none'},ma,'不可见')];
 assert.equal(new Set(ids).size,8);assert.equal(repo.entries('web:default').filter(x=>x.topic==='常玩的游戏').length,8);
 assert.throws(()=>create({kind:'legacy'},{kind:'none'},ma,'重复'),/UNIQUE/);
 assert.throws(()=>create({kind:'conversation',id:ca},{kind:'conversation',conversationId:ca},ma,'重复'),/UNIQUE/);
 assert.deepEqual(new Set(repo.entries('web:default',{channelId:'qq-bot',conversationId:ca}).map(x=>x.id)),new Set([ids[0],ids[4],ids[6]]));
 assert.deepEqual(new Set(repo.entries('web:default',{channelId:'qq-bot',conversationId:cb}).map(x=>x.id)),new Set([ids[1],ids[5]]));
 assert.deepEqual(repo.entries('web:default',{channelId:'web',scopeId:'web:default',conversationId:ca}),[]);
 assert.throws(()=>repo.updateMemory('web:default',ids[0],'跨群覆盖',[mb]),/MEMORY_SCOPE_DENIED/);
 repo.updateMemory('web:default',ids[0],'会话 A 更新',[ma]);
 assert.equal(repo.entries('web:default').find(x=>x.id===ids[0]).content,'会话 A 更新');
 assert.equal(repo.entries('web:default').find(x=>x.id===ids[1]).content,'会话 B');
 assert.deepEqual(repo.memorySources(ids[0]).map(x=>x.messageId),[ma]);assert.deepEqual(repo.memorySources(ids[1]).map(x=>x.messageId),[mb]);
 const db=new DatabaseSync(path);db.exec('PRAGMA foreign_keys=ON');assert.equal(db.prepare('SELECT content FROM global_context_revisions WHERE entry_id=? AND version=1').get(ids[0]).content,'会话 A');assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
 assert.throws(()=>db.prepare('UPDATE global_context_entries SET scope_key=? WHERE id=?').run('[]',ids[0]),/IMMUTABLE_MEMORY_SCOPE/);db.close();
 repo.deleteMemory('web:default',ids[0]);assert.equal(repo.entries('web:default').some(x=>x.id===ids[0]),false);assert.equal(repo.entries('web:default').find(x=>x.id===ids[1]).content,'会话 B');
 assert.throws(()=>repo.deleteMemory('other',ids[1]),/MEMORY_NOT_FOUND/);
});

// Rebuild a true schema-10 parent while retaining its existing child tables and data.
function downgrade10(db){db.exec(`PRAGMA foreign_keys=OFF; BEGIN;
 CREATE TABLE old_entries(id TEXT PRIMARY KEY,owner TEXT NOT NULL,topic TEXT NOT NULL,content TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,UNIQUE(owner,topic));
 INSERT INTO old_entries SELECT id,owner,topic,content,created_at,updated_at,version FROM global_context_entries;
 DROP TABLE global_context_entries; ALTER TABLE old_entries RENAME TO global_context_entries;
 CREATE TRIGGER global_context_scope_default AFTER INSERT ON global_context_entries BEGIN
 INSERT INTO global_context_scope(entry_id,subject_kind,visibility) VALUES(NEW.id,'legacy',CASE WHEN NEW.owner='web:default' THEN 'web_local' ELSE 'none' END); END;
 PRAGMA user_version=10; COMMIT; PRAGMA foreign_keys=ON;`);}

test('schema 10 migration preserves memory IDs, revisions, sources, queued jobs and foreign keys',async t=>{
 const root=mkdtempSync(join(tmpdir(),'memory-v10-')),path=join(root,'db.sqlite');let store;
 t.after(()=>{try{store?.close()}catch{}rmSync(root,{recursive:true,force:true});});
 const model={chatContext:async()=> '答复',synthesizeGlobalContext:async()=>'{"updates":[]}'};store=new ConversationService(model,path);
 const c=store.create();await store.submit(c.id,randomUUID(),'旧消息');const message=store.messages(c.id)[0];
 const id=store.globalContext.createMemory({owner:'web:default',topic:'旧主题',content:'原始正文',subject:{kind:'legacy'},visibility:{kind:'web_local'},messageIds:[message.id]});
 store.globalContext.updateMemory('web:default',id,'更新正文',[message.id]);const sources=store.globalContext.memorySources(id);const job=store.globalContext.jobs('web:default')[0];
 let db=new DatabaseSync(path);db.exec('PRAGMA foreign_keys=ON');db.prepare('INSERT INTO global_context_sources VALUES(?,?,?,?,?)').run(id,job.id,c.id,job.startSequence,job.endSequence);db.close();
 store.close();store=undefined;db=new DatabaseSync(path);downgrade10(db);assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);db.close();
 store=new ConversationService(model,path);const entry=store.globalContext.entries('web:default').find(x=>x.id===id);
 assert.equal(entry.content,'更新正文');assert.equal(entry.version,2);assert.equal(store.globalContext.jobs('web:default')[0].id,job.id);
 assert.equal(store.globalContext.memoryScope(id).visibility,'web_local');assert.ok(store.globalContext.memorySources(id).some(x=>x.messageId===sources[0].messageId));
 db=new DatabaseSync(path);db.exec('PRAGMA foreign_keys=ON');assert.equal(db.prepare('SELECT content FROM global_context_revisions WHERE entry_id=?').get(id).content,'原始正文');
 assert.equal(db.prepare('SELECT count(*) n FROM global_context_sources WHERE entry_id=?').get(id).n,1);assert.equal(db.prepare('SELECT count(*) n FROM global_context_message_sources WHERE entry_id=?').get(id).n,1);
 assert.equal(db.prepare('PRAGMA user_version').get().user_version,11);assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);migrateMemoryIdentity(db);db.close();
 store.globalContext.start();await until(()=>store.globalContext.counts('web:default').done===1);store.close();store=new ConversationService(model,path);
 assert.equal(store.globalContext.entries('web:default').find(x=>x.id===id).content,'更新正文');
});

test('schema 11 migration failure restores version, old data, foreign keys and trigger',async t=>{
 const root=mkdtempSync(join(tmpdir(),'memory-v11-fail-')),path=join(root,'db.sqlite');const store=new ConversationService({chatContext:async()=>''},path);store.close();
 const db=new DatabaseSync(path);t.after(()=>{db.close();rmSync(root,{recursive:true,force:true});});downgrade10(db);
 db.exec("INSERT INTO global_context_entries(id,owner,topic,content,created_at,updated_at,version) VALUES('keep','web:default','主题','原文','2020','2020',1); CREATE TABLE global_context_entries_v11(blocker TEXT);");
 assert.throws(()=>migrateMemoryIdentity(db));assert.equal(db.prepare('PRAGMA user_version').get().user_version,10);assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys,1);
 assert.equal(db.prepare("SELECT content FROM global_context_entries WHERE id='keep'").get().content,'原文');
 assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='trigger' AND name='global_context_scope_default'").get().n,1);assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
 db.exec("DROP TABLE global_context_entries_v11; PRAGMA foreign_keys=OFF; INSERT INTO global_context_message_sources(entry_id,message_id) VALUES('keep','missing-message'); PRAGMA foreign_keys=ON;");
 assert.throws(()=>migrateMemoryIdentity(db),/FOREIGN_KEY_VIOLATION/);assert.equal(db.prepare('PRAGMA user_version').get().user_version,10);
 assert.equal(db.prepare("SELECT content FROM global_context_entries WHERE id='keep'").get().content,'原文');
 assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='trigger' AND name='global_context_scope_default'").get().n,1);
 assert.equal(db.prepare('PRAGMA table_info(global_context_entries)').all().some(x=>x.name==='scope_key'),false);
});

test('early schema 10 without space visibility migrates without losing memories',async t=>{
 const root=mkdtempSync(join(tmpdir(),'memory-v10-early-')),path=join(root,'db.sqlite');let store=new ConversationService({chatContext:async()=> '答复'},path);
 t.after(()=>{try{store?.close()}catch{}rmSync(root,{recursive:true,force:true});});const c=store.create();await store.submit(c.id,randomUUID(),'历史');
 const id=store.globalContext.createMemory({owner:'web:default',topic:'主题',content:'旧数据',subject:{kind:'legacy'},visibility:{kind:'web_local'},messageIds:[store.messages(c.id)[0].id]});
 store.close();store=undefined;const db=new DatabaseSync(path);downgrade10(db);
 db.exec(`PRAGMA foreign_keys=OFF; BEGIN; DROP TRIGGER global_context_source_removed; DROP TRIGGER global_context_scope_default;
 CREATE TABLE old_scope(entry_id TEXT PRIMARY KEY REFERENCES global_context_entries(id) ON DELETE CASCADE,subject_kind TEXT NOT NULL,person_id TEXT REFERENCES people(id),space_id TEXT REFERENCES spaces(id),conversation_id TEXT REFERENCES conversations(id),visibility TEXT NOT NULL CHECK(visibility IN ('none','web_local','conversation')),visibility_conversation_id TEXT REFERENCES conversations(id));
 INSERT INTO old_scope SELECT entry_id,subject_kind,person_id,space_id,conversation_id,visibility,visibility_conversation_id FROM global_context_scope;
 DROP TABLE global_context_scope; ALTER TABLE old_scope RENAME TO global_context_scope;
 CREATE TRIGGER global_context_source_removed AFTER DELETE ON global_context_message_sources BEGIN UPDATE global_context_scope SET visibility='none',visibility_conversation_id=NULL WHERE entry_id=OLD.entry_id; END;
 CREATE TRIGGER global_context_scope_default AFTER INSERT ON global_context_entries BEGIN INSERT INTO global_context_scope(entry_id,subject_kind,visibility) VALUES(NEW.id,'legacy',CASE WHEN NEW.owner='web:default' THEN 'web_local' ELSE 'none' END); END;
 COMMIT; PRAGMA foreign_keys=ON;`);db.close();
 store=new ConversationService({chatContext:async()=> '答复'},path);assert.equal(store.globalContext.entries('web:default').find(x=>x.id===id).content,'旧数据');
 assert.equal(store.globalContext.memorySources(id).length,1);assert.equal(store.globalContext.memoryScope(id).visibility,'web_local');
 const check=new DatabaseSync(path);check.exec('PRAGMA foreign_keys=ON');assert.equal(check.prepare('PRAGMA user_version').get().user_version,11);assert.deepEqual(check.prepare('PRAGMA foreign_key_check').all(),[]);check.close();
});

test('a forged memory ID in model output is rejected and cannot change another scope',async t=>{
 const root=mkdtempSync(join(tmpdir(),'memory-forgery-')),path=join(root,'db.sqlite');let victim;
 const model={chatContext:async()=> '答复',synthesizeGlobalContext:async()=>JSON.stringify({updates:[{id:victim,topic:'同名',content:'恶意覆盖'}]})};
 const store=new ConversationService(model,path);t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});const a=store.create(),b=store.create();await store.submit(a.id,randomUUID(),'来源');
 victim=store.globalContext.createMemory({owner:'web:default',topic:'同名',content:'受限正文',subject:{kind:'legacy'},visibility:{kind:'conversation',conversationId:a.id},messageIds:[store.messages(a.id)[0].id]});
 store.globalContext.start();await until(()=>store.globalContext.jobs('web:default')[0].attempts===1);
 assert.equal(store.globalContext.entries('web:default').find(x=>x.id===victim).content,'受限正文');
 assert.equal(store.globalContext.entries('web:default',{channelId:'web',scopeId:'web:default',conversationId:b.id}).some(x=>x.id===victim),false);
 assert.equal(store.globalContext.jobs('web:default')[0].lastError,'INVALID_OUTPUT');
});
