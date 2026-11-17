import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { assembleContext } from "../apps/server/dist/context-assembler.js";
import { ConversationService } from "../apps/server/dist/conversation.js";
import { createStardustServer } from "../apps/server/dist/app.js";
import { builtInWebContextFlow, runWebContextFlow } from "../apps/server/dist/web-context-flow.js";

const history = [{ role: "user", content: "过去的问题", sequence: 11 }, { role: "assistant", content: "过去的回答", sequence: 12 }];
const entries = [{ id: "cat", topic: "猫", content: "猫住在窗台", sources: [{ conversationId: "other", startSequence: 1, endSequence: 2 }] }];
const options = { conversationId: "session", current: "猫在哪里？", instructions: "系统指令", budgetBytes: 1800, recentLimit: 50, useHistoryTool: true };
function detach(flow, source) {
  const g = flow.graphs.find(g => g.id === "context");
  g.edges = g.edges.filter(e => !(e.from.node === source && e.to.node === "assembler"));
}

test("flow matches the existing assembler and prunes disconnected data sources", async () => {
  const calls = { recent: 0, global: 0 };
  const sources = { recent: () => { calls.recent++; return history; }, global: () => { calls.global++; return entries; } };
  const flow = builtInWebContextFlow();
  const expected = assembleContext(history, options.current, options.conversationId, entries, 1800, 50, options.instructions);
  assert.deepEqual(await runWebContextFlow(flow, sources, options), expected);
  assert.deepEqual(calls, { recent: 1, global: 1 });
  detach(flow, "recent");
  assert.deepEqual(await runWebContextFlow(flow, sources, options), assembleContext([], options.current, options.conversationId, entries, 1800, 50, options.instructions));
  assert.deepEqual(calls, { recent: 1, global: 2 });
  detach(flow, "global");
  assert.deepEqual(await runWebContextFlow(flow, sources, options), assembleContext([], options.current, options.conversationId, [], 1800, 50, options.instructions));
  assert.deepEqual(calls, { recent: 1, global: 2 });
  const separate = builtInWebContextFlow(); detach(separate, "global");
  assert.deepEqual(await runWebContextFlow(separate, sources, options), assembleContext(history, options.current, options.conversationId, [], 1800, 50, options.instructions));
  assert.deepEqual(calls, { recent: 2, global: 2 });
});

test("flow retains budget, overlap, role and no-history-tool semantics", async () => {
  const overlapping = [{ ...entries[0], sources: [{ conversationId: "session", startSequence: 11, endSequence: 12 }] }];
  const sources = { recent: () => history, global: () => overlapping };
  assert.deepEqual(await runWebContextFlow(builtInWebContextFlow(), sources, options), assembleContext(history, options.current, "session", overlapping, 1800, 50, options.instructions));
  let globalCalls = 0;
  const plain = await runWebContextFlow(builtInWebContextFlow(), { ...sources, global: () => { globalCalls++; return entries; } }, { ...options, useHistoryTool: false });
  assert.deepEqual(plain.messages, [...history.map(({ role, content }) => ({ role, content })), { role: "user", content: options.current }]);
  assert.equal(globalCalls, 0);
  await assert.rejects(runWebContextFlow(builtInWebContextFlow(), sources, { ...options, budgetBytes: 20 }), /CONTEXT_FLOW_FAILED: CONTEXT_TOO_LARGE/);
});

test("invalid required connection, provider errors and cancellation never fall back", async () => {
  const flow = builtInWebContextFlow(); detach(flow, "current");
  let calls = 0;
  const sources = { recent: () => { calls++; return history; }, global: () => { calls++; return entries; } };
  await assert.rejects(runWebContextFlow(flow, sources, options), /CONTEXT_FLOW_INVALID: MISSING_REQUIRED_INPUT: assembler.current/); assert.equal(calls, 0);
  const failure = { recent: () => { throw Error("private database detail"); }, global: () => { calls++; return entries; } };
  await assert.rejects(runWebContextFlow(builtInWebContextFlow(), failure, options), /CONTEXT_FLOW_FAILED: NODE_FAILED/); assert.equal(calls, 0);
  const controller = new AbortController();
  const slow = { recent: async signal => { assert.equal(signal, controller.signal); controller.abort(); return history; }, global: () => { calls++; return entries; } };
  await assert.rejects(runWebContextFlow(builtInWebContextFlow(), slow, { ...options, signal: controller.signal }), /CONTEXT_FLOW_CANCELLED: CANCELLED/); assert.equal(calls, 0);
});

