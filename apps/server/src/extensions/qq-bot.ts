import type { QQBot, QQBotInboundMessage } from "@tencent-connect/qqbot-nodejs";
import { setTimeout as delay } from "node:timers/promises";
import { createHash, randomUUID } from "node:crypto";
import type { ExtensionPackage } from "../channel.js";

type BotFactory = (appId: string, appSecret: string) => Promise<QQBot>;
const defaultFactory: BotFactory = async (appId, appSecret) => {
  const { QQBot } = await import("@tencent-connect/qqbot-nodejs");
  return new QQBot({ appId, appSecret, intents: 1 << 25, reconnect: { maxAttempts: 10 } });
};
function platformError(error: unknown): { code?: string; status?: number } {
  if (!error || typeof error !== "object") return {};
  const value = error as { bizCode?: unknown; closeCode?: unknown; code?: unknown; httpStatus?: unknown };
  const number = typeof value.bizCode === "number" ? value.bizCode : value.closeCode;
  const safeCodes = ["GATEWAY_RETRY_EXHAUSTED", "GATEWAY_FATAL_CLOSE", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND"];
  const code = typeof number === "number" && Number.isSafeInteger(number) ? String(number) : typeof value.code === "string" && safeCodes.includes(value.code) ? value.code : undefined;
  const status = typeof value.httpStatus === "number" && value.httpStatus >= 100 && value.httpStatus <= 599 ? value.httpStatus : undefined;
  return { code, status };
}
export function createQQBotExtension(factory: BotFactory = defaultFactory): ExtensionPackage { return {
  manifest: {
    id: "qq-bot", name: "QQ 官方机器人", version: "1.0.0", description: "通过 QQ 开放平台接收私聊和群聊 @消息。", type: "channel",
    fields: [
      { key: "appId", env: "QQBOT_APP_ID", label: "AppID", sensitive: false, required: true },
      { key: "appSecret", env: "QQBOT_APP_SECRET", label: "AppSecret", sensitive: true, required: true },
    ],
  },
  create(config, host) {
    let bot: QQBot | undefined;
    let stopped = false;
    const controller = new AbortController();
    const seen = new Map<string, number>();
    const replies = new Map<string, number>();
    const conversations = new Map<string, number[]>();
    let pending = 0;
    let queue: Promise<void> = Promise.resolve();
    let sending: Promise<unknown> | undefined;
    let lastAccepted = 0;
    async function receive(message: QQBotInboundMessage): Promise<void> {
      const eventId = randomUUID();
      const scope = message.kind === "group" ? "group" : message.kind === "c2c" ? "private" : "other";
      host.log("DEBUG", "收到 QQ 消息事件。", { eventId, scope });
      const filtered = (reason: string): void => host.log("DEBUG", "QQ 消息已过滤。", { eventId, scope, reason });
      if (stopped || controller.signal.aborted || message.senderIsBot === true) { filtered("stopped_or_bot"); return; }
      if (message.kind === "c2c" ? message.rawEventType !== "C2C_MESSAGE_CREATE" : message.kind !== "group" || message.rawEventType !== "GROUP_AT_MESSAGE_CREATE") { filtered("unsupported_or_not_mentioned"); return; }
      if (typeof message.messageId !== "string" || !message.messageId || message.messageId.length > 1024 || typeof message.senderId !== "string" || !message.senderId || typeof message.replyTarget?.targetId !== "string" || !message.replyTarget.targetId || message.replyTarget.scope !== message.kind || message.replyTarget.msgId !== message.messageId || typeof message.content !== "string" || !message.content.trim() || Buffer.byteLength(message.content, "utf8") > 32 * 1024) { filtered("invalid_or_empty"); return; }
      const now = Date.now();
      for (const [id, time] of seen) if (now - time > 300_000) seen.delete(id);
      for (const [id, time] of replies) if (now - time > 300_000) replies.delete(id);
      for (const [id, times] of conversations) if (times.every((time) => now - time >= 60_000)) conversations.delete(id);
      const id = `${message.kind}:${message.messageId}`;
      if (seen.has(id)) { filtered("duplicate"); return; }
      seen.set(id, now);
      if (seen.size > 4096) seen.delete(seen.keys().next().value!);
      const conversation = `${message.kind}:${message.replyTarget.targetId}`;
      const digest = (content: string) => createHash("sha256").update(content.trim()).digest("hex");
      if (replies.has(`${conversation}:${digest(message.content)}`)) { filtered("reply_echo"); return; }
      const recent = (conversations.get(conversation) ?? []).filter((time) => now - time < 60_000);
      if (recent.length >= 5) { filtered("rate_limit"); return; }
      recent.push(now); conversations.set(conversation, recent);
      if (conversations.size > 4096) conversations.delete(conversations.keys().next().value!);
      if (pending >= 20) { filtered("queue_full"); return; }
      host.log("INFO", "QQ 消息已接受。", { eventId, scope });
      pending++;
      const work = async (): Promise<void> => {
        try {
          const wait = Math.max(0, 1000 - (Date.now() - lastAccepted));
          if (wait) await delay(wait, undefined, { signal: controller.signal });
          if (stopped || Date.now() - now > 240_000) { filtered("expired_or_stopped"); return; }
          lastAccepted = Date.now();
          let reply: string;
          host.log("DEBUG", "QQ 消息开始调用模型。", { eventId, scope });
          try { reply = await host.message({ channelId: "qq-bot", eventId, messageId: message.messageId, senderId: message.senderId, conversationId: message.replyTarget.targetId, conversationType: message.kind === "c2c" ? "private" : "group", content: message.content.trim(), timestamp: message.timestamp }, controller.signal); }
          catch { if (!stopped) { host.log("ERROR", "QQ 消息的模型调用失败。", { eventId, scope }); host.reportError("MODEL_FAILED"); } return; }
          if (stopped || controller.signal.aborted || Date.now() - now > 240_000 || !reply.trim()) { filtered("expired_stopped_or_empty_reply"); return; }
          try {
            const content = Array.from(reply).slice(0, 1500).join("");
            const request = bot!.sendText({ scope: message.replyTarget.scope, targetId: message.replyTarget.targetId, msgId: message.messageId }, content);
            sending = request;
            const sent = await request.finally(() => { if (sending === request) sending = undefined; });
            if (sent.id) seen.set(`${message.kind}:${sent.id}`, Date.now());
            replies.set(`${conversation}:${digest(content)}`, Date.now());
            if (replies.size > 4096) replies.delete(replies.keys().next().value!);
            host.log("INFO", "QQ 回复发送成功。", { eventId, scope });
          } catch (error) { if (!stopped) { host.log("ERROR", "QQ 回复发送失败。", { eventId, scope, ...platformError(error) }); host.reportError("SEND_FAILED"); } }
        } catch {
          if (!stopped) host.reportError("MODEL_FAILED");
        } finally { pending--; }
      };
      queue = queue.then(work, work);
      await queue;
    }
    return {
      start() {
        void (async () => {
          try {
            bot = await factory(config.appId!, config.appSecret!);
            if (stopped) return;
            bot.on("ready", () => { if (!stopped) { host.log("INFO", "QQ Gateway 已连接。"); host.status("connected"); } });
            bot.on("resumed", () => { if (!stopped) { host.log("INFO", "QQ Gateway 已恢复连接。"); host.status("connected"); } });
            bot.on("disconnected", (event) => { if (!stopped) { host.log("WARN", event.willReconnect ? "QQ Gateway 已断开，正在重连。" : "QQ Gateway 已断开，不再重连。", { code: Number.isSafeInteger(event.code) ? String(event.code) : undefined }); host.status(event.willReconnect ? "connecting" : "disconnected"); } });
            bot.on("error", (error) => { if (!stopped) { host.log("ERROR", "QQ Gateway 连接异常。", platformError(error)); host.status("error", "QQ 连接异常，请检查网络及平台权限。"); } });
            bot.on("message", (_context, message) => receive(message));
            await bot.start(controller.signal);
            if (!stopped) { host.log("WARN", "QQ Gateway 已断开。"); host.status("disconnected"); }
          } catch (error) { if (!stopped) { host.log("ERROR", "QQ Gateway 启动失败。", platformError(error)); host.status("error", "QQ 连接失败，请检查凭据、网络及平台权限。"); } }
        })();
      },
      async stop() { if (!stopped) host.log("INFO", "QQ Gateway 正在停止。"); stopped = true; controller.abort(); bot?.stop(); if (sending) await sending.catch(() => {}); },
    };
  },
}; }
export const qqBotExtension = createQQBotExtension();
