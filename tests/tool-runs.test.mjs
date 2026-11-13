import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { ExtensionManager } from "../apps/server/dist/extension-manager.js";
import { qqSendMessageTool } from "../apps/server/dist/extensions/qq-send-message.js";
import { ToolRuns } from "../apps/server/dist/tool-runs.js";
import { collectModelTurn } from "../apps/server/dist/model-stream.js";
import { AdminAuth } from "../apps/server/dist/admin-auth.js";
import { createStardustServer } from "../apps/server/dist/app.js";
import { createConfigStore } from "../apps/server/dist/config.js";
import { SetupService } from "../apps/server/dist/setup.js";
import { LogService } from "../apps/server/dist/logger.js";
import { createQQBotExtension } from "../apps/server/dist/extensions/qq-bot.js";
import { ModelService } from "../apps/server/dist/model.js";
import { createSecretStore } from "../apps/server/dist/model-secret.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "stardust-tool-"));
  const targetId = randomUUID(); const sent = [];
  let targets = [{ id: targetId, scope: "private", description: "测试私聊", expiresAt: new Date(Date.now() + 60000).toISOString() }];
  let sendResult = { status: "sent" };
  const channel = { manifest: { id: "qq-bot", name: "Mock", version: "1", description: "", type: "channel", fields: [] }, tools: [qqSendMessageTool], create(_config, host) { return {
    start() { host.status("connected"); }, stop() {},
    listMessageTargets() { return targets; },
    async sendMessage(target, content) { sent.push({ target, content }); return sendResult; },
  }; } };
  const logs = new LogService(100, () => {});
  const extensions = new ExtensionManager(root, { chat: async () => "reply" }, [channel], logs);
  await extensions.install("qq-bot"); await extensions.enable("qq-bot");
  await extensions.setToolEnabled("qq-bot", "send_message", true);
  const calls = [];
  const model = { async chatWithTools(messages, tools) {
    calls.push(structuredClone({ messages, tools }));
    if (messages.some((entry) => entry.role === "tool")) return { content: "最终回答", toolCalls: [] };
    return { content: "", toolCalls: [{ id: "call_1", name: "send_message", arguments: JSON.stringify({ channel: "qq-bot", target: targetId, content: "你好" }) }] };
  } };
  const runs = new ToolRuns(model, extensions, logs);
  t.after(async () => { runs.shutdown(); await extensions.shutdown(); await rm(root, { recursive: true, force: true }); });
  return { root, targetId, sent, extensions, model, runs, calls, logs, setTargets(value) { targets = value; }, setResult(value) { sendResult = value; } };
}
async function until(fn) {
  for (let i = 0; i < 200; i++) { const value = fn(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 5)); }
  throw new Error("timed out");
}

test("tool approval binds immutable arguments, executes once, and returns the result to the model", async (t) => {
  const f = await fixture(t);
  const id = f.runs.start("owner", "发送消息");
  const waiting = await until(() => { const run = f.runs.get("owner", id); return run.status === "waiting" && run; });
  assert.equal(waiting.calls[0].input.content, "你好"); assert.equal(f.sent.length, 0);
  waiting.calls[0].input.content = "tampered";
  f.runs.decide("owner", id, "call_1", true);
  assert.throws(() => f.runs.decide("owner", id, "call_1", true), /APPROVAL_UNAVAILABLE/);
  const done = await until(() => { const run = f.runs.get("owner", id); return run.status === "done" && run; });
  assert.equal(done.reply, "最终回答"); assert.deepEqual(f.sent, [{ target: f.targetId, content: "你好" }]);
  assert.equal(f.calls[1].messages.at(-1).tool_call_id, "call_1");
  assert.equal(JSON.parse(f.calls[1].messages.at(-1).content).status, "sent");
  assert.throws(() => f.runs.get("other-owner", id), /RUN_NOT_FOUND/);
  assert.doesNotMatch(JSON.stringify(f.logs.read()), /你好/);
});

