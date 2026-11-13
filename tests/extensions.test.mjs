import assert from "node:assert/strict";
import fs from "node:fs";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";
import { createConfigStore } from "../apps/server/dist/config.js";
import { createSecretStore } from "../apps/server/dist/model-secret.js";
import { ModelService } from "../apps/server/dist/model.js";
import { createEnvLoader } from "../apps/server/dist/env.js";
import { ExtensionManager } from "../apps/server/dist/extension-manager.js";
import { createQQBotExtension } from "../apps/server/dist/extensions/qq-bot.js";
import { SetupService } from "../apps/server/dist/setup.js";
import { createStardustServer } from "../apps/server/dist/app.js";
import { LogService } from "../apps/server/dist/logger.js";
import { dispatchEvent } from "@tencent-connect/qqbot-nodejs/protocol";

function mockBot() {
  const handlers = new Map();
  let finish;
  const bot = {
    sent: [], streamCalls: [], stopped: false, failSend: false, failStreamAt: -1,
    tokenManager: { async getAccessToken() { return "private-token"; } },
    on(name, handler) { handlers.set(name, handler); return this; },
    start() { handlers.get("ready")?.(); return new Promise((resolve) => { finish = resolve; }); },
    stop() { this.stopped = true; finish?.(); },
    async sendText(target, text) { if (this.failSend) throw Object.assign(new Error("secret-and-message"), { bizCode: 11281, httpStatus: 429 }); this.sent.push({ target, text }); return { id: `sent-${this.sent.length}` }; },
    emit(name, value) { return handlers.get(name)?.({}, value); },
  };
  bot.getCredentials = () => ({ appId: "123", clientSecret: "private-secret" });
  bot.messageApi = { async sendC2CStreamMessage(credentials, openid, request) {
    bot.streamCalls.push({ credentials, openid, request: structuredClone(request), at: Date.now() });
    if (request.index === bot.failStreamAt) throw Object.assign(new Error("stream request failed"), { httpStatus: 429, bizCode: 50002, bizMessage: "rate limited" });
    return { id: request.index === 0 ? "private-stream-id" : undefined };
  } };
  return bot;
}
function tinyPng(red, green, blue) {
  const chunk = (type, data) => {
    const name = Buffer.from(type), length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    let crc = 0xffffffff;
    for (const byte of Buffer.concat([name, data])) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, name, data, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.from([0, red, green, blue, 255]))), chunk("IEND", Buffer.alloc(0))]);
}
const message = (kind, id, extra = {}) => ({ kind, rawEventType: kind === "c2c" ? "C2C_MESSAGE_CREATE" : "GROUP_AT_MESSAGE_CREATE", senderId: "sender", messageId: id, timestamp: new Date().toISOString(), content: "hello", ...(kind === "group" ? { groupOpenid: "conversation" } : {}), replyTarget: { scope: kind, targetId: "conversation", msgId: id }, ...extra });
async function fixture(t, diagnosticFetch) {
  const root = await mkdtemp(join(tmpdir(), "stardust-extensions-"));
  const bots = [];
  const model = { fail: false, calls: [], async chat(content, signal) { this.calls.push(content); if (this.fail) throw new Error("secret-and-message"); if (signal.aborted) throw new Error("aborted"); return `reply:${content}`; } };
  const extension = createQQBotExtension(async () => { const bot = mockBot(); bots.push(bot); return bot; }, diagnosticFetch);
  const logs = new LogService(100, () => {});
  const manager = new ExtensionManager(root, model, [extension], logs);
  t.after(async () => { manager.shutdown(); await rm(root, { recursive: true, force: true }); });
  return { root, model, manager, extension, bots, logs };
}
async function waitFor(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 10)); }
  throw new Error("timeout waiting for mock gateway");
}

test("installation, isolated credentials, restore, disable and uninstall", async (t) => {
  const { root, manager, model, extension, bots } = await fixture(t);
  await mkdir(join(root, "env", "qq-bot"), { recursive: true });
  await writeFile(join(root, "env", "qq-bot", ".env"), "QQBOT_APP_ID=old\nQQBOT_APP_SECRET=old-secret\n");
  await writeFile(join(root, ".env"), "CORE_ONLY=preserved\n");
  await manager.restore(); assert.equal(bots.length, 0);
  assert.equal(manager.list()[0].installed, false);
  await manager.install("qq-bot");
  await manager.saveConfig("qq-bot", { appId: "123", appSecret: "secret-one" });
  assert.equal(bots.length, 0);
  assert.doesNotMatch(JSON.stringify(manager.list()), /secret-one/);
  assert.equal((await readFile(join(root, ".env"), "utf8")), "CORE_ONLY=preserved\n");
  assert.equal(createEnvLoader(root).loadExtensionEnv("qq-bot").values.QQBOT_APP_SECRET, "secret-one");
  await manager.saveConfig("qq-bot", { appSecret: "secret-two" });
  assert.equal(createEnvLoader(root).loadExtensionEnv("qq-bot").values.QQBOT_APP_SECRET, "secret-two");
  await manager.enable("qq-bot"); await waitFor(() => bots.length === 1 && manager.list()[0].state === "connected");
  manager.shutdown(); assert.equal(bots[0].stopped, true);
  const restored = new ExtensionManager(root, model, [extension]);
  t.after(() => restored.shutdown());
  await restored.restore(); await waitFor(() => bots.length === 2 && restored.list()[0].state === "connected");
  await restored.disable("qq-bot"); assert.equal(bots[1].stopped, true);
  await restored.saveConfig("qq-bot", { appSecret: null });
  assert.equal(restored.list()[0].fields.find((field) => field.key === "appSecret").configured, false);
  await assert.rejects(restored.enable("qq-bot"), { code: "NOT_CONFIGURED" });
  await restored.uninstall("qq-bot", false);
  assert.equal(createEnvLoader(root).loadExtensionEnv("qq-bot").configured, true);
  await restored.install("qq-bot"); await restored.uninstall("qq-bot", true);
  assert.deepEqual(createEnvLoader(root).loadExtensionEnv("qq-bot"), { configured: false });
  await assert.rejects(restored.install("../qq-bot"), { code: "INVALID_EXTENSION_ID" });
});

test("QQ events reach the model once and reply to the original conversation", async (t) => {
  const { manager, model, bots, logs } = await fixture(t);
  await manager.install("qq-bot"); await manager.saveConfig("qq-bot", { appId: "123", appSecret: "secret" }); await manager.enable("qq-bot");
  await waitFor(() => bots.length === 1 && manager.list()[0].state === "connected");
  const bot = bots[0];
  await bot.emit("message", message("c2c", "one"));
  await bot.emit("message", message("c2c", "one"));
  await bot.emit("message", message("c2c", "echo", { content: "reply:hello" }));
  await bot.emit("message", message("group", "ignored", { rawEventType: "GROUP_MESSAGE_CREATE" }));
  await bot.emit("message", message("group", "robot", { senderIsBot: true }));
  await bot.emit("message", message("group", "two"));
  assert.deepEqual(model.calls, ["hello", "hello"]);
  assert.deepEqual(bot.sent.map((item) => item.target), [{ scope: "c2c", targetId: "conversation", msgId: "one" }, { scope: "group", targetId: "conversation", msgId: "two" }]);
  assert.equal(bot.sent[0].text, "reply:hello");
  model.fail = true; await bot.emit("message", message("c2c", "three"));
  assert.equal(manager.list()[0].state, "connected"); assert.match(manager.list()[0].error, /模型/); assert.doesNotMatch(JSON.stringify(manager.list()), /secret-and-message|hello/);
  model.fail = false; bot.failSend = true; await bot.emit("message", message("c2c", "four"));
  assert.equal(manager.list()[0].state, "connected"); assert.match(manager.list()[0].error, /发送/); assert.equal(bot.sent.length, 2);
  const records = logs.read().entries;
  assert.ok(records.some((entry) => entry.message.includes("消息已接受")));
  assert.ok(records.some((entry) => entry.details?.reason === "group_no_self_mention"));
  assert.ok(records.some((entry) => entry.message.includes("回复发送失败") && entry.details?.code === "11281" && entry.details?.status === 429));
  assert.doesNotMatch(JSON.stringify(records), /secret-and-message|hello|conversation|"sender"/);
  await manager.disable("qq-bot"); await bot.emit("message", message("c2c", "five")); assert.equal(model.calls.length, 4);
});

