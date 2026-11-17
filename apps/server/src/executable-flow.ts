/** Server-owned executable graphs. This is deliberately unrelated to the visual FlowDocument. */
export type ValueType = "string" | "number" | "boolean" | "control" | "json";
export type Port = { type: ValueType; required?: boolean };
export type NodeContract = {
  role: "entry" | "node" | "output";
  inputs: Record<string, Port>;
  outputs: Record<string, Port>;
  // Trusted server code only. No Tool host, permission or approval capability is supplied.
  execute: (inputs: Readonly<Record<string, unknown>>, config: unknown, signal: AbortSignal) => Promise<Record<string, unknown>> | Record<string, unknown>;
  validateConfig?: (config: unknown) => boolean;
  sideEffect?: boolean;
};
export type FlowNode = { id: string; type: string; config?: unknown; graphId?: string };
export type FlowEdge = { from: { node: string; port: string }; to: { node: string; port: string } };
export type FlowGraph = {
  id: string; nodes: FlowNode[]; edges: FlowEdge[];
  interface: { inputs: { id: string; node: string; required: boolean; label?: string }[]; outputs: { id: string; node: string; label?: string }[] };
};
export type ExecutableFlow = { version: 1; rootId: string; graphs: FlowGraph[] };
/** A future server adapter may translate a visual draft; its result is still untrusted and must be validated. */
export type FlowDraftConverter = (draft: unknown) => unknown;
export type NodeState = { path: string[]; status: "succeeded" | "failed" | "cancelled" | "skipped"; error?: string };
export type FlowResult = { status: "succeeded" | "failed" | "cancelled"; outputs: Record<string, unknown>; nodes: NodeState[]; error?: string };

const own = (o: object, key: string) => Object.hasOwn(o, key);
const record = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
function shape(value: unknown, required: string[], optional: string[] = []): asserts value is Record<string, unknown> {
  if (!record(value) || required.some(k => !own(value, k)) || Object.keys(value).some(k => !required.includes(k) && !optional.includes(k))) throw new Error("INVALID_SCHEMA");
}
function id(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_:-]{1,128}$/.test(value)) throw new Error("INVALID_ID");
}
function validValue(value: unknown, type: ValueType): boolean {
  if (type === "json") {
    const seen = new Set<object>();
    const json = (item: unknown): boolean => {
      if (item === null || typeof item === "string" || typeof item === "boolean") return true;
      if (typeof item === "number") return Number.isFinite(item);
      if (typeof item !== "object" || seen.has(item)) return false;
      const prototype: unknown = Object.getPrototypeOf(item);
      if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null) return false;
      seen.add(item);
      const valid = Array.isArray(item) ? Array.from({ length: item.length }, (_, i) => own(item, String(i)) && json(item[i])).every(Boolean) : Object.values(item).every(json);
      seen.delete(item);
      return valid;
    };
    return json(value);
  }
  return type === "control" ? value === true : typeof value === type && (type !== "number" || Number.isFinite(value));
}
function portMap(value: Record<string, Port>): Record<string, Port> {
  const result: Record<string, Port> = Object.create(null);
  for (const [key, port] of Object.entries(value)) {
    id(key);
    if (!record(port) || !["string", "number", "boolean", "control", "json"].includes(port.type) || (port.required !== undefined && typeof port.required !== "boolean")) throw new Error("INVALID_CONTRACT");
    result[key] = Object.freeze({ type: port.type, required: port.required });
  }
  return Object.freeze(result);
}

/** Only trusted server bootstrap code may construct/register contracts. Graph JSON never supplies code or ports. */
export class FlowRegistry {
  private readonly types = new Map<string, NodeContract>();
  register(type: string, contract: NodeContract): this {
    id(type);
    if (type === "group" || this.types.has(type) || !["entry", "node", "output"].includes(contract.role) || typeof contract.execute !== "function") throw new Error("INVALID_CONTRACT");
    if ((contract.role === "entry" && (Object.keys(contract.inputs).length !== 0 || Object.keys(contract.outputs).join() !== "value")) || (contract.role === "output" && !own(contract.outputs, "value"))) throw new Error("INVALID_CONTRACT");
    this.types.set(type, Object.freeze({ ...contract, inputs: portMap(contract.inputs), outputs: portMap(contract.outputs) }));
    return this;
  }
  get(type: string): NodeContract | undefined { return this.types.get(type); }
}

