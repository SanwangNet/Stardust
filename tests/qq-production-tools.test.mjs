import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createStardustServer } from "../apps/server/dist/app.js";
import { ConversationService } from "../apps/server/dist/conversation.js";
import { ExtensionManager } from "../apps/server/dist/extension-manager.js";
import { createQQBotExtension } from "../apps/server/dist/extensions/qq-bot.js";
import { LogService } from "../apps/server/dist/logger.js";

const until = async fn => { for (let i = 0; i < 1000; i++) { const result = await fn(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error("timed out"); };
const event = (id, content, options = {}) => ({ kind: "c2c", rawEventType: "C2C_MESSAGE_CREATE", senderId: "authorized", messageId: id, timestamp: new Date().toISOString(), content, replyTarget: { scope: "c2c", targetId: "private-one", msgId: id }, ...options });

async function fixture(t, { enabled = true, policy, maxActive = 20, mode = "success", configured = true, runTimeoutMs } = {}) {
  const root = await mkdtemp(join(tmpdir(), "stardust-qq-production-"));
  const token = randomBytes(32).toString("base64url"), handlers = new Map(), platform = [], executions = [], turns = [];
  let finish, sendMode = mode, releaseSend, attemptedTarget;
  const bot = { on(name, fn) { handlers.set(name, fn); }, start() { handlers.get("ready")(); return new Promise(resolve => { finish = resolve; }); }, stop() { finish?.(); },
    async sendText(target, content) { platform.push({ target: structuredClone(target), content }); if (sendMode === "reject") throw Object.assign(new Error("mock rejection"), { httpStatus: 403 }); if (sendMode === "network") throw Object.assign(new Error("mock network"), { code: "ETIMEDOUT" }); if (sendMode === "hold") return await new Promise(resolve => { releaseSend = resolve; }); return { id: `reply-${platform.length}` }; },
    emit(value) { return handlers.get("message")({}, value); } };
  const tool = { name: "mock_tool", description: "mock", parameters: { type: "object" }, validate: input => input?.content === "固定内容" ? { content: input.content } : null,
    prepare: input => ({ approval: { operation: "模拟写入", targetDescription: "测试目标", content: input.content, risk: "模拟副作用" } }),
    async execute(input) { executions.push(structuredClone(input)); return { status: "sent" }; } };
  const pkg = { manifest: { id: "mock-provider", name: "Mock", version: "1", description: "mock", type: "channel", fields: [] }, tools: [tool], create(_config, host) { return { start() { host.status("connected"); }, stop() {} }; } };
  const model = { plain: [], async chatContext(messages) { this.plain.push(structuredClone(messages)); return `普通回复:${messages.at(-1).content}`; }, async chatWithTools(messages, tools) {
    turns.push(structuredClone({ messages, tools }));
    if (messages.at(-1).role === "tool") return { content: `工具结果:${JSON.parse(messages.at(-1).content).status}`, toolCalls: [] };
    const current = messages.findLast(item => item.role === "user").content;
    if (current === "直接") return { content: "直接回复", toolCalls: [] };
    if (current === "恶意目标") return { content: "", toolCalls: [{ id: "call_1", name: "send_message", arguments: JSON.stringify({ channel: "qq-bot", target: attemptedTarget, content: "模拟消息" }) }] };
    return { content: "", toolCalls: [{ id: "call_1", name: current === "强制未授权" ? "not_allowed" : "mock_tool", arguments: JSON.stringify({ content: "固定内容" }) }] };
  } };
  const manager = new ExtensionManager(root, model, [createQQBotExtension(async () => bot), pkg], new LogService(100, () => {}));
  const store = new ConversationService(model, ":memory:");
  const defaultPolicy = { private: ["mock_tool"], privateSenders: ["authorized"], group: ["mock_tool"], groups: ["group-one"], groupSenders: ["authorized"] };
  const server = createStardustServer({ setupService: { getInitializationState: () => ({ initialized: true }) }, extensionManager: manager, modelService: model, conversationService: store, qqApprovalToken: configured ? token : "", qqToolCalling: { enabled, policy: policy ?? defaultPolicy, maxActive }, ...(runTimeoutMs ? { qqToolAdapter: { register() {}, runTimeoutMs } } : {}) });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  await manager.install("qq-bot"); await manager.saveConfig("qq-bot", { appId: "123", appSecret: "mock-secret" }); await manager.enable("qq-bot");
  await until(() => handlers.has("message") && manager.list().find(item => item.id === "qq-bot").state === "connected");
  await manager.install("mock-provider"); await manager.enable("mock-provider"); await manager.setToolEnabled("mock-provider", "mock_tool", true);
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await manager.shutdown(); await rm(root, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`, base = "/api/v1/qq-tool-runs";
  const get = path => fetch(origin + path, { headers: { "x-stardust-approval-token": token } });
  const post = (path, body) => fetch(origin + path, { method: "POST", headers: { origin, "content-type": "application/json", "x-stardust-approval-token": token }, body: JSON.stringify(body) });
  const list = async () => (await (await get(base)).json()).runs;
  const read = async id => (await (await get(`${base}/${id}`)).json()).run;
  const decide = (id, approved) => post(`${base}/${id}/decision`, { toolCallId: "call_1", approved });
  return { bot, handlers, manager, model, platform, executions, turns, origin, list, read, decide, post, get, setMode(value) { sendMode = value; }, setAttemptedTarget(value) { attemptedTarget = value; }, releaseSend(value) { releaseSend(value); } };
}

test("real QQ ingress detaches waiting runs, keeps ordinary replies moving and resumes each approved call once", async t => {
  const f = await fixture(t);
  const first = event("one", "执行工具"); await f.bot.emit(first);
  const waiting = await until(async () => (await f.list()).find(run => run.status === "waiting"));
  assert.equal(f.executions.length, 0); assert.equal(waiting.source.scope, "private"); assert.equal(waiting.calls[0].providerId, "mock-provider");
  assert.ok(f.turns[0].tools.some(tool => tool.function.name === "mock_tool"));
  assert.doesNotMatch(JSON.stringify(f.turns[0].messages), /private-one|authorized|Web 渠道补充说明/);
  await f.bot.emit(first); assert.equal((await f.list()).length, 1);
  first.replyTarget.targetId = "mutated-after-acceptance";
  await f.bot.emit(event("ordinary", "普通消息", { senderId: "other", replyTarget: { scope: "c2c", targetId: "private-two", msgId: "ordinary" } }));
  assert.equal(f.platform.length, 1); assert.equal(f.platform[0].target.targetId, "private-two");
  await f.bot.emit(event("second", "执行工具", { replyTarget: { scope: "c2c", targetId: "private-three", msgId: "second" } }));
  const runs = await until(async () => { const list = await f.list(); return list.filter(run => run.status === "waiting").length === 2 && list; });
  const second = runs.find(run => run.id !== waiting.id);
  assert.equal((await f.decide(waiting.id, true)).status, 200); assert.equal((await f.decide(waiting.id, true)).status, 409);
  const firstDone = await until(async () => { const run = await f.read(waiting.id); return run.delivery === "delivered" && run; });
  assert.equal(firstDone.reply, "工具结果:sent"); assert.equal(firstDone.calls[0].result.status, "sent");
  assert.equal(f.executions.length, 1); assert.equal(f.platform[1].target.targetId, "private-one");
  assert.equal((await f.decide(second.id, false)).status, 200);
  const secondDone = await until(async () => { const run = await f.read(second.id); return run.delivery === "delivered" && run; });
  assert.equal(secondDone.reply, "工具结果:denied"); assert.equal(secondDone.calls[0].approvalStatus, "denied");
  assert.equal(f.platform[2].target.targetId, "private-three"); assert.equal(f.executions.length, 1);
  assert.equal((await f.read(waiting.id)).delivery, "delivered"); assert.equal(f.platform.length, 3);
  const toolTurn = f.turns.find(turn => turn.messages.at(-1).role === "tool"); assert.equal(toolTurn.messages.at(-1).tool_call_id, "call_1");
});

test("default-off and missing policy stay model-only; invalid group events never create runs", async t => {
  const f = await fixture(t, { enabled: false });
  await f.bot.emit(event("off", "执行工具")); assert.equal(f.model.plain.length, 1); assert.equal(f.turns.length, 0); assert.equal((await f.list()).length, 0);
  await f.bot.emit(event("ignored", "不应接收", { kind: "group", rawEventType: "GROUP_MESSAGE_CREATE", groupOpenid: "group-one", replyTarget: { scope: "group", targetId: "group-one", msgId: "ignored" } }));
  assert.equal((await f.list()).length, 0); assert.equal(f.platform.length, 1);
});

test("enabled switch with no explicit policy remains model-only", async t => {
  const f = await fixture(t, { enabled: true, policy: {} });
  await f.bot.emit(event("no-policy", "执行工具"));
  assert.equal(f.model.plain.length, 1); assert.equal(f.turns.length, 0); assert.equal((await f.list()).length, 0);
});

test("enabled switch without administrator credential remains model-only", async t => {
  const f = await fixture(t, { configured: false });
  await f.bot.emit(event("no-admin", "执行工具"));
  assert.equal(f.model.plain.length, 1); assert.equal(f.turns.length, 0);
  assert.equal((await f.get("/api/v1/qq-tool-runs")).status, 403);
});

test("authorized direct result is delivered once, expired group result remains queryable without sending", async t => {
  const f = await fixture(t);
  await f.bot.emit(event("direct", "直接"));
  const direct = await until(async () => (await f.list()).find(run => run.reply === "直接回复" && run.delivery === "delivered"));
  assert.equal(f.platform.length, 1); assert.equal(direct.generation, "generated");
  await f.bot.emit(event("old", "直接", { kind: "group", rawEventType: "GROUP_AT_MESSAGE_CREATE", groupOpenid: "group-one", timestamp: new Date(Date.now() - 6 * 60_000).toISOString(), replyTarget: { scope: "group", targetId: "group-one", msgId: "old" } }));
  const expired = await until(async () => (await f.list()).find(run => run.source.scope === "group" && run.delivery === "unavailable"));
  assert.equal(expired.reply, "直接回复"); assert.equal(expired.deliveryReason, "REPLY_EXPIRED"); assert.equal(f.platform.length, 1);
});

for (const [mode, expected] of [["reject", "rejected"], ["network", "unknown_outcome"]]) test(`QQ delivery ${mode} is recorded once without retry`, async t => {
  const f = await fixture(t, { mode }); await f.bot.emit(event(mode, "直接"));
  const run = await until(async () => (await f.list()).find(item => item.delivery === expected));
  assert.equal(run.reply, "直接回复"); assert.equal(run.generation, "generated");
  assert.equal(f.platform.length, 1); await f.read(run.id); await f.read(run.id); assert.equal(f.platform.length, 1);
});

test("forced unregistered Tool fails Core, and source disconnect invalidates waiting approval", async t => {
  const f = await fixture(t);
  await f.bot.emit(event("forced", "强制未授权"));
  const failed = await until(async () => (await f.list()).find(run => run.delivery === "delivered"));
  assert.equal(failed.calls[0].result.code, "TOOL_UNAVAILABLE"); assert.ok(!f.turns[0].tools.some(tool => tool.function.name === "not_allowed"));
  await f.bot.emit(event("pending", "执行工具"));
  const waiting = await until(async () => (await f.list()).find(run => run.status === "waiting"));
  f.handlers.get("disconnected")({ willReconnect: true }); f.handlers.get("resumed")();
  assert.equal((await f.decide(waiting.id, true)).status, 409);
  const cancelled = await f.read(waiting.id); assert.equal(cancelled.status, "error"); assert.equal(cancelled.delivery, "unavailable");
  assert.equal(f.executions.length, 0); assert.equal(f.platform.length, 1);
});

test("active run quota fails closed while a prior approval waits", async t => {
  const f = await fixture(t, { maxActive: 1 });
  await f.bot.emit(event("limit-one", "执行工具")); await until(async () => (await f.list()).some(run => run.status === "waiting"));
  await f.bot.emit(event("limit-two", "执行工具", { replyTarget: { scope: "c2c", targetId: "another", msgId: "limit-two" } }));
  assert.equal((await f.list()).length, 1); assert.equal(f.executions.length, 0); assert.equal(f.platform.length, 0);
});

test("disabled Tool invalidates a real QQ approval and run timeout releases its slot", async t => {
  const f = await fixture(t, { runTimeoutMs: 1500, maxActive: 1 });
  await f.bot.emit(event("disabled", "执行工具"));
  const waiting = await until(async () => (await f.list()).find(run => run.status === "waiting"));
  await f.manager.setToolEnabled("mock-provider", "mock_tool", false);
  await f.manager.setToolEnabled("mock-provider", "mock_tool", true);
  assert.equal((await f.decide(waiting.id, true)).status, 409);
  const revoked = await until(async () => { const run = await f.read(waiting.id); return run.status === "done" && run; });
  assert.equal(revoked.calls[0].status, "unavailable"); assert.equal(f.executions.length, 0);
  await f.bot.emit(event("timeout", "执行工具", { replyTarget: { scope: "c2c", targetId: "another", msgId: "timeout" } }));
  const timed = await until(async () => (await f.list()).find(run => run.id !== waiting.id && run.status === "error"));
  assert.equal(timed.delivery, "unavailable"); assert.equal((await f.decide(timed.id, true)).status, 409); assert.equal(f.executions.length, 0);
});

test("approval after the original group reply expires keeps the result without delivery", async t => {
  const f = await fixture(t);
  await f.bot.emit(event("late", "执行工具", { kind: "group", rawEventType: "GROUP_AT_MESSAGE_CREATE", groupOpenid: "group-one", timestamp: new Date(Date.now() - 300_000 + 500).toISOString(), replyTarget: { scope: "group", targetId: "group-one", msgId: "late" } }));
  const waiting = await until(async () => (await f.list()).find(run => run.status === "waiting"));
  await new Promise(resolve => setTimeout(resolve, 550));
  assert.equal((await f.decide(waiting.id, true)).status, 200);
  const done = await until(async () => { const run = await f.read(waiting.id); return run.delivery === "unavailable" && run; });
  assert.equal(done.deliveryReason, "REPLY_EXPIRED"); assert.equal(done.reply, "工具结果:sent");
  assert.equal(f.executions.length, 1); assert.equal(f.platform.length, 0);
});

test("disconnect during delivery yields unknown outcome and never resends after reconnect", async t => {
  const f = await fixture(t, { mode: "hold" }); await f.bot.emit(event("inflight", "直接"));
  const run = await until(async () => (await f.list()).find(item => item.delivery === "delivering"));
  assert.equal(f.platform.length, 1);
  f.handlers.get("disconnected")({ willReconnect: true }); f.handlers.get("resumed")();
  const unknown = await until(async () => { const item = await f.read(run.id); return item.delivery === "unknown_outcome" && item; });
  assert.equal(unknown.generation, "generated"); f.releaseSend({ id: "late-reply" });
  await f.read(run.id); assert.equal(f.platform.length, 1);
});

test("QQ send_message cannot reveal or use a different conversation target", async t => {
  const f = await fixture(t, { policy: { private: ["send_message"], privateSenders: ["authorized"] } });
  await f.manager.setToolEnabled("qq-bot", "send_message", true);
  await f.bot.emit(event("other", "普通", { senderId: "other", replyTarget: { scope: "c2c", targetId: "other-private", msgId: "other" } }));
  const other = f.manager.availableTargets()[0].targets[0].id; f.setAttemptedTarget(other);
  await f.bot.emit(event("attack", "恶意目标"));
  const run = await until(async () => (await f.list()).find(item => item.delivery === "delivered"));
  assert.equal(run.calls[0].result.code, "TOOL_UNAVAILABLE");
  assert.ok(f.turns[0].tools.some(tool => tool.function.name === "send_message"));
  assert.doesNotMatch(f.turns[0].messages[0].content, new RegExp(other));
  assert.equal(f.platform.length, 2); assert.equal(f.executions.length, 0);
});
