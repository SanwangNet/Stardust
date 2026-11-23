import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import { ConversationService } from "../apps/server/dist/conversation.js";
import { ExtensionManager } from "../apps/server/dist/extension-manager.js";
import { createStardustServer } from "../apps/server/dist/app.js";
import { LogService } from "../apps/server/dist/logger.js";
import { migratePeopleManagement } from "../apps/server/dist/people.js";

const admin = "a".repeat(43), when = "2026-01-01T00:00:00.000Z";
const removeV8 = "DROP TRIGGER people_merge_guard; DROP TRIGGER identity_merged_insert; DROP TRIGGER identity_merged_update; DROP INDEX people_merged_into; ALTER TABLE people DROP COLUMN merge_audit_id; ALTER TABLE people DROP COLUMN merged_at; ALTER TABLE people DROP COLUMN merged_into_id; ";
const observation = (group, sender, name, date = when) => ({ space: { providerId:"qq",accountId:"mock-application",spaceType:"group",externalId:group,observedAt:date,source:"message_sender" }, identity: { identityType:"qq_group_member",scopeKind:"space",externalId:sender,displayName:name,observedAt:date,source:"message_sender" }, membership: { displayName:name,observedAt:date,source:"message_sender" } });
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(),"stardust-people-edit-")), path = join(root,"test.sqlite"), model = { async chatContext() { return "mock"; } };
  const store = new ConversationService(model,path), manager = new ExtensionManager(root,model,[],new LogService(20,() => {}));
  const server = createStardustServer({modelService:model,extensionManager:manager,conversationService:store,qqApprovalToken:admin,setupService:{getInitializationState:()=>({initialized:true})}});
  server.listen(0,"127.0.0.1"); await once(server,"listening");
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await manager.shutdown(); await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:50}); });
  const origin = `http://127.0.0.1:${server.address().port}`, control = (await (await fetch(`${origin}/api/v1/control-session`)).json()).token;
  const request = (url, method = "GET", body, headers = {}) => fetch(origin + url,{method,headers:{"x-stardust-control-token":control,...(method === "GET" ? {} : {origin,"content-type":"application/json"}),...headers},...(body === undefined ? {} : {body:JSON.stringify(body)})});
  const get = async url => { const response = await request(url); assert.equal(response.status,200); return response.json(); };
  return { root,path,store,server,origin,control,request,get };
}

test("manual profile is versioned, audited, isolated from observations and can fall back to the latest observed name", async t => {
  const f = await fixture(t), input = observation("mock-group-1","mock-member-1","原昵称"), first = f.store.people.observeSpaceMember(input), path = `/api/v1/people/${first.identity.personId}`;
  const original = (await f.get(path)).person; assert.equal(original.manualName,null); assert.equal(original.version,0);
  assert.equal((await f.request(path,"GET",undefined,{"x-stardust-control-token":""})).status,403);
  assert.equal((await f.request(path,"PATCH",{manualName:"张三",note:"备注",version:0},{"x-stardust-control-token":"wrong"})).status,403);
  assert.equal((await f.request(path,"PATCH",{manualName:"张三",note:"备注",version:0},{origin:"https://evil.example"})).status,403);
  assert.equal((await f.request(path,"PATCH",{manualName:"张三",note:"备注",version:0},{"x-forwarded-for":"203.0.113.1"})).status,403);
  assert.equal((await f.request(path,"PATCH",{manualName:"张三",note:"备注",version:0,actor:"fake"})).status,400);
  assert.equal((await f.request(path,"PATCH",{manualName:"张三",note:"备注",version:0})).status,200);
  assert.equal((await f.request(path,"PATCH",{manualName:"旧覆盖",note:null,version:0})).status,409);
  f.store.people.observeSpaceMember(observation("mock-group-1","mock-member-1","新昵称","2026-01-02T00:00:00.000Z"));
  const changed = (await f.get(path)).person; assert.equal(changed.displayName,"张三"); assert.equal(changed.observedName,"新昵称"); assert.equal(changed.note,"备注");
  assert.equal((await f.request(path,"PATCH",{manualName:null,note:"",version:changed.version})).status,200);
  const cleared = (await f.get(path)).person; assert.equal(cleared.displayName,"新昵称"); assert.equal(cleared.note,null);
  assert.equal((await f.request(path,"PATCH",{manualName:"中".repeat(200),note:null,version:cleared.version})).status,400);
  const audit = (await f.get(`${path}/audit`)).items; assert.deepEqual(new Set(audit.map(item => item.operation)),new Set(["name_set","name_clear","note_set"]));
  assert.ok(audit.every(item => item.actor === "local-administrator" && item.result === "success")); assert.doesNotMatch(JSON.stringify(audit),/mock-member-1|mock-group-1|mock-application/);
});

