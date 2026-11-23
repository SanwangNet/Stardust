import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { ConversationService } from "../apps/server/dist/conversation.js";
import { qqKeys, migrateHistoryProvenance } from "../apps/server/dist/history-provenance.js";
import { ContextAccessPolicy } from "../apps/server/dist/context-access-policy.js";
const model = { chatContext: async () => "答复" };
const event = (conversationId = "group-a", senderId = "sender-a", messageId = "event-a", account = "bot-a", type = "group") => ({ channelId:"qq-bot", identityAccountId:account, senderId, messageId, conversationId, conversationType:type, content:"消息正文", timestamp:"2025-01-01T00:00:00.000Z" });
const meta = { observedAt:"2025-01-01T00:00:00.000Z", source:"message_sender" };
function fixture(t) { const root=mkdtempSync(join(tmpdir(),"history-source-")), path=join(root,"db.sqlite"); let store=new ConversationService(model,path); t.after(()=>{try{store.close()}catch{} rmSync(root,{recursive:true,force:true})}); return {path,get store(){return store}, reopen(){store.close();store=new ConversationService(model,path)}}; }
function observe(store, e) { return store.people.observeSpaceMember({ space:{providerId:"qq",accountId:e.identityAccountId,spaceType:"group",externalId:e.conversationId,...meta}, identity:{identityType:"qq_group_member",scopeKind:"space",externalId:e.senderId,...meta},membership:{...meta} }); }
const history=(f,e)=>{const id=qqKeys(e).conversationId;return f.store.historyProvenance(id,id)};
test("Web and legacy messages preserve authors without inventing identities",async t=>{
 const f=fixture(t), c=f.store.create(); await f.store.submit(c.id,randomUUID(),"旧消息");
 const original=f.store.messages(c.id); let rows=f.store.historyProvenance(c.id,c.id);
 assert.deepEqual(rows.map(x=>x.authorKind),["web_user","agent"]); assert.ok(rows.every(x=>x.currentPersonId===null));
 f.store.close(); const db=new DatabaseSync(f.path); db.exec("DROP TRIGGER message_provenance_default; DROP TABLE message_provenance; PRAGMA user_version=8"); db.close();
 f.reopen = () => {}; const reopened=new ConversationService(model,f.path);
 rows=reopened.historyProvenance(c.id,c.id); assert.deepEqual(reopened.messages(c.id),original); assert.deepEqual(rows.map(x=>x.authorKind),["web_user","agent"]); reopened.close();
});
test("QQ evidence survives async observation, restart, duplicates and account isolation",t=>{
 const f=fixture(t), a=event(), b=event("group-a","sender-b","event-b"), other=event("group-b","sender-a","event-c"), bot=event("group-a","sender-a","event-d","bot-b"), priv=event("private-a","sender-a","event-e","bot-a","private");
 for(const e of [a,b,other,bot,priv]) f.store.recordQQ(e,"回复"); f.store.recordQQ(a,"回复");
 assert.equal(history(f,a).length,4); // two authors and two agent replies in the same group
 assert.equal(history(f,a)[0].identityState,"unknown");
 const observed=observe(f.store,a); observe(f.store,b); observe(f.store,other); observe(f.store,bot);
 f.store.people.observeIdentity({ providerId:"qq", accountId:"bot-a", identityType:"qq_c2c_user", scope:{kind:"account"},externalId:"sender-a",...meta });
 f.reopen(); const rows=history(f,a); assert.equal(rows[0].identityId,observed.identity.id); assert.equal(rows[0].currentPersonId,observed.identity.personId);
 assert.notEqual(rows[0].identityId,rows[2].identityId); assert.equal(rows[1].authorKind,"agent"); assert.equal(rows[1].identityState,"not_applicable");
 assert.notEqual(history(f,other)[0].identityId,rows[0].identityId); assert.notEqual(history(f,bot)[0].identityId,rows[0].identityId); assert.notEqual(history(f,priv)[0].identityId,rows[0].identityId);
 assert.throws(()=>f.store.recordQQ({...a, senderId:"other"}),/QQ_EVENT_CONFLICT/); assert.equal(history(f,a).length,4);
 assert.throws(()=>f.store.historyProvenance(qqKeys(a).conversationId,qqKeys(other).conversationId),/HISTORY_ACCESS_DENIED/);
});
test("transfer, merge, split and undo keep historical identity stable",t=>{
 const f=fixture(t), a=event(), b=event("group-b","sender-a","event-b"); f.store.recordQQ(a); f.store.recordQQ(b);
 const aa=observe(f.store,a), bb=observe(f.store,b), repo=f.store.people; let row=history(f,b)[0]; assert.equal(row.identityId,bb.identity.id);
 repo.reassignIdentity(bb.identity.id,aa.identity.personId,0,"确认"); row=history(f,b)[0]; assert.equal(row.identityId,bb.identity.id); assert.equal(row.currentPersonId,aa.identity.personId);
 const sp=repo.previewSplit(aa.identity.personId,null,[bb.identity.id]); const split=repo.splitPeople(aa.identity.personId,null,[bb.identity.id],sp.fingerprint,"拆分");
 assert.equal(history(f,b)[0].currentPersonId,split.targetId);
 const opt={nameChoice:"target",noteChoice:"target"}, p=repo.previewMerge(split.targetId,aa.identity.personId,opt), merged=repo.mergePeople(split.targetId,aa.identity.personId,opt,p.fingerprint,"合并");
 assert.equal(history(f,b)[0].currentPersonId,aa.identity.personId); repo.undoMerge(merged.auditId,"恢复");
 row=history(f,b)[0]; assert.equal(row.currentPersonId,split.targetId); assert.equal(row.identityId,bb.identity.id); assert.equal(row.content,"消息正文");
});
test("policy denies every cross-range dimension and incomplete source",()=>{
 const p=new ContextAccessPolicy(), q={channelId:"qq-bot",conversationId:"c"};
 assert.equal(p.evaluateHistory(q,q,"CURRENT_CONVERSATION"),"allow");
 for(const scope of ["CURRENT_SPACE","SAME_IDENTITY","SAME_PERSON","OTHER_CHANNEL"]) assert.equal(p.evaluateHistory(q,q,scope),"deny");
 assert.equal(p.evaluateHistory(q,{channelId:"qq-bot",conversationId:"other"},"CURRENT_CONVERSATION"),"deny");
 assert.equal(p.evaluateHistory(q,{},"CURRENT_CONVERSATION"),"deny");
});
test("migration rollback and repeat are transactional",t=>{
 const db=new DatabaseSync(":memory:"); t.after(()=>db.close()); db.exec("PRAGMA user_version=8");
 assert.throws(()=>migrateHistoryProvenance(db)); assert.equal(db.prepare("PRAGMA user_version").get().user_version,8);
 assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='message_provenance'").get().n,0);
});