const stringIn = { value: { type: "string" as const, required: true } };
const stringOut = { value: { type: "string" as const } };
export function createFlowRegistry(): FlowRegistry {
  const registry = new FlowRegistry();
  const noConfig = (value: unknown) => value === undefined;
  registry.register("input", { role: "entry", inputs: {}, outputs: stringOut, validateConfig: noConfig, execute: () => ({}) });
  registry.register("output", { role: "output", inputs: stringIn, outputs: stringOut, validateConfig: noConfig, execute: i => ({ value: i.value }) });
  registry.register("pass", { role: "node", inputs: stringIn, outputs: stringOut, validateConfig: noConfig, execute: i => ({ value: i.value }) });
  registry.register("transform", { role: "node", inputs: stringIn, outputs: stringOut,
    validateConfig: c => record(c) && Object.keys(c).length === 1 && typeof c.suffix === "string",
    execute: (i, c) => ({ value: String(i.value) + (c as { suffix: string }).suffix }) });
  registry.register("merge", { role: "node", inputs: { ...stringIn, optional: { type: "string", required: false } }, outputs: stringOut,
    validateConfig: noConfig, execute: i => ({ value: String(i.value) + (i.optional ?? "") }) });
  return registry;
}

type Resolved = { node: FlowNode; role: NodeContract["role"]; inputs: Record<string, Port>; outputs: Record<string, Port>; contract?: NodeContract; child?: CheckedGraph };
type CheckedGraph = { graph: FlowGraph; nodes: Map<string, Resolved>; incoming: Map<string, FlowEdge[]>; order: string[] };
type Checked = { root: CheckedGraph; graphs: Map<string, CheckedGraph> };