test("SDK group events require an authoritative or explicit self-mention and log only safe diagnostics", async (t) => {
  const { manager, model, bots, logs } = await fixture(t);
  await manager.install("qq-bot"); await manager.saveConfig("qq-bot", { appId: "123", appSecret: "sensitive-secret-value" }); await manager.enable("qq-bot");
  await waitFor(() => bots.length === 1 && manager.list()[0].state === "connected");
  const bot = bots[0];
  const sdkMessage = (eventType, id, content, mentions) => {
    const raw = { id, content, timestamp: new Date().toISOString(), author: { member_openid: "private-user-openid" }, group_openid: "private-group-openid", message_type: 103, ...(mentions === undefined ? {} : { mentions }) };
    const dispatched = dispatchEvent(eventType, raw, "test");
    assert.equal(dispatched.action, "message");
    return { ...dispatched.msg, replyTarget: { scope: "group", targetId: dispatched.msg.groupOpenid, msgId: dispatched.msg.messageId } };
  };
  await bot.emit("message", sdkMessage("GROUP_AT_MESSAGE_CREATE", "one", "private-content-one"));
  await bot.emit("message", sdkMessage("GROUP_MESSAGE_CREATE", "two", "private-content-two", [{ is_you: true, member_openid: "private-mentioned-openid" }]));
  await bot.emit("message", sdkMessage("GROUP_MESSAGE_CREATE", "three", "<@!123> private-content-three"));
  await bot.emit("message", sdkMessage("GROUP_MESSAGE_CREATE", "six", "<@123> private-content-six", []));
  await bot.emit("message", sdkMessage("GROUP_MESSAGE_CREATE", "four", "private-content-four"));
  await bot.emit("message", sdkMessage("GROUP_MESSAGE_CREATE", "five", "<@!999> private-content-five", [{ is_you: false, bot: true }]));
  await bot.emit("message", sdkMessage("GROUP_MESSAGE_CREATE", "seven", "private-content-seven", []));
  await bot.emit("message", sdkMessage("GROUP_AT_MESSAGE_CREATE", "one", "private-content-one"));
  assert.equal(model.calls.length, 4);
  assert.deepEqual(bot.sent.map((item) => item.target.msgId), ["one", "two", "three", "six"]);
  const entries = logs.read().entries;
  const received = entries.filter((entry) => entry.message === "收到 QQ 消息事件。");
  assert.deepEqual(received.map((entry) => entry.details.mentionBranch), ["official_at_event", "mentions_is_you", "content_appid_marker", "content_appid_marker", "no_self_mention", "no_self_mention", "no_self_mention", "official_at_event"]);
  assert.equal(received[0].details.rawEventType, "GROUP_AT_MESSAGE_CREATE");
  assert.equal(received[1].details.rawEventType, "GROUP_MESSAGE_CREATE");
  assert.equal(received[1].details.kind, "group"); assert.equal(received[1].details.msgType, 103);
  assert.equal(received[0].details.mentionsPresent, false); assert.equal(received[0].details.mentionCount, 0);
  assert.equal(received[1].details.mentionsPresent, true); assert.equal(received[1].details.mentionCount, 1);
  assert.equal(received[3].details.mentionsPresent, true); assert.equal(received[3].details.mentionCount, 0);
  assert.equal(received[1].details.hasGroupOpenid, true);
  assert.equal(entries.filter((entry) => entry.details?.reason === "group_no_self_mention").length, 3);
  assert.ok(entries.some((entry) => entry.details?.reason === "duplicate"));
  assert.doesNotMatch(JSON.stringify(entries), /private-user-openid|private-group-openid|private-mentioned-openid|private-content|sensitive-secret-value/);
});

test("malformed group events have precise, privacy-safe filtering diagnostics", async (t) => {
  const { manager, bots, logs } = await fixture(t);
  await manager.install("qq-bot"); await manager.saveConfig("qq-bot", { appId: "123", appSecret: "secret" }); await manager.enable("qq-bot");
  await waitFor(() => bots.length === 1 && manager.list()[0].state === "connected");
  const bot = bots[0];
  await bot.emit("message", message("group", "one", { groupOpenid: "" }));
  await bot.emit("message", message("group", "two", { groupOpenid: "elsewhere" }));
  await bot.emit("message", message("group", "three", { rawEventType: "AT_MESSAGE_CREATE" }));
  await bot.emit("message", message("c2c", "four", { rawEventType: "GROUP_MESSAGE_CREATE" }));
  await bot.emit("message", message("group", "five", { rawEventType: "GROUP_MESSAGE_CREATE", mentions: { is_you: true } }));
  const rejected = logs.read().entries.filter((entry) => entry.message === "QQ 消息已过滤。");
  assert.deepEqual(rejected.map((entry) => entry.details.reason), ["missing_group_openid", "group_reply_target_mismatch", "group_unsupported_event_type", "private_unexpected_event_type", "group_no_self_mention"]);
  assert.equal(rejected[0].details.hasGroupOpenid, false);
  assert.equal(rejected[0].details.msgType, null);
  assert.equal(rejected[4].details.mentionsPresent, true); assert.equal(rejected[4].details.mentionCount, 0);
  assert.equal(bot.sent.length, 0);
  assert.doesNotMatch(JSON.stringify(rejected), /elsewhere|conversation|sender|secret/);
});

test("mock QQ and a mock model HTTP server complete the channel-to-model reply path", async (t) => {
  const { root, extension, bots } = await fixture(t);
  let received;
  const upstream = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      received = JSON.parse(body);
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ choices: [{ message: { content: "模型回复" } }] }));
    });
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  t.after(async () => { upstream.closeAllConnections(); await new Promise((resolve) => upstream.close(resolve)); });
  const store = createConfigStore(root); store.initializeConfig({});
  const model = new ModelService(store, createSecretStore(root, {}));
  model.saveConfig({ baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, modelId: "mock", timeoutMs: 1000, stream: false, keyAction: "keep" });
  const manager = new ExtensionManager(root, model, [extension]);
  t.after(() => manager.shutdown());
  await manager.install("qq-bot"); await manager.saveConfig("qq-bot", { appId: "123", appSecret: "secret" }); await manager.enable("qq-bot");
  await waitFor(() => bots.length === 1 && manager.list()[0].state === "connected");
  await bots[0].emit("message", message("c2c", "original"));
  assert.equal(received.messages[0].content, "hello");
  assert.deepEqual(bots[0].sent, [{ target: { scope: "c2c", targetId: "conversation", msgId: "original" }, text: "模型回复" }]);
});

test("failed configuration replacement leaves the previous secret intact", async (t) => {
  const { root, manager } = await fixture(t);
  await manager.install("qq-bot"); await manager.saveConfig("qq-bot", { appId: "123", appSecret: "old-secret" });
  const rename = t.mock.method(fs, "renameSync", () => { throw new Error("private failure"); });
  await assert.rejects(manager.saveConfig("qq-bot", { appSecret: "new-secret" }), { code: "SAVE_FAILED" });
  rename.mock.restore();
  assert.equal(createEnvLoader(root).loadExtensionEnv("qq-bot").values.QQBOT_APP_SECRET, "old-secret");
  assert.doesNotMatch(JSON.stringify(manager.list()), /old-secret|new-secret/);
});

test("a failed gateway stays isolated and credentials in different extensions do not collide", async (t) => {
  const { root, model } = await fixture(t);
  const fail = createQQBotExtension(async () => { throw new Error("hidden-secret"); });
  const other = { ...fail, tools: [], manifest: { ...fail.manifest, id: "other-extension" } };
  const manager = new ExtensionManager(root, model, [fail, other]);
  t.after(() => manager.shutdown());
  await manager.install("qq-bot"); await manager.install("other-extension");
  await manager.saveConfig("qq-bot", { appId: "one", appSecret: "hidden-secret" });
  await manager.saveConfig("other-extension", { appId: "two", appSecret: "other-secret" });
  assert.equal(createEnvLoader(root).loadExtensionEnv("qq-bot").values.QQBOT_APP_SECRET, "hidden-secret");
  assert.equal(createEnvLoader(root).loadExtensionEnv("other-extension").values.QQBOT_APP_SECRET, "other-secret");
  await manager.enable("qq-bot"); await waitFor(() => manager.list()[0].state === "error");
  assert.doesNotMatch(JSON.stringify(manager.list()), /hidden-secret|other-secret/);
  assert.equal(manager.list()[1].enabled, false);
});

test("stopping an extension cancels pending model work and prevents a late reply", async (t) => {
  const { root, extension, bots } = await fixture(t);
  let complete;
  const model = { chat: () => new Promise((resolve) => { complete = resolve; }) };
  const manager = new ExtensionManager(root, model, [extension]);
  t.after(() => manager.shutdown());
  await manager.install("qq-bot"); await manager.saveConfig("qq-bot", { appId: "123", appSecret: "secret" }); await manager.enable("qq-bot");
  await waitFor(() => bots.length === 1 && manager.list()[0].state === "connected");
  const pending = bots[0].emit("message", message("c2c", "one"));
  await waitFor(() => typeof complete === "function");
  await manager.disable("qq-bot"); complete("late reply"); await pending;
  assert.equal(bots[0].stopped, true); assert.equal(bots[0].sent.length, 0);
});