test("identity moves, detaches and undo preserve memberships and reject stale or repeated operations", async t => {
  const f = await fixture(t), a = f.store.people.observeSpaceMember(observation("mock-group-a","mock-person-a","同名")), b = f.store.people.observeSpaceMember(observation("mock-group-b","mock-person-b","同名"));
  const move = `/api/v1/identities/${b.identity.id}/reassign`, originalMembership = f.store.people.listSpaceMembers(b.space.id)[0];
  const body = {targetPersonId:a.identity.personId,version:0,reason:"人工核对确认"};
  const competing = await Promise.all([f.request(move,"POST",body),f.request(move,"POST",body)]); assert.deepEqual(competing.map(r=>r.status).sort(),[200,409]);
  const success = await competing.find(r=>r.status===200).json(), auditId = success.result.auditId;
  assert.equal(f.store.people.getIdentity(b.identity.id).personId,a.identity.personId); assert.ok(f.store.people.getPerson(b.identity.personId));
  assert.deepEqual(f.store.people.listSpaceMembers(b.space.id)[0],originalMembership); assert.equal(f.store.people.getIdentity(a.identity.id).personId,a.identity.personId);
  f.store.people.observeSpaceMember(observation("mock-group-b","mock-person-b","群昵称变化","2026-02-01T00:00:00.000Z"));
  assert.equal(f.store.people.getIdentity(b.identity.id).personId,a.identity.personId);
  assert.equal((await f.request(`/api/v1/people/audit/${auditId}/undo`,"POST",{reason:"纠正关联"})).status,200);
  assert.equal(f.store.people.getIdentity(b.identity.id).personId,b.identity.personId);
  assert.equal((await f.request(`/api/v1/people/audit/${auditId}/undo`,"POST",{reason:"重复撤销"})).status,409);
  assert.equal((await f.request(move,"POST",{...body,version:2})).status,200);
  const detached = await f.request(`/api/v1/identities/${b.identity.id}/detach`,"POST",{version:3,reason:"确认并非同一人"}); assert.equal(detached.status,200);
  const data = (await detached.json()).result; assert.notEqual(data.personId,a.identity.personId); assert.equal(f.store.people.getPerson(data.personId).status,"provisional");
  assert.equal(f.store.people.listSpaceMembers(b.space.id).length,1); assert.ok(f.store.people.getPerson(a.identity.personId));
  assert.equal((await f.request(`/api/v1/identities/${b.identity.id}/detach`,"POST",{version:4,reason:"再次解除"})).status,409);
  assert.equal((await f.request(`/api/v1/people/audit/${data.auditId}/undo`,"POST",{reason:"撤销解除"})).status,200);
  assert.ok(f.store.people.getPerson(data.personId)); assert.equal(f.store.people.getIdentity(b.identity.id).personId,a.identity.personId);
  const history = (await f.get(`/api/v1/people/${a.identity.personId}/audit`)).items; assert.ok(history.some(item=>item.operation==="identity_undo")); assert.doesNotMatch(JSON.stringify(history),/mock-person-b|mock-group-b|mock-application/);
});