/** Validate untrusted data, including unused structures. Cycles are not iteration constructs. */
function check(flow: unknown, registry: FlowRegistry): Checked {
  shape(flow, ["version", "rootId", "graphs"]); if (flow.version !== 1 || !Array.isArray(flow.graphs)) throw new Error("INVALID_SCHEMA"); id(flow.rootId);
  const graphs = new Map<string, FlowGraph>();
  for (const raw of flow.graphs) {
    shape(raw, ["id", "nodes", "edges", "interface"]); id(raw.id);
    if (graphs.has(raw.id) || !Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) throw new Error("INVALID_GRAPH");
    shape(raw.interface, ["inputs", "outputs"]);
    if (!Array.isArray(raw.interface.inputs) || !Array.isArray(raw.interface.outputs)) throw new Error("INVALID_INTERFACE");
    graphs.set(raw.id, raw as FlowGraph);
  }
  const checked = new Map<string, CheckedGraph>(); const visiting = new Set<string>();
  function build(graphId: string): CheckedGraph {
    const previous = checked.get(graphId); if (previous) return previous;
    if (visiting.has(graphId)) throw new Error(`GROUP_CYCLE: ${graphId}`);
    const graph = graphs.get(graphId); if (!graph) throw new Error(`UNKNOWN_GRAPH: ${graphId}`);
    visiting.add(graphId); const nodes = new Map<string, Resolved>();
    for (const raw of graph.nodes) {
      shape(raw, ["id", "type"], ["config", "graphId"]); id(raw.id); id(raw.type);
      if (nodes.has(raw.id)) throw new Error(`DUPLICATE_NODE: ${raw.id}`);
      const node = raw as FlowNode;
      if (node.type === "group") {
        if (own(node, "config")) throw new Error("INVALID_GROUP"); id(node.graphId);
        const child = build(node.graphId); const inputs: Record<string, Port> = Object.create(null), outputs: Record<string, Port> = Object.create(null);
        for (const item of child.graph.interface.inputs) inputs[item.id] = { type: child.nodes.get(item.node)!.outputs.value!.type, required: item.required };
        for (const item of child.graph.interface.outputs) outputs[item.id] = { type: child.nodes.get(item.node)!.outputs.value!.type };
        nodes.set(node.id, { node, role: "node", inputs, outputs, child });
      } else {
        if (own(node, "graphId")) throw new Error("INVALID_NODE");
        const contract = registry.get(node.type); if (!contract) throw new Error(`UNKNOWN_NODE_TYPE: ${node.type}`);
        if (contract.validateConfig ? !contract.validateConfig(node.config) : node.config !== undefined) throw new Error(`INVALID_CONFIG: ${node.id}`);
        nodes.set(node.id, { node, role: contract.role, inputs: contract.inputs, outputs: contract.outputs, contract });
      }
    }
    for (const [kind, entries] of [["inputs", graph.interface.inputs], ["outputs", graph.interface.outputs]] as const) {
      const names = new Set<string>(), bound = new Set<string>();
      for (const item of entries) {
        shape(item, kind === "inputs" ? ["id", "node", "required"] : ["id", "node"], ["label"]); id(item.id); id(item.node);
        if (item.label !== undefined && (typeof item.label !== "string" || !item.label.trim() || item.label.length > 120)) throw new Error("INVALID_INTERFACE");
        if (kind === "inputs" && typeof (item as { required?: unknown }).required !== "boolean") throw new Error("INVALID_INTERFACE");
        const endpoint = nodes.get(item.node);
        if (names.has(item.id) || bound.has(item.node) || !endpoint || endpoint.role !== (kind === "inputs" ? "entry" : "output") || !endpoint.outputs.value) throw new Error("INVALID_INTERFACE");
        names.add(item.id); bound.add(item.node);
      }
    }
    const incoming = new Map<string, FlowEdge[]>(); const out = new Map<string, string[]>(); const degree = new Map([...nodes.keys()].map(k => [k, 0])); const targets = new Set<string>();
    for (const edge of graph.edges) {
      shape(edge, ["from", "to"]); shape(edge.from, ["node", "port"]); shape(edge.to, ["node", "port"]);
      id(edge.from.node); id(edge.from.port); id(edge.to.node); id(edge.to.port);
      const sourcePorts = nodes.get(edge.from.node)?.outputs, targetPorts = nodes.get(edge.to.node)?.inputs;
      const source = sourcePorts && own(sourcePorts, edge.from.port) ? sourcePorts[edge.from.port] : undefined;
      const target = targetPorts && own(targetPorts, edge.to.port) ? targetPorts[edge.to.port] : undefined;
      if (!source || !target) throw new Error("INVALID_PORT");
      if (source.type !== target.type) throw new Error("PORT_TYPE_MISMATCH");
      const key = `${edge.to.node}\0${edge.to.port}`; if (targets.has(key)) throw new Error("DUPLICATE_INPUT"); targets.add(key);
      incoming.set(edge.to.node, [...(incoming.get(edge.to.node) ?? []), edge]); out.set(edge.from.node, [...(out.get(edge.from.node) ?? []), edge.to.node]); degree.set(edge.to.node, degree.get(edge.to.node)! + 1);
    }
    const queue = [...degree].filter(([, n]) => n === 0).map(([k]) => k), order: string[] = [];
    for (let i = 0; i < queue.length; i++) { const n = queue[i]!; order.push(n); for (const next of out.get(n) ?? []) { const d = degree.get(next)! - 1; degree.set(next, d); if (!d) queue.push(next); } }
    if (order.length !== nodes.size) throw new Error("GRAPH_CYCLE");
    const result = { graph, nodes, incoming, order }; checked.set(graphId, result); visiting.delete(graphId); return result;
  }
  for (const graphId of graphs.keys()) build(graphId);
  return { root: build(flow.rootId), graphs: checked };
}

