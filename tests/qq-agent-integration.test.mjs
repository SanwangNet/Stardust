import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AgentOrchestrator } from "../apps/server/dist/agent-orchestrator.js";
import { createStardustServer } from "../apps/server/dist/app.js";
import { ConversationService } from "../apps/server/dist/conversation.js";
import { ExtensionManager } from "../apps/server/dist/extension-manager.js";
import { createQQBotExtension } from "../apps/server/dist/extensions/qq-bot.js";
import { ModelError } from "../apps/server/dist/model.js";
import { LogService } from "../apps/server/dist/logger.js";

const until = async predicate => {
  for (let i = 0; i < 300; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error("等待超时");
};
function mockBot() {
  const handlers = new Map(); let finish;
  return { sent: [], on(name, fn) { handlers.set(name, fn); }, start() { handlers.get("ready")(); return new Promise(resolve => { finish = resolve; }); }, stop() { finish?.(); }, async sendText(target, content) { this.sent.push({ target, content }); return { id: `reply-${this.sent.length}` }; }, emit(message) { return handlers.get("message")({}, message); } };
}
function event(kind, id, target, extra = {}) {
  return { kind, rawEventType: kind === "c2c" ? "C2C_MESSAGE_CREATE" : "GROUP_AT_MESSAGE_CREATE", senderId: "sender", messageId: id, timestamp: new Date().toISOString(), content: `消息-${id}`, ...(kind === "group" ? { groupOpenid: target } : {}), replyTarget: { scope: kind, targetId: target, msgId: id }, ...extra };
}
async function fixture(t, model) {
  const root = await mkdtemp(join(tmpdir(), "stardust-qq-agent-")), bot = mockBot(), entries = [];
  class ObservedAgent extends AgentOrchestrator {
    async execute(request, mode) { entries.push({ request, mode }); return super.execute(request, mode); }
  }
  const manager = new ExtensionManager(root, model, [createQQBotExtension(async () => bot)], new LogService(100, () => {}));
  const store = new ConversationService(model, ":memory:");
  store.agent.update({ agentPrompt: "用户配置的主身份", webPrompt: "仅 Web 专用提示" }, []);
  const web = store.create("私人 Web"); await store.submit(web.id, randomUUID(), "绝密 Web 历史");
  const server = createStardustServer({ setupService: { getInitializationState: () => ({ initialized: true }) }, extensionManager: manager, conversationService: store, modelService: model, agentOrchestrator: new ObservedAgent(model) });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  await manager.install("qq-bot"); await manager.saveConfig("qq-bot", { appId: "123", appSecret: "mock-secret" }); await manager.enable("qq-bot");
  await until(() => manager.list().find(item => item.id === "qq-bot").state === "connected");
  t.after(async () => { await manager.shutdown(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  return { bot, entries, manager, store, server };
}

for (const supportsTools of [false, true]) test(`QQ through the real adapter uses model-only execution (chatWithTools=${supportsTools})`, async t => {
  const calls = []; let toolCalls = 0;
  const model = { async chatContext(messages, signal, context) { calls.push({ messages: structuredClone(messages), signal, context }); return messages.at(-1).content === "绝密 Web 历史" ? "历史答复" : "QQ 答复"; }, ...(supportsTools ? { async chatWithTools() { toolCalls++; return { content: "Web 答复", toolCalls: [] }; } } : {}) };
  const f = await fixture(t, model); calls.length = 0;
  let toolLookups = 0, targetLookups = 0;
  const availableTools = f.manager.availableTools.bind(f.manager), availableTargets = f.manager.availableTargets.bind(f.manager);
  f.manager.availableTools = () => { toolLookups++; throw new Error("QQ must not inspect tools"); };
  f.manager.availableTargets = () => { targetLookups++; throw new Error("QQ must not inspect targets"); };
  const a = event("c2c", "one", "private-openid");
  await f.bot.emit(a); await f.bot.emit(a);
  await f.bot.emit(event("group", "ignored", "group-openid", { rawEventType: "GROUP_MESSAGE_CREATE" }));
  await f.bot.emit(event("c2c", "empty", "private-openid", { content: "  " }));
  await f.bot.emit(event("group", "bad-target", "group-openid", { replyTarget: { scope: "group", targetId: "other", msgId: "bad-target" } }));
  await f.bot.emit(event("group", "two", "group-openid"));
  await f.bot.emit(event("c2c", "three", "group-openid"));
  await f.bot.emit(event("group", "four", "other-group"));
  assert.equal(f.entries.length, 4); assert.equal(calls.length, 4); assert.equal(f.bot.sent.length, 4);
  assert.equal(toolCalls, 0); assert.equal(toolLookups, 0); assert.equal(targetLookups, 0);
  assert.equal(f.store.listWeb().length, 1);
  const sources = f.entries.map(entry => entry.request.source);
  assert.ok(sources.every(source => source.starcoreId === "qq-bot" && source.channelId === "qq-bot"));
  assert.equal(new Set(sources.map(source => source.conversationId)).size, 4);
  assert.ok(sources.every(source => !JSON.stringify(source).includes("openid")));
  for (let i = 0; i < calls.length; i++) {
    const { messages, context } = calls[i];
    assert.deepEqual(f.entries[i].mode, { mode: "model-only" });
    assert.deepEqual(messages.map(m => m.role), ["system", "user"]);
    assert.match(messages[0].content, /用户配置的主身份/); assert.match(messages[0].content, /不可信输入/);
    assert.doesNotMatch(JSON.stringify(messages), /仅 Web 专用提示|绝密 Web 历史|可用消息渠道|send_message|openid/);
    assert.match(context.eventId, /^[0-9a-f-]{36}$/); assert.equal(context.eventId, f.entries[i].request.modelContext.eventId);
  }
  assert.deepEqual(f.bot.sent.map(item => item.target), [a.replyTarget, event("group", "two", "group-openid").replyTarget, event("c2c", "three", "group-openid").replyTarget, event("group", "four", "other-group").replyTarget]);
  f.manager.availableTools = availableTools; f.manager.availableTargets = availableTargets;
  const origin = `http://127.0.0.1:${f.server.address().port}`, webId = f.store.listWeb()[0].id;
  const response = await fetch(`${origin}/api/v1/conversations/${webId}/messages`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ requestId: randomUUID(), content: "Web 新请求" }) });
  assert.equal(response.status, 200); assert.equal(f.entries.length, 5);
  assert.equal(f.entries[4].request.source.starcoreId, "web-chat"); assert.equal(typeof f.entries[4].mode, "function");
  assert.equal(toolCalls, supportsTools ? 1 : 0);
});

test("QQ stop aborts the shared agent request and discards a late model reply", async t => {
  let resolveReply, modelSignal;
  const model = { async chatContext(messages, signal) { if (messages.at(-1).content === "绝密 Web 历史") return "历史答复"; modelSignal = signal; return new Promise(resolve => { resolveReply = resolve; }); }, async chatWithTools() { throw new Error("unexpected tools"); } };
  const f = await fixture(t, model);
  const pending = f.bot.emit(event("c2c", "cancel", "private-openid"));
  await until(() => modelSignal); await f.manager.disable("qq-bot");
  assert.equal(modelSignal.aborted, true); resolveReply("迟到的回复"); await pending;
  assert.equal(f.bot.sent.length, 0); assert.equal(f.entries.length, 1);
  await f.bot.emit(event("c2c", "after-stop", "private-openid")); assert.equal(f.entries.length, 1);
});

test("QQ suppresses empty replies and preserves model error categories", async t => {
  let mode = "empty";
  const model = { async chatContext(messages) { if (messages.at(-1).content === "绝密 Web 历史") return "历史答复"; if (mode === "empty") return "  "; throw new ModelError(mode, 400); } };
  const f = await fixture(t, model);
  await f.bot.emit(event("c2c", "empty-reply", "private-openid")); assert.equal(f.bot.sent.length, 0);
  mode = "NOT_CONFIGURED"; await f.bot.emit(event("c2c", "error", "private-openid"));
  assert.equal(f.bot.sent.length, 0); assert.match(f.manager.list()[0].error, /模型未配置/);
  mode = "REQUEST_CANCELLED"; await f.bot.emit(event("c2c", "cancelled", "private-openid"));
  assert.equal(f.manager.list()[0].error, undefined); assert.equal(f.bot.sent.length, 0);
});

test("QQ never sends a passive reply using an expired or invalid message timestamp", async t => {
  const model = { async chatContext() { return "回复"; } };
  const f = await fixture(t, model);
  await f.bot.emit(event("group", "expired", "group-openid", { timestamp: new Date(Date.now() - 6 * 60_000).toISOString() }));
  await f.bot.emit(event("c2c", "invalid-time", "private-openid", { timestamp: "invalid" }));
  assert.equal(f.bot.sent.length, 0);
  assert.equal(f.entries.length, 2);
});

test("model-only mode fails closed when chatContext is unavailable", async () => {
  let tools = 0;
  const agent = new AgentOrchestrator({ async chatWithTools() { tools++; return { content: "", toolCalls: [] }; } });
  await assert.rejects(agent.execute({ source: { starcoreId: "qq", channelId: "qq", conversationId: "opaque" }, current: "hello", messages: [{ role: "user", content: "hello" }] }, { mode: "model-only" }), { code: "NOT_CONFIGURED" });
  assert.equal(tools, 0);
});
