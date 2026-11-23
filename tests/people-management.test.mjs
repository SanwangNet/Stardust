import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { ConversationService } from "../apps/server/dist/conversation.js";
import { createStardustServer } from "../apps/server/dist/app.js";
import { ExtensionManager } from "../apps/server/dist/extension-manager.js";
import { webChatExtension } from "../apps/server/dist/extensions/web-chat.js";
import { LogService } from "../apps/server/dist/logger.js";

const token = "a".repeat(43), at = "2026-01-01T00:00:00.000Z";
async function fixture(t, configured = true, onDisk = false) {
  const root = await mkdtemp(join(tmpdir(), "stardust-people-management-"));
  const database = onDisk ? join(root, "test.sqlite") : ":memory:";
  const model = { async chatContext() { return "ok"; } }, store = new ConversationService(model, database);
  const manager = new ExtensionManager(root, model, [webChatExtension], new LogService(20, () => {}));
  const server = createStardustServer({ modelService: model, extensionManager: manager, conversationService: store, setupService: { getInitializationState: () => ({ initialized: true }) }, qqApprovalToken: configured ? token : "" });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await manager.shutdown(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const control = (await (await fetch(base + "/api/v1/control-session")).json()).token;
  const get = (path, options = {}) => fetch(base + path, { headers: options.noAuth ? {} : { "x-stardust-control-token": control, ...(options.headers ?? {}) } });
  return { store, get, database };
}
function member(store, group, sender, name, time = at, app = "private-app-id") {
  const meta = { observedAt: time, source: "message_sender" };
  return store.people.observeSpaceMember({ space: { providerId: "qq", accountId: app, spaceType: "group", externalId: group, ...meta }, identity: { identityType: "qq_group_member", scopeKind: "space", externalId: sender, displayName: name, ...meta }, membership: { displayName: name, ...meta } });
}
test("management endpoints use the local control session without a separate administrator credential", async t => {
  const f = await fixture(t, false);
  for (const path of ["/api/v1/people", "/api/v1/spaces", `/api/v1/people/${crypto.randomUUID()}`, `/api/v1/spaces/${crypto.randomUUID()}/members`]) {
    assert.notEqual((await f.get(path)).status, 403); assert.equal((await f.get(path, { noAuth: true })).status, 403);
  }
  const authorized = await fixture(t);
  assert.equal((await authorized.get("/people-ui.js", { noAuth: true })).status, 200);
  assert.equal((await authorized.get("/api/v1/people", { noAuth: true })).status, 403);
  assert.equal((await authorized.get("/api/v1/spaces", { headers: { origin: "http://evil.example" } })).status, 403);
  assert.equal((await authorized.get("/api/v1/people")).status, 200);
});
test("file-backed reads use WAL while a separate writer holds a transaction", async t => {
  const f = await fixture(t, true, true); member(f.store, "mock-group", "mock-user", "名字");
  const writer = new DatabaseSync(f.database); writer.exec("BEGIN IMMEDIATE");
  try {
    const responses = await Promise.all([f.get("/api/v1/people"), f.get("/api/v1/spaces")]);
    assert.deepEqual(responses.map(response => response.status), [200, 200]);
    assert.equal((await responses[0].json()).items.length, 1);
    assert.equal((await responses[1].json()).items.length, 1);
  } finally { writer.exec("ROLLBACK"); writer.close(); }
});
test("safe paginated projections preserve distinct identities and observed memberships", async t => {
  const f = await fixture(t), first = member(f.store, "secret-group", "secret-user", "同名"), other = member(f.store, "secret-group", "secret-other", "同名"), second = member(f.store, "other-group", "secret-user", "同名", "2026-01-02T00:00:00.000Z");
  const linked = f.store.people.upsertIdentity({ providerId: "web", accountId: "secret-web-app", identityType: "account", scope: { kind: "account" }, externalId: "secret-web-id", displayName: "另一个名称", observedAt: at, source: "manual" }, { personId: first.identity.personId, method: "manual_confirmation" });
  const qqLinked = f.store.people.upsertIdentity({ providerId: "qq", accountId: "private-app-id", identityType: "account", scope: { kind: "account" }, externalId: "secret-qq-id", observedAt: at, source: "manual" }, { personId: first.identity.personId, method: "manual_confirmation" });
  f.store.people.observeMembership({ spaceId: second.space.id, identityId: qqLinked.id, displayName: "另一个群内昵称", role: "member", observedAt: "2026-01-03T00:00:00.000Z", source: "manual" });
  assert.notEqual(first.identity.personId, other.identity.personId); assert.notEqual(first.identity.personId, second.identity.personId); assert.equal(linked.personId, first.identity.personId);
  for (let n = 0; n < 23; n++) f.store.people.createPerson({ displayName: `人员${n}` });
  const page = async path => (await (await f.get(path)).json());
  const p1 = await page("/api/v1/people?limit=10"), p2 = await page("/api/v1/people?limit=10&offset=10"), p3 = await page("/api/v1/people?limit=10&offset=20");
  assert.equal(new Set([...p1.items,...p2.items,...p3.items].map(x => x.id)).size, 26);
  assert.equal(p1.items[0].id, first.identity.personId); assert.equal(p1.items[0].lastSeenAt, "2026-01-03T00:00:00.000Z"); assert.equal(p1.hasMore, true); assert.equal(p3.hasMore, false);
  const searched = await page("/api/v1/people?q=另一个名称"); assert.deepEqual(searched.items.map(x => x.id), [first.identity.personId]);
  const identities = await page(`/api/v1/people/${first.identity.personId}/identities?limit=1`); assert.equal(identities.items.length, 1); assert.equal(identities.hasMore, true);
  const groups = await page(`/api/v1/people/${first.identity.personId}/spaces`); assert.equal(groups.items.length, 2); assert.equal(groups.items.find(x => x.spaceId === first.space.id).displayName, "同名"); assert.equal(groups.items.find(x => x.spaceId === first.space.id).role, null);
  const spaces = await page("/api/v1/spaces?limit=1"); assert.equal(spaces.items[0].id, second.space.id); assert.equal(spaces.hasMore, true);
  const detail = await page(`/api/v1/spaces/${first.space.id}`); assert.equal(detail.space.displayName, null); assert.equal(detail.space.memberCount, 2);
  const members = await page(`/api/v1/spaces/${first.space.id}/members?limit=1`); assert.equal(members.items.length, 1); assert.equal(members.hasMore, true);
  const body = JSON.stringify([p1,p2,p3,searched,identities,groups,spaces,detail,members]); assert.doesNotMatch(body, /secret-group|secret-user|secret-other|secret-web|private-app-id/);
  assert.equal((await f.get(`/api/v1/people/${crypto.randomUUID()}`)).status, 404);
  assert.equal((await f.get(`/api/v1/spaces/${crypto.randomUUID()}/members`)).status, 404);
  for (const q of ["limit=0", "limit=51", "offset=-1", "limit=1&limit=2", "offset=2.5"]) assert.equal((await f.get(`/api/v1/people?${q}`)).status, 400);
});
