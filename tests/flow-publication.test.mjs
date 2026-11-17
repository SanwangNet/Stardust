import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { FlowPublication } from "../apps/server/dist/flow-publication.js";
import { ConversationService } from "../apps/server/dist/conversation.js";
import { createStardustServer } from "../apps/server/dist/app.js";
import { AdminAuth } from "../apps/server/dist/admin-auth.js";

test("draft CAS, validation, atomic publish and restart recovery", async () => {
  const dir = mkdtempSync(join(tmpdir(), "stardust-flow-")), path = join(dir, "flows.json"), store = new FlowPublication(path);
  try {
    const initial = store.read();
    assert.throws(() => store.save(initial.revision, { recent: true, global: false, search: true, node: "forged" }), /INVALID_CONNECTIONS/);
    const draft = store.save(initial.revision, { recent: true, global: false, search: true });
    assert.equal(store.read().published.connections.global, true);
    assert.throws(() => store.save(initial.revision, initial.draft), /FLOW_CONFLICT/);
    await store.validate(draft.draft); const published = await store.publish(draft.revision);
    assert.equal(new FlowPublication(path).read().published.connections.global, false);
    assert.equal(published.previous.id, "default");
    assert.throws(() => store.save(published.revision, { recent: "bad", global: true, search: true }), /INVALID_CONNECTIONS/);
  } finally { const rel = relative(tmpdir(), dir); assert.ok(rel && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel)); rmSync(dir, { recursive: true, force: true }); }
});

test("authorized Web publish changes next request but not draft or in-flight request", async t => {
  const env = ["STARDUST_FLOW_EDITOR", "STARDUST_WEB_CONTEXT_FLOW", "STARDUST_WEB_TOOL_FLOW"], previous = env.map(k => process.env[k]);
  env.forEach(k => { process.env[k] = "1"; });
  const dir = mkdtempSync(join(tmpdir(), "stardust-flow-http-")), flow = new FlowPublication(join(dir, "flows.json"));
  const contexts = [], toolsSeen = [], searches = []; let globalReads = 0, recentReads = 0, hold, entered;
  const model = { chatContext: async () => "unused", chatWithTools: async (messages, tools) => {
    contexts.push(structuredClone(messages)); toolsSeen.push(structuredClone(tools));
    if (messages.at(-1).role === "tool") return { content: "答复", toolCalls: [] };
    return { content: "", toolCalls: [{ id: "lookup", name: "search_history", arguments: '{"keywords":["猫"]}' }] };
  } };
  const store = new ConversationService(model, ":memory:");
  const recent = store.readRecentContext.bind(store); store.readRecentContext = async id => { recentReads++; if (hold) { entered?.(); await hold; } return recent(id); };
  store.globalContext.entries = () => { globalReads++; return [{ id: "g", topic: "猫", content: "猫在窗台", sources: [] }]; };
  store.searchHistory = () => { searches.push(true); return []; };
  const extensions = { restore: async () => {}, shutdown: async () => {}, availableTools: () => [], availableTargets: () => [] };
  const token = "a-secure-test-token-at-least-32-characters";
  const server = createStardustServer({ setupService: { getInitializationState: () => ({ initialized: true }) }, extensionManager: extensions, modelService: model, conversationService: store, adminAuth: new AdminAuth(token), flowPublication: flow });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); env.forEach((k, i) => previous[i] === undefined ? delete process.env[k] : process.env[k] = previous[i]); const rel = relative(tmpdir(), dir); assert.ok(rel && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel)); rmSync(dir, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = (url, data, cookie = "") => fetch(origin + url, { method: "POST", headers: { origin, cookie, "content-type": "application/json" }, body: JSON.stringify(data) });
  assert.equal((await fetch(origin + "/api/v1/flow-publication")).status, 403);
  const login = await post("/api/v1/admin/login", { token }), cookie = login.headers.get("set-cookie").split(";")[0];
  const get = async () => (await (await fetch(origin + "/api/v1/flow-publication", { headers: { cookie } })).json());
  let state = await get(); assert.equal(state.graphs.context.graphs[1].id, "context"); assert.equal(state.graphs.tools.graphs[1].interface.inputs[0].label, "模型请求准备");
  assert.equal((await post("/api/v1/flow-publication/save", { revision: state.revision, connections: { recent: true, global: false, search: true, type: "tool" } }, cookie)).status, 400);
  const id = (await (await post("/api/v1/conversations", {})).json()).conversation.id;
  const send = () => post(`/api/v1/conversations/${id}/messages`, { requestId: randomUUID(), content: "猫" });
  let saved = await (await post("/api/v1/flow-publication/save", { revision: state.revision, connections: { recent: false, global: false, search: false } }, cookie)).json();
  assert.equal((await send()).status, 200); assert.equal(globalReads, 1); assert.equal(recentReads, 1); assert.equal(searches.length, 1);
  assert.equal((await post("/api/v1/flow-publication/publish", { revision: state.revision }, cookie)).status, 409);
  let release; hold = new Promise(r => { release = r; }); const ready = new Promise(r => { entered = r; });
  const pending = send(); await ready;
  assert.equal((await post("/api/v1/flow-publication/validate", { revision: saved.revision }, cookie)).status, 200);
  saved = await (await post("/api/v1/flow-publication/publish", { revision: saved.revision }, cookie)).json();
  hold = undefined; release(); assert.equal((await pending).status, 200);
  assert.equal(globalReads, 2); assert.equal(searches.length, 2);
  assert.equal((await send()).status, 200); assert.equal(globalReads, 2); assert.equal(recentReads, 2); assert.equal(searches.length, 2);
  assert.ok(!toolsSeen.at(-2).some(t => t.function.name === "search_history")); assert.equal(JSON.parse(contexts.at(-1).at(-1).content).error, "TOOL_UNAVAILABLE");
  state = await get(); saved = await (await post("/api/v1/flow-publication/reset", { revision: state.revision }, cookie)).json();
  await post("/api/v1/flow-publication/publish", { revision: saved.revision }, cookie);
  assert.equal((await send()).status, 200); assert.equal(globalReads, 3); assert.equal(recentReads, 3); assert.equal(searches.length, 3);
  const publish = async connections => { const s = await get(); const draft = await (await post("/api/v1/flow-publication/save", { revision: s.revision, connections }, cookie)).json(); assert.equal((await post("/api/v1/flow-publication/publish", { revision: draft.revision }, cookie)).status, 200); };
  await publish({ recent: false, global: true, search: true }); await send(); assert.equal(recentReads, 3); assert.equal(globalReads, 4); assert.equal(searches.length, 4);
  await publish({ recent: true, global: false, search: true }); await send(); assert.equal(recentReads, 4); assert.equal(globalReads, 4); assert.equal(searches.length, 5);
  await publish({ recent: true, global: true, search: false }); await send(); assert.equal(recentReads, 5); assert.equal(globalReads, 5); assert.equal(searches.length, 5);
});
