import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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

async function until(predicate) {
  for (let i = 0; i < 400; i++) { const value = await predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error("timed out");
}

for (const flow of [false, true]) test(`Web invokes the real QQ Tool through Core and approval (flows=${flow})`, async t => {
  const root = await mkdtemp(join(tmpdir(), "stardust-web-qq-"));
  const handlers = new Map(), platform = [], turns = [], sources = [];
  let finish, target, mode = "success", releaseModel, modelWaiting = false, qqRequests = 0;
  const bot = {
    tokenManager: { async getAccessToken() { return "mock-token"; } },
    on(name, fn) { handlers.set(name, fn); return this; },
    start() { handlers.get("ready")(); return new Promise(resolve => { finish = resolve; }); },
    stop() { finish?.(); },
    async sendText() { return { id: "passive-reply" }; },
  };
  const model = {
    async chatContext() { qqRequests++; return "QQ 回复"; },
    async chatWithTools(messages, tools) {
      turns.push(structuredClone({ messages, tools }));
      const last = messages.at(-1);
      if (last.role === "tool") return { content: `结果：${JSON.parse(last.content).status}`, toolCalls: [] };
      if (last.role === "user" && last.content === "请调整语气") return { content: "", toolCalls: [{ id: "call_qq2", name: "send_message", arguments: JSON.stringify({ channel: "qq-bot", target, content: "调整后的内容" }) }] };
      if (mode === "hold") { modelWaiting = true; await new Promise(resolve => { releaseModel = resolve; }); }
      const args = { channel: "qq-bot", target, content: mode === "invalid" ? "" : "测试消息" };
      return { content: "", toolCalls: [{ id: "call_qq", name: "send_message", arguments: JSON.stringify(args) }] };
    },
  };
  class ObservedAgent extends AgentOrchestrator {
    async execute(request, adapter) { sources.push(request.source); return super.execute(request, adapter); }
  }
  const qq = createQQBotExtension(async () => bot, async (url, request) => {
    platform.push({ url, body: JSON.parse(request.body) });
    if (mode === "unknown") throw new Error("mock network failure");
    if (mode === "reject") return Response.json({ code: 22009, message: "permission denied" }, { status: 403 });
    return Response.json({ id: "mock-sent" });
  });
  const manager = new ExtensionManager(root, model, [qq], new LogService(100, () => {}));
  const store = new ConversationService(model, ":memory:");
  const server = createStardustServer({ setupService: { getInitializationState: () => ({ initialized: true }) }, extensionManager: manager, conversationService: store, modelService: model, agentOrchestrator: new ObservedAgent(model), toolAvailabilityFlow: { enabled: flow }, toolExecutionFlow: { enabled: flow } });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { await manager.shutdown(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  await manager.install("qq-bot"); await manager.saveConfig("qq-bot", { appId: "123", appSecret: "mock-secret" }); await manager.enable("qq-bot");
  await until(() => handlers.has("message") && manager.list()[0].state === "connected");
  await handlers.get("message")({}, { kind: "c2c", rawEventType: "C2C_MESSAGE_CREATE", senderId: "mock-sender", messageId: "incoming", timestamp: new Date().toISOString(), content: "QQ 私有历史", replyTarget: { scope: "c2c", targetId: "mock-openid", msgId: "incoming" } });
  target = manager.availableTargets()[0].targets[0].id;
  const descriptor = manager.capabilityCatalog().capabilities.find(item => item.id === "tool:qq-bot:send_message");
  assert.equal(descriptor.providerId, "qq-bot"); assert.equal(descriptor.available, false);
  await manager.setToolEnabled("qq-bot", "send_message", true);
  assert.equal(manager.capabilityCatalog().capabilities.find(item => item.id === descriptor.id).available, true);
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body) => fetch(origin + path, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) });
  const id = (await (await post("/api/v1/conversations", {})).json()).conversation.id;
  const otherId = (await (await post("/api/v1/conversations", {})).json()).conversation.id;
  const session = (await (await fetch(`${origin}/api/v1/control-session`)).json()).token;
  const controlPost = body => fetch(`${origin}/api/v1/approvals/decision`, { method: "POST", headers: { origin, "content-type": "application/json", "x-stardust-control-token": session }, body: JSON.stringify(body) });
  const base = `/api/v1/conversations/${id}/messages`;
  const start = content => { const requestId = randomUUID(); return { requestId, pending: post(base, { requestId, content }), path: `${base}/${requestId}/tool` }; };
  const waitApproval = async path => until(async () => { const response = await fetch(origin + path); if (!response.ok) return; const run = (await response.json()).run; return run?.status === "waiting" && run; });
  const decide = (path, approved, extra = {}) => post(path + "/decision", { toolCallId: "call_qq", approved, ...extra });

  const success = start("发送消息");
  const waiting = await waitApproval(success.path);
  assert.equal(platform.length, 0);
  assert.equal((await fetch(`${origin}/api/v1/tool-runs/${waiting.id}`)).status, 404);
  assert.equal((await post(`/api/v1/tool-runs/${waiting.id}/decision`, { toolCallId: "call_qq", approved: true })).status, 404);
  assert.equal(waiting.calls[0].approval.content, "测试消息");
  assert.equal(waiting.calls[0].input.target, undefined);
  assert.ok(waiting.calls[0].expiresAt);
  assert.ok(turns[0].tools.some(item => item.function.name === "send_message"));
  assert.match(JSON.stringify(turns[0].messages), new RegExp(target));
  assert.doesNotMatch(JSON.stringify(turns[0].messages), /mock-openid|mock-sender|QQ 私有历史/);
  assert.equal((await decide(success.path, true, { content: "替换" })).status, 400);
  const approvals = async conversation => (await (await fetch(`${origin}/api/v1/approvals?conversationId=${conversation}`, { headers: { "x-stardust-control-token": session } })).json()).items;
  const safe = (await approvals(id)).find(item => item.requestId === success.requestId);
  assert.equal((await approvals(otherId)).some(item => item.runId === safe.runId), false);
  const decisionOnce = { source: "web", runId: safe.runId, callId: safe.callId, conversationId: id, requestId: success.requestId, decision: "approve" };
  assert.equal((await controlPost({ ...decisionOnce, conversationId: otherId })).status, 409);
  assert.equal((await controlPost(decisionOnce)).status, 200);
  assert.equal((await controlPost(decisionOnce)).status, 409);
  assert.equal((await success.pending).status, 200);
  const callStatus = await fetch(`${origin}/api/v1/approvals/status?source=web&runId=${safe.runId}&callId=${safe.callId}&conversationId=${id}`, { headers: { "x-stardust-control-token": session } });
  assert.equal((await callStatus.json()).result.status, "sent");
  assert.equal(platform.length, 1); assert.equal(platform[0].body.content, "测试消息");
  assert.equal(turns[1].messages.at(-1).tool_call_id, "call_qq");
  assert.equal(JSON.parse(turns[1].messages.at(-1).content).status, "sent");
  assert.deepEqual(store.messages(id).map(message => message.content), ["发送消息", "结果：sent"]);
  assert.equal(qqRequests, 1); assert.deepEqual(sources.map(source => source.starcoreId), ["qq-bot", "web-chat"]);

  const feedbackRequest = start("请求调整"); await waitApproval(feedbackRequest.path);
  const approvalUrl = `${origin}/api/v1/approvals?conversationId=${id}`;
  assert.equal((await fetch(approvalUrl)).status, 403);
  assert.equal((await fetch(approvalUrl, { headers: { "x-stardust-control-token": session, origin: "https://evil.example" } })).status, 403);
  const listApprovals = async () => (await (await fetch(approvalUrl, { headers: { "x-stardust-control-token": session } })).json()).items;
  const firstApproval = (await listApprovals()).find(item => item.requestId === feedbackRequest.requestId);
  assert.equal(firstApproval.content, "测试消息"); assert.equal(firstApproval.canApprove, true); assert.doesNotMatch(JSON.stringify(firstApproval), new RegExp(target));
  const decision = { source: "web", runId: firstApproval.runId, callId: firstApproval.callId, conversationId: id, requestId: feedbackRequest.requestId, decision: "feedback", feedback: "请调整语气" };
  assert.equal((await controlPost(decision)).status, 200); assert.equal((await controlPost(decision)).status, 409);
  const next = await until(async () => (await listApprovals()).find(item => item.callId === "call_qq2"));
  assert.equal(next.content, "调整后的内容"); assert.equal(platform.length, 1);
  assert.ok(turns.some(turn => turn.messages.at(-1).role === "user" && turn.messages.at(-1).content === "请调整语气"));
  assert.equal((await controlPost({ source: "web", runId: next.runId, callId: next.callId, conversationId: id, requestId: feedbackRequest.requestId, decision: "deny" })).status, 200);
  assert.equal((await feedbackRequest.pending).status, 200); assert.equal(platform.length, 1);

  const denied = start("拒绝发送"); await waitApproval(denied.path);
  assert.equal((await decide(denied.path, false)).status, 200); assert.equal((await denied.pending).status, 200);
  assert.equal(platform.length, 1); assert.equal(JSON.parse(turns.at(-1).messages.at(-1).content).status, "denied");

  for (const outcome of ["reject", "unknown"]) {
    mode = outcome; const request = start(outcome); await waitApproval(request.path);
    assert.equal((await decide(request.path, true)).status, 200); assert.equal((await request.pending).status, 200);
    assert.equal(JSON.parse(turns.at(-1).messages.at(-1).content).status, outcome === "reject" ? "rejected" : "unknown_outcome");
  }
  assert.equal(platform.length, 3);

  mode = "invalid"; const invalid = start("参数无效"); assert.equal((await invalid.pending).status, 200);
  assert.equal(JSON.parse(turns.at(-1).messages.at(-1).content).code, "INVALID_ARGUMENTS");

  store.agent.update({ tool: { name: "send_message", enabled: false } }, ["send_message"]);
  mode = "success"; const hidden = start("未授权"); assert.equal((await hidden.pending).status, 200);
  assert.ok(!turns.at(-2).tools.some(item => item.function.name === "send_message"));
  assert.doesNotMatch(JSON.stringify(turns.at(-2).messages), new RegExp(target));
  assert.equal(JSON.parse(turns.at(-1).messages.at(-1).content).code, "TOOL_UNAVAILABLE");
  store.agent.update({ tool: { name: "send_message", enabled: true } }, ["send_message"]);

  mode = "hold"; const stale = start("断线前请求"); await until(() => modelWaiting);
  handlers.get("disconnected")({ willReconnect: true }); handlers.get("resumed")(); releaseModel();
  assert.equal((await stale.pending).status, 200);
  assert.equal(JSON.parse(turns.at(-1).messages.at(-1).content).code, "TOOL_UNAVAILABLE");
  assert.equal(platform.length, 3); assert.equal(qqRequests, 1);

  mode = "success"; const pendingApproval = start("等待期间断线"); await waitApproval(pendingApproval.path);
  handlers.get("disconnected")({ willReconnect: true }); handlers.get("resumed")();
  assert.equal((await decide(pendingApproval.path, true)).status, 409);
  assert.equal((await pendingApproval.pending).status, 200);
  assert.equal(JSON.parse(turns.at(-1).messages.at(-1).content).status, "unavailable");
  assert.equal(platform.length, 3);

  const fresh = start("重连后的新请求"); await waitApproval(fresh.path);
  assert.equal((await decide(fresh.path, true)).status, 200); assert.equal((await fresh.pending).status, 200);
  assert.equal(platform.length, 4); assert.equal(JSON.parse(turns.at(-1).messages.at(-1).content).status, "sent");

  await manager.setToolEnabled("qq-bot", "send_message", false);
  const disabled = start("禁用后请求"); assert.equal((await disabled.pending).status, 200);
  assert.ok(!turns.at(-2).tools.some(item => item.function.name === "send_message"));
  assert.doesNotMatch(JSON.stringify(turns.at(-2).messages), new RegExp(target));
  assert.equal(JSON.parse(turns.at(-1).messages.at(-1).content).code, "TOOL_UNAVAILABLE");
  assert.equal(platform.length, 4); assert.equal(qqRequests, 1);
});
