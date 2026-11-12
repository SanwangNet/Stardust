import assert from "node:assert/strict";
import fs from "node:fs";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createConfigStore } from "../apps/server/dist/config.js";
import { createSecretStore } from "../apps/server/dist/model-secret.js";
import { ModelService } from "../apps/server/dist/model.js";
import { createEnvLoader } from "../apps/server/dist/env.js";
import { ExtensionManager } from "../apps/server/dist/extension-manager.js";
import { createQQBotExtension } from "../apps/server/dist/extensions/qq-bot.js";
import { SetupService } from "../apps/server/dist/setup.js";
import { createStardustServer } from "../apps/server/dist/app.js";

function mockBot() {
  const handlers = new Map();
  let finish;
  return {
    sent: [], stopped: false, failSend: false,
    on(name, handler) { handlers.set(name, handler); return this; },
    start() { handlers.get("ready")?.(); return new Promise((resolve) => { finish = resolve; }); },
    stop() { this.stopped = true; finish?.(); },
    async sendText(target, text) { if (this.failSend) throw new Error("secret-and-message"); this.sent.push({ target, text }); return { id: `sent-${this.sent.length}` }; },
    emit(name, value) { return handlers.get(name)?.({}, value); },
  };
}
const message = (kind, id, extra = {}) => ({ kind, rawEventType: kind === "c2c" ? "C2C_MESSAGE_CREATE" : "GROUP_AT_MESSAGE_CREATE", senderId: "sender", messageId: id, timestamp: new Date().toISOString(), content: "hello", replyTarget: { scope: kind, targetId: "conversation", msgId: id }, ...extra });
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "stardust-extensions-"));
  const bots = [];
  const model = { fail: false, calls: [], async chat(content, signal) { this.calls.push(content); if (this.fail) throw new Error("secret-and-message"); if (signal.aborted) throw new Error("aborted"); return `reply:${content}`; } };
  const extension = createQQBotExtension(async () => { const bot = mockBot(); bots.push(bot); return bot; });
  const manager = new ExtensionManager(root, model, [extension]);
  t.after(async () => { manager.shutdown(); await rm(root, { recursive: true, force: true }); });
  return { root, model, manager, extension, bots };
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
  const { manager, model, bots } = await fixture(t);
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
  await manager.disable("qq-bot"); await bot.emit("message", message("c2c", "five")); assert.equal(model.calls.length, 4);
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
