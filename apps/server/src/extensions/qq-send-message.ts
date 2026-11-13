import type { ToolDefinition } from "../channel.js";

export const qqSendMessageTool: ToolDefinition = {
    name: "send_message",
    legacyExtensionId: "send-message",
    description: "向已知渠道目标发送一条文本；必须使用提供的目标引用。",
    parameters: { type: "object", properties: { channel: { type: "string", enum: ["qq-bot"] }, target: { type: "string" }, content: { type: "string", minLength: 1, maxLength: 1500 } }, required: ["channel", "target", "content"], additionalProperties: false },
    validate(input) {
      if (!input || typeof input !== "object" || Array.isArray(input)) return null;
      const data = input as Record<string, unknown>;
      if (Object.keys(data).length !== 3 || data.channel !== "qq-bot" || typeof data.target !== "string" || !/^[0-9a-f-]{36}$/.test(data.target) || typeof data.content !== "string" || !data.content.trim() || Array.from(data.content).length > 1500 || Buffer.byteLength(data.content, "utf8") > 6000) return null;
      return { channel: data.channel, target: data.target, content: data.content };
    },
    prepare(input, host) {
      const channel = input.channel as string, target = input.target as string, content = input.content as string;
      const targets = host.targets(channel);
      const selected = targets.find((item) => item.id === target && Date.parse(item.expiresAt) > Date.now());
      if (!selected) return { error: "TARGET_UNAVAILABLE" };
      if (targets.filter((item) => item.scope === selected.scope).length !== 1) return { error: "TARGET_AMBIGUOUS" };
      return { approval: { operation: "主动发送文本", targetDescription: selected.description, channel, content, risk: "将向所选渠道发送真实消息；平台可能拒绝，网络中断时发送结果可能未知。", expiresAt: selected.expiresAt } };
    },
    execute(input, host, signal) { return host.send(input.channel as string, input.target as string, input.content as string, signal); },
};
