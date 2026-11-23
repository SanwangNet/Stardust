import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import { ConversationService } from "../apps/server/dist/conversation.js";
import { migratePeople } from "../apps/server/dist/people.js";

const model = { chatContext: async () => "测试回复" };
const time = (year, month = "01") => `${year}-${month}-01T00:00:00.000Z`;
const obs = (at = time(2024)) => ({ observedAt: at, source: "platform_event", sourceEventId: "mock-event" });
const space = (externalId, extra = {}) => ({ providerId: "qq", accountId: "mock-app-a", spaceType: "group", externalId, ...obs(), ...extra });
const identity = (externalId, extra = {}) => ({ providerId: "qq", accountId: "mock-app-a", identityType: "member", scope: { kind: "account" }, externalId, ...obs(), ...extra });
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "stardust-people-")), path = join(root, "chat.sqlite");
  const stores = [];
  const open = () => { const store = new ConversationService(model, path); stores.push(store); return store; };
  const store = open();
  t.after(() => { for (const item of stores) { try { item.close(); } catch {} } rmSync(root, { recursive: true, force: true }); });
  return { root, path, store, people: store.people, open };
}

test("Person and Identity use explicit links and never merge by a name", t => {
  const { people } = fixture(t);
  const person = people.createPerson({ displayName: "测试人物", status: "confirmed" });
  assert.match(person.id, /^[0-9a-f-]{36}$/); assert.deepEqual(people.getPerson(person.id), person);
  const a = people.observeIdentity(identity("same-external", { displayName: "同名" }));
  const b = people.observeIdentity(identity("same-external", { providerId: "web", displayName: "同名" }));
  const c = people.observeIdentity(identity("same-external", { accountId: "mock-app-b", displayName: "同名" }));
  assert.notEqual(a.personId,b.personId); assert.notEqual(a.personId,c.personId);
  assert.equal(people.getPerson(a.personId).status,"provisional");
  assert.equal(people.getPerson(a.personId).displayNameSource,"platform_event"); assert.equal(people.getPerson(a.personId).displayNameObservedAt,time(2024));
  assert.equal(people.listPersons().length,4);
  const linkedA = people.upsertIdentity(identity("linked-a"), { personId: person.id, method: "manual_confirmation" });
  const linkedB = people.upsertIdentity(identity("linked-b", { providerId: "web", identityType: "user" }), { personId: person.id, method: "platform_verified" });
  assert.deepEqual(people.getPersonIdentities(person.id).map(item => item.id).sort(), [linkedA.id,linkedB.id].sort());
  assert.equal(linkedA.linkMethod, "manual_confirmation"); assert.equal(linkedB.linkMethod, "platform_verified");
  assert.throws(() => people.upsertIdentity(identity("same-external"), { personId: person.id, method: "manual_confirmation" }), /IDENTITY_ALREADY_BOUND/);
  const confirmed = people.upsertIdentity(identity("same-external"), { personId: a.personId, method: "manual_confirmation" });
  assert.equal(confirmed.id, a.id); assert.equal(confirmed.linkMethod, "manual_confirmation");
  assert.throws(() => people.upsertIdentity(identity("untrusted"), { personId: person.id, method: "model_guess" }), /INVALID_INPUT/);
  assert.equal(people.getPerson(a.personId).id,a.personId);
});