test("denial, disabled tool or channel, missing target and ambiguous targets never send", async (t) => {
  const f = await fixture(t);
  const run = f.runs.start("owner", "send");
  await until(() => f.runs.get("owner", run).status === "waiting");
  f.runs.decide("owner", run, "call_1", false);
  await until(() => f.runs.get("owner", run).status === "done");
  assert.equal(f.sent.length, 0); assert.equal(JSON.parse(f.calls.at(-1).messages.at(-1).content).status, "denied");
  const second = f.runs.start("owner", "send");
  await until(() => f.runs.get("owner", second).status === "waiting");
  await f.extensions.setToolEnabled("qq-bot", "send_message", false);
  await f.extensions.setToolEnabled("qq-bot", "send_message", true);
  assert.throws(() => f.runs.decide("owner", second, "call_1", true), /APPROVAL_UNAVAILABLE/);
  await until(() => f.runs.get("owner", second).status === "done");
  assert.equal(f.runs.get("owner", second).calls[0].result.code, "TOOL_DISABLED"); assert.equal(f.sent.length, 0);
  const third = f.runs.start("owner", "send");
  await until(() => f.runs.get("owner", third).status === "waiting");
  await f.extensions.disable("qq-bot");
  await f.extensions.enable("qq-bot");
  assert.throws(() => f.runs.decide("owner", third, "call_1", true), /APPROVAL_UNAVAILABLE/);
  await until(() => f.runs.get("owner", third).status === "done");
  assert.ok(["CHANNEL_UNAVAILABLE", "TOOL_DISABLED"].includes(f.runs.get("owner", third).calls[0].result.code)); assert.equal(f.sent.length, 0);
  f.setTargets([]);
  const missing = f.runs.start("owner", "send"); await until(() => f.runs.get("owner", missing).status === "done");
  assert.equal(f.runs.get("owner", missing).calls[0].result.code, "TARGET_UNAVAILABLE");
  f.setTargets([{ id: f.targetId, scope: "private", description: "one", expiresAt: new Date(Date.now() + 60000).toISOString() }, { id: randomUUID(), scope: "private", description: "two", expiresAt: new Date(Date.now() + 60000).toISOString() }]);
  const ambiguous = f.runs.start("owner", "send"); await until(() => f.runs.get("owner", ambiguous).status === "done");
  assert.equal(f.runs.get("owner", ambiguous).calls[0].result.code, "TARGET_AMBIGUOUS"); assert.equal(f.sent.length, 0);
});

test("expired approval and unknown delivery results are returned without retry", async (t) => {
  const f = await fixture(t);
  f.setTargets([{ id: f.targetId, scope: "private", description: "测试私聊", expiresAt: new Date(Date.now() + 80).toISOString() }]);
  const expired = f.runs.start("owner", "send");
  await until(() => f.runs.get("owner", expired).status === "waiting");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.throws(() => f.runs.decide("owner", expired, "call_1", true), /APPROVAL_UNAVAILABLE/);
  await until(() => f.runs.get("owner", expired).status === "done"); assert.equal(f.sent.length, 0);
  f.setTargets([{ id: f.targetId, scope: "private", description: "测试私聊", expiresAt: new Date(Date.now() + 60000).toISOString() }]);
  f.setResult({ status: "unknown_outcome", code: "UNKNOWN_OUTCOME" });
  const unknown = f.runs.start("owner", "send"); await until(() => f.runs.get("owner", unknown).status === "waiting");
  f.runs.decide("owner", unknown, "call_1", true); await until(() => f.runs.get("owner", unknown).status === "done");
  assert.equal(f.sent.length, 1); assert.equal(f.runs.get("owner", unknown).calls[0].result.status, "unknown_outcome");
});

test("streaming tool_calls reassemble arguments split across UTF-8 and SSE chunks", async () => {
  const events = [
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_", type: "function", function: { name: "send_", arguments: "{\"content\":\"你" } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "1", function: { name: "message", arguments: "好\"}" } }] } }] },
  ];
  const bytes = new TextEncoder().encode(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n");
  const body = new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
  const response = new Response(body, { headers: { "Content-Type": "text/event-stream" } });
  const turn = await collectModelTurn(response, new AbortController().signal, 10240, () => new Error("invalid"), () => new Error("incomplete"), async () => new Error("upstream"));
  assert.deepEqual(turn.toolCalls, [{ id: "call_1", name: "send_message", arguments: "{\"content\":\"你好\"}" }]);
});

