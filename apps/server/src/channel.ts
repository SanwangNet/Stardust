export interface ChannelMessage {
  channelId: string;
  messageId: string;
  senderId: string;
  conversationId: string;
  conversationType: "private" | "group";
  content: string;
  timestamp: string;
  eventId?: string;
}

export type ExtensionStatus = "disconnected" | "connecting" | "connected" | "error";
export interface ExtensionField { key: string; env: string; label: string; sensitive: boolean; required: boolean }
export interface ExtensionManifest { id: string; name: string; version: string; description: string; type: "channel"; fields: ExtensionField[] }
export interface ChannelHost {
  message(message: ChannelMessage, signal: AbortSignal): Promise<string>;
  status(state: ExtensionStatus, error?: string): void;
  reportError(code: "MODEL_FAILED" | "SEND_FAILED"): void;
  log(level: "DEBUG" | "INFO" | "WARN" | "ERROR", message: string, details?: { eventId?: string; reason?: string; code?: string; scope?: string; status?: number }): void;
}
export interface ChannelInstance { start(): void; stop(): void | Promise<void> }
export interface ExtensionPackage {
  manifest: ExtensionManifest;
  create(config: Record<string, string>, host: ChannelHost): ChannelInstance;
}