test("disable waits for an already-started platform send", async (t) => {
  const { manager, bots } = await fixture(t);
  await manager.install("qq-bot"); await manager.saveConfig("qq-bot", { appId: "123", appSecret: "secret" }); await manager.enable("qq-bot");
  await waitFor(() => bots.length === 1 && manager.list()[0].state === "connected");
  let completeSend;
  bots[0].sendText = () => new Promise((resolve) => { completeSend = resolve; });
  const messagePending = bots[0].emit("message", message("c2c", "one"));
  await waitFor(() => typeof completeSend === "function");
  let finished = false;
  const disabling = manager.disable("qq-bot").then(() => { finished = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(finished, false);
  completeSend({ id: "sent" });
  await Promise.all([disabling, messagePending]);
  assert.equal(bots[0].stopped, true);
});

test("extension HTTP management is initialization-gated, origin-checked and does not return secrets", async (t) => {
  const { root, manager, bots } = await fixture(t);
  const setup = new SetupService(createConfigStore(root));
  const server = createStardustServer({ setupService: setup, extensionManager: manager });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { if (server.listening) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); } });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, extra = {}) => fetch(`${origin}/api/v1/extensions/qq-bot/${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...extra }, body: JSON.stringify(body) });
  assert.equal((await fetch(`${origin}/api/v1/extensions`)).status, 403);
  await setup.completeInitialization({});
  assert.equal((await post("install", {}, { Origin: "https://invalid.example" })).status, 403);
  assert.equal((await post("install", {})).status, 200);
  assert.equal((await post("config", { appId: "123", appSecret: "hidden-secret" })).status, 200);
  const response = await fetch(`${origin}/api/v1/extensions`); assert.equal(response.status, 200); assert.doesNotMatch(await response.text(), /hidden-secret/);
  assert.equal((await post("enable", {})).status, 200);
  await waitFor(() => bots.length === 1 && manager.list()[0].state === "connected");
  server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
  assert.equal(bots[0].stopped, true);
});

test("capability targets contain only accepted real events and never expose identifiers or messages", async (t) => {
  const { manager, model, bots, logs } = await fixture(t);
  assert.throws(() => manager.capabilityTargets("qq-bot"), { code: "NOT_INSTALLED" });
  await manager.install("qq-bot"); await manager.saveConfig("qq-bot", { appId: "123", appSecret: "private-secret" }); await manager.enable("qq-bot");
  await waitFor(() => bots.length === 1 && manager.list()[0].state === "connected");
  model.fail = true;
  const old = new Date(Date.now() - 10 * 60_000).toISOString();
  await bots[0].emit("message", message("c2c", "private-message-id", { timestamp: old, content: "private-message-content" }));
  await bots[0].emit("message", message("c2c", "private-message-id", { timestamp: old, content: "private-message-content" }));
  await bots[0].emit("message", message("group", "filtered-id", { rawEventType: "GROUP_MESSAGE_CREATE" }));
  await bots[0].emit("message", message("group", "group-message-id", { timestamp: old }));
  const targets = manager.capabilityTargets("qq-bot");
  assert.equal(targets.length, 2);
  assert.deepEqual(targets.map((entry) => entry.scope), ["private", "group"]);
  assert.ok(Date.parse(targets[0].replyExpiresAt) > Date.now());
  assert.ok(Date.parse(targets[1].replyExpiresAt) < Date.now());
  assert.doesNotMatch(JSON.stringify(targets), /private-message|group-message|conversation|sender|private-secret/);
  assert.equal(bots[0].sent.length, 0);
  assert.doesNotMatch(JSON.stringify(logs.read()), /private-message-content|conversation|private-secret/);
  await manager.disable("qq-bot");
  assert.deepEqual(manager.capabilityTargets("qq-bot"), []);
});

test("capability target API is initialization gated and has no send operation", async (t) => {
  const { root, manager, model, bots } = await fixture(t);
  const setup = new SetupService(createConfigStore(root));
  const server = createStardustServer({ setupService: setup, extensionManager: manager });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { if (server.listening) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); } });
  const url = `http://127.0.0.1:${server.address().port}/api/v1/extensions/qq-bot/capability-targets`;
  assert.equal((await fetch(url)).status, 403);
  await setup.completeInitialization({});
  await manager.install("qq-bot"); await manager.saveConfig("qq-bot", { appId: "123", appSecret: "secret" }); await manager.enable("qq-bot");
  await waitFor(() => bots.length === 1 && manager.list()[0].state === "connected");
  model.fail = true;
  await bots[0].emit("message", message("c2c", "sensitive-msgid"));
  const response = await fetch(url); assert.equal(response.status, 200);
  const text = await response.text(); assert.doesNotMatch(text, /sensitive-msgid|conversation|sender|secret|hello/);
  assert.equal(JSON.parse(text).targets.length, 1);
  assert.notEqual((await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 200);
  assert.equal(bots[0].sent.length, 0);
});

test("manual QQ tests address only received targets, use passive msg_id, and never retry", async (t) => {
  const calls = [];
  const mockFetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return Response.json(url.endsWith("/files") ? { file_info: "uploaded-file-info" } : { id: `outgoing-${calls.length}` }, { status: 200 });
  };
  const { manager, model, bots, logs } = await fixture(t, mockFetch);
  await manager.install("qq-bot"); await manager.saveConfig("qq-bot", { appId: "123", appSecret: "private-secret" }); await manager.enable("qq-bot");
  await waitFor(() => bots.length === 1 && manager.list()[0].state === "connected");
  model.fail = true;
  await bots[0].emit("message", message("c2c", "private-msg-id", { replyTarget: { scope: "c2c", targetId: "private-openid", msgId: "private-msg-id" } }));
  await bots[0].emit("message", message("group", "group-msg-id", { groupOpenid: "group-openid", replyTarget: { scope: "group", targetId: "group-openid", msgId: "group-msg-id" } }));
  const targets = manager.capabilityTargets("qq-bot");
  const privateTarget = targets.find((entry) => entry.scope === "private");
  const groupTarget = targets.find((entry) => entry.scope === "group");
  assert.doesNotMatch(JSON.stringify(targets), /private-openid|group-openid|private-msg-id|group-msg-id|private-secret/);
  assert.throws(() => manager.runCapabilityTest("qq-bot", { targetId: privateTarget.id, kind: "group-text", requestId: randomUUID() }), { code: "INVALID_TARGET" });
  assert.throws(() => manager.runCapabilityTest("qq-bot", { targetId: randomUUID(), kind: "private-text", requestId: randomUUID() }), { code: "INVALID_TARGET" });
  const requestId = randomUUID();
  const input = { targetId: privateTarget.id, kind: "private-text", requestId };
  const [result, duplicate] = await Promise.all([manager.runCapabilityTest("qq-bot", input), manager.runCapabilityTest("qq-bot", input)]);
  assert.deepEqual(result, duplicate); assert.equal(calls.length, 1);
  assert.equal(result.state, "success"); assert.equal(result.httpStatus, 200); assert.equal(result.serverAccepted, true); assert.equal(result.clientReceived, "unconfirmed");
  assert.equal(calls[0].url, "https://api.sgroup.qq.com/v2/users/private-openid/messages");
  assert.equal(calls[0].body.msg_type, 0); assert.ok(!("msg_id" in calls[0].body));
  assert.throws(() => manager.runCapabilityTest("qq-bot", { ...input, kind: "private-file" }), { code: "INVALID_INPUT" });
  await manager.runCapabilityTest("qq-bot", { targetId: groupTarget.id, kind: "group-text", requestId: randomUUID() });
  assert.match(calls[1].url, /groups\/group-openid\/messages$/); assert.ok(!("msg_id" in calls[1].body));
  const passivePrivate = await manager.runCapabilityTest("qq-bot", { targetId: privateTarget.id, kind: "private-text", mode: "passive", requestId: randomUUID() });
  assert.equal(passivePrivate.state, "success"); assert.equal(calls[2].body.msg_id, "private-msg-id"); assert.ok(Number.isInteger(calls[2].body.msg_seq));
  const passiveGroup = await manager.runCapabilityTest("qq-bot", { targetId: groupTarget.id, kind: "group-text", mode: "passive", requestId: randomUUID() });
  assert.equal(passiveGroup.state, "success"); assert.equal(calls[3].body.msg_id, "group-msg-id"); assert.ok(Number.isInteger(calls[3].body.msg_seq));
  for (const [kind, target, msgId, fileType] of [
    ["private-file", privateTarget, "private-msg-id", 4], ["group-file", groupTarget, "group-msg-id", 4],
    ["private-png", privateTarget, "private-msg-id", 1], ["group-png", groupTarget, "group-msg-id", 1],
  ]) {
    const before = calls.length;
    const output = await manager.runCapabilityTest("qq-bot", { targetId: target.id, kind, requestId: randomUUID() });
    assert.equal(output.state, "success"); assert.equal(calls.length, before + 2);
    const upload = calls[before].body, send = calls[before + 1].body;
    assert.equal(upload.file_type, fileType); assert.equal(upload.srv_send_msg, false);
    if (fileType === 4) { assert.equal(upload.file_name, "hello-stardust.txt"); assert.equal(Buffer.from(upload.file_data, "base64").toString(), "Hello, Stardust!\n"); }
    else assert.deepEqual([...Buffer.from(upload.file_data, "base64").subarray(0, 8)], [137,80,78,71,13,10,26,10]);
    assert.equal(send.msg_type, 7); assert.equal(send.msg_id, msgId); assert.ok(Number.isInteger(send.msg_seq));
    if (kind.endsWith("-png")) assert.equal(send.content, " ", "the existing PNG flow retains its original single-space content");
    assert.equal(calls[before + 1].init.redirect, "error");
  }
  assert.doesNotMatch(JSON.stringify(logs.read()), /private-openid|group-openid|private-msg-id|group-msg-id|private-secret|private-token|Hello, Stardust/);
  await manager.disable("qq-bot");
  assert.throws(() => manager.runCapabilityTest("qq-bot", input), { code: "EXTENSION_NOT_CONNECTED" });
});