test("tool HTTP endpoints require a same-origin local administrator session", async (t) => {
  const f = await fixture(t); const setup = new SetupService(createConfigStore(f.root)); await setup.completeInitialization({});
  const token = "a-secure-test-token-at-least-32-characters";
  const server = createStardustServer({ setupService: setup, extensionManager: f.extensions, modelService: f.model, adminAuth: new AdminAuth(token) });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { if (server.listening) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); } });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, headers = {}) => fetch(origin + path, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin, ...headers }, body: JSON.stringify(body) });
  assert.equal((await post("/api/v1/tool-runs", { message: "hello" })).status, 401);
  assert.equal((await post("/api/v1/admin/login", { token }, { Origin: "https://evil.example" })).status, 403);
  assert.equal((await post("/api/v1/admin/login", { token: "incorrect" })).status, 401);
  const login = await post("/api/v1/admin/login", { token }); assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0]; assert.match(login.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
  const response = await post("/api/v1/tool-runs", { message: "hello" }, { Cookie: cookie }); assert.equal(response.status, 202);
  const { id } = await response.json();
  assert.equal((await fetch(`${origin}/api/v1/tool-runs/${id}`)).status, 401);
  const state = await fetch(`${origin}/api/v1/tool-runs/${id}`, { headers: { Cookie: cookie } }); assert.equal(state.status, 200);
  assert.doesNotMatch(await state.text(), new RegExp(token));
});

test("model tool responses are validated in non-streaming and streaming modes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stardust-tool-model-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createConfigStore(root); store.initializeConfig({});
  const secret = createSecretStore(root, {});
  const payloads = [];
  let stream = false; let fail = false;
  const request = async (_url, init) => {
    payloads.push(JSON.parse(init.body));
    if (fail) return Response.json({ error: { code: "unsupported", message: "tools unsupported" } }, { status: 400 });
    if (stream) return new Response('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"send_message","arguments":"{\\\"x\\\":"}}]}}]}\n\ndata: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}}]}}]}\n\ndata: [DONE]\n\n', { headers: { "Content-Type": "text/event-stream" } });
    return Response.json({ choices: [{ message: { content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "send_message", arguments: "{\"x\":1}" } }] } }] });
  };
  const model = new ModelService(store, secret, request, new LogService(100, () => {}));
  model.saveConfig({ baseUrl: "http://127.0.0.1:9999/v1", modelId: "mock", timeoutMs: 3000, stream: false, keyAction: "keep" });
  const schema = [{ type: "function", function: { name: "send_message", description: "send", parameters: { type: "object" } } }];
  let turn = await model.chatWithTools([{ role: "user", content: "hello" }], schema);
  assert.equal(turn.toolCalls[0].arguments, "{\"x\":1}"); assert.equal(payloads[0].tools[0].function.name, "send_message"); assert.equal(payloads[0].stream, false);
  stream = true;
  model.saveConfig({ baseUrl: "http://127.0.0.1:9999/v1", modelId: "mock", timeoutMs: 3000, stream: true, keyAction: "keep" });
  turn = await model.chatWithTools([{ role: "user", content: "hello" }], schema);
  assert.equal(turn.toolCalls[0].arguments, "{\"x\":1}"); assert.equal(payloads[1].stream, true);
  fail = true;
  await assert.rejects(model.chatWithTools([{ role: "user", content: "hello" }], schema), { code: "UPSTREAM_BAD_REQUEST" });
});

test("tool calls are bounded even when the model repeatedly calls unavailable tools", async (t) => {
  const f = await fixture(t);
  let count = 0;
  const model = { async chatWithTools() { return { content: "", toolCalls: [{ id: `call_${++count}`, name: "not_installed", arguments: "{}" }] }; } };
  const runs = new ToolRuns(model, f.extensions, f.logs); t.after(() => runs.shutdown());
  const id = runs.start("owner", "hello");
  await until(() => runs.get("owner", id).status === "error");
  assert.equal(runs.get("owner", id).error, "TOOL_CALL_LIMIT"); assert.equal(f.sent.length, 0);
});

