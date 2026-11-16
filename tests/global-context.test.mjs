import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { get } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { ConversationService } from "../apps/server/dist/conversation.js";
import { WEB_CONTEXT_OWNER } from "../apps/server/dist/global-context.js";
import { createStardustServer } from "../apps/server/dist/app.js";
import { ModelService } from "../apps/server/dist/model.js";

async function until(fn) {
  for (let i = 0; i < 400; i++) { const result = await fn(); if (result) return result; await new Promise((resolve) => setTimeout(resolve, 10)); }
  throw new Error("worker timed out");
}
function tempStore(model) {
  const root = mkdtempSync(join(tmpdir(), "stardust-global-"));
  const path = join(root, "conversation.sqlite");
  const store = new ConversationService(model, path);
  return { root, path, store, dispose() { try { store.close(); } finally { rmSync(root, { recursive: true, force: true }); } } };
}

test("first turn and successive conversations create ordered, incremental scoped summaries", async () => {
  const inputs = [];
  const model = {
    chatContext: async () => "收到",
    async synthesizeGlobalContext(system, input) {
      assert.match(system, /不可信/);
      const data = JSON.parse(input); inputs.push(data);
      if (inputs.length === 1) return JSON.stringify({ updates: [{ topic: "宠物", content: "猫叫小白" }] });
      if (inputs.length === 2) return JSON.stringify({ updates: [{ topic: "宠物", content: "用户更正猫叫小黑" }] });
      return JSON.stringify({ updates: [] });
    },
  };
  const f = tempStore(model);
  try {
    f.store.globalContext.start();
    const a = f.store.create("A"), b = f.store.create("B");
    const firstId = randomUUID();
    await f.store.submit(a.id, firstId, "我有一只叫小白的猫");
    await until(() => f.store.globalContext.counts(WEB_CONTEXT_OWNER).done === 1);
    assert.equal(f.store.globalContext.entries(WEB_CONTEXT_OWNER)[0].content, "猫叫小白");
    await f.store.submit(a.id, randomUUID(), "其实叫小黑");
    await until(() => f.store.globalContext.counts(WEB_CONTEXT_OWNER).done === 2);
    const [entry] = f.store.globalContext.entries(WEB_CONTEXT_OWNER);
    assert.equal(entry.content, "用户更正猫叫小黑"); assert.equal(entry.version, 2); assert.equal(entry.sources.length, 2);
    assert.equal(inputs[1].existing[0].content, "猫叫小白");
    await f.store.submit(b.id, randomUUID(), "新会话");
    await until(() => f.store.globalContext.counts(WEB_CONTEXT_OWNER).done === 3);
    assert.equal(f.store.globalContext.entries(WEB_CONTEXT_OWNER)[0].version, 2);
    assert.equal(f.store.globalContext.jobs(WEB_CONTEXT_OWNER)[0].outcome, "no_change");
    assert.deepEqual(f.store.messages(b.id).map((m) => m.content), ["新会话", "收到"]);
    await f.store.submit(a.id, firstId, "我有一只叫小白的猫");
    assert.equal(f.store.globalContext.jobs(WEB_CONTEXT_OWNER).length, 3);
    const qq = f.store.create("QQ", "qq"); await f.store.submit(qq.id, randomUUID(), "不共享");
    assert.equal(f.store.globalContext.jobs(WEB_CONTEXT_OWNER).length, 3);
    assert.deepEqual(f.store.globalContext.entries("other-owner"), []);
    assert.deepEqual(f.store.globalContext.jobs("other-owner"), []);
    assert.throws(() => f.store.globalContext.retry("other-owner", 1), /JOB_NOT_RETRYABLE/);
    f.store.delete(a.id);
    assert.equal(f.store.globalContext.entries(WEB_CONTEXT_OWNER)[0].content, "用户更正猫叫小黑");
    assert.equal(f.store.globalContext.entries(WEB_CONTEXT_OWNER)[0].sources.length, 2);
  } finally { f.dispose(); }
});

