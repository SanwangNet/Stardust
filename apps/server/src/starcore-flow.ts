import { createHash } from "node:crypto";
import { createFlowRegistry, FlowRegistry, validateExecutableFlow, type ExecutableFlow, type NodeContract, type Port } from "./executable-flow.js";
import { builtInWebContextFlow, createWebContextRegistry } from "./web-context-flow.js";
import type { ExtensionManifest } from "./channel.js";

/** Declarations are metadata, never executable code or authority. */
export type StarcoreFlowNode = {
  id: string; owner: string; name: string; description: string; category: "channel" | "tool" | "context" | "note";
  role: NodeContract["role"]; inputs: Record<string, Port>; outputs: Record<string, Port>;
  executable: boolean; capability?: string; adapter?: string;
};
export type StarcoreFlowGroup = { id: string; owner: string; name: string; description: string; editable: false; flow: ExecutableFlow };
export type StarcoreFlowContract = { protocol: 1; owner: string; packageVersion: string; nodes: StarcoreFlowNode[]; groups: StarcoreFlowGroup[] };
export type ResolvedGroupInterface = { groupId: string; graphId: string; inputs: { id: string; node: string; type: Port["type"]; required: boolean; label: string }[]; outputs: { id: string; node: string; type: Port["type"]; required: boolean; label: string }[] };

const trustedBindings: Readonly<Record<string, { owner: string; capability: string }>> = Object.freeze({
  "core:web-context": { owner: "web-chat", capability: "channel" },
  "core:qq-input": { owner: "qq-bot", capability: "channel" },
});
const webBindings: Readonly<Record<string, string>> = Object.freeze({ "web-chat:recent": "web-recent", "web-chat:global": "web-global", "web-chat:assembler": "web-assembler", "web-chat:json-output": "json-output" });
const text = (x: unknown): x is string => typeof x === "string" && x.trim().length > 0 && x.length <= 300;
const localId = (owner: string, value: unknown): value is string => typeof value === "string" && value.startsWith(`${owner}:`) && /^[a-z0-9][a-z0-9-]*:[a-z0-9][a-z0-9-]*$/.test(value) && value.length <= 128;
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
}