test("QQ direct PNG media experiment sends one file request with srv_send_msg and no message ID", async (t) => {
  const requests = [];
  const { manager, model, bots } = await fixture(t, async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) });
    return requests.length === 1 ? Response.json({ id: "direct-message" }, { status: 201 }) : Response.json({ code: 22103, message: "direct send rejected private-secret group-openid" }, { status: 403 });
  });
  await manager.install("qq-bot"); await manager.saveConfig("qq-bot", { appId: "123", appSecret: "private-secret" }); await manager.enable("qq-bot");
  await waitFor(() => bots.length === 1 && manager.list()[0].state === "connected"); model.fail = true;
  await bots[0].emit("message", message("c2c", "private-inbound", { replyTarget: { scope: "c2c", targetId: "private-openid", msgId: "private-inbound" } }));
  await bots[0].emit("message", message("group", "group-inbound", { groupOpenid: "group-openid", replyTarget: { scope: "group", targetId: "group-openid", msgId: "group-inbound" } }));
  const targets = manager.capabilityTargets("qq-bot");
  const privateTarget = targets.find((target) => target.scope === "private"); const groupTarget = targets.find((target) => target.scope === "group");
  assert.throws(() => manager.runCapabilityTest("qq-bot", { targetId: privateTarget.id, kind: "group-png-direct", requestId: randomUUID() }), { code: "INVALID_TARGET" });
  for (const [index, [scope, target]] of [["private", privateTarget], ["group", groupTarget]].entries()) {
    const result = await manager.runCapabilityTest("qq-bot", { targetId: target.id, kind: `${scope}-png-direct`, requestId: randomUUID() });
    assert.equal(result.mode, "active"); assert.equal(result.interface, `POST /v2/${scope === "private" ? "users/{openid}" : "groups/{group_openid}"}/files`);
    assert.equal(result.httpStatus, index === 0 ? 201 : 403); assert.equal(result.stage, "direct_send"); assert.equal(result.state, index === 0 ? "success" : "rejected");
    assert.equal(result.messageIdReturned, index === 0); assert.equal(result.clientReceived, "unconfirmed");
  }
  assert.equal(requests.length, 2, "one confirmed direct-send operation uses only /files");
  assert.deepEqual(requests.map((request) => request.url), ["https://api.sgroup.qq.com/v2/users/private-openid/files", "https://api.sgroup.qq.com/v2/groups/group-openid/files"]);
  for (const { body } of requests) {
    assert.equal(body.file_type, 1); assert.equal(body.srv_send_msg, true);
    assert.ok(Buffer.from(body.file_data, "base64").subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
    assert.ok(!("msg_id" in body) && !("event_id" in body));
  }
  await manager.disable("qq-bot");
});

test("QQ empty-content PNG experiment keeps passive identifiers and reports upload/send stages without fallback", async (t) => {
  const requests = [];
  const { manager, model, bots } = await fixture(t, async (url, init) => {
    const body = JSON.parse(init.body); requests.push({ url, body });
    if (url.endsWith("/files") && requests.length === 5) return Response.json({ code: 22104, message: "upload rejected private-secret" }, { status: 429 });
    if (url.endsWith("/files")) return Response.json({ file_info: `file-info-${requests.length}` }, { status: 200 });
    if (body.content === "" && requests.length === 4) return Response.json({ code: 22001, message: "empty content rejected" }, { status: 400 });
    if (body.content === "") return Response.json({ id: `sent-${requests.length}` }, { status: 201 });
    return Response.json({ code: 22001, message: "empty content rejected" }, { status: 400 });
  });
  await manager.install("qq-bot"); await manager.saveConfig("qq-bot", { appId: "123", appSecret: "private-secret" }); await manager.enable("qq-bot");
  await waitFor(() => bots.length === 1 && manager.list()[0].state === "connected"); model.fail = true;
  await bots[0].emit("message", message("c2c", "private-inbound", { replyTarget: { scope: "c2c", targetId: "private-openid", msgId: "private-inbound" } }));
  await bots[0].emit("message", message("group", "group-inbound", { groupOpenid: "group-openid", replyTarget: { scope: "group", targetId: "group-openid", msgId: "group-inbound" } }));
  const targets = manager.capabilityTargets("qq-bot");
  const privateTarget = targets.find((target) => target.scope === "private"); const groupTarget = targets.find((target) => target.scope === "group");
  const privateResult = await manager.runCapabilityTest("qq-bot", { targetId: privateTarget.id, kind: "private-png-empty-content", requestId: randomUUID() });
  assert.equal(privateResult.state, "success"); assert.equal(privateResult.httpStatus, 201); assert.equal(privateResult.messageIdReturned, true);
  assert.deepEqual(privateResult.stages.map(({ stage, state, httpStatus }) => ({ stage, state, httpStatus })), [{ stage: "upload", state: "success", httpStatus: 200 }, { stage: "send", state: "success", httpStatus: 201 }]);
  const groupResult = await manager.runCapabilityTest("qq-bot", { targetId: groupTarget.id, kind: "group-png-empty-content", requestId: randomUUID() });
  assert.equal(groupResult.state, "rejected"); assert.equal(groupResult.httpStatus, 400); assert.equal(groupResult.stage, "send"); assert.equal(groupResult.businessCode, "22001");
  assert.deepEqual(groupResult.stages.map(({ stage, state, httpStatus }) => ({ stage, state, httpStatus })), [{ stage: "upload", state: "success", httpStatus: 200 }, { stage: "send", state: "rejected", httpStatus: 400 }]);
  const uploadRejected = await manager.runCapabilityTest("qq-bot", { targetId: groupTarget.id, kind: "group-png-empty-content", requestId: randomUUID() });
  assert.equal(uploadRejected.state, "rejected"); assert.equal(uploadRejected.stage, "upload"); assert.equal(uploadRejected.httpStatus, 429);
  assert.deepEqual(uploadRejected.stages.map(({ stage, state, httpStatus }) => ({ stage, state, httpStatus })), [{ stage: "upload", state: "rejected", httpStatus: 429 }]);
  assert.equal(requests.length, 5, "uploads and sends execute once; an upload rejection never calls /messages");
  assert.deepEqual(requests.map(({ url }) => url), [
    "https://api.sgroup.qq.com/v2/users/private-openid/files", "https://api.sgroup.qq.com/v2/users/private-openid/messages",
    "https://api.sgroup.qq.com/v2/groups/group-openid/files", "https://api.sgroup.qq.com/v2/groups/group-openid/messages",
    "https://api.sgroup.qq.com/v2/groups/group-openid/files",
  ]);
  for (const [upload, send, messageId, fileInfo] of [[requests[0], requests[1], "private-inbound", "file-info-1"], [requests[2], requests[3], "group-inbound", "file-info-3"]]) {
    assert.equal(upload.body.file_type, 1); assert.equal(upload.body.srv_send_msg, false);
    assert.equal(send.body.msg_type, 7); assert.equal(send.body.content, ""); assert.equal(send.body.media.file_info, fileInfo);
    assert.equal(send.body.msg_id, messageId); assert.ok(Number.isInteger(send.body.msg_seq));
  }
  await manager.disable("qq-bot");
});

test("QQ direct PNG network failure is an unknown outcome and is not retried", async (t) => {
  let calls = 0;
  const { manager, model, bots } = await fixture(t, async () => { calls++; throw new TypeError("socket closed"); });
  await manager.install("qq-bot"); await manager.saveConfig("qq-bot", { appId: "123", appSecret: "private-secret" }); await manager.enable("qq-bot");
  await waitFor(() => bots.length === 1 && manager.list()[0].state === "connected"); model.fail = true;
  await bots[0].emit("message", message("c2c", "private-inbound", { replyTarget: { scope: "c2c", targetId: "private-openid", msgId: "private-inbound" } }));
  const target = manager.capabilityTargets("qq-bot").find((entry) => entry.scope === "private");
  const result = await manager.runCapabilityTest("qq-bot", { targetId: target.id, kind: "private-png-direct", requestId: randomUUID() });
  assert.equal(calls, 1); assert.equal(result.state, "unknown_outcome"); assert.equal(result.stage, "direct_send"); assert.equal(result.messageIdReturned, false);
  assert.deepEqual(result.stages.map(({ stage, state, httpStatus }) => ({ stage, state, httpStatus })), [{ stage: "direct_send", state: "unknown_outcome", httpStatus: undefined }]);
  await manager.disable("qq-bot");
});

