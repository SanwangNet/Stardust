import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { ConversationService } from "../apps/server/dist/conversation.js";
import { ExtensionManager } from "../apps/server/dist/extension-manager.js";
import { createStardustServer } from "../apps/server/dist/app.js";
import { LogService } from "../apps/server/dist/logger.js";
import { migratePeopleMerge } from "../apps/server/dist/people.js";

const at = "2026-01-01T00:00:00.000Z", opts = {nameChoice:"target",noteChoice:"target"};
const observed = (group, member, name, timestamp = at) => ({space:{providerId:"qq",accountId:"fake-bot-app",spaceType:"group",externalId:group,observedAt:timestamp,source:"message_sender"},identity:{identityType:"qq_group_member",scopeKind:"space",externalId:member,displayName:name,observedAt:timestamp,source:"message_sender"},membership:{displayName:name,observedAt:timestamp,source:"message_sender"}});
async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),"stardust-merge-")), path=join(root,"test.sqlite"), model={async chatContext(){return "ok";}}, store=new ConversationService(model,path);
  const manager=new ExtensionManager(root,model,[],new LogService(30,()=>{}));
  const server=createStardustServer({modelService:model,extensionManager:manager,conversationService:store,qqApprovalToken:"",setupService:{getInitializationState:()=>({initialized:true})}});
  server.listen(0,"127.0.0.1"); await once(server,"listening");
  t.after(async()=>{server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); await manager.shutdown(); await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:50});});
  const origin=`http://127.0.0.1:${server.address().port}`, control=(await (await fetch(origin+"/api/v1/control-session")).json()).token;
  const req=(path,method="GET",body,headers={})=>fetch(origin+path,{method,headers:{"x-stardust-control-token":control,...(method==="GET"?{}:{origin,"content-type":"application/json"}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const read=async path=>{const response=await req(path);assert.equal(response.status,200);return response.json();};
  const preview=async(sourceId,targetId,options=opts)=>{const response=await req("/api/v1/people/merge/preview","POST",{sourceId,targetId,options});assert.equal(response.status,200);return (await response.json()).result;};
  const merge=(sourceId,targetId,p,options=opts)=>req("/api/v1/people/merge","POST",{sourceId,targetId,options,fingerprint:p.fingerprint,reason:"人工核对"});
  return {root,path,store,manager,server,origin,control,req,read,preview,merge};
}

test("batch merge preserves original person, observations and supports conflict-free restoration",async t=>{
  const f=await fixture(t), a=f.store.people.observeSpaceMember(observed("fake-group-a","fake-user-a","甲")), b=f.store.people.observeSpaceMember(observed("fake-group-b","fake-user-b","乙")), c=f.store.people.observeSpaceMember(observed("fake-group-c","fake-user-c","丙"));
  const source=b.identity.personId,target=a.identity.personId;
  f.store.people.reassignIdentity(c.identity.id,source,0,"人工核实");
  f.store.people.editPerson(source,0,"来源姓名","来源备注"); f.store.people.editPerson(target,0,"目标姓名","目标备注");
  const chosen={nameChoice:"source",noteChoice:"custom",note:"核对后的备注"}, p=await f.preview(source,target,chosen);
  assert.equal(p.identities.length,2); assert.equal(p.spaceCount,2); assert.equal(p.membershipCount,2); assert.equal(p.final.manualName,"来源姓名"); assert.equal(p.final.note,"核对后的备注");
  assert.doesNotMatch(JSON.stringify(p),/fake-group|fake-user|fake-bot-app/);
  const beforeB=f.store.people.listSpaceMembers(b.space.id)[0], beforeC=f.store.people.listSpaceMembers(c.space.id)[0];
  const response=await f.merge(source,target,p,chosen); assert.equal(response.status,200); const {auditId}=(await response.json()).result;
  const merged=(await f.read(`/api/v1/people/${source}`)).person; assert.equal(merged.mergedIntoId,target); assert.equal(merged.manualName,"来源姓名"); assert.equal(merged.note,"来源备注");
  assert.equal(f.store.people.getIdentity(b.identity.id).personId,target); assert.equal(f.store.people.getIdentity(c.identity.id).personId,target);
  assert.deepEqual(f.store.people.listSpaceMembers(b.space.id)[0],beforeB); assert.deepEqual(f.store.people.listSpaceMembers(c.space.id)[0],beforeC);
  assert.equal((await f.merge(source,target,p,chosen)).status,409);
  assert.ok(!(await f.read("/api/v1/people")).items.some(item=>item.id===source)); assert.ok((await f.read("/api/v1/people?state=merged")).items.some(item=>item.id===source));
  assert.equal((await f.req(`/api/v1/people/${source}`,"PATCH",{manualName:"不可写",note:null,version:merged.version})).status,409);
  f.store.people.observeSpaceMember(observed("fake-group-b","fake-user-b","新观察","2026-02-01T00:00:00.000Z"));
  assert.equal(f.store.people.getIdentity(b.identity.id).personId,target);
  const audit=(await f.read(`/api/v1/people/${source}/audit`)).items.find(item=>item.id===auditId); assert.equal(audit.operation,"person_merge"); assert.equal(audit.canUndo,true); assert.doesNotMatch(JSON.stringify(audit),/fake-group|fake-user|fake-bot-app/);
  assert.equal((await f.req(`/api/v1/people/merge/${auditId}/undo`,"POST",{reason:"纠正合并"})).status,200);
  assert.equal((await f.req(`/api/v1/people/merge/${auditId}/undo`,"POST",{reason:"重复撤销"})).status,409);
  assert.equal(f.store.people.getIdentity(b.identity.id).personId,source); assert.equal(f.store.people.getIdentity(c.identity.id).personId,source);
  assert.equal(f.store.people.getIdentity(b.identity.id).displayName,"新观察"); assert.equal(f.store.people.getPerson(target).manualName,"目标姓名"); assert.equal(f.store.people.getPerson(target).note,"目标备注");
  assert.equal(f.store.people.getPerson(source).mergedIntoId,null); assert.ok((await f.read(`/api/v1/people/${source}/audit`)).items.some(item=>item.operation==="person_merge_undo"));
});

test("stale previews, invalid merged states and cycles are rejected",async t=>{
  const f=await fixture(t), a=f.store.people.observeSpaceMember(observed("group-1","user-1","甲")), b=f.store.people.observeSpaceMember(observed("group-2","user-2","乙"));
  const source=b.identity.personId,target=a.identity.personId, p=await f.preview(source,target);
  f.store.people.upsertIdentity({providerId:"web",accountId:"mock-account",identityType:"user",scope:{kind:"account"},externalId:"new-identity",observedAt:at,source:"manual"},{personId:source,method:"manual_confirmation"});
  assert.equal((await f.merge(source,target,p)).status,409); assert.equal(f.store.people.getIdentity(b.identity.id).personId,source);
  const refreshed=await f.preview(source,target); assert.equal((await f.merge(source,target,refreshed)).status,200);
  assert.equal((await f.req("/api/v1/people/merge/preview","POST",{sourceId:target,targetId:source,options:opts})).status,409);
  assert.equal((await f.req("/api/v1/people/merge/preview","POST",{sourceId:target,targetId:target,options:opts})).status,409);
  const third=f.store.people.createPerson({displayName:"另一人"}); assert.equal((await f.req("/api/v1/people/merge/preview","POST",{sourceId:target,targetId:third.id,options:opts})).status,409);
  assert.equal((await f.req(`/api/v1/identities/${b.identity.id}/reassign`,"POST",{targetPersonId:source,version:1,reason:"错误目标"})).status,409);
});

test("split is atomic for multiple identities and creates a provisional destination only on success",async t=>{
  const f=await fixture(t), a=f.store.people.observeSpaceMember(observed("scope-a","sender-a","甲")), b=f.store.people.observeSpaceMember(observed("scope-b","sender-b","乙")), c=f.store.people.observeSpaceMember(observed("scope-c","sender-c","丙"));
  const source=a.identity.personId; f.store.people.reassignIdentity(b.identity.id,source,0,"人工核对"); f.store.people.reassignIdentity(c.identity.id,source,0,"人工核对");
  const body={sourceId:source,targetId:null,identities:[b.identity.id,c.identity.id]}, preview=(await (await f.req("/api/v1/people/split/preview","POST",body)).json()).result;
  assert.equal(preview.identities.length,2); const originalCount=f.store.people.listPersons().length;
  const bad=await f.req("/api/v1/people/split","POST",{...body,fingerprint:`${"0".repeat(64)}.${"0".repeat(64)}`,reason:"分开身份"}); assert.equal(bad.status,409); assert.equal(f.store.people.listPersons().length,originalCount);
  const response=await f.req("/api/v1/people/split","POST",{...body,fingerprint:preview.fingerprint,reason:"分开身份"}); assert.equal(response.status,200);
  const result=(await response.json()).result; assert.equal(f.store.people.getPerson(result.targetId).status,"provisional"); assert.equal(f.store.people.getIdentity(b.identity.id).personId,result.targetId); assert.equal(f.store.people.getIdentity(c.identity.id).personId,result.targetId);
  assert.equal(f.store.people.getIdentity(a.identity.id).personId,source); assert.equal(f.store.people.listSpaceMembers(b.space.id).length,1);
  assert.equal((await f.req("/api/v1/people/split","POST",{...body,fingerprint:preview.fingerprint,reason:"重复"})).status,409);
  assert.ok((await f.read(`/api/v1/people/${source}/audit`)).items.some(item=>item.operation==="person_split"));
  const existing={sourceId:result.targetId,targetId:source,identities:[b.identity.id]}, p2=(await (await f.req("/api/v1/people/split/preview","POST",existing)).json()).result;
  assert.equal((await f.req("/api/v1/people/split","POST",{...existing,fingerprint:p2.fingerprint,reason:"调整"})).status,200);
  assert.equal(f.store.people.getIdentity(b.identity.id).personId,source);
});

test("audit failure rolls back a merge, and subsequent profile changes prevent destructive restore",async t=>{
  const f=await fixture(t), a=f.store.people.observeSpaceMember(observed("group-a","user-a","甲")), b=f.store.people.observeSpaceMember(observed("group-b","user-b","乙")), source=b.identity.personId,target=a.identity.personId, p=await f.preview(source,target);
  const db=new DatabaseSync(f.path); db.exec("CREATE TRIGGER fail_merge BEFORE INSERT ON people_audit BEGIN SELECT RAISE(ABORT,'test_failure'); END");
  try { assert.equal((await f.merge(source,target,p)).status,503); assert.equal(f.store.people.getPerson(source).mergedIntoId,null); assert.equal(f.store.people.getIdentity(b.identity.id).personId,source); } finally { db.exec("DROP TRIGGER fail_merge"); db.close(); }
  const result=(await (await f.merge(source,target,p)).json()).result;
  f.store.people.editPerson(target,1,"后续人工名",null);
  assert.equal((await f.req(`/api/v1/people/merge/${result.auditId}/undo`,"POST",{reason:"不能覆盖后续资料"})).status,409);
  assert.equal(f.store.people.getIdentity(b.identity.id).personId,target); assert.equal(f.store.people.getPerson(target).manualName,"后续人工名");
});

test("concurrent merges and preview changes never move an unconfirmed identity",async t=>{
  const f=await fixture(t), a=f.store.people.observeSpaceMember(observed("g-a","u-a","甲")), b=f.store.people.observeSpaceMember(observed("g-b","u-b","乙")), c=f.store.people.observeSpaceMember(observed("g-c","u-c","丙"));
  const source=b.identity.personId,target=a.identity.personId, third=c.identity.personId, old=await f.preview(source,target);
  f.store.people.editPerson(source,0,"新的名称",null); assert.equal((await f.merge(source,target,old)).status,409);
  const [p1,p2]=await Promise.all([f.preview(source,target),f.preview(source,third)]);
  const results=await Promise.all([f.merge(source,target,p1),f.merge(source,third,p2)]);
  assert.deepEqual(results.map(item=>item.status).sort(),[200,409]);
  const merged=f.store.people.getPerson(source), destination=merged.mergedIntoId;
  assert.ok([target,third].includes(destination)); assert.equal(f.store.people.getIdentity(b.identity.id).personId,destination);
  assert.equal(f.store.people.getIdentity(a.identity.id).personId,target); assert.equal(f.store.people.getIdentity(c.identity.id).personId,third);
});

test("later identity moves block undo even when the identity returns to the merged target",async t=>{
  const f=await fixture(t), a=f.store.people.observeSpaceMember(observed("g-a","u-a","甲")), b=f.store.people.observeSpaceMember(observed("g-b","u-b","乙")), c=f.store.people.observeSpaceMember(observed("g-c","u-c","丙")), source=b.identity.personId,target=a.identity.personId;
  const preview=await f.preview(source,target), merge=await f.merge(source,target,preview), auditId=(await merge.json()).result.auditId;
  f.store.people.reassignIdentity(b.identity.id,c.identity.personId,1,"变更归属"); f.store.people.reassignIdentity(b.identity.id,target,2,"再次变更");
  assert.equal((await f.req(`/api/v1/people/merge/${auditId}/undo`,"POST",{reason:"不能覆盖后续归属"})).status,409);
  assert.equal(f.store.people.getIdentity(b.identity.id).personId,target);
  assert.equal((await f.read(`/api/v1/people/${source}/audit`)).items.find(item=>item.id===auditId).canUndo,false);
});

test("a failed restoration audit leaves the merge and profile intact",async t=>{
  const f=await fixture(t), a=f.store.people.observeSpaceMember(observed("group-one","sender-one","甲")), b=f.store.people.observeSpaceMember(observed("group-two","sender-two","乙")), source=b.identity.personId,target=a.identity.personId;
  f.store.people.editPerson(target,0,"目标名称",null); f.store.people.editPerson(source,0,"来源名称",null);
  const choices={nameChoice:"source",noteChoice:"target"}, p=await f.preview(source,target,choices), auditId=(await (await f.merge(source,target,p,choices)).json()).result.auditId;
  const db=new DatabaseSync(f.path); db.exec("CREATE TRIGGER fail_restore BEFORE INSERT ON people_audit BEGIN SELECT RAISE(ABORT,'test_failure'); END");
  try { assert.equal((await f.req(`/api/v1/people/merge/${auditId}/undo`,"POST",{reason:"撤销误合并"})).status,503); }
  finally { db.exec("DROP TRIGGER fail_restore"); db.close(); }
  assert.equal(f.store.people.getPerson(source).mergedIntoId,target); assert.equal(f.store.people.getIdentity(b.identity.id).personId,target); assert.equal(f.store.people.getPerson(target).manualName,"来源名称");
  assert.equal((await f.req(`/api/v1/people/merge/${auditId}/undo`,"POST",{reason:"撤销误合并"})).status,200); assert.equal(f.store.people.getPerson(target).manualName,"目标名称");
});

test("split audit failure rolls back newly created people and rejects invalid selections",async t=>{
  const f=await fixture(t), a=f.store.people.observeSpaceMember(observed("g-a","u-a","甲")), b=f.store.people.observeSpaceMember(observed("g-b","u-b","乙")), source=a.identity.personId;
  const invalid={sourceId:source,targetId:null,identities:[a.identity.id,a.identity.id]}; assert.equal((await f.req("/api/v1/people/split/preview","POST",invalid)).status,400);
  assert.equal((await f.req("/api/v1/people/split/preview","POST",{...invalid,identities:[b.identity.id]})).status,409);
  const body={sourceId:source,targetId:null,identities:[a.identity.id]}, p=(await (await f.req("/api/v1/people/split/preview","POST",body)).json()).result, count=f.store.people.listPersons().length;
  const db=new DatabaseSync(f.path); db.exec("CREATE TRIGGER fail_split BEFORE INSERT ON people_audit BEGIN SELECT RAISE(ABORT,'test_failure'); END");
  try { assert.equal((await f.req("/api/v1/people/split","POST",{...body,fingerprint:p.fingerprint,reason:"人工拆分"})).status,503); }
  finally { db.exec("DROP TRIGGER fail_split"); db.close(); }
  assert.equal(f.store.people.listPersons().length,count); assert.equal(f.store.people.getIdentity(a.identity.id).personId,source);
});

test("local controller access needs no password but rejects cross-site and forged data",async t=>{
  const f=await fixture(t), a=f.store.people.createPerson(),b=f.store.people.createPerson();
  assert.equal((await fetch(f.origin+"/api/v1/people")).status,403);
  assert.equal((await f.req("/api/v1/people")).status,200);
  const body={sourceId:a.id,targetId:b.id,options:opts};
  assert.equal((await f.req("/api/v1/people/merge/preview","POST",body,{origin:"https://evil.example"})).status,403);
  assert.equal((await f.req("/api/v1/people/merge/preview","POST",{...body,actor:"fake"})).status,400);
  assert.equal((await f.req("/api/v1/people/merge/preview","POST",{...body,targetId:randomUUID()})).status,404);
  assert.equal((await f.req("/api/v1/people/merge","POST",{...body,fingerprint:"fake",reason:"确认"})).status,400);
});

test("version 7 migration is additive, repeatable and rolls back on failure",async t=>{
  const root=await mkdtemp(join(tmpdir(),"stardust-v7-")),path=join(root,"db.sqlite"),model={async chatContext(){return "ok";}};
  t.after(()=>rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:50}));
  let store=new ConversationService(model,path), a=store.people.observeSpaceMember(observed("old-group","old-user","原名")); store.people.editPerson(a.identity.personId,0,"人工名称",null); store.close();
  const downgrade="DROP TRIGGER global_context_scope_default; DROP TRIGGER global_context_source_removed; DROP TABLE global_context_message_sources; DROP TABLE global_context_revisions; DROP TABLE global_context_scope; DROP TRIGGER message_provenance_default; DROP TABLE message_provenance; DROP TRIGGER people_merge_guard; DROP TRIGGER identity_merged_insert; DROP TRIGGER identity_merged_update; DROP INDEX people_merged_into; ALTER TABLE people DROP COLUMN merge_audit_id; ALTER TABLE people DROP COLUMN merged_at; ALTER TABLE people DROP COLUMN merged_into_id; PRAGMA user_version=7;";
  let db=new DatabaseSync(path); db.exec(downgrade+"CREATE INDEX people_merged_into ON people(id)"); assert.throws(()=>migratePeopleMerge(db),/already exists/); assert.equal(db.prepare("PRAGMA user_version").get().user_version,7); assert.equal(db.prepare("PRAGMA table_info(people)").all().some(x=>x.name==="merged_into_id"),false); db.exec("DROP INDEX people_merged_into"); db.close();
  store=new ConversationService(model,path); assert.equal(store.people.getIdentity(a.identity.id).personId,a.identity.personId); assert.equal(store.people.getPerson(a.identity.personId).manualName,"人工名称"); assert.equal(store.people.listSpaceMembers(a.space.id).length,1); assert.equal(store.people.managementAudit(a.identity.personId,10,0).length,1); store.close();
  db=new DatabaseSync(path); assert.equal(db.prepare("PRAGMA user_version").get().user_version,11); migratePeopleMerge(db); assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(),[]); db.close();
});
