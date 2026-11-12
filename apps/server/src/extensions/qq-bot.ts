import type { QQBot, QQBotInboundMessage } from "@tencent-connect/qqbot-nodejs";
import { setTimeout as delay } from "node:timers/promises";
import { createHash } from "node:crypto";
import type { ExtensionPackage } from "../channel.js";

type BotFactory = (appId: string, appSecret: string) => Promise<QQBot>;
const defaultFactory: BotFactory = async (appId, appSecret) => {
  const { QQBot } = await import("@tencent-connect/qqbot-nodejs");
  return new QQBot({ appId, appSecret, intents: 1 << 25, reconnect: { maxAttempts: 10 } });
};
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
      if (stopped || controller.signal.aborted || message.senderIsBot === true) return;
      if (message.kind === "c2c" ? message.rawEventType !== "C2C_MESSAGE_CREATE" : message.kind !== "group" || message.rawEventType !== "GROUP_AT_MESSAGE_CREATE") return;
      if (typeof message.messageId !== "string" || !message.messageId || message.messageId.length > 1024 || typeof message.senderId !== "string" || !message.senderId || typeof message.replyTarget?.targetId !== "string" || !message.replyTarget.targetId || message.replyTarget.scope !== message.kind || message.replyTarget.msgId !== message.messageId || typeof message.content !== "string" || !message.content.trim() || Buffer.byteLength(message.content, "utf8") > 32 * 1024) return;
      const now = Date.now();
      for (const [id, time] of seen) if (now - time > 300_000) seen.delete(id);
      for (const [id, time] of replies) if (now - time > 300_000) replies.delete(id);
      for (const [id, times] of conversations) if (times.every((time) => now - time >= 60_000)) conversations.delete(id);
      const id = `${message.kind}:${message.messageId}`;
      if (seen.has(id)) return;
      seen.set(id, now);
      if (seen.size > 4096) seen.delete(seen.keys().next().value!);
      const conversation = `${message.kind}:${message.replyTarget.targetId}`;
      const digest = (content: string) => createHash("sha256").update(content.trim()).digest("hex");
      if (replies.has(`${conversation}:${digest(message.content)}`)) return;
      const recent = (conversations.get(conversation) ?? []).filter((time) => now - time < 60_000);
      if (recent.length >= 5) return;
      recent.push(now); conversations.set(conversation, recent);
      if (conversations.size > 4096) conversations.delete(conversations.keys().next().value!);
      if (pending >= 20) return;
      pending++;
      const work = async (): Promise<void> => {
        try {
          const wait = Math.max(0, 1000 - (Date.now() - lastAccepted));
          if (wait) await delay(wait, undefined, { signal: controller.signal });
          if (stopped || Date.now() - now > 240_000) return;
          lastAccepted = Date.now();
          let reply: string;
          try { reply = await host.message({ channelId: "qq-bot", messageId: message.messageId, senderId: message.senderId, conversationId: message.replyTarget.targetId, conversationType: message.kind === "c2c" ? "private" : "group", content: message.content.trim(), timestamp: message.timestamp }, controller.signal); }
          catch { if (!stopped) host.reportError("MODEL_FAILED"); return; }
          if (stopped || controller.signal.aborted || Date.now() - now > 240_000 || !reply.trim()) return;
          try {
            const content = Array.from(reply).slice(0, 1500).join("");
            const request = bot!.sendText({ scope: message.replyTarget.scope, targetId: message.replyTarget.targetId, msgId: message.messageId }, content);
            sending = request;
            const sent = await request.finally(() => { if (sending === request) sending = undefined; });
            if (sent.id) seen.set(`${message.kind}:${sent.id}`, Date.now());
            replies.set(`${conversation}:${digest(content)}`, Date.now());
            if (replies.size > 4096) replies.delete(replies.keys().next().value!);
          } catch { if (!stopped) host.reportError("SEND_FAILED"); }
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
            bot.on("ready", () => { if (!stopped) host.status("connected"); });
            bot.on("resumed", () => { if (!stopped) host.status("connected"); });
            bot.on("disconnected", () => { if (!stopped) host.status("connecting"); });
            bot.on("error", () => { if (!stopped) host.status("error", "QQ 连接异常，请检查网络及平台权限。"); });
            bot.on("message", (_context, message) => receive(message));
            await bot.start(controller.signal);
            if (!stopped) host.status("disconnected");
          } catch { if (!stopped) host.status("error", "QQ 连接失败，请检查凭据、网络及平台权限。"); }
        })();
      },
      async stop() { stopped = true; controller.abort(); bot?.stop(); if (sending) await sending.catch(() => {}); },
    };
  },
}; }
export const qqBotExtension = createQQBotExtension();
