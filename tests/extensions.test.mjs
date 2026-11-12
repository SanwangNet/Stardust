import assert from "node:assert/strict";
import fs from "node:fs";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
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
  return {
    sent: [], stopped: false, failSend: false,
    tokenManager: { async getAccessToken() { return "private-token"; } },
    on(name, handler) { handlers.set(name, handler); return this; },
    start() { handlers.get("ready")?.(); return new Promise((resolve) => { finish = resolve; }); },
    stop() { this.stopped = true; finish?.(); },
    async sendText(target, text) { if (this.failSend) throw Object.assign(new Error("secret-and-message"), { bizCode: 11281, httpStatus: 429 }); this.sent.push({ target, text }); return { id: `sent-${this.sent.length}` }; },
    emit(name, value) { return handlers.get(name)?.({}, value); },
  };
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
  const other = { ...fail, manifest: { ...fail.manifest, id: "other-extension" } };
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
    assert.equal(calls[before + 1].init.redirect, "error");
  }
  assert.doesNotMatch(JSON.stringify(logs.read()), /private-openid|group-openid|private-msg-id|group-msg-id|private-secret|private-token|Hello, Stardust/);
  await manager.disable("qq-bot");
  assert.throws(() => manager.runCapabilityTest("qq-bot", input), { code: "EXTENSION_NOT_CONNECTED" });
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
  const { root, manager, model, bots } = await fixture(t, async () => { calls++; return Response.json({ id: "sent-by-platform" }, { status: 201 }); });
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
  const invalid = await post({ ...body, targetId: randomUUID(), requestId: randomUUID() }); assert.equal(invalid.status, 400); assert.equal(calls, 1);
  await manager.disable("qq-bot"); assert.equal((await post({ ...body, requestId: randomUUID() })).status, 409); assert.equal(calls, 1);
});