test("QQ channel forwards a confirmed tool call once and ordinary passive replies survive tool removal", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stardust-tool-qq-")); const handlers = new Map(), sends = [], outbound = []; let finish;
  let mode = "success";
  const bot = {
    tokenManager: { async getAccessToken() { return "fake-token"; } },
    on(name, fn) { handlers.set(name, fn); return this; },
    start() { handlers.get("ready")(); return new Promise((resolve) => { finish = resolve; }); },
    stop() { finish?.(); },
    async sendText(target, content) { sends.push({ target, content }); return { id: "passive-sent" }; },
  };
  const qq = createQQBotExtension(async () => bot, async (url, request) => {
    outbound.push({ url, body: JSON.parse(request.body) });
    if (mode === "network") throw new Error("network");
    if (mode === "reject") return Response.json({ code: 22009, message: "permission denied" }, { status: 403 });
    return Response.json({ id: "tool-sent" });
  });
  const manager = new ExtensionManager(root, { chat: async () => "正常被动回复" }, [qq], new LogService(100, () => {}));
  t.after(async () => { await manager.shutdown(); await rm(root, { recursive: true, force: true }); });
  await manager.install("qq-bot"); await manager.saveConfig("qq-bot", { appId: "123", appSecret: "fake-secret" }); await manager.enable("qq-bot");
  await manager.setToolEnabled("qq-bot", "send_message", true);
  await until(() => handlers.has("message"));
  const msg = (id) => ({ kind: "c2c", rawEventType: "C2C_MESSAGE_CREATE", senderId: "private-user", messageId: id, timestamp: new Date().toISOString(), content: "hi", replyTarget: { scope: "c2c", targetId: "private-openid", msgId: id } });
  await handlers.get("message")({}, msg("original-one"));
  const target = manager.availableTargets()[0].targets[0];
  assert.doesNotMatch(JSON.stringify(target), /private-openid|private-user/);
  const result = await manager.executeTool("send_message", { channel: "qq-bot", target: target.id, content: "主动测试" }, new AbortController().signal);
  assert.equal(result.status, "sent"); assert.equal(outbound.length, 1); assert.equal(outbound[0].body.content, "主动测试"); assert.ok(!("msg_id" in outbound[0].body));
  await handlers.get("message")({}, { ...msg("tool-sent"), content: "主动测试" });
  assert.equal(sends.length, 1);
  mode = "reject";
  const rejected = await manager.executeTool("send_message", { channel: "qq-bot", target: target.id, content: "主动测试" }, new AbortController().signal);
  assert.equal(rejected.status, "rejected"); assert.equal(rejected.httpStatus, 403); assert.equal(rejected.code, "22009"); assert.equal(outbound.length, 2);
  mode = "network";
  const unknown = await manager.executeTool("send_message", { channel: "qq-bot", target: target.id, content: "主动测试" }, new AbortController().signal);
  assert.equal(unknown.status, "unknown_outcome"); assert.equal(outbound.length, 3);
  await manager.setToolEnabled("qq-bot", "send_message", false);
  await handlers.get("message")({}, msg("original-two"));
  assert.equal(sends.length, 2); assert.equal(sends[1].target.msgId, "original-two");
});

test("uninstalling the owner removes its Tool without affecting unrelated services", async (t) => {
  const f = await fixture(t);
  await f.extensions.uninstall("qq-bot", false);
  assert.equal(f.extensions.availableTools().length, 0);
  const result = await f.extensions.executeTool("send_message", { channel: "qq-bot", target: f.targetId, content: "hello" }, new AbortController().signal);
  assert.equal(result.status, "unavailable"); assert.equal(result.code, "TOOL_DISABLED");
  await f.extensions.install("qq-bot"); await f.extensions.enable("qq-bot");
  assert.equal(f.extensions.list()[0].tools[0].enabled, true);
  assert.equal(f.extensions.availableTools().length, 1);
});