test("Markdown multi-image tests use passive real targets, masked IDs and unique message sequences", async (t) => {
  const requests = [];
  const imageUrl1 = "https://images.example.com/first.png"; const imageUrl2 = "https://cdn.example.net/second.png";
  const { manager, model, bots, logs } = await fixture(t, async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) });
    return Response.json({ id: `markdown-message-${requests.length}` }, { status: 201 });
  });
  await manager.install("qq-bot"); await manager.saveConfig("qq-bot", { appId: "123", appSecret: "private-secret" }); await manager.enable("qq-bot");
  await waitFor(() => bots.length === 1 && manager.list()[0].state === "connected"); model.fail = true;
  await bots[0].emit("message", message("c2c", "private-markdown-msg", { replyTarget: { scope: "c2c", targetId: "private-openid", msgId: "private-markdown-msg" } }));
  await bots[0].emit("message", message("group", "group-markdown-msg", { groupOpenid: "group-openid", replyTarget: { scope: "group", targetId: "group-openid", msgId: "group-markdown-msg" } }));
  const targets = manager.capabilityTargets("qq-bot"); const privateTarget = targets.find((item) => item.scope === "private"); const groupTarget = targets.find((item) => item.scope === "group");
  assert.throws(() => manager.runCapabilityTest("qq-bot", { targetId: privateTarget.id, kind: "group-markdown-multi-image", requestId: randomUUID(), imageUrl1, imageUrl2 }), { code: "INVALID_TARGET" });
  assert.throws(() => manager.runCapabilityTest("qq-bot", { targetId: privateTarget.id, kind: "private-markdown-multi-image", requestId: randomUUID(), imageUrl1: "http://images.example.com/a.png", imageUrl2 }), { code: "INVALID_INPUT" });
  const run = (target, scope) => manager.runCapabilityTest("qq-bot", { targetId: target.id, kind: `${scope}-markdown-multi-image`, mode: "passive", requestId: randomUUID(), imageUrl1, imageUrl2 });
  const first = await run(privateTarget, "private"); const second = await run(privateTarget, "private"); const group = await run(groupTarget, "group");
  assert.deepEqual([first.state, second.state, group.state], ["success", "success", "success"]);
  assert.deepEqual(requests.map(({ url }) => url), [
    "https://api.sgroup.qq.com/v2/users/private-openid/messages", "https://api.sgroup.qq.com/v2/users/private-openid/messages", "https://api.sgroup.qq.com/v2/groups/group-openid/messages",
  ]);
  const expectedContent = `## Stardust 多图测试\n\n![图片一 #320px #180px](${imageUrl1})\n\n![图片二 #320px #180px](${imageUrl2})`;
  for (const request of requests) {
    assert.equal(request.body.msg_type, 2); assert.deepEqual(request.body.markdown, { content: expectedContent });
    assert.ok(Number.isInteger(request.body.msg_seq)); assert.equal(request.body.msg_seq >= 0 && request.body.msg_seq <= 65535, true);
  }
  assert.equal(requests[0].body.msg_id, "private-markdown-msg"); assert.notEqual(requests[0].body.msg_seq, requests[1].body.msg_seq);
  assert.equal(requests[2].body.msg_id, "group-markdown-msg");
  assert.equal(first.interface, "POST /v2/users/{openid}/messages"); assert.equal(group.interface, "POST /v2/groups/{group_openid}/messages");
  assert.equal(first.httpStatus, 201); assert.equal(first.stage, "send"); assert.equal(first.serverAccepted, true); assert.equal(first.clientReceived, "unconfirmed");
  assert.match(first.requestMessageId, /•••/); assert.match(first.messageId, /•••/); assert.equal(typeof first.durationMs, "number");
  assert.doesNotMatch(JSON.stringify([first, second, group, logs.read()]), /private-openid|group-openid|private-markdown-msg|group-markdown-msg|images\.example\.com|cdn\.example\.net|private-secret/);
  await manager.disable("qq-bot");
});

