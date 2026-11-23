import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { builtInWebToolExecutionFlow, runToolExecutionFlow } from "../apps/server/dist/web-tool-execution-flow.js";
import { builtInWebToolFlow } from "../apps/server/dist/web-tool-flow.js";
import { ConversationService } from "../apps/server/dist/conversation.js";
import { createStardustServer } from "../apps/server/dist/app.js";

const wait = async fn => { for (let i = 0; i < 200; i++) { const x = await fn(); if (x) return x; await new Promise(r => setTimeout(r, 10)); } throw Error("timeout"); };
const cut = (flow, from, to) => { const graph = flow.graphs[1], edge = graph.edges.find(e => e.from.node === from && e.to.node === to); graph.edges = graph.edges.filter(e => e !== edge); return edge; };
test("required execution stages cannot be bypassed or invoked on cancellation", async () => {
  for (const [from, to] of [["input", "validate"], ["validate", "permission"], ["permission", "approval"], ["approval", "executor"], ["executor", "result"]]) {
    const flow = builtInWebToolExecutionFlow(); cut(flow, from, to); let calls = 0;
    await assert.rejects(runToolExecutionFlow(flow, new AbortController().signal, () => { calls++; }), /TOOL_EXECUTION_FLOW_INVALID/); assert.equal(calls, 0);
  }
  const controller = new AbortController(); controller.abort(); let calls = 0;
  await assert.rejects(runToolExecutionFlow(builtInWebToolExecutionFlow(), controller.signal, () => { calls++; }), /CANCELLED/); assert.equal(calls, 0);
  const forged = builtInWebToolExecutionFlow(); forged.graphs[1].interface.outputs.push({ id: "extra", node: "output" });
  await assert.rejects(runToolExecutionFlow(forged, new AbortController().signal, () => { calls++; }), /TOOL_EXECUTION_FLOW_INVALID/); assert.equal(calls, 0);
  await runToolExecutionFlow(builtInWebToolExecutionFlow(), new AbortController().signal, () => { calls++; }); assert.equal(calls, 1);
});

test("real Web tool requests obey graph, approval, denial and availability", async t => {
  const flow = builtInWebToolExecutionFlow(), availability = builtInWebToolFlow(), sent = [], modelCalls = [], controller = new AbortController();
  const tool = { name: "send_message", description: "mock", parameters: {}, validate: value => value?.content === "ok" ? value : null,
    prepare: input => ({ approval: { operation: "mock", targetDescription: "mock", content: input.content, channel: "mock", risk: "mock" } }) };
  const extensions = { restore: async () => {}, shutdown: async () => {}, availableTools: () => [tool], availableTargets: () => [], toolHost: () => ({}),
    toolSignal: () => controller.signal, channelSignal: () => controller.signal, executeTool: async (_name, input) => { sent.push(input.content); return { status: "sent" }; } };
  const model = { chatContext: async () => "unused", chatWithTools: async (messages, tools) => {
    modelCalls.push(structuredClone({ messages, tools }));
    if (messages.at(-1).role === "tool") return { content: "结束", toolCalls: [] };
    const text = messages.at(-1).content;
    return { content: "", toolCalls: [{ id: "call_1", name: text.includes("搜索") ? "search_history" : "send_message", arguments: text.includes("搜索") ? '{"keywords":["猫"]}' : text.includes("非法") ? '{"content":"bad"}' : '{"content":"ok"}' }] };
  } };
  const store = new ConversationService(model, ":memory:"); let searches = 0;
  const search = store.searchHistory.bind(store); store.searchHistory = (...args) => { searches++; return search(...args); };
  const server = createStardustServer({ setupService: { getInitializationState: () => ({ initialized: true }) }, extensionManager: extensions, modelService: model, conversationService: store, toolExecutionFlow: { enabled: true, definition: flow }, toolAvailabilityFlow: { enabled: true, definition: availability } });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = (path, data) => fetch(origin + path, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(data) });
  const id = (await (await post("/api/v1/conversations", {})).json()).conversation.id;
  const start = text => { const requestId = randomUUID(); return { path: `/api/v1/conversations/${id}/messages/${requestId}/tool`, response: post(`/api/v1/conversations/${id}/messages`, { requestId, content: text }) }; };
  let request = start("搜索猫"); assert.equal((await request.response).status, 200); assert.equal(searches, 1);
  assert.ok(JSON.parse(modelCalls.at(-1).messages.at(-1).content).results);
  const edge = cut(flow, "approval", "executor"); request = start("搜索猫"); assert.equal((await request.response).status, 200); assert.equal(searches, 1);
  assert.equal(JSON.parse(modelCalls.at(-1).messages.at(-1).content).code, "TOOL_EXECUTION_FLOW_INVALID");
  request = start("发送"); assert.equal((await request.response).status, 200); assert.equal(sent.length, 0);
  flow.graphs[1].edges.push(edge); request = start("发送");
  const pending = await wait(async () => { const run = (await (await fetch(origin + request.path)).json()).run; return run?.status === "waiting" && run; });
  assert.equal(sent.length, 0);
  assert.equal((await post(request.path + "/decision", { toolCallId: pending.calls[0].id, approved: true })).status, 200);
  assert.equal((await post(request.path + "/decision", { toolCallId: pending.calls[0].id, approved: true })).status, 409);
  assert.equal((await request.response).status, 200); assert.deepEqual(sent, ["ok"]); assert.equal(JSON.parse(modelCalls.at(-1).messages.at(-1).content).status, "sent");
  request = start("发送"); await wait(async () => (await (await fetch(origin + request.path)).json()).run?.status === "waiting");
  assert.equal((await post(request.path + "/decision", { toolCallId: "call_1", approved: false })).status, 200); assert.equal((await request.response).status, 200); assert.deepEqual(sent, ["ok"]);
  request = start("非法参数"); assert.equal((await request.response).status, 200); assert.deepEqual(sent, ["ok"]);
  assert.equal(JSON.parse(modelCalls.at(-1).messages.at(-1).content).code, "INVALID_ARGUMENTS");
  request = start("发送"); await wait(async () => (await (await fetch(origin + request.path)).json()).run?.status === "waiting");
  store.agent.update({ tool: { name: "send_message", enabled: false } }, ["send_message"]);
  assert.equal((await post(request.path + "/decision", { toolCallId: "call_1", approved: true })).status, 409);
  assert.equal((await request.response).status, 200); assert.deepEqual(sent, ["ok"]);
  cut(availability, "search", "filter"); request = start("搜索猫"); assert.equal((await request.response).status, 200); assert.equal(searches, 1);
  assert.equal(JSON.parse(modelCalls.at(-1).messages.at(-1).content).error, "TOOL_UNAVAILABLE");
});
