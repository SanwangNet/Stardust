import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { AgentOrchestrator } from "../apps/server/dist/agent-orchestrator.js";
import { createStardustServer } from "../apps/server/dist/app.js";
import { ConversationService } from "../apps/server/dist/conversation.js";
import { ModelError } from "../apps/server/dist/model.js";
import { ToolRuns } from "../apps/server/dist/tool-runs.js";

const source = { starcoreId: "test-starcore", channelId: "test-channel", conversationId: "test-conversation" };
const request = (signal, origin = source) => ({
  source: origin, current: "用户请求", messages: [{ role: "user", content: "用户请求" }], signal,
});
const until = async fn => {
  for (let i = 0; i < 300; i++) {
    const value = await fn();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("等待超时");
};

function coreFixture(model, { allowed = true, result = { status: "sent" }, executeTool } = {}) {
  const lease = new AbortController(), executed = [], prepared = [];
  const tool = {
    name: "mock_write", description: "测试工具", parameters: { type: "object" },
    validate: value => value?.content === "ok" ? value : null,
    prepare: input => {
      prepared.push(input);
      return { approval: { operation: "测试操作", targetDescription: "测试目标", risk: "测试" } };
    },
  };
  const extensions = {
    availableTools: () => [tool], availableTargets: () => [], toolHost: () => ({}),
    toolSignal: () => lease.signal,
    executeTool: async (name, input, signal) => {
      executed.push({ name, input });
      return executeTool ? executeTool(signal) : result;
    },
  };
  const agent = new AgentOrchestrator(model);
  const runs = new ToolRuns(model, extensions, undefined, agent);
  let runId;
  let closed = false;
  const launch = (req = request()) => agent.execute(req, incoming => {
    runId = runs.start("trusted-owner", incoming.current, incoming.messages, {
      searchHistory: () => [], activity: () => {}, allowTool: () => allowed,
    }, incoming.source);
    return {
      get: () => runs.get("trusted-owner", runId),
      cancel: () => runs.cancel("trusted-owner", runId),
      close: () => { closed = true; },
      isClosed: () => false,
    };
  });
  return {
    agent, runs, executed, prepared, launch,
    id: () => runId, closed: () => closed,
    state: () => runs.get("trusted-owner", runId),
    decide: (id, value) => runs.decide("trusted-owner", runId, id, value),
  };
}

test("plain model execution preserves source, normalized context and cancellation signal", async () => {
  const calls = [];
  const model = { async chatContext(messages, signal) { calls.push({ messages, signal }); return "直接回复"; } };
  const agent = new AgentOrchestrator(model), controller = new AbortController();
  const input = request(controller.signal);
  const result = await agent.execute(input, () => { throw new Error("普通请求不应启动工具"); });
  assert.deepEqual(result, { source, content: "直接回复" });
  assert.deepEqual(calls[0].messages, input.messages);
  assert.equal(calls[0].signal, controller.signal);
  controller.abort();
  await assert.rejects(agent.execute(input, () => { throw new Error("不应执行"); }), { code: "REQUEST_CANCELLED" });
});

test("multiple model tool rounds pass through Core approval and return the results to the model", async t => {
  const calls = [];
  const model = { async chatWithTools(messages, tools) {
    calls.push(structuredClone({ messages, tools }));
    const completed = messages.filter(item => item.role === "tool").length;
    if (completed === 2) return { content: "最终答复", toolCalls: [] };
    return { content: "", toolCalls: [{ id: `call_${completed + 1}`, name: "mock_write", arguments: '{"content":"ok"}' }] };
  } };
  const f = coreFixture(model);
  t.after(() => f.runs.shutdown());
  const pending = f.launch();
  await until(() => f.id() && f.state().status === "waiting");
  assert.equal(f.executed.length, 0);
  f.decide("call_1", true);
  await until(() => f.state().status === "waiting" && f.state().calls.some(call => call.id === "call_2"));
  assert.equal(f.executed.length, 1);
  f.decide("call_2", true);
  assert.deepEqual(await pending, { source, content: "最终答复" });
  assert.equal(f.executed.length, 2);
  assert.equal(f.prepared.length, 2);
  assert.equal(calls.length, 3);
  assert.equal(JSON.parse(calls[1].messages.at(-1).content).status, "sent");
  assert.equal(JSON.parse(calls[2].messages.at(-1).content).status, "sent");
  assert.equal(f.closed(), true);
});

test("Core rejects denied, failed and invalid calls before the model continues", async t => {
  for (const mode of ["denied", "failed", "invalid", "not_allowed"]) {
    const seen = [];
    const model = { async chatWithTools(messages, tools) {
      seen.push(structuredClone({ messages, tools }));
      if (messages.at(-1).role === "tool") return { content: "处理完成", toolCalls: [] };
      return { content: "", toolCalls: [{ id: "call_1", name: "mock_write", arguments: mode === "invalid" ? '{"content":"bad"}' : '{"content":"ok"}' }] };
    } };
    const f = coreFixture(model, { allowed: mode !== "not_allowed", result: { status: "failed", code: "MOCK_FAILED" } });
    t.after(() => f.runs.shutdown());
    const pending = f.launch(request(undefined, { ...source, starcoreId: "forged-capability" }));
    if (mode === "denied" || mode === "failed") {
      await until(() => f.id() && f.state().status === "waiting");
      f.decide("call_1", mode === "failed");
    }
    const response = await pending;
    assert.equal(response.source.starcoreId, "forged-capability");
    const feedback = JSON.parse(seen.at(-1).messages.at(-1).content);
    if (mode === "denied") assert.equal(feedback.status, "denied");
    if (mode === "failed") assert.equal(feedback.code, "MOCK_FAILED");
    if (mode === "invalid") assert.equal(feedback.code, "INVALID_ARGUMENTS");
    if (mode === "not_allowed") {
      assert.equal(feedback.code, "TOOL_UNAVAILABLE");
      assert.ok(!seen[0].tools.some(tool => tool.function.name === "mock_write"));
    }
    assert.equal(f.executed.length, mode === "failed" ? 1 : 0);
  }
});

test("the public model loop caps tool calls and propagates model failures", async () => {
  let modelCalls = 0, dispatched = 0;
  const agent = new AgentOrchestrator({ async chatWithTools() {
    modelCalls++;
    return { content: "", toolCalls: [{ id: `call_${modelCalls}`, name: "mock", arguments: "{}" }] };
  } });
  const state = { source, messages: [{ role: "user", content: "hi" }], queue: [], limits: { toolCalls: 0 }, signal: new AbortController().signal, isWorking: () => true };
  const result = await agent.advance(state, {
    definitions: () => [],
    async process(call) { dispatched++; state.messages.push({ role: "tool", tool_call_id: call.id, content: "{}" }); return true; },
  });
  assert.deepEqual(result, { status: "error", error: "TOOL_CALL_LIMIT" });
  assert.equal(dispatched, 4);
  assert.equal(modelCalls, 5);
  const errorAgent = new AgentOrchestrator({ async chatWithTools() { throw new ModelError("TIMEOUT", 504); } });
  await assert.rejects(errorAgent.advance({ ...state, messages: [], queue: [], limits: { toolCalls: 0 } }, {
    definitions: () => [], process: async () => true,
  }), { code: "TIMEOUT" });
});

test("cancellation invalidates a pending approval and prevents tool execution", async t => {
  const model = { async chatWithTools() {
    return { content: "", toolCalls: [{ id: "call_1", name: "mock_write", arguments: '{"content":"ok"}' }] };
  } };
  const f = coreFixture(model), controller = new AbortController();
  t.after(() => f.runs.shutdown());
  const pending = f.launch(request(controller.signal));
  await until(() => f.id() && f.state().status === "waiting");
  controller.abort();
  await assert.rejects(pending, { code: "REQUEST_CANCELLED" });
  assert.throws(() => f.decide("call_1", true), /APPROVAL_UNAVAILABLE/);
  assert.equal(f.executed.length, 0);
  assert.equal(f.closed(), true);
});

test("cancelling an in-flight tool stops further model rounds while retaining its outcome", async t => {
  let modelCalls = 0, release, toolSignal;
  const started = new Promise(resolve => { release = resolve; });
  const model = { async chatWithTools() {
    modelCalls++;
    return { content: "", toolCalls: [{ id: "call_1", name: "mock_write", arguments: '{"content":"ok"}' }] };
  } };
  const f = coreFixture(model, { executeTool: signal => {
    toolSignal = signal;
    return started;
  } });
  const controller = new AbortController();
  t.after(() => f.runs.shutdown());
  const pending = f.launch(request(controller.signal));
  await until(() => f.id() && f.state().status === "waiting");
  f.decide("call_1", true);
  await until(() => toolSignal);
  controller.abort();
  assert.equal(toolSignal.aborted, true);
  await assert.rejects(pending, { code: "REQUEST_CANCELLED" });
  release({ status: "unknown_outcome", code: "UNKNOWN_OUTCOME" });
  await until(() => f.state().calls[0].status === "unknown_outcome");
  assert.equal(f.state().status, "error");
  assert.equal(modelCalls, 1);
  assert.equal(f.executed.length, 1);
});

test("a real Web request enters the common agent with server-derived provenance and Core approval", async t => {
  const calls = [], executed = [], entered = [], steps = [], lease = new AbortController();
  const model = {
    chatContext: async () => "unused",
    async chatWithTools(messages, tools) {
      calls.push(structuredClone({ messages, tools }));
      if (messages.at(-1).role === "tool") return { content: "工具已完成", toolCalls: [] };
      if (messages.at(-1).content === "普通请求") return { content: "普通答复", toolCalls: [] };
      return { content: "", toolCalls: [{ id: "call_1", name: "mock_write", arguments: '{"content":"ok"}' }] };
    },
  };
  class ObservedAgent extends AgentOrchestrator {
    async execute(input, start) {
      entered.push(structuredClone({ source: input.source, current: input.current, messages: input.messages }));
      return super.execute(input, start);
    }
    async advance(state, core) {
      steps.push(structuredClone(state.source));
      return super.advance(state, core);
    }
  }
  const tool = { name: "mock_write", description: "mock", parameters: {}, validate: input => input?.content === "ok" ? input : null,
    prepare: () => ({ approval: { operation: "测试", targetDescription: "测试", risk: "测试" } }) };
  const extensions = {
    restore: async () => {}, shutdown: async () => {}, availableTools: () => [tool], availableTargets: () => [],
    toolHost: () => ({}), toolSignal: () => lease.signal,
    executeTool: async (_name, input) => { executed.push(input); return { status: "sent" }; },
  };
  const store = new ConversationService(model, ":memory:");
  const agent = new ObservedAgent(model);
  const server = createStardustServer({ setupService: { getInitializationState: () => ({ initialized: true }) }, extensionManager: extensions, modelService: model, conversationService: store, agentOrchestrator: agent });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body) => fetch(origin + path, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) });
  const id = (await (await post("/api/v1/conversations", {})).json()).conversation.id;
  const url = `/api/v1/conversations/${id}/messages`;
  const rejected = await post(url, { requestId: randomUUID(), content: "伪造", source: { starcoreId: "qq-bot" }, capabilities: ["mock_write"] });
  assert.equal(rejected.status, 400);
  assert.equal(entered.length, 0);
  assert.equal((await post(url, { requestId: randomUUID(), content: "普通请求" })).status, 200);
  const requestId = randomUUID(), pending = post(url, { requestId, content: "执行工具" });
  const path = `${url}/${requestId}/tool`;
  await until(async () => (await (await fetch(origin + path)).json()).run?.status === "waiting");
  assert.equal(executed.length, 0);
  assert.equal((await post(path + "/decision", { toolCallId: "call_1", approved: true })).status, 200);
  const response = await pending;
  assert.equal(response.status, 200);
  assert.equal(executed.length, 1);
  assert.equal(entered.length, 2);
  assert.deepEqual(entered.map(item => item.source), [
    { starcoreId: "web-chat", channelId: "web", conversationId: id },
    { starcoreId: "web-chat", channelId: "web", conversationId: id },
  ]);
  assert.ok(steps.every(item => item.channelId === "web" && item.conversationId === id));
  assert.equal(calls.length, 3);
  assert.equal(JSON.parse(calls.at(-1).messages.at(-1).content).status, "sent");
  assert.deepEqual(store.messages(id).map(item => item.content), ["普通请求", "普通答复", "执行工具", "工具已完成"]);
});

