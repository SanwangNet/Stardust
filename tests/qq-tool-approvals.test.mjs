import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AgentOrchestrator } from "../apps/server/dist/agent-orchestrator.js";
import { createStardustServer } from "../apps/server/dist/app.js";
import { ConversationService } from "../apps/server/dist/conversation.js";
import { ExtensionManager } from "../apps/server/dist/extension-manager.js";
import { createQQBotExtension } from "../apps/server/dist/extensions/qq-bot.js";
import { LogService } from "../apps/server/dist/logger.js";

const until = async fn => { for (let i = 0; i < 400; i++) { const value = await fn(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error("timed out"); };
const message = (scope = "private", extra = {}) => ({ channelId: "qq-bot", conversationType: scope, conversationId: "private-platform-target", senderId: "private-platform-sender", messageId: randomUUID(), content: "请求测试", timestamp: new Date().toISOString(), ...extra });

async function fixture(t, { policy = { private: ["mock_write"] }, timeout = 10000, retention } = {}) {
  const root = await mkdtemp(join(tmpdir(), "stardust-qq-approval-")), token = randomBytes(32).toString("base64url");
  const hosts = new Map(), sent = [], turns = [], steps = [];
  let starter, expiryMs = 60000, pendingExecute, executeSignal, mode = "sent";
  const handlers = new Map(); let finish;
  const bot = { sent: [], on(name, fn) { handlers.set(name, fn); }, start() { handlers.get("ready")(); return new Promise(resolve => { finish = resolve; }); }, stop() { finish?.(); }, async sendText(target, content) { this.sent.push({ target, content }); return { id: "mock-reply" }; }, emit(value) { return handlers.get("message")({}, value); } };
  const tool = { name: "mock_write", description: "mock", parameters: { type: "object" },
    validate: value => value?.target === "safe-target" && value?.content === "固定内容" ? { target: value.target, content: value.content } : null,
    prepare: input => ({ approval: { operation: "测试操作", targetDescription: "测试目标", content: input.content, risk: "外部副作用", expiresAt: new Date(Date.now() + expiryMs).toISOString() } }),
    async execute(input, _host, signal) { sent.push(structuredClone(input)); executeSignal = signal; if (mode === "hold") return await new Promise(resolve => { pendingExecute = resolve; }); return { status: mode }; },
  };
  const pkg = (id, tools = []) => ({ manifest: { id, name: id, version: "1", description: "mock", type: "channel", fields: [] }, tools, create(_config, host) { hosts.set(id, host); return { start() { host.status("connected"); }, stop() {} }; } });
  const model = { async chatContext() { return "model only"; }, async chatWithTools(messages, tools, signal) {
    turns.push(structuredClone({ messages, tools }));
    if (messages.at(-1).role === "tool") return { content: `模型结果 ${JSON.parse(messages.at(-1).content).status}`, toolCalls: [] };
    return { content: "", toolCalls: [{ id: "mock_call", name: "mock_write", arguments: JSON.stringify({ target: "safe-target", content: "固定内容" }) }] };
  } };
  class ObservedAgent extends AgentOrchestrator { async advance(state, core) { steps.push(structuredClone(state.source)); return super.advance(state, core); } }
  const manager = new ExtensionManager(root, model, [createQQBotExtension(async () => bot), pkg("mock-provider", [tool])], new LogService(100, () => {}));
  const store = new ConversationService(model, ":memory:");
  const server = createStardustServer({ setupService: { getInitializationState: () => ({ initialized: true }) }, extensionManager: manager, modelService: model, conversationService: store, agentOrchestrator: new ObservedAgent(model), qqApprovalToken: token, qqToolAdapter: { policy, runTimeoutMs: timeout, retentionMs: retention, register(start) { starter = start; } } });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  await manager.install("qq-bot"); await manager.saveConfig("qq-bot", { appId: "123", appSecret: "mock-secret" }); await manager.enable("qq-bot");
  await until(() => handlers.has("message") && manager.list().find(item => item.id === "qq-bot").state === "connected");
  hosts.set("qq-bot", { status(value) { if (value === "connected") handlers.get("resumed")(); else handlers.get("disconnected")({ willReconnect: true }); } });
  await manager.install("mock-provider"); await manager.enable("mock-provider");
  await manager.setToolEnabled("mock-provider", "mock_write", true);
  t.after(async () => { if (server.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } await manager.shutdown(); await rm(root, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`, base = "/api/v1/qq-tool-runs";
  const get = (path, headers = {}) => fetch(origin + path, { headers: { "x-stardust-approval-token": token, ...headers } });
  const post = (path, body, headers = {}) => fetch(origin + path, { method: "POST", headers: { origin, "content-type": "application/json", "x-stardust-approval-token": token, ...headers }, body: JSON.stringify(body) });
  const read = async id => { const response = await get(`${base}/${id}`); assert.equal(response.status, 200); return (await response.json()).run; };
  const wait = (id, status) => until(async () => { const run = await read(id); return run.status === status && run; });
  const decide = (id, approved, headers) => post(`${base}/${id}/decision`, { toolCallId: "mock_call", approved }, headers);
  return { starter: (...args) => starter(...args), manager, store, server, token, bot, hosts, sent, turns, steps, origin, base, get, post, read, wait, decide, setExpiry: n => { expiryMs = n; }, setMode: value => { mode = value; }, release: value => pendingExecute(value), getExecuteSignal: () => executeSignal };
}

test("trusted QQ test adapter pauses immediately, isolates identities and resumes the same Core run after admin approval", async t => {
  const f = await fixture(t), original = message();
  const id = await f.starter(original), duplicate = await f.starter(original);
  assert.equal(id, duplicate);
  await assert.rejects(f.starter({ ...original, senderId: "other-sender" }), /QQ_EVENT_CONFLICT/);
  const waiting = await f.wait(id, "waiting");
  assert.equal(f.sent.length, 0); assert.equal(waiting.source.scope, "private");
  assert.equal(waiting.calls[0].providerId, "mock-provider"); assert.equal(waiting.calls[0].approval.content, "固定内容");
  assert.equal(waiting.calls[0].approvalStatus, "pending");
  assert.equal(waiting.calls[0].approval.operation, "测试操作"); assert.equal(waiting.calls[0].approval.targetDescription, "测试目标");
  assert.ok(waiting.calls[0].createdAt && waiting.calls[0].expiresAt); assert.equal(waiting.delivery, "not_attempted");
  assert.doesNotMatch(JSON.stringify(waiting), /private-platform-target|private-platform-sender/);
  assert.equal((await f.get(f.base, { "x-stardust-approval-token": "wrong" })).status, 403);
  assert.equal((await f.get(`${f.base}/${id}`, { origin: "https://evil.example" })).status, 403);
  assert.equal((await f.get(`${f.base}/${id}`, { "x-forwarded-for": "127.0.0.1" })).status, 403);
  assert.equal((await f.decide(id, true, { "x-stardust-approval-token": "wrong" })).status, 403);
  assert.equal((await f.decide(id, true, { origin: "https://evil.example" })).status, 403);
  assert.equal((await f.get(`/api/v1/tool-runs/${id}`)).status, 404);
  assert.equal((await f.post(`/api/v1/tool-runs/${id}/decision`, { toolCallId: "mock_call", approved: true })).status, 404);
  assert.equal((await f.post(`${f.base}/${id}/decision`, { toolCallId: "mock_call", approved: true, content: "替换" })).status, 400);

  await f.bot.emit({ kind: "c2c", rawEventType: "C2C_MESSAGE_CREATE", senderId: "mock-sender", messageId: "mock-message", timestamp: new Date().toISOString(), content: "批准", replyTarget: { scope: "c2c", targetId: "mock-target", msgId: "mock-message" } });
  assert.equal(f.bot.sent.length, 1); assert.equal((await f.read(id)).status, "waiting"); assert.equal(f.sent.length, 0);

  // A waiting run does not hold the adapter or prevent a second source from progressing.
  const group1 = await f.starter(message("group", { conversationId: "group-one", senderId: "member-one", content: "批准", starcoreId: "web-chat", providerId: "mock-provider" }));
  const group2 = await f.starter(message("group", { conversationId: "group-two", senderId: "member-one" }));
  const group3 = await f.starter(message("group", { conversationId: "group-one", senderId: "member-two" }));
  const [a, b, c] = await Promise.all([f.wait(group1, "done"), f.wait(group2, "done"), f.wait(group3, "done")]);
  assert.notEqual(a.source.conversationRef, b.source.conversationRef); assert.equal(a.source.conversationRef, c.source.conversationRef); assert.notEqual(a.source.senderRef, c.source.senderRef);
  assert.equal(a.calls[0].result.code, "TOOL_UNAVAILABLE"); assert.equal(f.sent.length, 0);
  assert.equal((await f.decide(group1, true)).status, 409);

  assert.equal((await f.decide(id, true)).status, 200); assert.equal((await f.decide(id, true)).status, 409);
  const done = await f.wait(id, "done");
  assert.equal(done.reply, "模型结果 sent"); assert.equal(done.generation, "generated"); assert.equal(done.delivery, "not_attempted"); assert.equal(done.calls[0].approvalStatus, "approved");
  assert.deepEqual(f.sent, [{ target: "safe-target", content: "固定内容" }]);
  assert.equal(f.turns.at(-1).messages.at(-1).tool_call_id, "mock_call");
  assert.equal(JSON.parse(f.turns.at(-1).messages.at(-1).content).status, "sent");
  assert.ok(f.steps.every(step => step.starcoreId === "qq-bot" && step.channelId === "qq-bot"));
});

test("default denial, rejection, expiry, revocation, cancellation and reconnect remain fail closed", async t => {
  const f = await fixture(t);
  const deniedId = await f.starter(message()); await f.wait(deniedId, "waiting");
  assert.equal((await f.decide(deniedId, false)).status, 200);
  assert.equal((await f.wait(deniedId, "done")).calls[0].result.status, "denied");
  assert.equal((await f.decide(deniedId, true)).status, 409);

  f.setExpiry(80); const expired = await f.starter(message()); await f.wait(expired, "waiting");
  await new Promise(resolve => setTimeout(resolve, 110));
  assert.equal((await f.decide(expired, true)).status, 409);
  assert.equal((await f.wait(expired, "done")).calls[0].status, "expired"); f.setExpiry(60000);

  const disabled = await f.starter(message()); await f.wait(disabled, "waiting");
  await f.manager.setToolEnabled("mock-provider", "mock_write", false); await f.manager.setToolEnabled("mock-provider", "mock_write", true);
  assert.equal((await f.decide(disabled, true)).status, 409); assert.equal((await f.wait(disabled, "done")).calls[0].status, "unavailable");

  const disconnected = await f.starter(message()); await f.wait(disconnected, "waiting");
  f.hosts.get("qq-bot").status("disconnected"); f.hosts.get("qq-bot").status("connected");
  assert.equal((await f.decide(disconnected, true)).status, 409);
  assert.equal((await f.wait(disconnected, "error")).calls[0].status, "cancelled");
  const fresh = await f.starter(message()); await f.wait(fresh, "waiting"); assert.equal((await f.decide(fresh, false)).status, 200); await f.wait(fresh, "done");

  const controller = new AbortController(), cancelled = await f.starter(message(), controller.signal); await f.wait(cancelled, "waiting"); controller.abort();
  assert.equal((await f.decide(cancelled, true)).status, 409); assert.equal((await f.wait(cancelled, "error")).calls[0].status, "cancelled");
  await assert.rejects(f.starter(message("private", { channelId: "web-chat", starcoreId: "qq-bot" })), /INVALID_QQ_REQUEST/);
  assert.equal(f.sent.length, 0);
});

test("in-flight cancellation preserves an unknown outcome and a timed-out run cannot be approved", async t => {
  const f = await fixture(t, { timeout: 500 });
  f.setMode("hold"); const controller = new AbortController(), id = await f.starter(message(), controller.signal); await f.wait(id, "waiting");
  assert.equal((await f.decide(id, true)).status, 200); await until(() => f.sent.length === 1);
  controller.abort(); assert.equal(f.getExecuteSignal().aborted, true);
  assert.equal((await f.read(id)).calls[0].result.status, "unknown_outcome");
  f.release({ status: "unknown_outcome", code: "UNKNOWN_OUTCOME" });
  const settled = await until(async () => { const run = await f.read(id); return run.calls[0].status === "unknown_outcome" && run; });
  assert.equal(settled.status, "error"); assert.equal(settled.delivery, "not_attempted"); assert.equal(f.sent.length, 1);
  const timed = await f.starter(message()); await f.wait(timed, "waiting"); await f.wait(timed, "error");
  assert.equal((await f.decide(timed, true)).status, 409); assert.equal(f.sent.length, 1);
});

test("QQ tool policy has no default grants", async t => {
  const f = await fixture(t, { policy: {} });
  const id = await f.starter(message()); const done = await f.wait(id, "done");
  assert.equal(done.calls[0].result.code, "TOOL_UNAVAILABLE");
  assert.ok(!f.turns[0].tools.some(item => item.function.name === "mock_write")); assert.equal(f.sent.length, 0);
});

test("an expired approval resumes without a management poll", async t => {
  const f = await fixture(t, { timeout: 5000 }); f.setExpiry(80);
  const id = await f.starter(message());
  await until(() => f.turns.some(turn => turn.messages.at(-1).role === "tool"));
  const result = JSON.parse(f.turns.at(-1).messages.at(-1).content);
  assert.equal(result.status, "expired"); assert.equal((await f.wait(id, "done")).reply, "模型结果 expired"); assert.equal(f.sent.length, 0);
});

test("timeout eventually removes retained state and shutdown cannot revive an approval", async t => {
  const f = await fixture(t, { timeout: 200, retention: 150 });
  const expired = await f.starter(message()); await f.wait(expired, "waiting"); await f.wait(expired, "error");
  await until(async () => (await f.get(`${f.base}/${expired}`)).status === 404);
  const pending = await f.starter(message()); await f.wait(pending, "waiting");
  f.server.closeAllConnections(); await new Promise(resolve => f.server.close(resolve));
  await assert.rejects(f.starter(message()), /INVALID_QQ_REQUEST/);
  const replacement = createStardustServer({ setupService: { getInitializationState: () => ({ initialized: true }) }, qqApprovalToken: f.token, extensionManager: { restore: async () => {}, shutdown: async () => {} } });
  replacement.listen(0, "127.0.0.1"); await once(replacement, "listening");
  t.after(async () => { replacement.closeAllConnections(); await new Promise(resolve => replacement.close(resolve)); });
  const url = `http://127.0.0.1:${replacement.address().port}/api/v1/qq-tool-runs/${pending}`;
  assert.equal((await fetch(url, { headers: { "x-stardust-approval-token": f.token } })).status, 404);
  assert.equal(f.sent.length, 0);
});

test("missing administrator credential fails closed", async t => {
  let start;
  const server = createStardustServer({ setupService: { getInitializationState: () => ({ initialized: true }) }, qqApprovalToken: "", extensionManager: { restore: async () => {}, shutdown: async () => {} }, qqToolAdapter: { register(callback) { start = callback; } } });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  assert.throws(() => start(message()), /ADMIN_NOT_CONFIGURED/);
  const url = `http://127.0.0.1:${server.address().port}/api/v1/qq-tool-runs`;
  assert.equal((await fetch(url, { headers: { "x-stardust-approval-token": "a".repeat(43) } })).status, 403);
});