/** Uses the same port, graph, interface, type and recursive-group validation as the runtime. */
export function validateStarcoreFlow(manifest: ExtensionManifest, declaration: StarcoreFlowContract, toolNames: string[]): { fingerprint: string; warnings: string[] } {
  if (!declaration || declaration.protocol !== 1 || declaration.owner !== manifest.id || declaration.packageVersion !== manifest.version || !Array.isArray(declaration.nodes) || !Array.isArray(declaration.groups) || declaration.nodes.length > 100 || declaration.groups.length > 50) throw new Error("FLOW_CONTRACT_INCOMPATIBLE");
  const registry = new FlowRegistry(), core = createFlowRegistry();
  for (const type of ["input", "output", "pass"]) registry.register(type, core.get(type)!);
  const ids = new Set<string>();
  for (const node of declaration.nodes) {
    if (!node || !localId(manifest.id, node.id) || node.owner !== manifest.id || ids.has(node.id) || !text(node.name) || !text(node.description) || !["channel", "tool", "context", "note"].includes(node.category) || typeof node.executable !== "boolean") throw new Error("INVALID_FLOW_NODE");
    ids.add(node.id);
    if (node.capability !== undefined && node.capability !== "channel" && !(node.capability.startsWith("tool:") && toolNames.includes(node.capability.slice(5)))) throw new Error("FLOW_CAPABILITY_UNAVAILABLE");
    if (node.capability === "channel" && manifest.type !== "channel") throw new Error("FLOW_CAPABILITY_UNAVAILABLE");
    if (manifest.id === "qq-bot" && ["qq-bot:accept", "qq-bot:diagnostic"].includes(node.id) && (!node.executable || node.adapter !== "core:qq-input" || node.capability !== "channel")) throw new Error("FLOW_ADAPTER_UNTRUSTED");
    if (node.executable) {
      const binding = node.adapter && trustedBindings[node.adapter];
      if (!binding || binding.owner !== manifest.id || binding.capability !== node.capability) throw new Error("FLOW_ADAPTER_UNTRUSTED");
      const original = webBindings[node.id];
      const webActual = original && createWebContextRegistry({ recent: () => [], global: () => [] }, { conversationId: "catalog", current: "", instructions: "", budgetBytes: 48000, recentLimit: 50, useHistoryTool: true }).get(original);
      const qqPort = { value: { type: "string" as const, required: true } };
      const actual = node.adapter === "core:qq-input" && node.id === "qq-bot:accept" ? { role: "node", inputs: { ...qqPort, diagnostic: { type: "string" as const } }, outputs: { value: { type: "string" as const } } } : node.adapter === "core:qq-input" && node.id === "qq-bot:diagnostic" ? { role: "node", inputs: qqPort, outputs: { value: { type: "string" as const } } } : webActual;
      if (!actual || JSON.stringify(canonical({ role: node.role, inputs: node.inputs, outputs: node.outputs })) !== JSON.stringify(canonical({ role: actual.role, inputs: actual.inputs, outputs: actual.outputs }))) throw new Error("FLOW_ADAPTER_UNTRUSTED");
    } else if (node.adapter !== undefined) throw new Error("FLOW_ADAPTER_UNTRUSTED");
    try { registry.register(node.id, { role: node.role, inputs: node.inputs, outputs: node.outputs, execute: () => { throw new Error("FLOW_DECLARATION_NOT_EXECUTABLE"); } }); }
    catch { throw new Error("INVALID_FLOW_PORTS"); }
  }
  const groupIds = new Set<string>(), warnings: string[] = [];
  for (const group of declaration.groups) {
    if (!group || !localId(manifest.id, group.id) || group.owner !== manifest.id || groupIds.has(group.id) || ids.has(group.id) || !text(group.name) || !text(group.description) || group.editable !== false || !group.flow || group.flow.rootId !== group.id || !Array.isArray(group.flow.graphs)) throw new Error("INVALID_FLOW_GROUP");
    groupIds.add(group.id);
    for (const graph of group.flow.graphs) {
      if (!localId(manifest.id, graph.id)) throw new Error("FLOW_GRAPH_NAMESPACE");
      for (const item of [...graph.interface.inputs, ...graph.interface.outputs]) if (!text(item.label)) throw new Error("FLOW_INTERFACE_LABEL_REQUIRED");
      const reachable = (from: string, target: string): boolean => {
        const seen = new Set<string>(), pending = [from];
        while (pending.length) { const node = pending.pop()!; if (node === target) return true; if (seen.has(node)) continue; seen.add(node); for (const edge of graph.edges) if (edge.from.node === node) pending.push(edge.to.node); }
        return false;
      };
      for (const item of graph.interface.inputs) if (!graph.interface.outputs.some(out => reachable(item.node, out.node))) warnings.push(`${graph.id}:${item.id}:INPUT_UNCONNECTED`);
      for (const item of graph.interface.outputs) if (!graph.interface.inputs.some(input => reachable(input.node, item.node))) warnings.push(`${graph.id}:${item.id}:OUTPUT_UNCONNECTED`);
    }
    try { validateExecutableFlow(group.flow, registry); }
    catch (error) { throw new Error(`INVALID_FLOW_GRAPH: ${error instanceof Error ? error.message : "UNKNOWN"}`); }
  }
  const signature = { protocol: declaration.protocol, nodes: declaration.nodes.map(({ id, role, inputs, outputs, executable, capability, adapter }) => ({ id, role, inputs, outputs, executable, capability, adapter })).sort((a, b) => a.id.localeCompare(b.id)), groups: declaration.groups.map(group => ({ id: group.id, interfaces: group.flow.graphs.map(({ id, interface: iface }) => ({ id, inputs: iface.inputs.map(({ id, node, required }) => ({ id, node, required })), outputs: iface.outputs.map(({ id, node }) => ({ id, node })) })).sort((a, b) => a.id.localeCompare(b.id)) })).sort((a, b) => a.id.localeCompare(b.id)) };
  return { fingerprint: createHash("sha256").update(JSON.stringify(canonical(signature))).digest("hex"), warnings };
}

/** Interface types are derived from the same endpoint contracts M1 validates, never a second declaration. */
export function resolveStarcoreInterfaces(declaration: StarcoreFlowContract): ResolvedGroupInterface[] {
  const core = createFlowRegistry();
  return declaration.groups.flatMap(group => group.flow.graphs.map(graph => {
    const typeAt = (nodeId: string): Port["type"] => {
      const node = graph.nodes.find(item => item.id === nodeId)!;
      const contract = declaration.nodes.find(item => item.id === node.type) ?? core.get(node.type);
      return contract!.outputs.value!.type;
    };
    return { groupId: group.id, graphId: graph.id,
      inputs: graph.interface.inputs.map(port => ({ id: port.id, node: port.node, type: typeAt(port.node), required: port.required, label: port.label! })),
      outputs: graph.interface.outputs.map(port => ({ id: port.id, node: port.node, type: typeAt(port.node), required: true, label: port.label! })) };
  }));
}