test("audit failure rolls back profile and identity changes; audit rows are immutable", async t => {
  const f = await fixture(t), a = f.store.people.observeSpaceMember(observation("group-one","person-one","甲")), b = f.store.people.observeSpaceMember(observation("group-two","person-two","乙"));
  const db = new DatabaseSync(f.path); db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON people_audit BEGIN SELECT RAISE(ABORT,'test_failure'); END");
  try {
    assert.equal((await f.request(`/api/v1/people/${a.identity.personId}`,"PATCH",{manualName:"新名",note:null,version:0})).status,503);
    assert.equal((await f.request(`/api/v1/identities/${b.identity.id}/reassign`,"POST",{targetPersonId:a.identity.personId,version:0,reason:"人工确认"})).status,503);
    assert.equal(f.store.people.getPerson(a.identity.personId).manualName,null); assert.equal(f.store.people.getIdentity(b.identity.id).personId,b.identity.personId);
  } finally { db.exec("DROP TRIGGER fail_audit"); }
  assert.equal((await f.request(`/api/v1/people/${a.identity.personId}`,"PATCH",{manualName:"新名",note:null,version:0})).status,200);
  assert.throws(() => db.exec("UPDATE people_audit SET actor='fake'"),/AUDIT_IMMUTABLE/); assert.throws(() => db.exec("DELETE FROM people_audit"),/AUDIT_IMMUTABLE/); db.close();
});

test("an old audit cannot undo a later move even if the identity returns to the same person", async t => {
  const f = await fixture(t), a = f.store.people.observeSpaceMember(observation("scope-a","member-a","甲")), b = f.store.people.observeSpaceMember(observation("scope-b","member-b","乙"));
  const path = `/api/v1/identities/${b.identity.id}/reassign`;
  const first = (await (await f.request(path,"POST",{targetPersonId:a.identity.personId,version:0,reason:"第一次确认"})).json()).result;
  assert.equal((await f.request(path,"POST",{targetPersonId:b.identity.personId,version:1,reason:"重新判断"})).status,200);
  assert.equal((await f.request(path,"POST",{targetPersonId:a.identity.personId,version:2,reason:"再次确认"})).status,200);
  assert.equal((await f.request(`/api/v1/people/audit/${first.auditId}/undo`,"POST",{reason:"尝试撤销"})).status,409);
  assert.equal(f.store.people.getIdentity(b.identity.id).personId,a.identity.personId);
  const audit = (await f.get(`/api/v1/people/${a.identity.personId}/audit`)).items.find(item=>item.id===first.auditId); assert.equal(audit.canUndo,false);
});

test("concurrent edits reject stale versions and do not accept platform identifiers in audit reasons", async t => {
  const f = await fixture(t), a = f.store.people.observeSpaceMember(observation("mock-group-one","mock-sensitive-person","甲")), b = f.store.people.observeSpaceMember(observation("mock-group-two","mock-other-person","乙"));
  const profile = `/api/v1/people/${a.identity.personId}`;
  const attempts = await Promise.all([f.request(profile,"PATCH",{manualName:"名称一",note:null,version:0}),f.request(profile,"PATCH",{manualName:"名称二",note:null,version:0})]);
  assert.deepEqual(attempts.map(r=>r.status).sort(),[200,409]);
  assert.equal((await f.request(`/api/v1/identities/${b.identity.id}/reassign`,"POST",{targetPersonId:a.identity.personId,version:0,reason:"mock-other-person"})).status,400);
  assert.equal((await f.request(profile,"PATCH",{manualName:"新名称",note:"mock-sensitive-person",version:1})).status,400);
  assert.equal(f.store.people.getIdentity(b.identity.id).personId,b.identity.personId);
});