test("invalid summaries fail without changing existing entries and can be retried explicitly", async () => {
  let calls = 0;
  const model = { chatContext: async () => "答复", async synthesizeGlobalContext() { calls++; return calls === 1 ? '{"updates":[{"topic":"项目","content":"进行中"}]}' : calls <= 4 ? '{"updates":[{"topic":"项目","content":"污染","extra":true}]}' : '{"updates":[{"topic":"项目","content":"已完成"}]}'; } };
  const f = tempStore(model);
  try {
    f.store.globalContext.start(); const conversation = f.store.create();
    await f.store.submit(conversation.id, randomUUID(), "开始");
    await until(() => f.store.globalContext.counts(WEB_CONTEXT_OWNER).done === 1);
    await f.store.submit(conversation.id, randomUUID(), "完成");
    for (let attempt = 1; attempt <= 3; attempt++) {
      await until(() => f.store.globalContext.jobs(WEB_CONTEXT_OWNER)[0]?.attempts === attempt && f.store.globalContext.jobs(WEB_CONTEXT_OWNER)[0]?.status !== "processing");
      if (attempt < 3) {
        const db = new DatabaseSync(f.path); db.prepare("UPDATE synthesis_jobs SET next_attempt_at = ? WHERE status = 'pending'").run(new Date(0).toISOString()); db.close();
        f.store.globalContext.wake();
      }
    }
    const failed = f.store.globalContext.jobs(WEB_CONTEXT_OWNER)[0];
    assert.equal(failed.status, "failed"); assert.equal(failed.lastError, "INVALID_OUTPUT");
    assert.equal(f.store.globalContext.entries(WEB_CONTEXT_OWNER)[0].content, "进行中");
    f.store.globalContext.retry(WEB_CONTEXT_OWNER, failed.id);
    await until(() => f.store.globalContext.counts(WEB_CONTEXT_OWNER).done === 2);
    assert.equal(f.store.globalContext.entries(WEB_CONTEXT_OWNER)[0].content, "已完成");
  } finally { f.dispose(); }
});

