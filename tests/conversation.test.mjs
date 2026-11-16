import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConversationService } from "../apps/server/dist/conversation.js";
import { buildConversationContext } from "../apps/server/dist/conversation-context.js";
import { ModelService } from "../apps/server/dist/model.js";
import { createStardustServer } from "../apps/server/dist/app.js";
import { AdminAuth } from "../apps/server/dist/admin-auth.js";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { ModelError } from "../apps/server/dist/model.js";

test("conversations persist, isolate histories and handle concurrent and duplicate requests", async () => {
  const root = mkdtempSync(join(tmpdir(), "stardust-conversation-"));
  const path = join(root, "conversation.sqlite");
  const calls = [];
  let release;
  const model = { async chatContext(messages) { calls.push(messages); if (messages.at(-1).content === "wait") await new Promise((resolve) => { release = resolve; }); return "reply"; } };
  let store;
  try {
    store = new ConversationService(model, path);
    const a = store.create("A"), b = store.create("B");
    const first = randomUUID();
    await store.submit(a.id, first, "cat");
    await store.submit(a.id, randomUUID(), "name?");
    await store.submit(b.id, randomUUID(), "other");
    assert.deepEqual(calls[1], [{ role: "user", content: "cat" }, { role: "assistant", content: "reply" }, { role: "user", content: "name?" }]);
    assert.deepEqual(calls[2], [{ role: "user", content: "other" }]);
    await store.submit(a.id, first, "cat");
    assert.equal(calls.length, 3);
    const waiting = store.submit(a.id, randomUUID(), "wait");
    await assert.rejects(store.submit(a.id, randomUUID(), "overlap"), /CONVERSATION_BUSY/);
    release(); await waiting;
    store.rename(a.id, "renamed");
    store.close();
    store = new ConversationService(model, path);
    assert.equal(store.get(a.id).title, "renamed");
    assert.deepEqual(store.messages(a.id).map((message) => message.role), ["user", "assistant", "user", "assistant", "user", "assistant"]);
    store.delete(a.id); assert.throws(() => store.get(a.id), /NOT_FOUND/);
    assert.equal(store.messages(b.id).length, 2);
  } finally { store?.close(); rmSync(root, { recursive: true, force: true }); }
});

test("failed and interrupted requests do not become assistant replies", async () => {
  const root = mkdtempSync(join(tmpdir(), "stardust-conversation-"));
  const path = join(root, "conversation.sqlite");
  let store;
  try {
    store = new ConversationService({ chatContext: async () => { throw new Error("MODEL_FAILED"); } }, path);
    const conversation = store.create();
    await assert.rejects(store.submit(conversation.id, randomUUID(), "hello"), /MODEL_FAILED/);
    assert.deepEqual(store.messages(conversation.id).map(({ role, status }) => [role, status]), [["user", "failed"]]);
    store.close();
    const db = new DatabaseSync(path);
    db.prepare("UPDATE messages SET status = 'pending' WHERE conversation_id = ?").run(conversation.id);
    db.close();
    store = new ConversationService({ chatContext: async () => { throw new ModelError("TIMEOUT", 504); } }, path);
    assert.equal(store.messages(conversation.id)[0].status, "unknown");
    await assert.rejects(store.submit(conversation.id, randomUUID(), "timeout"), { code: "TIMEOUT" });
    assert.equal(store.messages(conversation.id)[1].status, "unknown");
  } finally { store?.close(); rmSync(root, { recursive: true, force: true }); }
});

test("context budget retains complete recent turns and rejects oversized current input", () => {
  const history = [{ role: "user", content: "old" }, { role: "assistant", content: "old reply" }, { role: "user", content: "recent" }, { role: "assistant", content: "recent reply" }];
  assert.deepEqual(buildConversationContext(history, "now", 120), [...history.slice(2), { role: "user", content: "now" }]);
  assert.throws(() => buildConversationContext(history, "x".repeat(100), 100), /CONTEXT_TOO_LARGE/);
  assert.deepEqual(buildConversationContext(history, "now", 1000, [], 2), [...history.slice(2), { role: "user", content: "now" }]);
});

test("retry reuses the failed message and does not replay an active request", async () => {
  let calls = 0;
  let finish;
  const model = { async chatContext() { calls++; if (calls === 1) throw new Error("failure"); await new Promise((resolve) => { finish = resolve; }); return "ok"; } };
  const store = new ConversationService(model, ":memory:");
  try {
    const id = store.create().id, requestId = randomUUID();
    await assert.rejects(store.submit(id, requestId, "hello"));
    const pending = store.submit(id, requestId, "hello", true);
    assert.equal((await store.submit(id, requestId, "hello", true))[0].status, "pending");
    assert.equal(calls, 2);
    finish(); await pending;
    assert.deepEqual(store.messages(id).map((message) => [message.role, message.status]), [["user", "complete"], ["assistant", "complete"]]);
    await store.submit(id, requestId, "hello", true);
    assert.equal(calls, 2);
  } finally { store.close(); }
});

test("model receives ordered context with existing stream configuration", async () => {
  let body;
  const store = { loadConfig: () => ({ model: { baseUrl: "https://example.test/v1", modelId: "test", timeoutMs: 1000, stream: false } }) };
  const secrets = { getKey: () => ({ key: "", fileKey: "" }) };
  const model = new ModelService(store, secrets, async (_url, request) => {
    body = JSON.parse(request.body);
    return Response.json({ choices: [{ message: { content: "answer" } }] });
  });
  const messages = [{ role: "user", content: "cat" }, { role: "assistant", content: "reply" }, { role: "user", content: "name?" }];
  assert.equal(await model.chatContext(messages), "answer");
  assert.deepEqual(body.messages, messages);
  assert.equal(body.stream, false);
});

test("conversation API is available locally and protects against cross-origin writes", async () => {
  const token = "a-secure-test-token-at-least-32-characters";
  const store = new ConversationService({ chatContext: async () => "answer" }, ":memory:");
  const setup = { getInitializationState: () => ({ initialized: true }) };
  const extensions = { restore: async () => {}, shutdown: async () => {}, availableTools: () => [] };
  const server = createStardustServer({ setupService: setup, extensionManager: extensions, adminAuth: new AdminAuth(token), conversationService: store });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const origin = `http://127.0.0.1:${server.address().port}`;
    const request = (path, options = {}) => fetch(origin + path, options);
    assert.equal((await request("/api/v1/conversations")).status, 200);
    const login = await request("/api/v1/admin/login", { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ token }) });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const headers = { cookie, origin, "content-type": "application/json" };
    assert.equal((await request("/api/v1/conversations", { method: "POST", headers: { ...headers, origin: "https://evil.example" }, body: "{}" })).status, 403);
    const created = await request("/api/v1/conversations", { method: "POST", headers, body: JSON.stringify({ title: "A" }) });
    assert.equal(created.status, 201);
    const id = (await created.json()).conversation.id;
    const sent = await request(`/api/v1/conversations/${id}/messages`, { method: "POST", headers, body: JSON.stringify({ requestId: randomUUID(), content: "hello" }) });
    assert.equal(sent.status, 200);
    const history = await request(`/api/v1/conversations/${id}/messages`, { headers: { cookie } });
    assert.deepEqual((await history.json()).messages.map((item) => item.content), ["hello", "answer"]);
    assert.equal((await request(`/api/v1/conversations/${randomUUID()}`, { headers: { cookie } })).status, 404);
    assert.equal((await request(`/api/v1/conversations/${id}`, { method: "DELETE", headers: { cookie } })).status, 403);
  } finally {
    if (server.listening) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  }
});