/** A declaration registry cannot execute. Adapters require a separate Core-owned runtime. */
export class StarcoreFlowRegistry {
  private readonly contracts = new Map<string, StarcoreFlowContract>();
  register(manifest: ExtensionManifest, declaration: StarcoreFlowContract, toolNames: string[] = []): void {
    if (this.contracts.has(manifest.id)) throw new Error("DUPLICATE_FLOW_OWNER");
    validateStarcoreFlow(manifest, declaration, toolNames);
    this.contracts.set(manifest.id, structuredClone(declaration));
  }
  get(owner: string): StarcoreFlowContract | undefined { const value = this.contracts.get(owner); return value && structuredClone(value); }
  execute(): never { throw new Error("FLOW_ADAPTER_UNAVAILABLE"); }
}

/** Web declarations are generated from the actual M2 graph and its Core contracts. */
export function webContextDeclaration(version: string, definition: ExecutableFlow = builtInWebContextFlow()): StarcoreFlowContract {
  const flow = structuredClone(definition);
  const core = createWebContextRegistry({ recent: () => [], global: () => [] }, { conversationId: "catalog", current: "", instructions: "", budgetBytes: 48000, recentLimit: 50, useHistoryTool: true });
  const mapped: Record<string, string> = { "web-recent": "web-chat:recent", "web-global": "web-chat:global", "web-assembler": "web-chat:assembler", "json-output": "web-chat:json-output" };
  const names: Record<string, string> = { "web-recent": "Web 近期上下文", "web-global": "Web 全局上下文", "web-assembler": "Web 上下文组装器", "json-output": "结构化输出" };
  const nodes = Object.entries(mapped).map(([original, id]): StarcoreFlowNode => {
    const contract = core.get(original)!;
    return { id, owner: "web-chat", name: names[original]!, description: "对应现有 Web 上下文流程的 Core 节点；执行仍由原请求链负责。", category: "context", role: contract.role, inputs: contract.inputs, outputs: contract.outputs, executable: true, capability: "channel", adapter: "core:web-context" };
  });
  flow.rootId = "web-chat:web";
  for (const graph of flow.graphs) {
    graph.id = `web-chat:${graph.id}`;
    for (const node of graph.nodes) { if (node.graphId) node.graphId = `web-chat:${node.graphId}`; node.type = mapped[node.type] ?? node.type; }
  }
  return { protocol: 1, owner: "web-chat", packageVersion: version, nodes, groups: [{ id: "web-chat:web", owner: "web-chat", name: "Web 上下文", description: "现有 Web 上下文图的只读注册视图；执行状态以 Core 开关为准。", editable: false, flow }] };
}

/** Core binds only these fixed QQ node IDs; no unified context is implied. */
export function qqInputDeclaration(version: string): StarcoreFlowContract {
  const id = "qq-bot:input", child = "qq-bot:filter", port = { value: { type: "string" as const, required: true } }, out = { value: { type: "string" as const } };
  const edge = (from: string, to: string, target = "value", source = "value") => ({ from: { node: from, port: source }, to: { node: to, port: target } });
  return { protocol: 1, owner: "qq-bot", packageVersion: version, nodes: [
    { id: "qq-bot:accept", owner: "qq-bot", name: "QQ 入站消息过滤", description: "执行现有 QQ 事件、@、去重、回声及限流规则。", category: "channel", role: "node", inputs: { ...port, diagnostic: { type: "string" } }, outputs: out, executable: true, capability: "channel", adapter: "core:qq-input" },
    { id: "qq-bot:diagnostic", owner: "qq-bot", name: "接收事件诊断", description: "记录现有脱敏接收诊断；断开时不记录。", category: "channel", role: "node", inputs: port, outputs: out, executable: true, capability: "channel", adapter: "core:qq-input" },
  ], groups: [{ id, owner: "qq-bot", name: "QQ 消息入口", description: "QQ 入站过滤；不包括统一上下文或模型调用。", editable: false, flow: { version: 1, rootId: id, graphs: [
    { id, nodes: [{ id: "input", type: "input" }, { id: "filter", type: "group", graphId: child }, { id: "output", type: "output" }], edges: [edge("input", "filter", "message"), edge("filter", "output", "value", "result")], interface: { inputs: [{ id: "message", node: "input", required: true, label: "QQ 入站消息" }], outputs: [{ id: "result", node: "output", label: "交给现有 QQ 处理链" }] } },
    { id: child, nodes: [{ id: "input", type: "input" }, { id: "diagnostic", type: "qq-bot:diagnostic" }, { id: "accept", type: "qq-bot:accept" }, { id: "output", type: "output" }], edges: [edge("input", "diagnostic"), edge("input", "accept"), edge("diagnostic", "accept", "diagnostic"), edge("accept", "output")], interface: { inputs: [{ id: "message", node: "input", required: true, label: "QQ 入站消息" }], outputs: [{ id: "result", node: "output", label: "交给现有 QQ 处理链" }] } },
  ] } }] };
}
