import { createFlowRegistry, executeFlow, validateExecutableFlow, type ExecutableFlow } from "./executable-flow.js";
import { searchTool } from "./history-agent.js";

const edge = (from: string, port: string, to: string, input: string) => ({ from: { node: from, port }, to: { node: to, port: input } });

/** The graph contains no executable Tool implementations or permission grants. */
export function builtInWebToolFlow(): ExecutableFlow {
  return { version: 1, rootId: "root", graphs: [
    { id: "root", nodes: [{ id: "input", type: "input" }, { id: "tools", type: "group", graphId: "availability" }, { id: "output", type: "tool-output" }],
      edges: [edge("input", "value", "tools", "request"), edge("tools", "definitions", "output", "value")],
      interface: { inputs: [{ id: "request", node: "input", required: true }], outputs: [{ id: "definitions", node: "output" }] } },
    { id: "availability", nodes: [{ id: "input", type: "input" }, { id: "search", type: "registered-search" }, { id: "extensions", type: "registered-extensions" }, { id: "filter", type: "tool-filter" }, { id: "output", type: "tool-output" }],
      edges: [edge("input", "value", "search", "trigger"), edge("input", "value", "extensions", "trigger"), edge("input", "value", "filter", "trigger"), edge("search", "value", "filter", "search"), edge("extensions", "value", "filter", "extensions"), edge("filter", "value", "output", "value")],
      interface: { inputs: [{ id: "request", node: "input", required: true, label: "模型请求准备" }], outputs: [{ id: "definitions", node: "output", label: "提供给模型" }] } },
  ] };
}

export class WebToolFlowError extends Error {
  constructor(readonly code: "TOOL_FLOW_INVALID" | "TOOL_FLOW_FAILED" | "TOOL_FLOW_CANCELLED") { super(code); }
}

/** Candidate names originate only in Core registrations; graph data cannot add a registration. */
type RegisteredTool = { name: string; description: string; parameters: Record<string, unknown> };
export async function runWebToolFlow(flow: ExecutableFlow, registeredExtensions: RegisteredTool[], allowed: (name: string) => boolean, signal?: AbortSignal): Promise<ReadonlySet<string>> {
  const registry = createFlowRegistry(), string = { type: "string" as const, required: true }, json = { type: "json" as const };
  const candidates = registeredExtensions.filter(tool => tool.name !== "search_history").map(({ name, description, parameters }) => ({ name, description, parameters }));
  registry.register("registered-search", { role: "node", inputs: { trigger: string }, outputs: { value: json }, execute: () => ({ value: [searchTool.function] }) });
  registry.register("registered-extensions", { role: "node", inputs: { trigger: string }, outputs: { value: json }, execute: () => ({ value: candidates }) });
  registry.register("tool-filter", { role: "node", inputs: { trigger: string, search: json, extensions: json }, outputs: { value: json }, execute: i => ({ value: [...(i.search as RegisteredTool[] ?? []), ...(i.extensions as RegisteredTool[] ?? [])].filter(tool => allowed(tool.name)) }) });
  registry.register("tool-output", { role: "output", inputs: { value: { ...json, required: true } }, outputs: { value: json }, execute: i => ({ value: i.value }) });
  try { validateExecutableFlow(flow, registry); } catch { throw new WebToolFlowError("TOOL_FLOW_INVALID"); }
  const result = await executeFlow(flow, registry, { request: "web" }, { signal });
  if (result.status !== "succeeded") throw new WebToolFlowError(result.status === "cancelled" ? "TOOL_FLOW_CANCELLED" : "TOOL_FLOW_FAILED");
  const definitions = result.outputs.definitions;
  const trusted = new Set([searchTool.function.name, ...candidates.map(tool => tool.name)]);
  if (!Array.isArray(definitions) || definitions.some(tool => !tool || typeof tool !== "object" || typeof tool.name !== "string" || !trusted.has(tool.name))) throw new WebToolFlowError("TOOL_FLOW_FAILED");
  try { return new Set(definitions.map(tool => tool.name).filter(allowed)); }
  catch { throw new WebToolFlowError("TOOL_FLOW_FAILED"); }
}