type Plan = { selected: Set<string>; children: Map<string, Plan>; groupInputs: Map<string, Set<string>> };
function plan(graph: CheckedGraph, targets: string[]): Plan {
  if (!targets.length) throw new Error("NO_TARGET");
  const selected = new Set<string>(), children = new Map<string, Plan>(), groupInputs = new Map<string, Set<string>>(), demanded = new Map<string, Set<string>>();
  function visit(nodeId: string, requestedPort?: string): void {
    const node = graph.nodes.get(nodeId); if (!node) throw new Error(`UNKNOWN_TARGET: ${nodeId}`);
    if (node.child) {
      const ports = demanded.get(nodeId) ?? new Set<string>();
      const before = ports.size;
      if (requestedPort === undefined) for (const output of node.child.graph.interface.outputs) ports.add(output.id);
      else ports.add(requestedPort);
      if (selected.has(nodeId) && ports.size === before) return;
      selected.add(nodeId); demanded.set(nodeId, ports);
      const childPlan = plan(node.child, node.child.graph.interface.outputs.filter(o => ports.has(o.id)).map(o => o.node));
      children.set(nodeId, childPlan);
      const needed = new Set(node.child.graph.interface.inputs.filter(i => childPlan.selected.has(i.node)).map(i => i.id));
      groupInputs.set(nodeId, needed);
      const incoming = graph.incoming.get(nodeId) ?? [];
      for (const port of needed) {
        const edge = incoming.find(e => e.to.port === port);
        if (!edge && node.inputs[port]!.required) throw new Error(`MISSING_REQUIRED_INPUT: ${nodeId}.${port}`);
        if (edge) visit(edge.from.node, edge.from.port);
      }
      return;
    }
    if (selected.has(nodeId)) return;
    selected.add(nodeId); const incoming = graph.incoming.get(nodeId) ?? [];
    if (node.role === "entry" && !graph.graph.interface.inputs.some(input => input.node === nodeId)) throw new Error(`UNBOUND_ENTRY: ${nodeId}`);
    for (const [port, spec] of Object.entries(node.inputs)) if (spec.required && !incoming.some(e => e.to.port === port)) throw new Error(`MISSING_REQUIRED_INPUT: ${nodeId}.${port}`);
    if (node.role !== "entry" && !incoming.length) throw new Error(`UNREACHABLE_NODE: ${nodeId}`);
    for (const edge of incoming) visit(edge.from.node, edge.from.port);
  }
  for (const target of targets) visit(target);
  return { selected, children, groupInputs };
}

export function validateExecutableFlow(flow: unknown, registry: FlowRegistry, targets?: string[]): void {
  const checked = check(flow, registry); plan(checked.root, targets ?? checked.root.graph.interface.outputs.map(o => o.node));
}