test("a concurrent QQ observation cannot undo a manual identity move", async t => {
  const f = await fixture(t), a = f.store.people.observeSpaceMember(observation("scope-one","member-one","甲")), b = f.store.people.observeSpaceMember(observation("scope-two","member-two","乙"));
  const input = { providerId:"qq",accountId:"mock-application",identityType:"qq_group_member",scope:{kind:"space",spaceId:b.space.id},externalId:"member-two",displayName:"新观察",observedAt:"2026-02-01T00:00:00.000Z",source:"message_sender" };
  const observing = new Promise((resolve,reject) => { const worker = new Worker(new URL("./fixtures/people-observer-worker.mjs",import.meta.url),{workerData:{path:f.path,input}}); worker.once("message",value=>value.error ? reject(new Error(value.error)) : resolve(value)); worker.once("error",reject); });
  const [moved, observed] = await Promise.all([f.request(`/api/v1/identities/${b.identity.id}/reassign`,"POST",{targetPersonId:a.identity.personId,version:0,reason:"人工核对"}), observing]);
  assert.equal(moved.status,200); assert.equal(observed.identityId,b.identity.id);
  assert.equal(f.store.people.getIdentity(b.identity.id).personId,a.identity.personId);
  assert.equal(f.store.people.getIdentity(b.identity.id).displayName,"新观察"); assert.equal(f.store.people.listSpaceMembers(b.space.id).length,1);
});

test("version 6 upgrade preserves old records and is repeatable", async t => {
  const root = await mkdtemp(join(tmpdir(),"stardust-people-v6-")), path = join(root,"test.sqlite"), model = {async chatContext(){return "ok";}};
  t.after(() => rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:50}));
  let store = new ConversationService(model,path); const before = store.people.observeSpaceMember(observation("legacy-group","legacy-member","旧昵称")), manuallyNamed = store.people.createPerson({displayName:"原有人名"}); store.close();
  let db = new DatabaseSync(path); db.exec("DROP TRIGGER message_provenance_default; DROP TABLE message_provenance;" + removeV8 + "DROP TABLE people_audit; ALTER TABLE identities DROP COLUMN link_version; ALTER TABLE people DROP COLUMN version; ALTER TABLE people DROP COLUMN note; ALTER TABLE people DROP COLUMN manual_name; PRAGMA user_version=6;"); db.close();
  store = new ConversationService(model,path); assert.equal(store.people.getIdentity(before.identity.id).personId,before.identity.personId); assert.equal(store.people.listSpaceMembers(before.space.id).length,1); assert.equal(store.people.getPerson(manuallyNamed.id).manualName,"原有人名"); store.close();
  db = new DatabaseSync(path); assert.equal(db.prepare("PRAGMA user_version").get().user_version,9); migratePeopleManagement(db); assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(),[]); db.close();
});

test("failed version 7 migration rolls back every schema change", async t => {
  const root = await mkdtemp(join(tmpdir(),"stardust-people-v6-fail-")), path = join(root,"test.sqlite"), model = {async chatContext(){return "ok";}};
  t.after(() => rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:50}));
  const store = new ConversationService(model,path), person = store.people.observeIdentity({providerId:"qq",accountId:"app",identityType:"user",scope:{kind:"account"},externalId:"legacy-secret",observedAt:when,source:"message_sender"}); store.close();
  const db = new DatabaseSync(path); db.exec("DROP TRIGGER message_provenance_default; DROP TABLE message_provenance;" + removeV8 + "DROP TABLE people_audit; ALTER TABLE identities DROP COLUMN link_version; ALTER TABLE people DROP COLUMN version; ALTER TABLE people DROP COLUMN note; ALTER TABLE people DROP COLUMN manual_name; CREATE TABLE people_audit(existing TEXT); PRAGMA user_version=6;");
  assert.throws(() => migratePeopleManagement(db),/already exists/);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version,6);
  assert.equal(db.prepare("SELECT person_id FROM identities WHERE id=?").get(person.id).person_id,person.personId);
  assert.equal(db.prepare("PRAGMA table_info(people)").all().some(row=>row.name==="manual_name"),false); db.close();
});
