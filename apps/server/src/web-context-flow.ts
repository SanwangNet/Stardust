import { assembleContext, type ContextEntry, type RecentMessage } from "./context-assembler.js";
import { buildConversationContext, type ConversationContextMessage } from "./conversation-context.js";
import { createFlowRegistry, executeFlow, validateExecutableFlow, type ExecutableFlow } from "./executable-flow.js";

type Assembled = { messages: ConversationContextMessage[]; selectedEntryIds: string[] };
type Sources = {
  // These closures are supplied by Core for this request, never by the graph or HTTP client.
  recent: (signal: AbortSignal) => RecentMessage[] | Promise<RecentMessage[]>;
  global: (signal: AbortSignal) => ContextEntry[] | Promise<ContextEntry[]>;
};
type RunOptions = { conversationId: string; current: string; instructions: string; budgetBytes: number; recentLimit: number; useHistoryTool: boolean; signal?: AbortSignal };

const edge = (from: string, fromPort: string, to: string, toPort: string) => ({ from: { node: from, port: fromPort }, to: { node: to, port: toPort } });

/** Trusted server-side definition; edit the two edges into assembler to enable/disable each source. */
export function builtInWebContextFlow(): ExecutableFlow {
  return { version: 1, rootId: "web", graphs: [
    { id: "web", nodes: [{ id: "input", type: "input" }, { id: "context", type: "group", graphId: "context" }, { id: "output", type: "json-output" }],
      edges: [edge("input", "value", "context", "current"), edge("context", "result", "output", "value")],
      interface: { inputs: [{ id: "current", node: "input", required: true, label: "Web 对话请求" }], outputs: [{ id: "result", node: "output", label: "返回主流程" }] } },
    { id: "context", nodes: [{ id: "input", type: "input" }, { id: "current", type: "pass" }, { id: "recent", type: "web-recent" }, { id: "global", type: "web-global" }, { id: "assembler", type: "web-assembler" }, { id: "output", type: "json-output" }],
      edges: [edge("input", "value", "current", "value"), edge("current", "value", "recent", "trigger"), edge("current", "value", "global", "trigger"),
        edge("current", "value", "assembler", "current"), edge("recent", "value", "assembler", "recent"), edge("global", "value", "assembler", "global"), edge("assembler", "value", "output", "value")],
      interface: { inputs: [{ id: "current", node: "input", required: true, label: "Web 对话请求" }], outputs: [{ id: "result", node: "output", label: "返回主流程" }] } },
  ] };
}

export class WebContextFlowError extends Error {
  constructor(readonly code: "CONTEXT_FLOW_INVALID" | "CONTEXT_FLOW_FAILED" | "CONTEXT_FLOW_CANCELLED", readonly reason: string) {
    super(`${code}: ${reason}`);
  }
}

// Never expose arbitrary exceptions from data providers, which may contain private data.
function safeReason(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return /^(?:INVALID_SCHEMA|INVALID_ID|INVALID_GRAPH|INVALID_INTERFACE|INVALID_GROUP|INVALID_NODE|INVALID_PORT|PORT_TYPE_MISMATCH|DUPLICATE_INPUT|GRAPH_CYCLE|NO_TARGET|CONTEXT_TOO_LARGE|CANCELLED)$/.test(message)
    || /^(?:MISSING_REQUIRED_INPUT|MISSING_REQUIRED_VALUE|MISSING_ENTRY_VALUE|INVALID_INPUT_VALUE|INVALID_OUTPUT_VALUE|MISSING_OUTPUT_VALUE|UNKNOWN_NODE_TYPE|UNKNOWN_GRAPH|GROUP_CYCLE|UNREACHABLE_NODE|UNBOUND_ENTRY|INVALID_CONFIG|DUPLICATE_NODE): [a-zA-Z0-9_.:-]{1,260}$/.test(message) ? message : "NODE_FAILED";
}

/** Only the server constructs sources and selects the flow. No identity/scope is accepted from graph data. */
export function createWebContextRegistry(sources: Sources, options: RunOptions) {
  const registry = createFlowRegistry();
  const str = { type: "string" as const, required: true }, json = { type: "json" as const };
  registry.register("json-output", { role: "output", inputs: { value: { ...json, required: true } }, outputs: { value: json }, execute: i => ({ value: i.value }) });
  registry.register("web-recent", { role: "node", inputs: { trigger: str }, outputs: { value: json }, execute: async (_i, _c, signal) => ({ value: await sources.recent(signal) }) });
  registry.register("web-global", { role: "node", inputs: { trigger: str }, outputs: { value: json }, execute: async (_i, _c, signal) => ({ value: options.useHistoryTool ? await sources.global(signal) : [] }) });
  registry.register("web-assembler", { role: "node", inputs: { current: str, recent: json, global: json }, outputs: { value: json }, execute: i => {
    const recent = (i.recent ?? []) as RecentMessage[], global = (i.global ?? []) as ContextEntry[];
    const value: Assembled = options.useHistoryTool
      ? assembleContext(recent, i.current as string, options.conversationId, global, Math.min(options.budgetBytes, 36_000), options.recentLimit, options.instructions)
      : { messages: buildConversationContext(recent.map(({ role, content }) => ({ role, content })), i.current as string, options.budgetBytes, [], options.recentLimit), selectedEntryIds: [] };
    return { value };
  } });
  return registry;
}

export async function runWebContextFlow(definition: ExecutableFlow, sources: Sources, options: RunOptions): Promise<Assembled> {
  const registry = createWebContextRegistry(sources, options);
  try { validateExecutableFlow(definition, registry); }
  catch (error) { throw new WebContextFlowError("CONTEXT_FLOW_INVALID", safeReason(error)); }
  const result = await executeFlow(definition, registry, { current: options.current }, { signal: options.signal });
  if (result.status !== "succeeded") throw new WebContextFlowError(result.status === "cancelled" ? "CONTEXT_FLOW_CANCELLED" : "CONTEXT_FLOW_FAILED", safeReason(result.error));
  const assembled = result.outputs.result as Assembled | undefined;
  if (!assembled || !Array.isArray(assembled.messages) || !Array.isArray(assembled.selectedEntryIds)) throw new WebContextFlowError("CONTEXT_FLOW_FAILED", "INVALID_RESULT");
  return assembled;
}
