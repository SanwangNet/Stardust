import { qqBotExtension } from "./qq-bot.js";
import { webChatExtension } from "./web-chat.js";

// This is the allowlist of trusted extensions shipped with this build.
export const bundledExtensions = [webChatExtension, qqBotExtension];