test("identity, space and membership observations preserve first/last time and field provenance under reordering", t => {
  const { people } = fixture(t);
  const a = people.upsertSpace(space("group-a", { displayName: "群新版", ...obs(time(2024)) }));
  const b = people.upsertSpace(space("group-a", { displayName: "群旧版", ...obs(time(2020)) }));
  const c = people.upsertSpace(space("group-a", { displayName: null, ...obs(time(2025)) }));
  assert.equal(a.id,b.id); assert.equal(c.id,a.id); assert.equal(c.displayName,"群新版");
  assert.equal(c.firstSeenAt,time(2020)); assert.equal(c.lastSeenAt,time(2025)); assert.equal(c.displayNameObservedAt,time(2024));
  const first = people.observeIdentity(identity("member-a", { displayName: "新名字", ...obs(time(2024)) }));
  const earlier = people.observeIdentity(identity("member-a", { displayName: "旧名字", ...obs(time(2021)) }));
  const later = people.observeIdentity(identity("member-a", { displayName: "", ...obs(time(2025)) }));
  assert.equal(first.id,earlier.id); assert.equal(first.personId,later.personId); assert.equal(later.displayName,"新名字");
  assert.equal(later.firstSeenAt,time(2021)); assert.equal(later.lastSeenAt,time(2025)); assert.equal(later.displayNameObservedAt,time(2024));
  assert.equal(people.findIdentity({ providerId:"qq",accountId:"mock-app-a",identityType:"member",scope:{kind:"account"},externalId:"member-a" }).id, first.id);
  const one = people.observeMembership({ spaceId:a.id,identityId:first.id,displayName:"新群昵称",role:"admin",...obs(time(2024)) });
  assert.equal(people.getIdentity(one.identityId).personId,first.personId);
  const two = people.observeMembership({ spaceId:a.id,identityId:first.id,displayName:"旧群昵称",role:"member",...obs(time(2020)) });
  const three = people.observeMembership({ spaceId:a.id,identityId:first.id,displayName:null,role:null,...obs(time(2025)) });
  assert.equal(one.id,two.id); assert.equal(three.id,one.id); assert.equal(three.displayName,"新群昵称"); assert.equal(three.role,"admin");
  assert.equal(three.firstSeenAt,time(2020)); assert.equal(three.lastSeenAt,time(2025)); assert.equal(three.observedAt,time(2025));
  assert.equal(three.displayNameObservedAt,time(2024)); assert.equal(three.roleObservedAt,time(2024)); assert.equal(three.roleSource,"platform_event");
  assert.equal(people.listSpaceMembers(a.id).length,1);
});

test("replaying the same observations leaves every stored field unchanged", async t => {
  const { people } = fixture(t);
  const s = space("stable", { displayName:"稳定群" }), i = identity("stable", { displayName:"稳定身份" });
  const originalSpace = people.upsertSpace(s), originalIdentity = people.observeIdentity(i);
  const m = { spaceId:originalSpace.id, identityId:originalIdentity.id, displayName:"群昵称", role:"member", ...obs() };
  const originalMembership = people.observeMembership(m);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(people.upsertSpace(s),originalSpace);
  assert.deepEqual(people.observeIdentity(i),originalIdentity);
  assert.deepEqual(people.observeMembership(m),originalMembership);
});

test("account and space scopes, bot namespaces, membership role and names are isolated", t => {
  const { people, store } = fixture(t);
  const a = people.upsertSpace(space("group-a", { displayName:"同名群" }));
  const b = people.upsertSpace(space("group-b", { displayName:"同名群" }));
  const foreign = people.upsertSpace(space("group-a", { providerId:"other",displayName:"同名群" }));
  const otherBot = people.upsertSpace(space("group-a", { accountId:"mock-app-b" }));
  assert.equal(new Set([a.id,b.id,foreign.id,otherBot.id]).size,4);
  const shared = people.observeIdentity(identity("member-1"));
  people.upsertMembership({ spaceId:a.id,identityId:shared.id,displayName:"群甲",role:"owner",...obs() });
  people.upsertMembership({ spaceId:b.id,identityId:shared.id,displayName:"群乙",role:"member",...obs() });
  assert.deepEqual(people.listPersonSpaces(shared.personId).map(item => item.displayName).sort(),["群乙","群甲"].sort());
  assert.deepEqual(people.listIdentitySpaces(shared.id).map(item => item.role).sort(),["member","owner"]);
  assert.ok(!("role" in people.getPerson(shared.personId))); assert.deepEqual(store.agent.settings().disabledTools,[]);
  const scopedA = people.observeIdentity(identity("same-scoped", { scope:{kind:"space",spaceId:a.id} }));
  const scopedB = people.observeIdentity(identity("same-scoped", { scope:{kind:"space",spaceId:b.id} }));
  assert.notEqual(scopedA.personId,scopedB.personId);
  assert.throws(() => people.upsertMembership({ spaceId:b.id,identityId:scopedA.id,...obs() }), /SCOPE_MISMATCH/);
  assert.throws(() => people.upsertMembership({ spaceId:foreign.id,identityId:shared.id,...obs() }), /SCOPE_MISMATCH/);
  assert.throws(() => people.upsertMembership({ spaceId:otherBot.id,identityId:shared.id,...obs() }), /SCOPE_MISMATCH/);
  assert.throws(() => people.observeIdentity(identity("x", { scope:{kind:"space",spaceId:otherBot.id} })), /SCOPE_MISMATCH/);
});