test("actual Web request obeys rewired graph, scoped reads, errors and reconnection", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "stardust-web-flow-")), path = join(root, "conversation.sqlite");
  const calls = [], flow = builtInWebContextFlow();
  const model = { chatContext: async () => { throw Error("unexpected plain model"); }, chatWithTools: async messages => { calls.push(structuredClone(messages)); return { content: "答复", toolCalls: [] }; } };
  const store = new ConversationService(model, path, 48000, 50, { contextFlow: { enabled: true, definition: flow } });
  const db = new DatabaseSync(path);
  const insert = db.prepare("INSERT INTO global_context_entries (id,owner,topic,content,created_at,updated_at,version) VALUES (?,?,?,?,?,?,1)");
  insert.run("web-entry", "web:default", "猫", "猫全局记忆", "2026", "2026");
  insert.run("qq-entry", "unbound:qq", "猫", "猫私密QQ记忆", "2026", "2026"); db.close();
  const recentIds = [], owners = [], originalMessages = store.messages.bind(store), originalEntries = store.globalContext.entries.bind(store.globalContext);
  store.messages = (...args) => { recentIds.push(args[0]); return originalMessages(...args); };
  store.globalContext.entries = owner => { owners.push(owner); return originalEntries(owner); };
  const extensions = { restore: async () => {}, shutdown: async () => {}, availableTools: () => [], availableTargets: () => [] };
  const server = createStardustServer({ setupService: { getInitializationState: () => ({ initialized: true }) }, extensionManager: extensions, modelService: model, conversationService: store });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = (url, body) => fetch(origin + url, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) });
  const a = (await (await post("/api/v1/conversations", { title: "A" })).json()).conversation.id;
  const b = (await (await post("/api/v1/conversations", { title: "B" })).json()).conversation.id;
  const send = async (id, content) => { const response = await post(`/api/v1/conversations/${id}/messages`, { requestId: randomUUID(), content }); assert.equal(response.status, 200); return response.json(); };
  await send(a, "猫之前说过A");
  assert.equal(calls.length, 1); assert.equal(recentIds.length, 1); assert.deepEqual(owners, ["web:default"]);
  assert.ok(calls[0].some(m => m.content?.includes("猫全局记忆"))); assert.ok(!JSON.stringify(calls[0]).includes("猫私密QQ记忆"));
  await send(b, "猫之前说过B");
  assert.ok(!JSON.stringify(calls[1]).includes("猫之前说过A"));
  const child = flow.graphs.find(g => g.id === "context");
  const globalEdge = child.edges.find(e => e.from.node === "global" && e.to.node === "assembler");
  detach(flow, "global"); let before = { recent: recentIds.length, global: owners.length };
  await send(a, "猫断开全局");
  assert.equal(recentIds.length, before.recent + 1); assert.equal(owners.length, before.global);
  assert.ok(JSON.stringify(calls.at(-1)).includes("猫之前说过A")); assert.ok(!JSON.stringify(calls.at(-1)).includes("猫全局记忆"));
  child.edges.push(globalEdge); before = { recent: recentIds.length, global: owners.length };
  await send(a, "猫重新连接全局"); assert.equal(owners.length, before.global + 1); assert.ok(JSON.stringify(calls.at(-1)).includes("猫全局记忆"));
  const recentEdge = child.edges.find(e => e.from.node === "recent" && e.to.node === "assembler");
  detach(flow, "recent"); before = { recent: recentIds.length, global: owners.length };
  await send(a, "猫断开近期"); assert.equal(recentIds.length, before.recent); assert.equal(owners.length, before.global + 1);
  assert.ok(!JSON.stringify(calls.at(-1)).includes("猫之前说过A")); assert.ok(JSON.stringify(calls.at(-1)).includes("猫全局记忆"));
  detach(flow, "global"); before = { recent: recentIds.length, global: owners.length };
  await send(a, "猫都断开"); assert.deepEqual({ recent: recentIds.length, global: owners.length }, before);
  assert.ok(!JSON.stringify(calls.at(-1)).includes("猫之前说过A")); assert.ok(!JSON.stringify(calls.at(-1)).includes("猫全局记忆"));
  child.edges.push(recentEdge, globalEdge); before = { recent: recentIds.length, global: owners.length };
  await send(a, "猫恢复全部"); assert.equal(recentIds.length, before.recent + 1); assert.equal(owners.length, before.global + 1);
  assert.ok(recentIds.every(id => id === a || id === b)); assert.ok(owners.every(owner => owner === "web:default"));
  assert.equal(calls.length, 7);
  const qq = store.create("QQ", "qq");
  const forged = await post(`/api/v1/conversations/${qq.id}/messages`, { requestId: randomUUID(), content: "猫", owner: "web:default" });
  assert.equal(forged.status, 404); assert.equal(calls.length, 7);
  assert.equal((await post(`/api/v1/conversations/${a}/messages`, { requestId: randomUUID(), content: "猫", scope: "unbound:qq" })).status, 400);
  detach(flow, "current"); before = { recent: recentIds.length, global: owners.length };
  const bad = await post(`/api/v1/conversations/${a}/messages`, { requestId: randomUUID(), content: "猫错误" });
  assert.equal(bad.status, 500); assert.deepEqual(await bad.json(), { error: "CONTEXT_FLOW_INVALID", reason: "MISSING_REQUIRED_INPUT: assembler.current" });
  assert.equal(calls.length, 7); assert.deepEqual({ recent: recentIds.length, global: owners.length }, before);
  child.edges.push({ from: { node: "current", port: "value" }, to: { node: "assembler", port: "current" } });
  store.readRecentContext = () => { throw new Error("secret database failure"); };
  const failed = await post(`/api/v1/conversations/${a}/messages`, { requestId: randomUUID(), content: "猫错误" });
  assert.equal(failed.status, 500); assert.deepEqual(await failed.json(), { error: "CONTEXT_FLOW_FAILED", reason: "NODE_FAILED" });
  assert.equal(calls.length, 7);
});

