import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createStardustServer } from "../apps/server/dist/app.js";
import { ConversationService } from "../apps/server/dist/conversation.js";
import { ExtensionManager } from "../apps/server/dist/extension-manager.js";
import { createQQBotExtension } from "../apps/server/dist/extensions/qq-bot.js";
import { LogService } from "../apps/server/dist/logger.js";
import { qqKeys } from "../apps/server/dist/history-provenance.js";
import { PeopleObserver } from "../apps/server/dist/people-observer.js";

const until = async fn => { for (let i = 0; i < 500; i++) { const value = await fn(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error("timed out"); };
const message = (kind, id, sender, target, extra = {}) => ({ kind, rawEventType: kind === "c2c" ? "C2C_MESSAGE_CREATE" : "GROUP_AT_MESSAGE_CREATE", senderId: sender, messageId: id, timestamp: new Date().toISOString(), content: `private text ${id}`, ...(kind === "group" ? { groupOpenid: target } : {}), replyTarget: { scope: kind, targetId: target, msgId: id }, ...extra });

async function fixture(t, options = {}) {
  const root = options.root ?? await mkdtemp(join(tmpdir(), "stardust-qq-people-"));
  const database = options.database ?? join(root, "people-test.sqlite"), handlers = new Map(), sent = [], logs = new LogService(300, () => {});
  let finish, failModel = false;
  const bot = { on(name, fn) { handlers.set(name, fn); }, start() { handlers.get("ready")(); return new Promise(resolve => { finish = resolve; }); }, stop() { finish?.(); }, async sendText(target, content) { sent.push({ target, content }); return { id: `mock-reply-${sent.length}` }; }, emit(event) { return handlers.get("message")({}, event); } };
  const model = { calls: [], async chatContext(messages) { this.calls.push(structuredClone(messages)); if (failModel) throw new Error("mock failure"); return "模拟回复"; } };
  const store = new ConversationService(model, database);
  const manager = new ExtensionManager(root, model, [createQQBotExtension(async () => bot)], logs);
  const server = createStardustServer({ setupService: { getInitializationState: () => ({ initialized: true }) }, extensionManager: manager, modelService: model, conversationService: store, logService: logs });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { if (server.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } await manager.shutdown(); if (!options.root) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  await manager.install("qq-bot"); await manager.saveConfig("qq-bot", { appId: options.appId ?? "123", appSecret: "mock-secret" }); await manager.enable("qq-bot");
  await until(() => handlers.has("message") && manager.list()[0].state === "connected");
  const identity = (type, externalId, scope = { kind: "account" }) => store.people.findIdentity({ providerId: "qq", accountId: options.appId ?? "123", identityType: type, scope, externalId });
  return { root, database, bot, handlers, store, manager, logs, model, sent, identity, setFail(value) { failModel = value; } };
}

test("real QQ ingress observes private and group senders in isolated scopes, skips mentions and keeps original replies", async t => {
  const f = await fixture(t), groupTime = new Date(Date.now() - 20_000).toISOString(), older = new Date(Date.now() - 30_000).toISOString();
  const privateEvent = message("c2c", "private-one", "same-mock-id", "private-target");
  await f.bot.emit(privateEvent);
  const c2c = await until(() => f.identity("qq_c2c_user", "same-mock-id"));
  assert.equal(f.store.people.getPerson(c2c.personId).status, "provisional"); assert.equal(c2c.displayName, null); assert.equal(c2c.observationSource, "message_sender");
  await f.bot.emit(privateEvent); assert.equal(f.model.calls.length, 1);
  const group = message("group", "group-new", "same-mock-id", "mock-group-a", { timestamp: groupTime, senderName: "新昵称", raw: { group_name: "不可采信群名", author: { member_role: "admin" } }, mentions: [{ member_openid: "mentioned-secret", nickname: "同名" }] });
  await f.bot.emit(group);
  const space = await until(() => f.store.people.listSpaces().find(item => item.externalId === "mock-group-a"));
  const membership = await until(() => f.store.people.listSpaceMembers(space.id)[0]);
  const member = f.store.people.getIdentity(membership.identityId);
  assert.equal(space.displayName, null); assert.equal(member.scopeKind, "space"); assert.equal(member.scopeSpaceId, space.id);
  assert.equal(member.identityType, "qq_group_member"); assert.notEqual(member.personId, c2c.personId);
  assert.equal(membership.displayName, "新昵称"); assert.equal(membership.role, null); assert.equal(membership.observationSource, "message_sender");
  assert.equal(f.store.people.listPersons().length, 2); assert.equal(f.store.people.listSpaceMembers(space.id).length, 1);
  await f.bot.emit(message("group", "group-old", "same-mock-id", "mock-group-a", { timestamp: older, senderName: "旧昵称" }));
  await until(() => f.store.people.listSpaceMembers(space.id)[0].firstSeenAt === older);
  const updated = f.store.people.listSpaceMembers(space.id)[0]; assert.equal(updated.displayName, "新昵称"); assert.equal(updated.lastSeenAt, groupTime);
  await f.bot.emit(message("group", "other-group", "same-mock-id", "mock-group-b", { senderName: "新昵称" }));
  const otherSpace = await until(() => f.store.people.listSpaces().find(item => item.externalId === "mock-group-b"));
  const otherMembership = await until(() => f.store.people.listSpaceMembers(otherSpace.id)[0]);
  assert.notEqual(f.store.people.getIdentity(otherMembership.identityId).personId, member.personId);
  await f.bot.emit(message("group", "different-member", "other-mock-id", "mock-group-a", { senderName: "新昵称" }));
  await until(() => f.store.people.listSpaceMembers(space.id).length === 2);
  assert.equal(f.store.people.listPersons().length, 4);
  assert.equal(f.sent.length, 5); assert.ok(f.model.calls.every(call => !JSON.stringify(call).includes("mentioned-secret")));
  assert.doesNotMatch(JSON.stringify(f.logs.read()), /same-mock-id|other-mock-id|mock-group-a|private text|mock-secret/);
});

test("ordinary observed group events do not reply, while invalid events and untrusted mentions create no extra identities", async t => {
  const old = process.env.STARDUST_QQ_INPUT_FLOW; process.env.STARDUST_QQ_INPUT_FLOW = "1";
  t.after(() => { if (old === undefined) delete process.env.STARDUST_QQ_INPUT_FLOW; else process.env.STARDUST_QQ_INPUT_FLOW = old; });
  const f = await fixture(t);
  await f.bot.emit(message("group", "not-mentioned", "sender", "group", { rawEventType: "GROUP_MESSAGE_CREATE" }));
  await f.bot.emit(message("c2c", "bot", "bot", "target", { senderIsBot: true }));
  await f.bot.emit(message("group", "bad-target", "sender", "group", { replyTarget: { scope: "group", targetId: "other", msgId: "bad-target" } }));
  await until(() => f.store.people.listPersons().length === 1); assert.equal(f.model.calls.length, 0); assert.equal(f.sent.length,0);
  await f.bot.emit(message("group", "allowed", "sender", "group", { mentions: [{ nickname: "只有名字" }, { member_openid: "untrusted-mention", username: "名字" }] }));
  const space = await until(() => f.store.people.listSpaces()[0]); await until(() => f.store.people.listSpaceMembers(space.id).length === 1);
  assert.equal(f.store.people.listPersons().length, 1); assert.equal(f.model.calls.length, 1);
});

test("QQ applications sharing a database keep identical private and group identifiers separate", async t => {
  const sharedRoot = await mkdtemp(join(tmpdir(), "stardust-qq-shared-"));
  const database = join(sharedRoot, "people.sqlite");
  const first = await fixture(t, { database, appId: "123" });
  await first.bot.emit(message("c2c", "a", "same-id", "target-a"));
  const a = await until(() => first.identity("qq_c2c_user", "same-id"));
  const second = await fixture(t, { database, appId: "456" });
  t.after(() => rm(sharedRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  await second.bot.emit(message("c2c", "b", "same-id", "target-b"));
  const b = await until(() => second.identity("qq_c2c_user", "same-id"));
  assert.notEqual(a.personId, b.personId); assert.notEqual(a.accountId, b.accountId);
  await first.bot.emit(message("group", "group-a", "same-id", "same-group"));
  await second.bot.emit(message("group", "group-b", "same-id", "same-group"));
  const spaces = await until(() => { const list = first.store.people.listSpaces(); return list.length === 2 && list; });
  assert.notEqual(spaces[0].id, spaces[1].id); assert.deepEqual(spaces.map(item => item.accountId).sort(), ["123", "456"]);
});

test("a busy observation database fails independently of model replies and a later event can succeed", async t => {
  const f = await fixture(t), locked = new DatabaseSync(f.database); locked.exec("PRAGMA busy_timeout=100; BEGIN IMMEDIATE");
  try {
    const started = Date.now(); await f.bot.emit(message("c2c", "locked", "locked-sender", "target"));
    assert.ok(Date.now() - started < 1000); assert.equal(f.sent.length, 1);
    await until(() => f.logs.read().entries.some(entry => entry.details?.code === "OBSERVATION_FAILED"));
    assert.equal(f.store.people.listPersons().length, 0);
  } finally { locked.exec("ROLLBACK"); locked.close(); }
  await f.bot.emit(message("c2c", "after-lock", "later-sender", "target"));
  await until(() => f.identity("qq_c2c_user", "later-sender")); assert.equal(f.sent.length, 2);
});

test("model failure does not undo an accepted observation; stopping revokes in-flight writes", async t => {
  const f = await fixture(t); f.setFail(true);
  await f.bot.emit(message("c2c", "model-failed", "known-sender", "target"));
  await until(() => f.identity("qq_c2c_user", "known-sender")); assert.equal(f.sent.length, 0);
  f.setFail(false);
  const locked = new DatabaseSync(f.database); locked.exec("PRAGMA busy_timeout=100; BEGIN IMMEDIATE");
  try {
    await f.bot.emit(message("c2c", "stop-pending", "stopped-sender", "target"));
    await f.manager.disable("qq-bot");
  } finally { locked.exec("ROLLBACK"); locked.close(); }
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(f.identity("qq_c2c_user", "stopped-sender"), null);
  assert.ok(f.identity("qq_c2c_user", "known-sender"));
});

test("bounded observer drops revoked pending work, closes safely and never waits on path initialization", async t => {
  const f = await fixture(t); let resolvePath;
  const fakeLogs = new LogService(30, () => {}), observer = new PeopleObserver(() => new Promise(resolve => { resolvePath = resolve; }), fakeLogs, 2);
  const first = new AbortController(), second = new AbortController();
  const observation = { kind: "identity", value: { providerId: "qq", accountId: "123", identityType: "qq_c2c_user", scope: { kind: "account" }, externalId: "must-not-write", observedAt: new Date().toISOString(), source: "message_sender" } };
  observer.submit(observation, first.signal); observer.submit(observation, second.signal); observer.submit(observation, new AbortController().signal);
  assert.ok(fakeLogs.read().entries.some(entry => entry.details?.code === "OBSERVATION_QUEUE_FULL"));
  first.abort(); second.abort(); observer.shutdown(); resolvePath(f.database);
  await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(f.identity("qq_c2c_user", "must-not-write"), null);
});


test("accepted QQ messages deliver only current scoped identity to the real orchestrator", async t => {
  const f = await fixture(t);
  const meta = { observedAt: new Date(Date.now() - 5000).toISOString(), source: "message_sender" };
  const add = (group, name) => f.store.people.observeSpaceMember({ space: { providerId: "qq", accountId: "123", spaceType: "group", externalId: group, ...meta }, identity: { identityType: "qq_group_member", scopeKind: "space", externalId: "openid-secret", displayName: name, ...meta }, membership: { displayName: name, ...meta } });
  const first = add("group-a", "群甲名称"), second = add("group-b", "群乙秘密");
  f.store.people.reassignIdentity(second.identity.id, first.identity.personId, 0, "人工确认");
  await f.bot.emit(message("group", "ctx-a", "openid-secret", "group-a"));
  await until(() => f.model.calls.length === 1);
  const promptA = JSON.stringify(f.model.calls[0]);
  assert.match(promptA, /群甲名称/);
  for (const secret of ["群乙秘密", "openid-secret", first.identity.personId, "group-a"]) assert.ok(!promptA.includes(secret));
  await f.bot.emit(message("group", "ctx-b", "openid-secret", "group-b"));
  await until(() => f.model.calls.length === 2);
  const promptB = JSON.stringify(f.model.calls[1]);
  assert.match(promptB, /群乙秘密/); assert.ok(!promptB.includes("群甲名称"));
});


test("accepted QQ event persists scoped user and agent provenance without entering Web search", async t => {
  const f = await fixture(t), event = message("group", "persist-event", "persist-user", "persist-group", { senderName: "当前群名字" });
  await f.bot.emit(event); await until(() => f.sent.length === 1);
  const input = { channelId:"qq-bot", identityAccountId:"123", senderId:"persist-user", messageId:"persist-event", conversationId:"persist-group", conversationType:"group", content:event.content, timestamp:event.timestamp };
  const id=qqKeys(input).conversationId, rows=f.store.historyProvenance(id,id);
  assert.equal(rows.length,2); assert.deepEqual(rows.map(row=>row.authorKind),["platform_user","agent"]);
  assert.equal(rows[0].identityState,"known"); assert.equal(rows[0].spaceState,"known"); assert.equal(rows[1].identityState,"not_applicable");
  assert.equal(f.store.searchHistory({keywords:["private text persist-event"]}).length,0);
  assert.ok(!JSON.stringify(f.model.calls).includes("persist-user"));
});