test("atomic composite observations and removal preserve unrelated identities and people", t => {
  const { people } = fixture(t);
  const input = { space:space("new-group"), identity:{identityType:"member",scopeKind:"space",externalId:"new-person",...obs()}, membership:{displayName:"群昵称",role:"admin",...obs()} };
  assert.throws(() => people.observeSpaceMember({ ...input, membership:{...input.membership,role:"x".repeat(129)} }), /INVALID_INPUT/);
  assert.equal(people.listSpaces().length,0); assert.equal(people.listPersons().length,0);
  const one = people.observeSpaceMember(input), two = people.observeSpaceMember(input);
  assert.equal(one.space.id,two.space.id); assert.equal(one.identity.id,two.identity.id); assert.equal(one.membership.id,two.membership.id); assert.equal(people.listPersons().length,1);
  assert.throws(() => people.deleteSpace(one.space.id));
  people.removeMembership(one.membership.id); assert.ok(people.getPerson(one.identity.personId)); assert.equal(people.getPersonIdentities(one.identity.personId).length,1);
  const freeSpace = people.upsertSpace(space("free-group")), freeIdentity = people.observeIdentity(identity("global-user"));
  people.upsertMembership({spaceId:freeSpace.id,identityId:freeIdentity.id,...obs()}); people.deleteSpace(freeSpace.id);
  assert.equal(people.listIdentitySpaces(freeIdentity.id).length,0); assert.ok(people.getPerson(freeIdentity.personId)); assert.equal(people.getPersonIdentities(freeIdentity.personId).length,1);
  assert.throws(() => people.upsertMembership({spaceId:one.space.id,identityId:randomUUID(),...obs()}),/NOT_FOUND/);
});

