import type { LogDetails, LogLevel } from "./logger.js";

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
  log(level: LogLevel, message: string, details?: LogDetails): void;
}
export interface CapabilityTarget { id: string; scope: "private" | "group"; receivedAt: string; replyExpiresAt: string | null }
export interface CapabilityTestInput { targetId: string; kind: string; requestId: string }
export interface CapabilityTestResult { state: "success" | "rejected" | "network_failure" | "unavailable"; interface: string; requestedAt: string; stage: string; httpStatus?: number; businessCode?: string; message?: string; serverAccepted: boolean; clientReceived: "unconfirmed" }
export interface ChannelInstance {
  start(): void;
  stop(): void | Promise<void>;
  getCapabilityTargets?(): CapabilityTarget[];
  runCapabilityTest?(input: CapabilityTestInput): Promise<CapabilityTestResult>;
}
export interface ExtensionPackage {
  manifest: ExtensionManifest;
  create(config: Record<string, string>, host: ChannelHost): ChannelInstance;
}
