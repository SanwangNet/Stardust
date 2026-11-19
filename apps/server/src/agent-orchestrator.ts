import { setTimeout as delay } from "node:timers/promises";
import type { ConversationContextMessage } from "./conversation-context.js";
import { ModelError, type ModelService, type ModelTurnMessage, type ToolCall } from "./model.js";

/** Source is server-supplied provenance. It does not grant capabilities. */
export type AgentSource = { starcoreId: string; channelId: string; conversationId: string };
export type AgentRequest = {
  source: AgentSource;
  current: string;
  messages: ConversationContextMessage[];
  signal?: AbortSignal;
};
export type AgentResult = { source: AgentSource; content: string };
type AgentModel = Partial<Pick<ModelService, "chatContext" | "chatWithTools">>;
type ToolDefinitions = Parameters<NonNullable<AgentModel["chatWithTools"]>>[1];

/** A trusted server adapter binds the request to the existing Core run and its policy. */
export type AgentRunHandle = {
  get(): { status: string; reply?: string; error?: string };
  cancel(): void;
  close(): void;
  isClosed(): boolean;
};
export type AgentRunFactory = (request: AgentRequest) => AgentRunHandle | Promise<AgentRunHandle>;

export type AgentStepState = {
  source: AgentSource;
  messages: ModelTurnMessage[];
  queue: ToolCall[];
  limits: { toolCalls: number };
  signal: AbortSignal;
  isWorking(): boolean;
};
export type AgentCoreTools = {
  /** Core appends a tool result before returning true, or returns false to pause the run. */
  process(call: ToolCall): Promise<boolean>;
  definitions(): ToolDefinitions;
};
export type AgentStepResult = { status: "done"; content: string } | { status: "paused" | "cancelled" } | { status: "error"; error: string };

/** Coordinates model turns. Tool admission, authorization and execution remain with Core. */
export class AgentOrchestrator {
  constructor(private readonly model: AgentModel) {}

  async execute(request: AgentRequest, startTools: AgentRunFactory): Promise<AgentResult> {
    const source = { ...request.source };
    if (request.signal?.aborted) throw new ModelError("REQUEST_CANCELLED", 499);
    if (typeof this.model.chatWithTools !== "function") {
      if (!this.model.chatContext) throw new ModelError("NOT_CONFIGURED", 400);
      const content = await this.model.chatContext(request.messages, request.signal);
      if (request.signal?.aborted) throw new ModelError("REQUEST_CANCELLED", 499);
      return { source, content };
    }

    const handle = await startTools({ ...request, source });
    const cancel = () => handle.cancel();
    request.signal?.addEventListener("abort", cancel, { once: true });
    try {
      if (request.signal?.aborted) cancel();
      while (!handle.isClosed()) {
        if (request.signal?.aborted) throw new ModelError("REQUEST_CANCELLED", 499);
        const run = handle.get();
        if (run.status === "done") return { source, content: run.reply ?? "" };
        if (run.status === "error") throw new ModelError(run.error ?? "TOOL_RUN_FAILED", 502);
        await delay(200);
      }
      throw new ModelError("REQUEST_CANCELLED", 499);
    } finally {
      request.signal?.removeEventListener("abort", cancel);
      handle.close();
    }
  }

  /** Resume the same model/tool loop after a Core approval or result. */
  async advance(state: AgentStepState, core: AgentCoreTools): Promise<AgentStepResult> {
    if (!this.model.chatWithTools) throw new ModelError("NOT_CONFIGURED", 400);
    while (state.isWorking() && !state.signal.aborted) {
      while (state.queue.length) {
        if (++state.limits.toolCalls > 4) return { status: "error", error: "TOOL_CALL_LIMIT" };
        if (!await core.process(state.queue.shift()!)) return { status: "paused" };
        if (state.signal.aborted) return { status: "cancelled" };
      }
      const tools = core.definitions();
      if (Buffer.byteLength(JSON.stringify(state.messages), "utf8") > 96_000) return { status: "error", error: "CONTEXT_TOO_LARGE" };
      const response = await this.model.chatWithTools(state.messages, tools, state.signal);
      if (state.signal.aborted) return { status: "cancelled" };
      if (!response.toolCalls.length) return { status: "done", content: response.content };
      state.messages.push({
        role: "assistant", content: response.content || null,
        tool_calls: response.toolCalls.map(call => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } })),
      });
      state.queue.push(...response.toolCalls);
    }
    return { status: state.signal.aborted ? "cancelled" : "paused" };
  }
}