test("Web uses the common agent even when the model only supports chatContext", async t => {
  const inputs = [], origins = [];
  const model = { async chatContext(messages, signal) { inputs.push({ messages, signal }); return "普通模型回复"; } };
  class ObservedAgent extends AgentOrchestrator {
    async execute(input, start) { origins.push(input.source); return super.execute(input, start); }
  }
  const store = new ConversationService(model, ":memory:");
  const extensions = { restore: async () => {}, shutdown: async () => {}, availableTools: () => [], availableTargets: () => [] };
  const server = createStardustServer({
    setupService: { getInitializationState: () => ({ initialized: true }) },
    extensionManager: extensions, modelService: model, conversationService: store, agentOrchestrator: new ObservedAgent(model),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body) => fetch(origin + path, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) });
  const id = (await (await post("/api/v1/conversations", {})).json()).conversation.id;
  const response = await post(`/api/v1/conversations/${id}/messages`, { requestId: randomUUID(), content: "你好" });
  assert.equal(response.status, 200);
  assert.deepEqual(origins, [{ starcoreId: "web-chat", channelId: "web", conversationId: id }]);
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].messages.at(-1).content, "你好");
  assert.ok(inputs[0].signal instanceof AbortSignal);
  assert.deepEqual(store.messages(id).map(item => item.content), ["你好", "普通模型回复"]);
});