test("migration write failure keeps the original installation file unchanged", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stardust-tool-migrate-fail-")); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "data"));
  const path = join(root, "data", "extensions.json");
  const original = JSON.stringify({ "qq-bot": { enabled: true }, "send-message": { enabled: true } });
  await writeFile(path, original);
  const manager = new ExtensionManager(root, undefined, [createQQBotExtension()]); t.after(() => manager.shutdown());
  const rename = t.mock.method(fs, "renameSync", () => { throw new Error("simulated failure"); });
  assert.throws(() => manager.list(), { code: "STATE_UNAVAILABLE" });
  rename.mock.restore();
  assert.equal(await readFile(path, "utf8"), original);
  assert.equal(manager.list()[0].tools[0].enabled, true);
});

test("QQ manifest exposes controlled page declarations and Tool state through management API", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stardust-tool-pages-")); t.after(() => rm(root, { recursive: true, force: true }));
  const manager = new ExtensionManager(root, undefined, [createQQBotExtension()]); t.after(() => manager.shutdown());
  const setup = new SetupService(createConfigStore(root)); await setup.completeInitialization({});
  const server = createStardustServer({ setupService: setup, extensionManager: manager });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { if (server.listening) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); } });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = (action, body) => fetch(`${origin}/api/v1/extensions/qq-bot/${action}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await post("install", {})).status, 200);
  let data = (await (await fetch(`${origin}/api/v1/extensions`)).json()).extensions;
  assert.deepEqual(data[0].managementPages.map((page) => page.pageKind), ["config", "qq-capabilities", "tools", "skills"]);
  assert.deepEqual(data[0].skills, []); assert.equal(data[0].tools[0].name, "send_message"); assert.equal(data[0].tools[0].enabled, false);
  assert.equal((await post("tool", { name: "send_message", enabled: true })).status, 200);
  data = (await (await fetch(`${origin}/api/v1/extensions`)).json()).extensions;
  assert.equal(data[0].tools[0].enabled, true); assert.equal(data[0].tools[0].available, false);
  assert.equal((await post("tool", { name: "unknown", enabled: true })).status, 404);
});

test("legacy Tool state migrates atomically to its declared owner without overriding explicit settings", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stardust-tool-migrate-")); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "data"));
  const path = join(root, "data", "extensions.json");
  const qq = createQQBotExtension(async () => { throw new Error("not started"); });
  await writeFile(path, JSON.stringify({ "qq-bot": { enabled: false, tools: { send_message: false }, extra: "keep" }, "send-message": { enabled: true }, other: { enabled: false, extra: "preserve" } }));
  const manager = new ExtensionManager(root, undefined, [qq]); t.after(() => manager.shutdown());
  const first = manager.list()[0];
  assert.equal(first.installed, true); assert.equal(first.tools[0].enabled, false);
  let saved = JSON.parse(await readFile(path, "utf8"));
  assert.equal(saved["send-message"], undefined); assert.equal(saved["qq-bot"].tools.send_message, false);
  assert.equal(saved["qq-bot"].extra, "keep"); assert.equal(saved.other.extra, "preserve");
  await writeFile(path, JSON.stringify({ "qq-bot": { enabled: true }, "send-message": { enabled: true } }));
  assert.equal(manager.list()[0].tools[0].enabled, true);
  saved = JSON.parse(await readFile(path, "utf8")); assert.equal(saved["send-message"], undefined); assert.equal(saved["qq-bot"].enabled, true);
  await writeFile(path, JSON.stringify({ "send-message": { enabled: true } }));
  const missingOwner = manager.list()[0]; assert.equal(missingOwner.installed, false);
  saved = JSON.parse(await readFile(path, "utf8"));
  assert.equal(saved["send-message"], undefined); assert.equal(saved["qq-bot"].installed, false); assert.equal(saved["qq-bot"].tools.send_message, true);
  await manager.install("qq-bot");
  assert.equal(manager.list()[0].tools[0].enabled, true);
  await manager.shutdown();
  const restored = new ExtensionManager(root, undefined, [qq]); t.after(() => restored.shutdown());
  assert.equal(restored.list()[0].tools[0].enabled, true);
});