test("restart recovers queued work and existing conversations without injecting global summaries", async () => {
  const calls = [];
  const model = { chatContext: async (messages) => { calls.push(messages); return "答复"; }, synthesizeGlobalContext: async () => '{"updates":[{"topic":"项目","content":"进行中"}]}' };
  const f = tempStore(model); let reopened;
  try {
    const a = f.store.create(); await f.store.submit(a.id, randomUUID(), "第一轮");
    assert.equal(f.store.globalContext.counts(WEB_CONTEXT_OWNER).pending, 1);
    f.store.close();
    const db = new DatabaseSync(f.path); db.exec("UPDATE synthesis_jobs SET status = 'processing'"); db.close();
    reopened = new ConversationService(model, f.path); reopened.globalContext.start();
    await until(() => reopened.globalContext.counts(WEB_CONTEXT_OWNER).done === 1);
    const b = reopened.create(); await reopened.submit(b.id, randomUUID(), "新会话");
    assert.deepEqual(calls.at(-1), [{ role: "user", content: "新会话" }]);
    assert.equal(reopened.messages(a.id).length, 2);
  } finally { reopened?.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("owners are isolated and synthesis receives only its own prior entries", async () => {
  const inputs = [];
  const model = { chatContext: async () => "答复", async synthesizeGlobalContext(_system, input) { const parsed = JSON.parse(input); inputs.push(parsed); return JSON.stringify({ updates: [{ topic: "主题", content: parsed.turn[0].content }] }); } };
  const f = tempStore(model);
  try {
    f.store.globalContext.start();
    const web = f.store.create(), other = f.store.create("其他", "test");
    await f.store.submit(web.id, randomUUID(), "Web 私人内容");
    await until(() => f.store.globalContext.counts(WEB_CONTEXT_OWNER).done === 1);
    const requestId = randomUUID(); await f.store.submit(other.id, requestId, "其他范围内容");
    const messages = f.store.messages(other.id);
    const db = new DatabaseSync(f.path); db.prepare("UPDATE conversations SET scope_id = ? WHERE id = ?").run("other:scope", other.id); db.close();
    f.store.globalContext.enqueue("other:scope", other.id, requestId, messages[0].sequence, messages[1].sequence, new Date().toISOString());
    f.store.globalContext.wake();
    await until(() => f.store.globalContext.counts("other:scope").done === 1);
    assert.deepEqual(inputs[1].existing, []);
    assert.equal(f.store.globalContext.entries(WEB_CONTEXT_OWNER)[0].content, "Web 私人内容");
    assert.equal(f.store.globalContext.entries("other:scope")[0].content, "其他范围内容");
    f.store.globalContext.clear(WEB_CONTEXT_OWNER);
    assert.equal(f.store.globalContext.entries("other:scope").length, 1);
  } finally { f.dispose(); }
});

test("concurrent conversations are synthesized serially without losing the latest summary", async () => {
  const inputs = []; let finishFirst;
  const model = {
    chatContext: async () => "答复",
    async synthesizeGlobalContext(_system, input) {
      const payload = JSON.parse(input); inputs.push(payload);
      if (inputs.length === 1) await new Promise((resolve) => { finishFirst = resolve; });
      return JSON.stringify({ updates: [{ topic: "项目", content: payload.turn[0].content }] });
    },
  };
  const f = tempStore(model);
  try {
    f.store.globalContext.start();
    const a = f.store.create(), b = f.store.create();
    await f.store.submit(a.id, randomUUID(), "项目计划");
    await until(() => finishFirst);
    await f.store.submit(b.id, randomUUID(), "项目完成");
    assert.equal(inputs.length, 1);
    assert.equal(f.store.messages(b.id).length, 2);
    finishFirst();
    await until(() => f.store.globalContext.counts(WEB_CONTEXT_OWNER).done === 2);
    assert.equal(inputs[1].existing[0].content, "项目计划");
    assert.equal(f.store.globalContext.entries(WEB_CONTEXT_OWNER)[0].content, "项目完成");
  } finally { f.dispose(); }
});

test("synthesis uses the configured model, bounded output and private logs", async () => {
  let body; const logs = [];
  const config = { loadConfig: () => ({ model: { baseUrl: "https://example.test/v1", modelId: "test", timeoutMs: 1000, stream: false } }) };
  const secrets = { getKey: () => ({ key: "private-key", fileKey: "" }) };
  const model = new ModelService(config, secrets, async (_url, request) => {
    body = JSON.parse(request.body);
    return Response.json({ choices: [{ message: { content: '{"updates":[]}' } }] });
  }, { write: (...entry) => logs.push(entry) });
  assert.equal(await model.synthesizeGlobalContext("system instruction", "private conversation"), '{"updates":[]}');
  assert.equal(body.model, "test"); assert.equal(body.max_tokens, 2000); assert.equal(body.stream, false);
  assert.deepEqual(body.messages, [{ role: "system", content: "system instruction" }, { role: "user", content: "private conversation" }]);
  assert.doesNotMatch(JSON.stringify(logs), /private conversation|private-key/);
});

test("version 1 database migrates without deleting conversation records", () => {
  const root = mkdtempSync(join(tmpdir(), "stardust-global-migration-")); const path = join(root, "conversation.sqlite");
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE messages (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL, status TEXT NOT NULL, request_id TEXT NOT NULL, UNIQUE(conversation_id, request_id, role));
    INSERT INTO conversations VALUES ('old', '旧会话', 'web', '2020', '2020'); PRAGMA user_version = 1;`);
  db.close();
  const store = new ConversationService({ chatContext: async () => "答复" }, path);
  try { assert.equal(store.get("old").title, "旧会话"); assert.deepEqual(store.globalContext.entries(WEB_CONTEXT_OWNER), []); }
  finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("clearing or deleting while synthesis runs cannot restore removed content", async () => {
  let release;
  const model = { chatContext: async () => "答复", synthesizeGlobalContext: async () => new Promise((resolve) => { release = resolve; }) };
  const f = tempStore(model);
  try {
    f.store.globalContext.start(); const first = f.store.create();
    await f.store.submit(first.id, randomUUID(), "内容一"); await until(() => release);
    f.store.globalContext.clear(WEB_CONTEXT_OWNER);
    release('{"updates":[{"topic":"旧摘要","content":"不应写入"}]}');
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.deepEqual(f.store.globalContext.entries(WEB_CONTEXT_OWNER), []); assert.equal(f.store.messages(first.id).length, 2);
    release = undefined;
    const second = f.store.create(); await f.store.submit(second.id, randomUUID(), "内容二"); await until(() => release);
    f.store.delete(second.id);
    release('{"updates":[{"topic":"删除来源","content":"不应写入"}]}');
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.deepEqual(f.store.globalContext.entries(WEB_CONTEXT_OWNER), []);
    assert.equal(f.store.globalContext.jobs(WEB_CONTEXT_OWNER).length, 0);
  } finally { f.dispose(); }
});

test("global context API needs no login, uses the internal scope and enforces local same-origin access", async () => {
  const model = { chatContext: async () => "答复" };
  const f = tempStore(model);
  const server = createStardustServer({ setupService: { getInitializationState: () => ({ initialized: true }) }, extensionManager: { restore: async () => {}, shutdown: async () => {}, availableTools: () => [] }, modelService: model, conversationService: f.store });
  try {
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const origin = `http://127.0.0.1:${server.address().port}`;
    const result = await fetch(origin + "/api/v1/global-context?owner=other");
    assert.equal(result.status, 200);
    assert.equal((await result.json()).owner, WEB_CONTEXT_OWNER);
    assert.equal((await fetch(origin + "/api/v1/global-context", { headers: { origin: "https://evil.test" } })).status, 403);
    const spoofedHostStatus = await new Promise((resolve, reject) => {
      get(origin + "/api/v1/global-context", { headers: { host: "attacker.example" } }, (response) => { response.resume(); resolve(response.statusCode); }).on("error", reject);
    });
    assert.equal(spoofedHostStatus, 403);
    assert.equal((await fetch(origin + "/api/v1/global-context", { method: "DELETE", headers: { origin: "https://evil.test" } })).status, 403);
    assert.equal((await fetch(origin + "/api/v1/global-context", { method: "DELETE" })).status, 403);
    assert.equal((await fetch(origin + "/api/v1/global-context", { method: "DELETE", headers: { origin } })).status, 200);
  } finally { if (server.listening) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); } rmSync(f.root, { recursive: true, force: true }); }
});