test("Markdown permission errors are returned as-is without retries or plain-text fallback", async (t) => {
  let calls = 0;
  const { manager, model, bots, logs } = await fixture(t, async () => {
    calls++; return Response.json({ code: 22009, message: "Markdown permission denied for https://images.example.com/private.png" }, { status: 403 });
  });
  await manager.install("qq-bot"); await manager.saveConfig("qq-bot", { appId: "123", appSecret: "private-secret" }); await manager.enable("qq-bot");
  await waitFor(() => bots.length === 1 && manager.list()[0].state === "connected"); model.fail = true;
  await bots[0].emit("message", message("c2c", "markdown-error-msg", { replyTarget: { scope: "c2c", targetId: "private-openid", msgId: "markdown-error-msg" } }));
  const target = manager.capabilityTargets("qq-bot").find((item) => item.scope === "private");
  const result = await manager.runCapabilityTest("qq-bot", { targetId: target.id, kind: "private-markdown-multi-image", requestId: randomUUID(), imageUrl1: "https://images.example.com/a.png", imageUrl2: "https://images.example.net/b.png" });
  assert.equal(calls, 1); assert.equal(result.state, "rejected"); assert.equal(result.httpStatus, 403); assert.equal(result.businessCode, "22009"); assert.equal(result.stage, "send");
  assert.match(result.message, /Markdown permission denied/); assert.doesNotMatch(result.message, /https:\/\//); assert.equal(result.serverAccepted, false);
  assert.doesNotMatch(JSON.stringify(logs.read()), /images\.example\.com|images\.example\.net|markdown-error-msg|private-openid|private-secret/);
  await manager.disable("qq-bot");
});

test("local Markdown image test uploads two PNG materials separately and sends one passive Markdown message", async (t) => {
  const firstPng = tinyPng(210, 40, 70), secondPng = tinyPng(30, 100, 220);
  const requests = []; let prepareNumber = 0;
  const materialRefs = ["qqbot-media://image/v1/private-material-token-one", "qqbot-media://image/v1/private-material-token-two", "qqbot-media://image/v1/group-material-token-one", "qqbot-media://image/v1/group-material-token-two"];
  const { manager, model, bots, logs } = await fixture(t, async (url, init) => {
    const parsed = new URL(url); const call = { url, method: init.method, headers: new Headers(init.headers), body: init.body };
    if (parsed.pathname === "/v2/media-images/prepare") {
      const body = JSON.parse(init.body); call.body = body; requests.push(call); prepareNumber++;
      return Response.json({ upload_id: `private-upload-task-${prepareNumber}`, presigned_url: `https://stardust-${prepareNumber}.cos.ap-guangzhou.myqcloud.com/upload?signature=presigned-secret-${prepareNumber}` }, { status: 200 });
    }
    if (init.method === "PUT") {
      const bytes = Buffer.from(init.body); call.body = bytes; requests.push(call);
      const etag = createHash("md5").update(bytes).digest("hex"); return new Response(null, { status: 200, headers: { ETag: `"${etag}"` } });
    }
    if (parsed.pathname === "/v2/media-images/complete") {
      call.body = JSON.parse(init.body); requests.push(call); const index = requests.filter((item) => new URL(item.url).pathname === "/v2/media-images/complete").length - 1;
      return Response.json({ image_id: `safe-image-id-${index + 1}`, url: materialRefs[index] }, { status: 200 });
    }
    call.body = JSON.parse(init.body); requests.push(call); return Response.json({ id: `local-markdown-message-${requests.length}` }, { status: 201 });
  });
  await manager.install("qq-bot"); await manager.saveConfig("qq-bot", { appId: "123", appSecret: "private-secret" }); await manager.enable("qq-bot");
  await waitFor(() => bots.length === 1 && manager.list()[0].state === "connected"); model.fail = true;
  await bots[0].emit("message", message("c2c", "local-private-inbound", { replyTarget: { scope: "c2c", targetId: "private-openid", msgId: "local-private-inbound" } }));
  await bots[0].emit("message", message("group", "local-group-inbound", { groupOpenid: "group-openid", replyTarget: { scope: "group", targetId: "group-openid", msgId: "local-group-inbound" } }));
  const targets = manager.capabilityTargets("qq-bot"); const privateTarget = targets.find((item) => item.scope === "private"); const groupTarget = targets.find((item) => item.scope === "group");
  assert.throws(() => manager.runCapabilityTest("qq-bot", { targetId: privateTarget.id, kind: "group-markdown-local-multi-image", requestId: randomUUID(), imageFiles: [firstPng, secondPng] }), { code: "INVALID_TARGET" });
  assert.throws(() => manager.runCapabilityTest("qq-bot", { targetId: privateTarget.id, kind: "private-markdown-local-multi-image", requestId: randomUUID(), imageFiles: [Buffer.from("not png"), secondPng] }), { code: "INVALID_INPUT" });
  assert.throws(() => manager.runCapabilityTest("qq-bot", { targetId: privateTarget.id, kind: "private-markdown-local-multi-image", requestId: randomUUID(), imageFiles: [Buffer.concat([firstPng, Buffer.alloc(10 * 1024 * 1024)]), secondPng] }), { code: "INVALID_INPUT" });
  const run = (target, scope) => manager.runCapabilityTest("qq-bot", { targetId: target.id, kind: `${scope}-markdown-local-multi-image`, mode: "passive", requestId: randomUUID(), imageFiles: [firstPng, secondPng] });
  const privateResult = await run(privateTarget, "private"); const groupResult = await run(groupTarget, "group");
  assert.deepEqual([privateResult.state, groupResult.state], ["success", "success"]);
  assert.equal(requests.filter((item) => new URL(item.url).pathname.endsWith("/messages")).length, 2, "exactly one Markdown send per confirmed test");
  const prepares = requests.filter((item) => new URL(item.url).pathname === "/v2/media-images/prepare");
  assert.equal(prepares.length, 4);
  assert.deepEqual(prepares.map((item) => item.body.file_size), [firstPng.length, secondPng.length, firstPng.length, secondPng.length]);
  const imageOrder = [firstPng, secondPng, firstPng, secondPng];
  assert.ok(prepares.every((item, index) => item.body.content_type === "image/png" && item.body.md5 === createHash("md5").update(imageOrder[index]).digest("hex") && item.body.sha1 === createHash("sha1").update(imageOrder[index]).digest("hex") && item.headers.get("authorization") === "QQBot private-token"));
  const puts = requests.filter((item) => item.method === "PUT");
  assert.equal(puts.length, 4); assert.deepEqual(puts.map((item) => item.body), [firstPng, secondPng, firstPng, secondPng]);
  assert.ok(puts.every((item) => item.headers.get("authorization") === null && item.headers.get("content-type") === "image/png"));
  const completes = requests.filter((item) => new URL(item.url).pathname === "/v2/media-images/complete");
  assert.equal(completes.length, 4); assert.ok(completes.every((item, index) => item.body.md5 === createHash("md5").update(imageOrder[index]).digest("hex") && item.headers.get("authorization") === "QQBot private-token"));
  const messages = requests.filter((item) => new URL(item.url).pathname.endsWith("/messages"));
  assert.deepEqual(messages.map((item) => new URL(item.url).pathname), ["/v2/users/private-openid/messages", "/v2/groups/group-openid/messages"]);
  for (const item of messages) {
    assert.equal(item.body.msg_type, 2); assert.equal(item.body.markdown.content, `## Stardust 本地多图测试\n\n![图片一 #320px #180px](${materialRefs[messages.indexOf(item) * 2]})\n\n![图片二 #320px #180px](${materialRefs[messages.indexOf(item) * 2 + 1]})`);
    assert.equal(item.body.msg_id, messages.indexOf(item) === 0 ? "local-private-inbound" : "local-group-inbound"); assert.ok(Number.isInteger(item.body.msg_seq));
  }
  assert.equal(privateResult.imageUploads[0].state, "success"); assert.equal(privateResult.imageUploads[1].state, "success");
  assert.match(privateResult.imageUploads[0].imageId, /•••/); assert.equal(privateResult.interface, "POST /v2/users/{openid}/messages");
  assert.equal(privateResult.stage, "send"); assert.equal(privateResult.clientReceived, "unconfirmed"); assert.equal(typeof privateResult.durationMs, "number");
  assert.doesNotMatch(JSON.stringify([privateResult, groupResult, logs.read()]), /private-secret|private-token|presigned-secret|material-token|private-openid|group-openid|local-private-inbound/);
  await manager.disable("qq-bot");
});

test("local Markdown image upload failure stops before message send and exposes only safe stage diagnostics", async (t) => {
  const firstPng = tinyPng(1, 2, 3), secondPng = tinyPng(4, 5, 6); const requests = []; let prepareNumber = 0;
  const { manager, model, bots } = await fixture(t, async (url, init) => {
    const parsed = new URL(url); requests.push({ url, method: init.method, body: init.body, headers: new Headers(init.headers) });
    if (parsed.pathname === "/v2/media-images/prepare") {
      prepareNumber++;
      if (prepareNumber === 2) return Response.json({ code: 40035002, message: "second image rejected private-secret" }, { status: 413 });
      return Response.json({ upload_id: "first-upload-task-secret", presigned_url: "https://stardust.cos.ap-guangzhou.myqcloud.com/upload?signature=signed-secret" });
    }
    if (init.method === "PUT") return new Response(null, { status: 200, headers: { ETag: `"${createHash("md5").update(init.body).digest("hex")}"` } });
    if (parsed.pathname === "/v2/media-images/complete") return Response.json({ image_id: "first-safe-image", url: "qqbot-media://image/v1/first-private-media-token" });
    return Response.json({ id: "should-not-send" });
  });
  await manager.install("qq-bot"); await manager.saveConfig("qq-bot", { appId: "123", appSecret: "private-secret" }); await manager.enable("qq-bot");
  await waitFor(() => bots.length === 1 && manager.list()[0].state === "connected"); model.fail = true;
  await bots[0].emit("message", message("c2c", "upload-failure-inbound", { replyTarget: { scope: "c2c", targetId: "private-openid", msgId: "upload-failure-inbound" } }));
  const target = manager.capabilityTargets("qq-bot").find((item) => item.scope === "private");
  const result = await manager.runCapabilityTest("qq-bot", { targetId: target.id, kind: "private-markdown-local-multi-image", requestId: randomUUID(), imageFiles: [firstPng, secondPng] });
  assert.equal(result.state, "rejected"); assert.equal(result.stage, "image_2_prepare"); assert.equal(result.httpStatus, 413); assert.equal(result.businessCode, "40035002");
  assert.deepEqual(result.imageUploads.map((item) => item.state), ["success", "rejected"]);
  assert.equal(requests.some((item) => new URL(item.url).pathname.endsWith("/messages")), false); assert.equal(requests.length, 4, "one prepare/put/complete for image one and one prepare rejection for image two");
  assert.match(result.message, /second image rejected/); assert.doesNotMatch(JSON.stringify(result), /private-secret|private-token|signed-secret|media-token|first-upload-task/);
  await manager.disable("qq-bot");
});

test("capability API accepts only two validated PNG parts for local Markdown uploads", async (t) => {
  const requests = []; const { root, manager, model, bots } = await fixture(t, async (url, init) => {
    const parsed = new URL(url); requests.push({ url, method: init.method });
    if (parsed.pathname === "/v2/media-images/prepare") return Response.json({ upload_id: `upload-${requests.length}`, presigned_url: "https://stardust.cos.ap-guangzhou.myqcloud.com/upload?sig=hidden" });
    if (init.method === "PUT") return new Response(null, { status: 200, headers: { ETag: `"${createHash("md5").update(init.body).digest("hex")}"` } });
    if (parsed.pathname === "/v2/media-images/complete") return Response.json({ image_id: `image-${requests.length}`, url: `qqbot-media://image/v1/private-token-${requests.length}` });
    return Response.json({ id: "local-message" }, { status: 201 });
  });
  const setup = new SetupService(createConfigStore(root)); const server = createStardustServer({ setupService: setup, extensionManager: manager });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { if (server.listening) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); } });
  const base = `http://127.0.0.1:${server.address().port}/api/v1/extensions/qq-bot`;
  await setup.completeInitialization({}); await manager.install("qq-bot"); await manager.saveConfig("qq-bot", { appId: "123", appSecret: "secret" }); await manager.enable("qq-bot");
  await waitFor(() => bots.length === 1 && manager.list()[0].state === "connected"); model.fail = true;
  await bots[0].emit("message", message("c2c", "multipart-inbound", { replyTarget: { scope: "c2c", targetId: "private-openid", msgId: "multipart-inbound" } }));
  const target = (await (await fetch(`${base}/capability-targets`)).json()).targets[0];
  const makeForm = (a, b, requestId = randomUUID()) => { const form = new FormData(); form.set("targetId", target.id); form.set("kind", "private-markdown-local-multi-image"); form.set("mode", "passive"); form.set("requestId", requestId); form.set("image1", a); form.set("image2", b); return form; };
  const origin = { Origin: `http://127.0.0.1:${server.address().port}` };
  const invalidType = await fetch(`${base}/capability-test`, { method: "POST", headers: origin, body: makeForm(new File([Buffer.from("not png")], "first.png", { type: "image/png" }), new File([tinyPng(1, 2, 3)], "second.png", { type: "image/png" })) });
  assert.equal(invalidType.status, 400); assert.equal(requests.length, 0);
  const oversize = new File([Buffer.concat([tinyPng(1, 2, 3), Buffer.alloc(10 * 1024 * 1024)])], "large.png", { type: "image/png" });
  const oversizedResponse = await fetch(`${base}/capability-test`, { method: "POST", headers: origin, body: makeForm(oversize, new File([tinyPng(4, 5, 6)], "second.png", { type: "image/png" })) });
  assert.equal(oversizedResponse.status, 400); assert.equal(requests.length, 0);
  const valid = await fetch(`${base}/capability-test`, { method: "POST", headers: origin, body: makeForm(new File([tinyPng(10, 20, 30)], "first.png", { type: "image/png" }), new File([tinyPng(40, 50, 60)], "second.png", { type: "image/png" })) });
  assert.equal(valid.status, 200); const result = (await valid.json()).result; assert.equal(result.state, "success"); assert.equal(requests.filter((item) => item.url.endsWith("/messages")).length, 1);
  assert.doesNotMatch(JSON.stringify(result), /private-token|private-openid/);
  await manager.disable("qq-bot");
});