test("rejects malformed external data and protects database constraints independently", t => {
  const { people, path } = fixture(t);
  for (const input of [identity(""), identity("a\u0000b"), identity("ok", { providerId:"QQ!" }), identity("ok", { accountId:"" }), identity("ok", { observedAt:"2024-02-30T00:00:00Z" }), identity("ok", { scope:{kind:"space",spaceId:"guessed"} }), identity("ok", { secretProfile:"should-not-be-stored" })]) {
    assert.throws(() => people.observeIdentity(input),/INVALID_INPUT/);
  }
  assert.equal(people.listPersons().length,0);
  const a = people.upsertSpace(space("a")), b = people.upsertSpace(space("b")), member = people.observeIdentity(identity("scoped",{scope:{kind:"space",spaceId:a.id}}));
  const db = new DatabaseSync(path); db.exec("PRAGMA foreign_keys=ON");
  try {
    assert.throws(() => db.prepare("INSERT INTO memberships(id,space_id,identity_id,provider_id,account_id,first_seen_at,last_seen_at,observed_at,observation_source,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(randomUUID(),b.id,member.id,"qq","mock-app-a",time(2024),time(2024),time(2024),"platform_event",time(2024),time(2024)),/MEMBERSHIP_SCOPE_MISMATCH/);
    assert.throws(() => db.prepare("INSERT INTO identities(id,person_id,provider_id,account_id,identity_type,scope_kind,external_id,link_method,first_seen_at,last_seen_at,observation_source,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(randomUUID(),randomUUID(),"qq","mock-app-a","member","account","unknown","observed",time(2024),time(2024),"platform_event",time(2024),time(2024)),/FOREIGN KEY/);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(),[]);
    assert.ok(db.prepare("PRAGMA index_list('memberships')").all().some(row => row.name === "memberships_identity"));
  } finally { db.close(); }
});

test("version 5 upgrades without changing existing conversations or global context; reopen and repeated migration are safe", async t => {
  const f = fixture(t), conversation = f.store.create("原始会话");
  await f.store.submit(conversation.id,randomUUID(),"原始消息"); f.store.close();
  let db = new DatabaseSync(f.path); db.exec("PRAGMA foreign_keys=ON; DROP TABLE people_audit; DROP TABLE memberships; DROP TABLE identities; DROP TABLE spaces; DROP TABLE people; PRAGMA user_version=5;");
  db.prepare("INSERT INTO global_context_entries(id,owner,topic,content,created_at,updated_at,version) VALUES(?,?,?,?,?,?,?)").run("legacy-entry","web:default","旧主题","旧内容",time(2020),time(2020),1); db.close();
  const migrated = f.open(); assert.deepEqual(migrated.messages(conversation.id).map(item => item.content),["原始消息","测试回复"]);
  assert.equal(migrated.globalContext.entries("web:default")[0].content,"旧内容");
  const result = migrated.people.observeIdentity(identity("persistent",{displayName:"持久化"})); migrated.close();
  db = new DatabaseSync(f.path); db.exec("PRAGMA foreign_keys=ON"); assert.equal(db.prepare("PRAGMA user_version").get().user_version,8); migratePeople(db); assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(),[]); db.close();
  const reopened = f.open(); assert.equal(reopened.people.getPerson(result.personId).displayName,"持久化"); assert.equal(reopened.people.getPersonIdentities(result.personId)[0].id,result.id);
});

test("failed migration rolls back and newer versions are rejected without clearing data", t => {
  const f = fixture(t); f.store.close();
  let db = new DatabaseSync(f.path); db.exec("PRAGMA foreign_keys=ON; DROP TABLE people_audit; DROP TABLE memberships; DROP TABLE identities; DROP TABLE spaces; DROP TABLE people; CREATE TABLE identities(existing TEXT); INSERT INTO identities VALUES('preserve'); PRAGMA user_version=5;"); db.close();
  assert.throws(() => f.open(),/already exists/);
  db = new DatabaseSync(f.path); assert.equal(db.prepare("PRAGMA user_version").get().user_version,5); assert.equal(db.prepare("SELECT existing FROM identities").get().existing,"preserve"); assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='people'").get().n,0);
  db.exec("PRAGMA user_version=9"); db.close();
  assert.throws(() => f.open(),/UNSUPPORTED_SCHEMA/);
  db = new DatabaseSync(f.path); assert.equal(db.prepare("SELECT existing FROM identities").get().existing,"preserve"); db.close();
});

test("concurrent independent connections resolve one external identity to one Person", async t => {
  const f = fixture(t); f.store.close();
  const input = identity("simultaneous",{displayName:"同一身份"});
  const results = await Promise.all(Array.from({length:8}, () => new Promise((resolve,reject) => {
    const worker = new Worker(new URL("./fixtures/people-observer-worker.mjs",import.meta.url), {workerData:{path:f.path,input}});
    worker.once("message",value => value.error ? reject(new Error(value.error)) : resolve(value)); worker.once("error",reject);
  })));
  assert.equal(new Set(results.map(item => item.personId)).size,1); assert.equal(new Set(results.map(item => item.identityId)).size,1);
  const reopened = f.open(); assert.equal(reopened.people.listPersons().length,1);
});