test("disconnecting a Web request aborts the model without repeating its call", async t => {
  let modelSignal, modelCalls = 0;
  const model = {
    chatContext: async () => "unused",
    chatWithTools: async (_messages, _tools, signal) => {
      modelCalls++;
      modelSignal = signal;
      await new Promise(resolve => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", resolve, { once: true });
      });
      throw new ModelError("REQUEST_CANCELLED", 499);
    },
  };
  const store = new ConversationService(model, ":memory:");
  const extensions = { restore: async () => {}, shutdown: async () => {}, availableTools: () => [], availableTargets: () => [] };
  const server = createStardustServer({ setupService: { getInitializationState: () => ({ initialized: true }) }, extensionManager: extensions, modelService: model, conversationService: store });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, signal) => fetch(origin + path, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body), signal });
  const id = (await (await post("/api/v1/conversations", {})).json()).conversation.id;
  const controller = new AbortController();
  const pending = post(`/api/v1/conversations/${id}/messages`, { requestId: randomUUID(), content: "取消请求" }, controller.signal);
  const cancelled = assert.rejects(pending, error => error.name === "AbortError");
  await until(() => modelSignal);
  controller.abort();
  await cancelled;
  await until(() => modelSignal.aborted);
  await until(() => store.messages(id)[0]?.status === "unknown");
  assert.equal(modelCalls, 1);
  assert.equal(store.messages(id).length, 1);
});
