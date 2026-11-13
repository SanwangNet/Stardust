import type { QQBot, QQBotInboundMessage } from "@tencent-connect/qqbot-nodejs";
import { setTimeout as delay } from "node:timers/promises";
import { createHash, randomUUID } from "node:crypto";
import type { CapabilityTestInput, CapabilityTestResult, ExtensionPackage } from "../channel.js";
import { ExtensionError } from "../extension-manager.js";
import { isPublicHttpsImageUrl, performQQCapabilityTest, performQQStreamCapabilityTest, type DiagnosticFetch, type QQTestTarget } from "./qq-capability.js";
import { qqSendMessageTool } from "./qq-send-message.js";

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
export function createQQBotExtension(factory: BotFactory = defaultFactory, diagnosticFetch: DiagnosticFetch = fetch): ExtensionPackage { return {
  manifest: {
    id: "qq-bot", name: "QQ 官方机器人", version: "1.0.0", description: "通过 QQ 开放平台接收私聊和群聊 @消息。", type: "channel",
    fields: [
      { key: "appId", env: "QQBOT_APP_ID", label: "AppID", sensitive: false, required: true },
      { key: "appSecret", env: "QQBOT_APP_SECRET", label: "AppSecret", sensitive: true, required: true },
    ],
    managementPages: [
      { pageId: "config", title: "机器人信息配置", description: "配置凭据与连接状态。", pageKind: "config" },
      { pageId: "capabilities", title: "机器人能力测试", description: "手动测试 QQ 平台能力。", pageKind: "qq-capabilities" },
      { pageId: "tools", title: "Tool 管理", description: "管理此扩展提供的 Tool。", pageKind: "tools" },
      { pageId: "skills", title: "Skill 管理", description: "查看此扩展提供的 Skill。", pageKind: "skills" },
    ],
    skills: [],
  },
  tools: [qqSendMessageTool],
  create(config, host) {
    let bot: QQBot | undefined;
    let stopped = false;
    const controller = new AbortController();
    const seen = new Map<string, number>();
    const replies = new Map<string, number>();
    const conversations = new Map<string, number[]>();
    const capabilityTargets: QQTestTarget[] = [];
    const capabilityRequests = new Map<string, { key: string; result: Promise<CapabilityTestResult> }>();
    const usedCapabilitySequences = new Map<string, Set<number>>();
    let activeTest: Promise<CapabilityTestResult> | undefined;
    let activeToolSend: Promise<unknown> | undefined;
    let connected = false;
    let pending = 0;
    let queue: Promise<void> = Promise.resolve();
    let sending: Promise<unknown> | undefined;
    let lastAccepted = 0;
    async function receive(message: QQBotInboundMessage): Promise<void> {
      const eventId = randomUUID();
      const scope = message.kind === "group" ? "group" : message.kind === "c2c" ? "private" : "other";
      const mentionsPresent = message.mentions !== undefined && message.mentions !== null;
      const mentions = Array.isArray(message.mentions) ? message.mentions : undefined;
      const hasGroupOpenid = typeof message.groupOpenid === "string" && Boolean(message.groupOpenid.trim());
      let mentionBranch = "not_applicable";
      if (message.kind === "group") {
        if (message.rawEventType === "GROUP_AT_MESSAGE_CREATE") mentionBranch = "official_at_event";
        else if (message.rawEventType !== "GROUP_MESSAGE_CREATE") mentionBranch = "unsupported_group_event";
        else if (mentions?.some((mention) => mention?.is_you === true)) mentionBranch = "mentions_is_you";
        else if (config.appId && typeof message.content === "string" && (message.content.includes(`<@${config.appId}>`) || message.content.includes(`<@!${config.appId}>`))) mentionBranch = "content_appid_marker";
        else mentionBranch = "no_self_mention";
      } else if (message.kind === "c2c") mentionBranch = "private_event";
      const rawEventType = typeof message.rawEventType === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(message.rawEventType) ? message.rawEventType : "UNAVAILABLE";
      const kind = ["c2c", "group", "guild", "dm"].includes(message.kind) ? message.kind : "unknown";
      const msgType = typeof message.msgType === "number" && Number.isSafeInteger(message.msgType) && message.msgType >= 0 && message.msgType <= 2_147_483_647 ? message.msgType : null;
      const diagnostic = { eventId, scope, rawEventType, kind, msgType, mentionsPresent, mentionCount: mentions?.length ?? 0, hasGroupOpenid, mentionBranch };
      host.log("DEBUG", "收到 QQ 消息事件。", diagnostic);
      const filtered = (reason: string): void => host.log("DEBUG", "QQ 消息已过滤。", { ...diagnostic, reason });
      if (stopped || controller.signal.aborted) { filtered("extension_stopped"); return; }
      if (message.senderIsBot === true) { filtered("bot_sender"); return; }
      if (message.kind === "c2c") {
        if (message.rawEventType !== "C2C_MESSAGE_CREATE") { filtered("private_unexpected_event_type"); return; }
      } else if (message.kind === "group") {
        if (mentionBranch === "unsupported_group_event") { filtered("group_unsupported_event_type"); return; }
        if (mentionBranch === "no_self_mention") { filtered("group_no_self_mention"); return; }
        if (!hasGroupOpenid) { filtered("missing_group_openid"); return; }
        if (message.replyTarget?.targetId !== message.groupOpenid) { filtered("group_reply_target_mismatch"); return; }
      } else { filtered("unsupported_message_kind"); return; }
      if (typeof message.messageId !== "string" || !message.messageId || message.messageId.length > 1024) { filtered("invalid_message_id"); return; }
      if (typeof message.senderId !== "string" || !message.senderId) { filtered("missing_sender"); return; }
      if (typeof message.replyTarget?.targetId !== "string" || !message.replyTarget.targetId || message.replyTarget.scope !== message.kind || message.replyTarget.msgId !== message.messageId) { filtered("invalid_reply_target"); return; }
      if (typeof message.content !== "string" || !message.content.trim() || Buffer.byteLength(message.content, "utf8") > 32 * 1024) { filtered("empty_or_oversized_content"); return; }
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
      // The opaque ID alone is exposed; actual targets remain in bounded runtime memory.
      const messageTime = Date.parse(message.timestamp);
      const expiry = Number.isFinite(messageTime) ? Math.min(messageTime, now) + (message.kind === "c2c" ? 60 : 5) * 60_000 : null;
      capabilityTargets.push({ id: randomUUID(), targetOpenid: message.replyTarget.targetId, messageId: message.messageId, scope: message.kind === "c2c" ? "private" : "group", receivedAt: new Date(now).toISOString(), replyExpiresAt: expiry === null ? null : new Date(expiry).toISOString() });
      if (capabilityTargets.length > 50) capabilityTargets.shift();
      host.log("INFO", "QQ 消息已接受。", diagnostic);
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
      listMessageTargets() {
        const unique = new Set<string>();
        return capabilityTargets.slice().reverse().filter((target) => {
          const key = `${target.scope}:${target.targetOpenid}`;
          if (Date.now() - Date.parse(target.receivedAt) >= 60 * 60_000 || unique.has(key)) return false;
          unique.add(key); return true;
        }).map((target) => ({ id: target.id, scope: target.scope, description: target.scope === "private" ? "QQ 私聊：最近交互的用户" : "QQ 群聊：最近交互的群", expiresAt: new Date(Date.parse(target.receivedAt) + 60 * 60_000).toISOString() }));
      },
      async sendMessage(targetId, content, signal) {
        const target = capabilityTargets.find((item) => item.id === targetId);
        if (!target || !bot || !connected || stopped || signal.aborted || Date.now() - Date.parse(target.receivedAt) >= 60 * 60_000 || !/^[A-Za-z0-9_-]{1,256}$/.test(target.targetOpenid)) return { status: "unavailable", code: "TARGET_UNAVAILABLE" };
        const currentBot = bot;
        const work = performQQCapabilityTest({
          kind: `${target.scope}-text`, target, textContent: content, signal: AbortSignal.any([controller.signal, signal]), appId: config.appId!, appSecret: config.appSecret!, request: diagnosticFetch,
          getToken: () => currentBot.tokenManager.getAccessToken(config.appId!, config.appSecret!),
          onSent: (messageId) => {
            const scope = target.scope === "private" ? "c2c" : "group";
            if (messageId.length <= 1024) seen.set(`${scope}:${messageId}`, Date.now());
            replies.set(`${scope}:${target.targetOpenid}:${createHash("sha256").update(content.trim()).digest("hex")}`, Date.now());
            if (replies.size > 4096) replies.delete(replies.keys().next().value!);
          },
        });
        activeToolSend = work;
        try {
          const result = await work;
          if (result.state === "success") return { status: "sent", httpStatus: result.httpStatus };
          if (result.state === "rejected") return { status: "rejected", code: result.businessCode, httpStatus: result.httpStatus, message: result.message };
          if (result.stage === "send") return { status: "unknown_outcome", code: "UNKNOWN_OUTCOME" };
          return { status: "unavailable", code: "CHANNEL_UNAVAILABLE" };
        } finally { if (activeToolSend === work) activeToolSend = undefined; }
      },
      getCapabilityTargets() {
        return capabilityTargets.filter((target) => Date.now() - Date.parse(target.receivedAt) < 60 * 60_000).map(({ id, scope, receivedAt, replyExpiresAt }) => ({ id, scope, receivedAt, replyExpiresAt }));
      },
      runCapabilityTest(input: CapabilityTestInput): Promise<CapabilityTestResult> {
        const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
        if (!uuid.test(input.targetId) || !uuid.test(input.requestId) || !/^(private|group)-(text|file|png|png-direct|png-empty-content|markdown-multi-image|markdown-local-multi-image)$/.test(input.kind)) throw new ExtensionError("INVALID_INPUT");
        if ((input.mode !== undefined && input.mode !== "active" && input.mode !== "passive") || (input.stream !== undefined && typeof input.stream !== "boolean")) throw new ExtensionError("INVALID_INPUT");
        const directPng = input.kind.endsWith("-png-direct");
        const markdownMultiImage = input.kind.endsWith("-markdown-multi-image");
        const markdownLocalMultiImage = input.kind.endsWith("-markdown-local-multi-image");
        if (markdownMultiImage ? (!input.imageUrl1 || !input.imageUrl2 || !isPublicHttpsImageUrl(input.imageUrl1) || !isPublicHttpsImageUrl(input.imageUrl2) || new URL(input.imageUrl1).href === new URL(input.imageUrl2).href || input.imageFiles !== undefined) : (input.imageUrl1 !== undefined || input.imageUrl2 !== undefined)) throw new ExtensionError("INVALID_INPUT");
        if (markdownLocalMultiImage ? (!input.imageFiles || input.imageFiles.length !== 2 || input.imageFiles.some((file) => !Buffer.isBuffer(file) || file.length < 8 || file.length > 10 * 1024 * 1024 || !file.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) || input.imageFiles[0].equals(input.imageFiles[1])) : input.imageFiles !== undefined) throw new ExtensionError("INVALID_INPUT");
        const media = input.kind.endsWith("-file") || input.kind.endsWith("-png") || directPng || input.kind.endsWith("-png-empty-content") || markdownLocalMultiImage;
        const mode = input.mode ?? (directPng ? "active" : media || markdownMultiImage ? "passive" : "active");
        const stream = input.stream ?? false;
        if ((media && (stream || (directPng ? mode !== "active" : mode !== "passive"))) || ((markdownMultiImage || markdownLocalMultiImage) && (stream || mode !== "passive")) || (stream && !input.kind.endsWith("-text"))) throw new ExtensionError("INVALID_INPUT");
        const urlsDigest = markdownMultiImage ? createHash("sha256").update(`${input.imageUrl1}\0${input.imageUrl2}`).digest("hex") : "";
        const filesDigest = markdownLocalMultiImage ? createHash("sha256").update(input.imageFiles!.map((file) => createHash("sha256").update(file).digest("hex")).join("\0")).digest("hex") : "";
        const key = `${input.targetId}:${input.kind}:${mode}:${stream}:${urlsDigest}:${filesDigest}`;
        const prior = capabilityRequests.get(input.requestId);
        if (prior) { if (prior.key !== key) throw new ExtensionError("INVALID_INPUT"); return prior.result; }
        if (capabilityRequests.size >= 512) throw new ExtensionError("TEST_LIMIT_REACHED", 429);
        if (!bot || stopped || !connected) throw new ExtensionError("EXTENSION_NOT_CONNECTED", 409);
        if (activeTest) throw new ExtensionError("TEST_IN_PROGRESS", 409);
        const target = capabilityTargets.find((item) => item.id === input.targetId);
        if (!target || Date.now() - Date.parse(target.receivedAt) >= 60 * 60_000 || !input.kind.startsWith(`${target.scope}-`)) throw new ExtensionError("INVALID_TARGET");
        if (!/^[A-Za-z0-9_-]{1,256}$/.test(target.targetOpenid)) throw new ExtensionError("INVALID_TARGET");
        const currentBot = bot;
        if (stream && mode === "passive" && (!target.replyExpiresAt || Date.now() - Date.parse(target.receivedAt) >= 5 * 60_000)) {
          const result: CapabilityTestResult = { state: "unavailable", interface: target.scope === "private" ? "POST /v2/users/{openid}/stream_messages" : "POST /v2/groups/{group_openid}/stream_messages（实验性、未验证候选接口）", requestedAt: new Date().toISOString(), stage: "target", mode, stream, frameCount: 0, completion: "not_started", serverAccepted: false, clientReceived: "unconfirmed", message: "被动流式实验要求使用 5 分钟内的真实入站消息。" };
          const promise = Promise.resolve(result); capabilityRequests.set(input.requestId, { key, result: promise }); return promise;
        }
        if (mode === "passive" && (!target.replyExpiresAt || Date.now() >= Date.parse(target.replyExpiresAt))) {
          const result: CapabilityTestResult = { state: "unavailable", interface: markdownMultiImage ? `POST /v2/${target.scope === "private" ? "users/{openid}" : "groups/{group_openid}"}/messages` : "未调用：被动回复目标已过期", requestedAt: new Date().toISOString(), stage: "target", mode, stream, frameCount: 0, completion: "not_started", serverAccepted: false, clientReceived: "unconfirmed", ...(markdownMultiImage ? { requestMessageId: `•••${target.messageId.slice(-4)}` } : {}), message: "所选入站消息的被动回复有效期已过；未发送请求。" };
          const promise = Promise.resolve(result); capabilityRequests.set(input.requestId, { key, result: promise }); return promise;
        }
        host.log("INFO", "QQ 平台能力测试开始。", { scope: target.scope, category: input.kind, requestId: input.requestId });
        const start = Date.now();
        const onSent = (messageId: string): void => {
          const scope = target.scope === "private" ? "c2c" : "group";
          if (messageId.length <= 1024) seen.set(`${scope}:${messageId}`, Date.now());
          if (input.kind.endsWith("-text")) {
            const hash = createHash("sha256").update("Hello, Stardust!").digest("hex");
            replies.set(`${scope}:${target.targetOpenid}:${hash}`, Date.now());
            if (replies.size > 4096) replies.delete(replies.keys().next().value!);
          }
        };
        const runBasicTest = (getNextSequence?: (messageId: string) => number) => performQQCapabilityTest({
          kind: input.kind, target, mode, signal: controller.signal, appId: config.appId!, appSecret: config.appSecret!, request: diagnosticFetch,
          getToken: () => currentBot.tokenManager.getAccessToken(config.appId!, config.appSecret!), onSent,
          ...(markdownMultiImage ? { imageUrl1: input.imageUrl1, imageUrl2: input.imageUrl2 } : {}),
          ...(markdownLocalMultiImage ? { imageFiles: input.imageFiles } : {}),
          ...(getNextSequence ? { getNextSequence } : {}),
        }).then((result) => ({ ...result, mode, stream: false as const, durationMs: Date.now() - start }));
        const work = stream
          ? import("@tencent-connect/qqbot-nodejs/protocol").then(({ getNextMsgSeq }) => performQQStreamCapabilityTest({
            target, signal: controller.signal, appId: config.appId!, appSecret: config.appSecret!, requestId: input.requestId,
            mode,
            getNextSequence: getNextMsgSeq,
            getToken: () => currentBot.tokenManager.getAccessToken(config.appId!, config.appSecret!),
            request: diagnosticFetch,
            onEvent: (level, message, details) => host.log(level, message, details),
          }))
          : markdownMultiImage || markdownLocalMultiImage
            ? import("@tencent-connect/qqbot-nodejs/protocol").then(({ getNextMsgSeq }) => runBasicTest((messageId) => {
              const used = usedCapabilitySequences.get(messageId) ?? new Set<number>();
              for (let attempt = 0; attempt < 65_536; attempt++) {
                const sequence = getNextMsgSeq(messageId);
                if (Number.isInteger(sequence) && sequence >= 0 && sequence <= 65_535 && !used.has(sequence)) {
                  used.add(sequence); usedCapabilitySequences.set(messageId, used); return sequence;
                }
              }
              throw new Error("MSG_SEQ_EXHAUSTED");
            }))
            : runBasicTest();
        const promise = work.then((result) => {
          host.log(result.state === "success" ? "INFO" : "WARN", "QQ 平台能力测试结束。", { scope: target.scope, category: result.state, requestId: input.requestId, status: result.httpStatus, code: result.businessCode });
          return result;
        }).finally(() => { if (activeTest === promise) activeTest = undefined; });
        activeTest = promise; capabilityRequests.set(input.requestId, { key, result: promise });
        return promise;
      },
      start() {
        void (async () => {
          try {
            bot = await factory(config.appId!, config.appSecret!);
            if (stopped) return;
            bot.on("ready", () => { if (!stopped) { connected = true; host.log("INFO", "QQ Gateway 已连接。"); host.status("connected"); } });
            bot.on("resumed", () => { if (!stopped) { connected = true; host.log("INFO", "QQ Gateway 已恢复连接。"); host.status("connected"); } });
            bot.on("disconnected", (event) => { connected = false; if (!stopped) { host.log("WARN", event.willReconnect ? "QQ Gateway 已断开，正在重连。" : "QQ Gateway 已断开，不再重连。", { code: Number.isSafeInteger(event.code) ? String(event.code) : undefined }); host.status(event.willReconnect ? "connecting" : "disconnected"); } });
            bot.on("error", (error) => { connected = false; if (!stopped) { host.log("ERROR", "QQ Gateway 连接异常。", platformError(error)); host.status("error", "QQ 连接异常，请检查网络及平台权限。"); } });
            bot.on("message", (_context, message) => receive(message));
            await bot.start(controller.signal);
            if (!stopped) { host.log("WARN", "QQ Gateway 已断开。"); host.status("disconnected"); }
          } catch (error) { if (!stopped) { host.log("ERROR", "QQ Gateway 启动失败。", platformError(error)); host.status("error", "QQ 连接失败，请检查凭据、网络及平台权限。"); } }
        })();
      },
      async stop() { if (!stopped) host.log("INFO", "QQ Gateway 正在停止。"); stopped = true; connected = false; capabilityTargets.length = 0; controller.abort(); bot?.stop(); await Promise.all([sending?.catch(() => {}), activeTest?.catch(() => {}), activeToolSend?.catch(() => {})]); },
    };
  },
}; }
export const qqBotExtension = createQQBotExtension();