test("QQ stream probes use the real C2C passive protocol, ordered frames and a final completion frame", async (t) => {
  const requests = [];
  const { manager, model, bots, logs } = await fixture(t, async (url, init) => {
    if (url.includes("/stream_messages")) requests.push({ url, init, body: JSON.parse(init.body) });
    return Response.json({ id: url.includes("/stream_messages") ? "private-stream-id" : "ordinary-send" }, { status: url.includes("/stream_messages") ? 201 : 200 });
  });
  await manager.install("qq-bot"); await manager.saveConfig("qq-bot", { appId: "123", appSecret: "private-secret" }); await manager.enable("qq-bot");
  await waitFor(() => bots.length === 1 && manager.list()[0].state === "connected"); model.fail = true;
  await bots[0].emit("message", message("c2c", "private-inbound-id", { replyTarget: { scope: "c2c", targetId: "private-openid", msgId: "private-inbound-id" } }));
  await bots[0].emit("message", message("group", "group-inbound-id", { groupOpenid: "group-openid", replyTarget: { scope: "group", targetId: "group-openid", msgId: "group-inbound-id" } }));
  const targets = manager.capabilityTargets("qq-bot");
  const privateTarget = targets.find((target) => target.scope === "private"); const groupTarget = targets.find((target) => target.scope === "group");
  const privatePassive = { targetId: privateTarget.id, kind: "private-text", mode: "passive", stream: true, requestId: randomUUID() };
  const result = await manager.runCapabilityTest("qq-bot", privatePassive);
  assert.equal(result.state, "success"); assert.equal(result.mode, "passive"); assert.equal(result.stream, true);
  assert.equal(result.frameCount, 4); assert.equal(result.completion, "complete"); assert.equal(result.clientReceived, "unconfirmed");
  assert.match(result.streamMsgId, /•••/); assert.doesNotMatch(JSON.stringify(result), /private-stream-id|private-openid|private-inbound-id|private-secret/);
  assert.equal(result.httpStatus, 201); assert.ok(result.frames.every((frame) => frame.httpStatus === 201));
  let calls = requests.slice(0, 4);
  assert.equal(calls.length, 4); assert.deepEqual(calls.map((call) => call.body.index), [0, 1, 2, 3]);
  assert.deepEqual(calls.map((call) => call.body.content_raw), ["Stardust", "Stardust 正在测试", "Stardust 正在测试流式消息", "Stardust 正在测试流式消息"]);
  assert.deepEqual(calls.map((call) => call.body.input_state), [1, 1, 1, 10]);
  assert.ok(calls.every((call) => call.url === "https://api.sgroup.qq.com/v2/users/private-openid/stream_messages" && call.body.msg_id === "private-inbound-id" && call.body.event_id === "private-inbound-id"));
  assert.ok(calls.every((call) => call.body.msg_seq === calls[0].body.msg_seq));
  assert.ok(calls.slice(1).every((call) => call.body.stream_msg_id === "private-stream-id"));
  assert.ok(calls.every((call) => call.body.input_mode === "replace" && call.body.content_type === "markdown"));
  assert.ok(calls.every((call) => call.init.headers.Authorization === "QQBot private-token"));

  const active = await manager.runCapabilityTest("qq-bot", { targetId: privateTarget.id, kind: "private-text", mode: "active", stream: true, requestId: randomUUID() });
  assert.equal(active.state, "success"); assert.equal(active.mode, "active"); assert.equal(active.httpStatus, 201);
  calls = requests.slice(4, 8); assert.equal(calls.length, 4);
  assert.ok(calls.every((call) => !("msg_id" in call.body) && !("event_id" in call.body)));
  assert.ok(calls.every((call) => call.body.msg_seq === 1));
  assert.ok(calls.slice(1).every((call) => call.body.stream_msg_id === "private-stream-id"));
  assert.equal(bots[0].streamCalls.length, 0, "the retrying/high-level SDK stream wrapper must not be used");

  const groupPassive = await manager.runCapabilityTest("qq-bot", { targetId: groupTarget.id, kind: "group-text", mode: "passive", stream: true, requestId: randomUUID() });
  assert.equal(groupPassive.state, "success"); assert.match(groupPassive.interface, /实验性、未验证候选接口/);
  calls = requests.slice(8, 12); assert.equal(calls.length, 4);
  assert.ok(calls.every((call) => call.url === "https://api.sgroup.qq.com/v2/groups/group-openid/stream_messages"));
  assert.ok(calls.every((call) => call.body.msg_id === "group-inbound-id" && call.body.event_id === "group-inbound-id"));
  const groupActive = await manager.runCapabilityTest("qq-bot", { targetId: groupTarget.id, kind: "group-text", mode: "active", stream: true, requestId: randomUUID() });
  assert.equal(groupActive.state, "success"); calls = requests.slice(12, 16); assert.equal(calls.length, 4);
  assert.ok(calls.every((call) => !("msg_id" in call.body) && !("event_id" in call.body)));
  assert.ok(calls.every((call) => call.url === "https://api.sgroup.qq.com/v2/groups/group-openid/stream_messages"));

  const ordinaryPassive = await manager.runCapabilityTest("qq-bot", { targetId: privateTarget.id, kind: "private-text", mode: "passive", requestId: randomUUID() });
  assert.equal(ordinaryPassive.state, "success"); assert.equal(ordinaryPassive.stream, false);
  const activeCallsBefore = requests.length;
  assert.equal(requests.length, activeCallsBefore);
  const diagnostics = JSON.stringify(logs.read());
  assert.doesNotMatch(diagnostics, /private-openid|group-openid|private-inbound-id|group-inbound-id|private-secret|private-stream-id|hello/);
  await manager.disable("qq-bot");
});

test("QQ stream frame failures are reported without retries and preserve partial progress", async (t) => {
  const requests = [];
  const { manager, model, bots } = await fixture(t, async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) });
    return requests.length === 2 ? Response.json({ code: 50002, message: "rate limited" }, { status: 429 }) : Response.json({ id: "private-stream-id" }, { status: 201 });
  });
  await manager.install("qq-bot"); await manager.saveConfig("qq-bot", { appId: "123", appSecret: "private-secret" }); await manager.enable("qq-bot");
  await waitFor(() => bots.length === 1 && manager.list()[0].state === "connected"); model.fail = true;
  await bots[0].emit("message", message("c2c", "private-inbound-id", { replyTarget: { scope: "c2c", targetId: "private-openid", msgId: "private-inbound-id" } }));
  const target = manager.capabilityTargets("qq-bot").find((entry) => entry.scope === "private");
  const result = await manager.runCapabilityTest("qq-bot", { targetId: target.id, kind: "private-text", mode: "passive", stream: true, requestId: randomUUID() });
  assert.equal(requests.length, 2); assert.equal(bots[0].streamCalls.length, 0); assert.equal(result.state, "partial_success");
  assert.equal(result.httpStatus, 429); assert.equal(result.businessCode, "50002"); assert.equal(result.frameCount, 1); assert.equal(result.completion, "partial");
  assert.deepEqual(result.frames.map((frame) => frame.state), ["success", "rejected"]);
  await manager.disable("qq-bot");
});

test("active QQ stream sends one unassociated first frame, stops on rejection, and never retries or falls back", async (t) => {
  const requests = [];
  const { manager, model, bots, logs } = await fixture(t, async (url, init) => {
    requests.push({ url, init, body: JSON.parse(init.body) });
    return Response.json({ code: 22009, message: "active stream denied private-secret private-openid" }, { status: 403 });
  });
  await manager.install("qq-bot"); await manager.saveConfig("qq-bot", { appId: "123", appSecret: "private-secret" }); await manager.enable("qq-bot");
  await waitFor(() => bots.length === 1 && manager.list()[0].state === "connected"); model.fail = true;
  await bots[0].emit("message", message("c2c", "real-inbound-id", { replyTarget: { scope: "c2c", targetId: "private-openid", msgId: "real-inbound-id" } }));
  const target = manager.capabilityTargets("qq-bot").find((entry) => entry.scope === "private");
  const result = await manager.runCapabilityTest("qq-bot", { targetId: target.id, kind: "private-text", mode: "active", stream: true, requestId: randomUUID() });
  assert.equal(requests.length, 1); assert.equal(result.state, "rejected"); assert.equal(result.httpStatus, 403); assert.equal(result.businessCode, "22009");
  assert.equal(requests[0].url, "https://api.sgroup.qq.com/v2/users/private-openid/stream_messages");
  assert.ok(!("msg_id" in requests[0].body) && !("event_id" in requests[0].body));
  assert.equal(requests[0].init.headers.Authorization, "QQBot private-token");
  assert.equal(bots[0].streamCalls.length, 0); assert.doesNotMatch(JSON.stringify(result), /private-secret|private-openid|real-inbound-id/);
  assert.doesNotMatch(JSON.stringify(logs.read()), /private-secret|private-openid|real-inbound-id|active stream denied/);
  await manager.disable("qq-bot");
});

