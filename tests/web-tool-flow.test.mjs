import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { builtInWebToolFlow, runWebToolFlow } from "../apps/server/dist/web-tool-flow.js";
import { ConversationService } from "../apps/server/dist/conversation.js";
import { createStardustServer } from "../apps/server/dist/app.js";

function disconnect(flow) {
  const graph = flow.graphs.find(g => g.id === "availability");
  const edge = graph.edges.find(e => e.from.node === "search" && e.to.node === "filter");
  graph.edges = graph.edges.filter(e => e !== edge); return edge;
}

test("availability graph prunes, filters and rejects unregistered types", async () => {
  const flow = builtInWebToolFlow();
  assert.equal(flow.graphs[1].interface.inputs[0].label, "模型请求准备");
  assert.equal(flow.graphs[1].interface.outputs[0].label, "提供给模型");
  assert.deepEqual([...await runWebToolFlow(flow, [{ name: "send_message", description: "test", parameters: {} }], () => true)].sort(), ["search_history", "send_message"]);
  const saved = disconnect(flow);
  assert.deepEqual([...await runWebToolFlow(flow, [], () => true)], []);
  flow.graphs[1].edges.push(saved);
  assert.deepEqual([...await runWebToolFlow(flow, [], () => false)], []);
  flow.graphs[1].nodes.push({ id: "forged", type: "registered-shell" });
  await assert.rejects(runWebToolFlow(flow, [], () => true), /TOOL_FLOW_INVALID/);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(runWebToolFlow(builtInWebToolFlow(), [], () => true, cancelled.signal), /TOOL_FLOW_CANCELLED/);
  await assert.rejects(runWebToolFlow(builtInWebToolFlow(), [], () => { throw Error("policy failed"); }), /TOOL_FLOW_FAILED/);
});

test("Web model list and dispatch follow graph and retain Core policy", async t => {
  const graph = builtInWebToolFlow(), calls = [], searches = [];
  const model = { chatContext: async () => "unused", chatWithTools: async (messages, tools) => {
    calls.push(structuredClone({ messages, tools }));
    if (messages.at(-1).role === "tool") return { content: "答复", toolCalls: [] };
    return { content: "", toolCalls: [{ id: "search_1", name: "search_history", arguments: JSON.stringify({ keywords: ["猫"] }) }] };
  } };
  const store = new ConversationService(model, ":memory:");
  const original = store.searchHistory.bind(store);
  store.searchHistory = (...args) => { searches.push(args[0]); return original(...args); };
  const extensions = { restore: async () => {}, shutdown: async () => {}, availableTools: () => [], availableTargets: () => [] };
  const server = createStardustServer({ setupService: { getInitializationState: () => ({ initialized: true }) }, extensionManager: extensions, modelService: model, conversationService: store, toolAvailabilityFlow: { enabled: true, definition: graph } });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = (url, body) => fetch(origin + url, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) });
  const id = (await (await post("/api/v1/conversations", {})).json()).conversation.id;
  const send = async () => { const response = await post(`/api/v1/conversations/${id}/messages`, { requestId: randomUUID(), content: "查猫" }); assert.equal(response.status, 200); };
  await send(); assert.ok(calls[0].tools.some(t => t.function.name === "search_history")); assert.equal(searches.length, 1);
  const saved = disconnect(graph); await send();
  assert.ok(!calls[2].tools.some(t => t.function.name === "search_history")); assert.equal(searches.length, 1);
  assert.equal(JSON.parse(calls[3].messages.at(-1).content).error, "TOOL_UNAVAILABLE");
  graph.graphs[1].edges.push(saved); await send(); assert.ok(calls[4].tools.some(t => t.function.name === "search_history")); assert.equal(searches.length, 2);
  store.agent.update({ tool: { name: "search_history", enabled: false } }, ["search_history"]);
  await send(); assert.ok(!calls[6].tools.some(t => t.function.name === "search_history")); assert.equal(searches.length, 2);
  assert.equal(JSON.parse(calls[7].messages.at(-1).content).error, "TOOL_UNAVAILABLE");
  const qq = store.create("QQ", "qq");
  assert.equal((await post(`/api/v1/conversations/${qq.id}/messages`, { requestId: randomUUID(), content: "查猫" })).status, 404);
  graph.graphs[1].nodes.push({ id: "forged", type: "fake-tool" });
  const failed = await post(`/api/v1/conversations/${id}/messages`, { requestId: randomUUID(), content: "失败" });
  assert.equal(failed.status, 500); assert.equal((await failed.json()).error, "TOOL_FLOW_INVALID"); assert.equal(calls.length, 8);
});

test("disabled development switch retains the existing Web tool path", async t => {
  const graph = builtInWebToolFlow(); graph.graphs[1].nodes.push({ id: "bad", type: "unknown" });
  const offered = [], model = { chatContext: async () => "unused", chatWithTools: async (_messages, tools) => { offered.push(tools); return { content: "答复", toolCalls: [] }; } };
  const store = new ConversationService(model, ":memory:");
  const extensions = { restore: async () => {}, shutdown: async () => {}, availableTools: () => [], availableTargets: () => [] };
  const server = createStardustServer({ setupService: { getInitializationState: () => ({ initialized: true }) }, extensionManager: extensions, modelService: model, conversationService: store, toolAvailabilityFlow: { enabled: false, definition: graph } });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = (url, body) => fetch(origin + url, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) });
  const id = (await (await post("/api/v1/conversations", {})).json()).conversation.id;
  assert.equal((await post(`/api/v1/conversations/${id}/messages`, { requestId: randomUUID(), content: "你好" })).status, 200);
  assert.ok(offered[0].some(tool => tool.function.name === "search_history"));
});