test("default and explicitly disabled flow preserve the legacy path", async () => {
  const captures = [], model = { chatContext: async messages => { captures.push(messages); return "ok"; }, chatWithTools: async () => ({ content: "ok", toolCalls: [] }) };
  const invalid = builtInWebContextFlow(); detach(invalid, "current");
  const store = new ConversationService(model, ":memory:", 48000, 50, { contextFlow: { enabled: false, definition: invalid } });
  try { const id = store.create().id; await store.submit(id, randomUUID(), "首条"); await store.submit(id, randomUUID(), "第二条"); assert.deepEqual(captures[1].slice(-3).map(m => m.content), ["首条", "ok", "第二条"]); }
  finally { store.close(); }
});

test("request cancellation and source errors stop before persistence or model dispatch", async () => {
  let models = 0, release, started;
  const model = { chatContext: async () => { models++; return "ok"; }, chatWithTools: async () => ({ content: "ok", toolCalls: [] }) };
  const store = new ConversationService(model, ":memory:", 48000, 50, { contextFlow: { enabled: true } });
  try {
    const id = store.create().id, signal = new AbortController();
    store.readRecentContext = () => new Promise(resolve => { release = resolve; started?.(); });
    const ready = new Promise(resolve => { started = resolve; });
    const pending = store.submit(id, randomUUID(), "猫", false, undefined, { signal: signal.signal });
    await ready;
    await assert.rejects(store.submit(id, randomUUID(), "并发"), /CONVERSATION_BUSY/);
    signal.abort(); release([]);
    await assert.rejects(pending, /CONTEXT_FLOW_CANCELLED/);
    assert.equal(models, 0); assert.deepEqual(store.messages(id), []);
    store.readRecentContext = () => { throw Error("private source failure"); };
    await assert.rejects(store.submit(id, randomUUID(), "猫"), /CONTEXT_FLOW_FAILED: NODE_FAILED/);
    assert.equal(models, 0); assert.deepEqual(store.messages(id), []);
  } finally { store.close(); }
});

test("the process switch enables Web graphs while non-Web conversations stay on their existing path", async () => {
  const previous = process.env.STARDUST_WEB_CONTEXT_FLOW; process.env.STARDUST_WEB_CONTEXT_FLOW = "1";
  const seen = [], model = { chatContext: async messages => { seen.push(messages); return "ok"; } };
  const store = new ConversationService(model, ":memory:");
  try {
    const web = store.create().id, qq = store.create("QQ", "qq").id;
    const original = store.readRecentContext.bind(store); let asynchronousReads = 0;
    store.readRecentContext = id => id === web ? (asynchronousReads++, Promise.resolve(original(id))) : original(id);
    await store.submit(web, randomUUID(), "Web输入");
    await store.submit(qq, randomUUID(), "QQ输入");
    assert.equal(asynchronousReads, 1);
    assert.deepEqual(seen.map(messages => messages.at(-1).content), ["Web输入", "QQ输入"]);
    process.env.STARDUST_WEB_CONTEXT_FLOW = "0"; store.readRecentContext = original;
    await store.submit(web, randomUUID(), "关闭图");
    assert.deepEqual(seen.at(-1).map(message => message.content), ["Web输入", "ok", "关闭图"]);
  } finally {
    store.close(); if (previous === undefined) delete process.env.STARDUST_WEB_CONTEXT_FLOW; else process.env.STARDUST_WEB_CONTEXT_FLOW = previous;
  }
});