test("HTTP chat automatically synthesizes, survives reopening, and clear does not rebuild old history", async () => {
  const synthesisInputs = [];
  const model = {
    chatContext: async () => "收到",
    async synthesizeGlobalContext(_system, input) {
      const payload = JSON.parse(input); synthesisInputs.push(payload);
      return JSON.stringify({ updates: [{ topic: "宠物", content: payload.turn[0].content }] });
    },
  };
  const root = mkdtempSync(join(tmpdir(), "stardust-global-http-")); const path = join(root, "conversation.sqlite");
  const setup = { getInitializationState: () => ({ initialized: true }) };
  const extensions = { restore: async () => {}, shutdown: async () => {}, availableTools: () => [] };
  let server;
  async function start() {
    const store = new ConversationService(model, path);
    const app = createStardustServer({ setupService: setup, extensionManager: extensions, modelService: model, conversationService: store });
    app.listen(0, "127.0.0.1"); await once(app, "listening");
    return { app, origin: `http://127.0.0.1:${app.address().port}` };
  }
  async function stop() { if (server?.listening) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); } }
  try {
    let running = await start(); server = running.app;
    let origin = running.origin;
    const post = (url, body) => fetch(origin + url, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) });
    const id = (await (await post("/api/v1/conversations", {})).json()).conversation.id;
    assert.equal((await post(`/api/v1/conversations/${id}/messages`, { requestId: randomUUID(), content: "猫叫小白" })).status, 200);
    await until(async () => (await (await fetch(origin + "/api/v1/global-context/jobs")).json()).counts.done === 1);
    let context = await (await fetch(origin + "/api/v1/global-context")).json();
    assert.equal(context.entries[0].content, "猫叫小白");
    await stop(); running = await start(); server = running.app; origin = running.origin;
    context = await (await fetch(origin + "/api/v1/global-context")).json();
    assert.equal(context.entries[0].content, "猫叫小白");
    assert.equal((await (await fetch(`${origin}/api/v1/conversations/${id}/messages`)).json()).messages.length, 2);
    assert.equal((await fetch(origin + "/api/v1/global-context", { method: "DELETE", headers: { origin } })).status, 200);
    assert.equal((await post(`/api/v1/conversations/${id}/messages`, { requestId: randomUUID(), content: "新的事实" })).status, 200);
    await until(async () => (await (await fetch(origin + "/api/v1/global-context/jobs")).json()).counts.done === 1);
    context = await (await fetch(origin + "/api/v1/global-context")).json();
    assert.equal(context.entries[0].content, "新的事实");
    assert.deepEqual(synthesisInputs.at(-1).existing, []);
    assert.equal((await (await fetch(`${origin}/api/v1/conversations/${id}/messages`)).json()).messages.length, 4);
  } finally { await stop(); rmSync(root, { recursive: true, force: true }); }
});