/** Validate a private snapshot before any node is called. Cancellation is cooperative. */
export async function executeFlow(flow: unknown, registry: FlowRegistry, inputs: Record<string, unknown>, options: { targets?: string[]; signal?: AbortSignal } = {}): Promise<FlowResult> {
  const snapshot: unknown = structuredClone(flow); const checked = check(snapshot, registry);
  const rootPlan = plan(checked.root, options.targets ?? checked.root.graph.interface.outputs.map(o => o.node));
  const signal = options.signal ?? new AbortController().signal; const states: NodeState[] = [];
  const values: Record<string, unknown> = Object.create(null);
  async function run(graph: CheckedGraph, current: Plan, supplied: Record<string, unknown>, path: string[]): Promise<Record<string, unknown>> {
    const results = new Map<string, Record<string, unknown>>();
    for (const [index, nodeId] of graph.order.entries()) {
      const node = graph.nodes.get(nodeId)!; const nodePath = [...path, nodeId];
      if (!current.selected.has(nodeId)) { states.push({ path: nodePath, status: "skipped" }); continue; }
      if (signal.aborted) {
        states.push({ path: nodePath, status: "cancelled" });
        for (const rest of graph.order.slice(index + 1)) states.push({ path: [...path, rest], status: "skipped" });
        throw new Error("CANCELLED");
      }
      try {
        const args: Record<string, unknown> = Object.create(null);
        for (const edge of graph.incoming.get(nodeId) ?? []) {
          if (node.child && !current.groupInputs.get(nodeId)!.has(edge.to.port)) continue;
          const source = results.get(edge.from.node)!;
          if (own(source, edge.from.port)) args[edge.to.port] = source[edge.from.port];
        }
        for (const [key, port] of Object.entries(node.inputs)) {
          if (node.child && !current.groupInputs.get(nodeId)!.has(key)) continue;
          if (!own(args, key)) { if (port.required) throw new Error(`MISSING_REQUIRED_VALUE: ${nodeId}.${key}`); }
          else if (!validValue(args[key], port.type)) throw new Error(`INVALID_INPUT_VALUE: ${nodeId}.${key}`);
        }
        let output: Record<string, unknown>;
        if (node.role === "entry") {
          if (!own(supplied, nodeId)) throw new Error(`MISSING_ENTRY_VALUE: ${nodeId}`);
          output = { value: supplied[nodeId] };
        } else if (node.child) {
          const childInputs: Record<string, unknown> = Object.create(null);
          for (const item of node.child.graph.interface.inputs) if (own(args, item.id)) childInputs[item.node] = args[item.id];
          const childResults = await run(node.child, current.children.get(nodeId)!, childInputs, nodePath);
          output = Object.create(null) as Record<string, unknown>;
          for (const item of node.child.graph.interface.outputs) if (own(childResults, item.node)) output[item.id] = childResults[item.node];
        } else {
          // M1 has no Core gateway integration. Fail closed even for trusted contracts that declare side effects.
          if (node.contract!.sideEffect) throw new Error(`SIDE_EFFECT_UNAVAILABLE: ${nodeId}`);
          output = await node.contract!.execute(Object.freeze(args), node.node.config, signal);
        }
        if (signal.aborted) throw new Error("CANCELLED");
        if (!record(output) || Object.keys(output).some(key => !own(node.outputs, key) || !validValue(output[key], node.outputs[key]!.type))) throw new Error(`INVALID_OUTPUT_VALUE: ${nodeId}`);
        if (node.role === "output" && !own(output, "value")) throw new Error(`MISSING_OUTPUT_VALUE: ${nodeId}`);
        results.set(nodeId, output); states.push({ path: nodePath, status: "succeeded" });
      } catch (error) {
        const cancelled = signal.aborted;
        states.push({ path: nodePath, status: cancelled ? "cancelled" : "failed", error: cancelled ? "CANCELLED" : error instanceof Error ? error.message : "NODE_FAILED" });
        for (const rest of graph.order.slice(index + 1)) states.push({ path: [...path, rest], status: "skipped" });
        throw error;
      }
    }
    const output: Record<string, unknown> = Object.create(null);
    for (const item of graph.graph.interface.outputs) { const value = results.get(item.node); if (value && own(value, "value")) output[item.node] = value.value; }
    return output;
  }
  try {
    const supplied: Record<string, unknown> = Object.create(null);
    for (const item of checked.root.graph.interface.inputs) if (own(inputs, item.id)) supplied[item.node] = inputs[item.id];
    const result = await run(checked.root, rootPlan, supplied, []);
    for (const item of checked.root.graph.interface.outputs) if (own(result, item.node)) values[item.id] = result[item.node];
    return { status: "succeeded", outputs: values, nodes: states };
  } catch (error) {
    return { status: signal.aborted ? "cancelled" : "failed", outputs: values, nodes: states, error: signal.aborted ? "CANCELLED" : error instanceof Error ? error.message : "NODE_FAILED" };
  }
}
