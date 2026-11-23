// Disposable, loopback-only browser fixture; all identities, tools and credentials are synthetic.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createStardustServer } from "../../apps/server/dist/app.js";
import { ConversationService } from "../../apps/server/dist/conversation.js";
import { ExtensionManager } from "../../apps/server/dist/extension-manager.js";
import { createQQBotExtension } from "../../apps/server/dist/extensions/qq-bot.js";
import { LogService } from "../../apps/server/dist/logger.js";
import { SetupService } from "../../apps/server/dist/setup.js";
import { createConfigStore } from "../../apps/server/dist/config.js";

const token = "a".repeat(43), root = mkdtempSync(join(tmpdir(), "stardust-browser-fixture-"));
const handlers = new Map(); let finish;
const bot = { on(name, fn) { handlers.set(name, fn); }, start() { handlers.get("ready")(); return new Promise(resolve => { finish = resolve; }); }, stop() { finish?.(); }, async sendText() { return { id: "mock-reply" }; }, emit(event) { return handlers.get("message")({}, event); } };
const tool = { name: "mock_write", description: "模拟操作", parameters: { type: "object" }, validate: input => input?.content ? input : null,
  prepare: input => ({ approval: { operation: "模拟发送", targetDescription: "测试目标", content: input.content, risk: "仅测试，无真实发送", ...(input.content === "模拟审批过期" ? { expiresAt: new Date(Date.now() + 300).toISOString() } : {}) } }),
  async execute() { return { status: "sent" }; } };
const pkg = (id, tools = []) => ({ manifest: { id, name: id, version: "1", description: "fixture", type: "channel", fields: [] }, tools,
  create(_config, host) { return { start() { host.status("connected"); }, stop() {} }; } });
const model = { async chatContext() { return "模拟普通回复"; }, async chatWithTools(messages) {
  if (messages.at(-1).role === "tool") return { content: `模拟结果：${JSON.parse(messages.at(-1).content).status}`, toolCalls: [] };
  if (messages.at(-1).content === "expired") return { content: "模拟过期回复", toolCalls: [] };
  return { content: "", toolCalls: [{ id: "mock_call", name: "mock_write", arguments: JSON.stringify({ content: messages.at(-1).content === "approval-expiry" ? "模拟审批过期" : "模拟内容：" + "长文本".repeat(30) }) }] };
} };
const manager = new ExtensionManager(root, model, [createQQBotExtension(async () => bot), pkg("mock-provider", [tool])], new LogService(100, () => {}));
const store = new ConversationService(model, ":memory:");
const setup = new SetupService(createConfigStore(root)); await setup.completeInitialization({});
const server = createStardustServer({ setupService: setup, extensionManager: manager, modelService: model, conversationService: store,
  qqApprovalToken: token, qqToolCalling: { enabled: true, policy: { private: ["mock_write"], privateSenders: ["mock-sender"], group: ["mock_write"], groups: ["mock-group"], groupSenders: ["mock-sender"] } } });
server.listen(0, "127.0.0.1", async () => {
  await manager.install("qq-bot"); await manager.saveConfig("qq-bot", { appId: "123", appSecret: "mock-secret" }); await manager.enable("qq-bot");
  while (!handlers.has("message")) await new Promise(resolve => setTimeout(resolve, 10));
  await manager.install("mock-provider"); await manager.enable("mock-provider");
  await manager.setToolEnabled("mock-provider", "mock_write", true);
  for (const id of ["one", "two"]) await bot.emit({ kind: "c2c", rawEventType: "C2C_MESSAGE_CREATE", senderId: "mock-sender", messageId: id, timestamp: new Date().toISOString(), content: id, replyTarget: { scope: "c2c", targetId: "mock-private-id", msgId: id } });
  await bot.emit({ kind: "group", rawEventType: "GROUP_AT_MESSAGE_CREATE", groupOpenid: "mock-group", senderId: "mock-sender", messageId: "expired", timestamp: new Date(Date.now() - 360_000).toISOString(), content: "expired", replyTarget: { scope: "group", targetId: "mock-group", msgId: "expired" } });
  await bot.emit({ kind: "c2c", rawEventType: "C2C_MESSAGE_CREATE", senderId: "mock-sender", messageId: "approval-expiry", timestamp: new Date().toISOString(), content: "approval-expiry", replyTarget: { scope: "c2c", targetId: "mock-private-id", msgId: "approval-expiry" } });
  console.log(`Fixture URL: http://127.0.0.1:${server.address().port} Token: ${token}`);
});
process.once("SIGINT", () => { server.closeAllConnections(); server.close(async () => { await manager.shutdown(); const absolute = resolve(root); if (absolute.startsWith(resolve(tmpdir()) + sep + "stardust-browser-fixture-")) rmSync(absolute, { recursive: true, force: true }); process.exit(0); }); });
