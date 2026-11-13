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
export interface ManagementPage { pageId: string; title: string; description: string; pageKind: string }
export interface ExtensionManifest { id: string; name: string; version: string; description: string; type: "channel" | "tool"; fields: ExtensionField[]; managementPages?: ManagementPage[]; skills?: { name: string; description: string }[] }
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
  listMessageTargets?(): MessageTarget[];
  sendMessage?(target: string, content: string, signal: AbortSignal): Promise<ChannelSendResult>;
}
export interface MessageTarget { id: string; description: string; scope: "private" | "group"; expiresAt: string }
export interface ChannelSendResult { status: "sent" | "rejected" | "unknown_outcome" | "unavailable"; code?: string; httpStatus?: number; message?: string }
export interface ToolHost {
  targets(channel: string): MessageTarget[];
  send(channel: string, target: string, content: string, signal: AbortSignal): Promise<ChannelSendResult>;
}
export type ToolInput = Record<string, unknown>;
export interface ToolApproval { operation: string; targetDescription: string; channel?: string; content?: string; risk: string; expiresAt?: string }
export interface ToolResult { status: string; code?: string; httpStatus?: number; message?: string }
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  legacyExtensionId?: string;
  validate(input: unknown): ToolInput | null;
  prepare(input: Readonly<ToolInput>, host: ToolHost): { approval: ToolApproval } | { error: string };
  execute(input: Readonly<ToolInput>, host: ToolHost, signal: AbortSignal): Promise<ToolResult>;
}
export interface ExtensionPackage {
  manifest: ExtensionManifest;
  create(config: Record<string, string>, host: ChannelHost): ChannelInstance;
  tool?: ToolDefinition;
  tools?: ToolDefinition[];
}