test("group stream candidate records real 404, 400 and 403 responses without retrying", async (t) => {
  const requests = []; const outcomes = [[404, 100404], [400, 100400], [403, 100403]];
  const { manager, model, bots, logs } = await fixture(t, async (url, init) => {
    const body = JSON.parse(init.body); requests.push({ url, body, init });
    const [status, code] = outcomes[requests.length - 1];
    return Response.json({ code, message: `candidate denied ${status} private-secret group-openid` }, { status });
  });
  await manager.install("qq-bot"); await manager.saveConfig("qq-bot", { appId: "123", appSecret: "private-secret" }); await manager.enable("qq-bot");
  await waitFor(() => bots.length === 1 && manager.list()[0].state === "connected"); model.fail = true;
  await bots[0].emit("message", message("group", "real-group-message", { groupOpenid: "group-openid", replyTarget: { scope: "group", targetId: "group-openid", msgId: "real-group-message" } }));
  const target = manager.capabilityTargets("qq-bot").find((entry) => entry.scope === "group");
  const wrongScope = manager.capabilityTargets("qq-bot").find((entry) => entry.scope === "private");
  assert.throws(() => manager.runCapabilityTest("qq-bot", { targetId: wrongScope?.id ?? randomUUID(), kind: "group-text", mode: "active", stream: true, requestId: randomUUID() }), { code: "INVALID_TARGET" });
  for (const [index, [status, code]] of outcomes.entries()) {
    const result = await manager.runCapabilityTest("qq-bot", { targetId: target.id, kind: "group-text", mode: index === 1 ? "passive" : "active", stream: true, requestId: randomUUID() });
    assert.equal(result.state, "rejected"); assert.equal(result.httpStatus, status); assert.equal(result.businessCode, String(code));
    assert.match(result.interface, /POST \/v2\/groups\/\{group_openid\}\/stream_messages（实验性、未验证候选接口）/);
    assert.equal(result.frameCount, 0); assert.equal(result.completion, "not_started");
  }
  assert.equal(requests.length, 3, "each manually initiated experiment sends exactly one rejected first frame");
  assert.ok(requests.every(({ url }) => url === "https://api.sgroup.qq.com/v2/groups/group-openid/stream_messages"));
  assert.ok(requests[0].body.msg_id === undefined && requests[0].body.event_id === undefined);
  assert.equal(requests[1].body.msg_id, "real-group-message"); assert.equal(requests[1].body.event_id, "real-group-message");
  assert.ok(requests[2].body.msg_id === undefined && requests[2].body.event_id === undefined);
  assert.ok(requests.every(({ init }) => init.headers.Authorization === "QQBot private-token"));
  assert.doesNotMatch(JSON.stringify(logs.read()), /private-secret|group-openid|real-group-message|candidate denied/);
  await manager.disable("qq-bot");
});

test("repeated confirmation with the same request ID sends one group stream first frame", async (t) => {
  const requests = [];
  let releaseFirstRequest;
  const firstRequest = new Promise((resolve) => { releaseFirstRequest = resolve; });
  const { manager, model, bots } = await fixture(t, async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) });
    if (requests.length === 1) await firstRequest;
    return Response.json({ code: 100404, message: "candidate path not found" }, { status: 404 });
  });
  await manager.install("qq-bot"); await manager.saveConfig("qq-bot", { appId: "123", appSecret: "private-secret" }); await manager.enable("qq-bot");
  await waitFor(() => bots.length === 1 && manager.list()[0].state === "connected"); model.fail = true;
  await bots[0].emit("message", message("group", "real-group-message", { groupOpenid: "group-openid", replyTarget: { scope: "group", targetId: "group-openid", msgId: "real-group-message" } }));
  const target = manager.capabilityTargets("qq-bot").find((entry) => entry.scope === "group");
  const input = { targetId: target.id, kind: "group-text", mode: "active", stream: true, requestId: randomUUID() };
  const first = manager.runCapabilityTest("qq-bot", input);
  await waitFor(() => requests.length === 1);
  const duplicate = manager.runCapabilityTest("qq-bot", input);
  releaseFirstRequest();
  const [result, duplicateResult] = await Promise.all([first, duplicate]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://api.sgroup.qq.com/v2/groups/group-openid/stream_messages");
  assert.ok(!("msg_id" in requests[0].body) && !("event_id" in requests[0].body));
  assert.equal(result.httpStatus, 404); assert.equal(duplicateResult.httpStatus, 404);
  await manager.disable("qq-bot");
});

test("manual QQ platform rejections, network failures and expiration do not retry or leak secrets", async (t) => {
  let calls = 0; let mode = "reject";
  const mockFetch = async () => {
    calls++;
    if (mode === "network") throw new Error("private-token private-secret");
    return Response.json({ code: 12345, message: "Denied private-secret Authorization: QQBot private-token openid=private-openid" }, { status: 403 });
  };
  const { manager, model, bots, logs } = await fixture(t, mockFetch);
  await manager.install("qq-bot"); await manager.saveConfig("qq-bot", { appId: "123", appSecret: "private-secret" }); await manager.enable("qq-bot");
  await waitFor(() => bots.length === 1 && manager.list()[0].state === "connected"); model.fail = true;
  await bots[0].emit("message", message("c2c", "sensitive-msg", { replyTarget: { scope: "c2c", targetId: "private-openid", msgId: "sensitive-msg" } }));
  await bots[0].emit("message", message("group", "expired-msg", { timestamp: new Date(Date.now() - 360000).toISOString() }));
  const targets = manager.capabilityTargets("qq-bot");
  const target = targets.find((item) => item.scope === "private");
  const rejected = await manager.runCapabilityTest("qq-bot", { targetId: target.id, kind: "private-file", requestId: randomUUID() });
  assert.equal(calls, 1); assert.equal(rejected.stage, "upload"); assert.equal(rejected.state, "rejected"); assert.equal(rejected.httpStatus, 403); assert.equal(rejected.businessCode, "12345");
  assert.doesNotMatch(JSON.stringify(rejected), /private-secret|private-token|private-openid|sensitive-msg/);
  mode = "network";
  const network = await manager.runCapabilityTest("qq-bot", { targetId: target.id, kind: "private-text", requestId: randomUUID() });
  assert.equal(calls, 2); assert.equal(network.state, "network_failure"); assert.doesNotMatch(JSON.stringify(network), /private-secret|private-token/);
  const expired = await manager.runCapabilityTest("qq-bot", { targetId: targets.find((item) => item.scope === "group").id, kind: "group-png", requestId: randomUUID() });
  assert.equal(expired.state, "unavailable"); assert.equal(calls, 2);
  assert.doesNotMatch(JSON.stringify(logs.read()), /private-secret|private-token|private-openid|sensitive-msg/);
});

test("capability HTTP execution enforces origin, validated inputs, enabled state and request idempotency", async (t) => {
  let calls = 0;
  const requests = [];
  const { root, manager, model, bots } = await fixture(t, async (url, init) => { calls++; requests.push({ url, body: JSON.parse(init.body) }); return Response.json({ id: "sent-by-platform" }, { status: 201 }); });
  const setup = new SetupService(createConfigStore(root));
  const server = createStardustServer({ setupService: setup, extensionManager: manager });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { if (server.listening) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); } });
  const base = `http://127.0.0.1:${server.address().port}/api/v1/extensions/qq-bot`;
  const post = (body, headers = {}) => fetch(`${base}/capability-test`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  assert.equal((await post({})).status, 403);
  await setup.completeInitialization({}); await manager.install("qq-bot"); await manager.saveConfig("qq-bot", { appId: "123", appSecret: "secret" }); await manager.enable("qq-bot");
  await waitFor(() => bots.length === 1 && manager.list()[0].state === "connected"); model.fail = true;
  await bots[0].emit("message", message("c2c", "message-private"));
  const target = (await (await fetch(`${base}/capability-targets`)).json()).targets[0];
  const body = { targetId: target.id, kind: "private-text", requestId: randomUUID() };
  assert.equal((await post(body, { Origin: "https://attacker.example" })).status, 403); assert.equal(calls, 0);
  assert.equal((await post({ ...body, extra: "field" })).status, 400); assert.equal(calls, 0);
  const first = await post(body); assert.equal(first.status, 200);
  const result = (await first.json()).result; assert.equal(result.httpStatus, 201); assert.equal(result.state, "success");
  assert.equal((await post(body)).status, 200); assert.equal(calls, 1);
  const markdownBody = { targetId: target.id, kind: "private-markdown-multi-image", mode: "passive", requestId: randomUUID(), imageUrl1: "https://images.example.com/first.png", imageUrl2: "https://cdn.example.net/second.png" };
  const markdownResponse = await post(markdownBody); assert.equal(markdownResponse.status, 200);
  const markdownResult = (await markdownResponse.json()).result;
  assert.equal(markdownResult.state, "success"); assert.equal(markdownResult.requestMessageId, "•••vate");
  assert.equal(requests[1].body.msg_type, 2); assert.equal(requests[1].body.msg_id, "message-private"); assert.ok(Number.isInteger(requests[1].body.msg_seq));
  assert.equal((await post({ ...markdownBody, imageUrl1: "https://images.example.org/changed.png" })).status, 400, "an idempotency key cannot be reused with changed image URLs");
  const invalidUrls = await post({ ...markdownBody, requestId: randomUUID(), imageUrl1: "http://127.0.0.1/image.png" }); assert.equal(invalidUrls.status, 400);
  assert.equal(calls, 2); assert.doesNotMatch(JSON.stringify(markdownResult), /images\.example\.com|cdn\.example\.net/);
  const invalid = await post({ ...body, targetId: randomUUID(), requestId: randomUUID() }); assert.equal(invalid.status, 400); assert.equal(calls, 2);
  await manager.disable("qq-bot"); assert.equal((await post({ ...body, requestId: randomUUID() })).status, 409); assert.equal(calls, 2);
});
