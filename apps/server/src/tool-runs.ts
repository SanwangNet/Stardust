import { randomUUID } from "node:crypto";
import type { ExtensionManager } from "./extension-manager.js";
import { ModelError, type ModelService, type ModelTurnMessage, type ToolCall } from "./model.js";
import { logger, type LogService } from "./logger.js";
import type { ToolApproval, ToolInput, ToolResult } from "./channel.js";

type CallView = { id: string; name: string; status: string; input?: ToolInput; approval?: ToolApproval; expiresAt?: string; result?: unknown };
type Run = {
  id: string; owner: string; status: "working" | "waiting" | "executing" | "done" | "error";
  messages: ModelTurnMessage[]; calls: CallView[]; queue: ToolCall[]; count: number; reply?: string; error?: string; errorDetail?: { source: string; status?: number; code?: string; message?: string };
  approval?: { call: ToolCall; input: Readonly<ToolInput>; deadline: number; channel?: string; toolSignal: AbortSignal; channelSignal?: AbortSignal };
  created: number; controller: AbortController;
};
function freezeInput(value: unknown): void {
  if (!value || typeof value !== "object") return;
  for (const child of Object.values(value)) freezeInput(child);
  Object.freeze(value);
}

export class ToolRuns {
  private readonly runs = new Map<string, Run>();
  constructor(private readonly model: Pick<ModelService, "chatWithTools">, private readonly extensions: ExtensionManager, private readonly logs: LogService = logger) {}
  start(owner: string, text: unknown): string {
    if (typeof text !== "string" || !text.trim() || Buffer.byteLength(text, "utf8") > 32000) throw new Error("INVALID_INPUT");
    for (const [id, run] of this.runs) if (Date.now() - run.created > 30 * 60_000 && run.status !== "executing") { run.controller.abort(); this.runs.delete(id); }
    if (this.runs.size >= 100) throw new Error("RUN_LIMIT");
    const targets = this.extensions.availableTools().length ? this.extensions.availableTargets() : [];
    const prompt = `以下是已知的可用消息渠道及目标引用。仅可使用这些引用；同类型多个目标无法明确区分时必须询问用户，不可猜测。\n${JSON.stringify(targets)}`;
    const run: Run = { id: randomUUID(), owner, status: "working", messages: [{ role: "system", content: prompt }, { role: "user", content: text }], calls: [], queue: [], count: 0, created: Date.now(), controller: new AbortController() };
    this.runs.set(run.id, run); void this.advance(run); return run.id;
  }
  get(owner: string, id: string) {
    const run = this.owned(owner, id);
    this.expire(run);
    return { id: run.id, status: run.status, calls: structuredClone(run.calls), ...(run.reply !== undefined ? { reply: run.reply } : {}), ...(run.error ? { error: run.error } : {}), ...(run.errorDetail ? { errorDetail: { ...run.errorDetail } } : {}) };
  }
  decide(owner: string, id: string, toolCallId: string, approved: boolean): void {
    const run = this.owned(owner, id); this.expire(run);
    const pending = run.approval;
    if (run.status !== "waiting" || !pending || pending.call.id !== toolCallId) throw new Error("APPROVAL_UNAVAILABLE");
    const view = run.calls.find((entry) => entry.id === toolCallId)!;
    run.approval = undefined;
    this.logs.write("INFO", "tools", approved ? "工具调用已批准。" : "工具调用已拒绝。", { runId: run.id, toolCallId, toolName: pending.call.name, channel: pending.channel, approval: approved ? "approved" : "denied", stage: "approval" });
    if (!approved) { view.status = "denied"; view.result = { status: "denied" }; run.messages.push({ role: "tool", tool_call_id: toolCallId, content: JSON.stringify(view.result) }); run.status = "working"; void this.advance(run); return; }
    // Transition before any await, making repeated approvals harmless.
    run.status = "executing"; view.status = "executing";
    const started = Date.now();
    void this.extensions.executeTool(pending.call.name, pending.input, run.controller.signal).catch((): ToolResult => ({ status: "unknown_outcome", code: "UNKNOWN_OUTCOME" })).then((result) => {
      view.status = result.status; view.result = result;
      this.logs.write(result.status === "sent" ? "INFO" : "WARN", "tools", "工具调用已结束。", { runId: run.id, toolCallId, toolName: pending.call.name, channel: pending.channel, approval: "approved", stage: result.status, code: result.code, message: result.message, durationMs: Date.now() - started, status: result.httpStatus }, typeof pending.input.content === "string" ? [pending.input.content] : []);
      run.messages.push({ role: "tool", tool_call_id: toolCallId, content: JSON.stringify(result) });
      run.status = "working"; void this.advance(run);
    });
  }
  private owned(owner: string, id: string): Run {
    const run = this.runs.get(id); if (!run || run.owner !== owner) throw new Error("RUN_NOT_FOUND"); return run;
  }
  private expire(run: Run): void {
    if (run.status !== "waiting" || !run.approval) return;
    const pending = run.approval;
    const reason = pending.toolSignal.aborted ? "TOOL_DISABLED" : pending.channelSignal?.aborted ? "CHANNEL_UNAVAILABLE" : Date.now() >= pending.deadline ? "APPROVAL_EXPIRED" : undefined;
    if (!reason) return;
    const call = pending.call; run.approval = undefined;
    const view = run.calls.find((item) => item.id === call.id)!; view.status = reason === "APPROVAL_EXPIRED" ? "expired" : "unavailable"; view.result = { status: view.status, code: reason };
    this.logs.write("WARN", "tools", "工具审批已失效。", { runId: run.id, toolCallId: call.id, toolName: call.name, channel: view.approval?.channel, approval: "expired", stage: "approval", code: reason });
    run.messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(view.result) });
    run.status = "working"; void this.advance(run);
  }
  private async advance(run: Run): Promise<void> {
    try {
      while (run.status === "working" && !run.controller.signal.aborted) {
        while (run.queue.length) {
          const call = run.queue.shift()!;
          if (++run.count > 4) { run.status = "error"; run.error = "TOOL_CALL_LIMIT"; return; }
          if (!/^[A-Za-z0-9_-]{1,128}$/.test(call.id) || run.calls.some((item) => item.id === call.id)) { run.status = "error"; run.error = "INVALID_TOOL_CALL"; return; }
          const view: CallView = { id: call.id, name: call.name, status: "validating" }; run.calls.push(view);
          const tool = this.extensions.availableTools().find((candidate) => candidate.name === call.name);
          let parsed: unknown; try { parsed = JSON.parse(call.arguments); } catch { parsed = null; }
          const input = tool?.validate(parsed);
          let failure: string | undefined;
          if (!tool) failure = "TOOL_UNAVAILABLE";
          else if (!input) failure = "INVALID_ARGUMENTS";
          else {
            const prepared = tool.prepare(input, this.extensions.toolHost());
            if ("error" in prepared) failure = prepared.error;
            else {
              const toolSignal = this.extensions.toolSignal(call.name);
              const channelSignal = prepared.approval.channel ? this.extensions.channelSignal(prepared.approval.channel) : undefined;
              const targetExpiry = prepared.approval.expiresAt ? Date.parse(prepared.approval.expiresAt) : Infinity;
              if (!toolSignal || toolSignal.aborted) failure = "TOOL_DISABLED";
              else if (prepared.approval.channel && (!channelSignal || channelSignal.aborted)) failure = "CHANNEL_UNAVAILABLE";
              else if (Number.isNaN(targetExpiry) || targetExpiry <= Date.now()) { failure = "TARGET_UNAVAILABLE"; }
              else {
                const deadline = Math.min(Date.now() + 5 * 60_000, targetExpiry);
                const snapshot = structuredClone(input); freezeInput(snapshot);
                view.input = structuredClone(snapshot); view.approval = structuredClone(prepared.approval); view.expiresAt = new Date(deadline).toISOString(); view.status = "waiting";
                run.approval = { call, input: snapshot, deadline, channel: prepared.approval.channel, toolSignal, channelSignal }; run.status = "waiting";
                this.logs.write("INFO", "tools", "工具调用等待批准。", { runId: run.id, toolCallId: call.id, toolName: call.name, channel: prepared.approval.channel, approval: "pending", stage: "approval" }); return;
              }
            }
          }
          view.status = "failed"; view.result = { status: "unavailable", code: failure };
          this.logs.write("WARN", "tools", "工具调用校验失败。", { runId: run.id, toolCallId: call.id, toolName: call.name, stage: "validation", code: failure });
          run.messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(view.result) });
        }
        const tools = this.extensions.availableTools().map((tool) => ({ type: "function" as const, function: { name: tool.name, description: tool.description, parameters: tool.parameters } }));
        const response = await this.model.chatWithTools(run.messages, tools, run.controller.signal);
        if (run.controller.signal.aborted) return;
        if (!response.toolCalls.length) { run.reply = response.content; run.status = "done"; return; }
        run.messages.push({ role: "assistant", content: response.content || null, tool_calls: response.toolCalls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } })) });
        run.queue.push(...response.toolCalls);
      }
    } catch (error) {
      run.status = "error";
      run.error = error instanceof ModelError ? error.code : "TOOL_RUN_FAILED";
      if (error instanceof ModelError) run.errorDetail = { source: error.diagnostic.source, status: error.diagnostic.status, code: error.diagnostic.code, message: error.diagnostic.message };
      this.logs.write("ERROR", "tools", "工具对话失败。", { requestId: run.id, code: run.error });
    }
  }
  shutdown(): void { for (const run of this.runs.values()) run.controller.abort(); this.runs.clear(); }
}
