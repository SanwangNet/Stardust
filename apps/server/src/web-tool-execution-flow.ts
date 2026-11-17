import { createFlowRegistry, executeFlow, validateExecutableFlow, type ExecutableFlow } from "./executable-flow.js";

const edge = (from: string, to: string) => ({ from: { node: from, port: "value" }, to: { node: to, port: "value" } });

/** Trusted graph: the stages gate the existing Core checks, approval state and executor. */
export function builtInWebToolExecutionFlow(): ExecutableFlow {
  return { version: 1, rootId: "root", graphs: [
    { id: "root", nodes: [{ id: "input", type: "input" }, { id: "tool", type: "group", graphId: "tool" }, { id: "output", type: "output" }],
      edges: [{ from: { node: "input", port: "value" }, to: { node: "tool", port: "call" } }, { from: { node: "tool", port: "result" }, to: { node: "output", port: "value" } }],
      interface: { inputs: [{ id: "call", node: "input", required: true }], outputs: [{ id: "result", node: "output" }] } },
    { id: "tool", nodes: [{ id: "input", type: "input" }, { id: "validate", type: "validate-stage" }, { id: "permission", type: "permission-stage" }, { id: "approval", type: "approval-stage" }, { id: "executor", type: "executor-stage" }, { id: "result", type: "result-stage" }, { id: "output", type: "output" }],
      edges: [edge("input", "validate"), edge("validate", "permission"), edge("permission", "approval"), edge("approval", "executor"), edge("executor", "result"), edge("result", "output")],
      interface: { inputs: [{ id: "call", node: "input", required: true, label: "模型调用" }], outputs: [{ id: "result", node: "output", label: "返回模型" }] } },
  ] };
}

/** Two bounded passes: admission, then execution after the Core's checks/approval. */
export async function runToolExecutionFlow(flow: ExecutableFlow, signal: AbortSignal, action?: () => Promise<void> | void): Promise<void> {
  // These Core invariants prevent a graph from manufacturing a stage token or bypassing approval.
  const root = flow.graphs?.find(g => g.id === "root"), group = flow.graphs?.find(g => g.id === "tool");
  const types: Record<string, string> = { input: "input", validate: "validate-stage", permission: "permission-stage", approval: "approval-stage", executor: "executor-stage", result: "result-stage", output: "output" };
  const linked = (graph: typeof group, from: string, fromPort: string, to: string, toPort: string) => graph?.edges.some(e => e.from.node === from && e.from.port === fromPort && e.to.node === to && e.to.port === toPort);
  if (flow.rootId !== "root" || !root || !group || root.nodes.find(n => n.id === "tool")?.type !== "group" || root.nodes.find(n => n.id === "tool")?.graphId !== "tool"
      || root.nodes.find(n => n.id === "input")?.type !== "input" || root.nodes.find(n => n.id === "output")?.type !== "output"
      || root.interface.inputs.length !== 1 || root.interface.inputs[0]?.id !== "call" || root.interface.inputs[0]?.node !== "input"
      || root.interface.outputs.length !== 1 || root.interface.outputs[0]?.id !== "result" || root.interface.outputs[0]?.node !== "output"
      || group.interface.inputs.length !== 1 || group.interface.inputs[0]?.id !== "call" || group.interface.inputs[0]?.node !== "input"
      || group.interface.outputs.length !== 1 || group.interface.outputs[0]?.id !== "result" || group.interface.outputs[0]?.node !== "output"
      || Object.entries(types).some(([node, type]) => group.nodes.find(n => n.id === node)?.type !== type)
      || !linked(root, "input", "value", "tool", "call") || !linked(root, "tool", "result", "output", "value")
      || !linked(group, "input", "value", "validate", "value") || !linked(group, "validate", "value", "permission", "value")
      || !linked(group, "permission", "value", "approval", "value") || !linked(group, "approval", "value", "executor", "value")
      || !linked(group, "executor", "value", "result", "value") || !linked(group, "result", "value", "output", "value")) throw new Error("TOOL_EXECUTION_FLOW_INVALID");
  const registry = createFlowRegistry(), port = { value: { type: "string" as const, required: true } }, output = { value: { type: "string" as const } };
  for (const [name, expected, next] of [["validate-stage", "", "V"], ["permission-stage", "V", "VP"], ["approval-stage", "VP", "VPA"], ["result-stage", "VPAE", "VPAER"]] as const) {
    registry.register(name, { role: "node", inputs: port, outputs: output, execute: i => { if (i.value !== expected) throw new Error("INVALID_STAGE"); return { value: next }; } });
  }
  let invoked = false;
  registry.register("executor-stage", { role: "node", inputs: port, outputs: output, execute: async i => {
    if (i.value !== "VPA" || signal.aborted) throw new Error("INVALID_STAGE");
    if (action) { if (invoked) throw new Error("DUPLICATE_EXECUTION"); invoked = true; await action(); }
    return { value: "VPAE" };
  } });
  try { validateExecutableFlow(flow, registry); } catch { throw new Error("TOOL_EXECUTION_FLOW_INVALID"); }
  const result = await executeFlow(flow, registry, { call: "" }, { signal });
  if (result.status !== "succeeded" || result.outputs.result !== "VPAER") throw new Error(signal.aborted ? "TOOL_EXECUTION_FLOW_CANCELLED" : "TOOL_EXECUTION_FLOW_FAILED");
}
