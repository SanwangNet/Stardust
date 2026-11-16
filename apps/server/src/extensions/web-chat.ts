import type { ExtensionPackage } from "../channel.js";

/** The Web transport is hosted by the HTTP server; the core owns its conversations. */
export const webChatExtension: ExtensionPackage = {
  manifest: {
    id: "web-chat", name: "Web 对话", version: "1.0.0", type: "channel", builtin: true,
    description: "通过 Web 与星尘对话。内置星核，不可卸载。", fields: [],
    managementPages: [
      { pageId: "prompt", pageKind: "web-prompt", title: "提示词", description: "配置 Web 渠道的提示词。" },
      { pageId: "tools", pageKind: "web-tools", title: "Tool", description: "管理此渠道可以使用的 Tool。" },
      { pageId: "skills", pageKind: "skills", title: "Skill", description: "查看 Web 对话可用的 Skill。" },
      { pageId: "config", pageKind: "config", title: "渠道状态", description: "启用或停用 Web 对话。" },
    ],
    skills: [],
  },
  create(_config, host) { return { start() { host.status("connected"); }, stop() { host.status("disconnected"); } }; },
};
