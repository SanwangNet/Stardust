import { flowGraphs, type FlowGraph, type FlowKind, type FlowViewId } from "./flow-data.js";

export type PortDirection = "input" | "output";
export type FlowPortDefinition = { id: string; direction: PortDirection; type: "flow" };
export type EditableNode = FlowGraph["nodes"][number] & {
  origin: "system" | "custom" | "interface";
  ports: FlowPortDefinition[];
};
export type EditableEdge = FlowGraph["edges"][number] & { sourcePortId: string; targetPortId: string };
export type EditableGraph = Omit<FlowGraph, "nodes" | "edges"> & {
  nodes: EditableNode[];
  edges: EditableEdge[];
  interface: { inputs: (FlowPortDefinition & { nodeId: string; portId: string })[]; outputs: (FlowPortDefinition & { nodeId: string; portId: string })[] };
};
export type FlowDocument = { version: 1; rootId: string; graphs: EditableGraph[] };

const sharedViews: FlowViewId[] = ["web", "qq"];
const ports = (): FlowPortDefinition[] => [
  { id: "in", direction: "input", type: "flow" },
  { id: "out", direction: "output", type: "flow" },
];
function interfaceFor(id: string): EditableGraph["interface"] {
  return {
    inputs: [{ id: "in", direction: "input", type: "flow", nodeId: `group-input:${id}`, portId: "out" }],
    outputs: [{ id: "out", direction: "output", type: "flow", nodeId: `group-output:${id}`, portId: "in" }],
  };
}
function interfaceNodes(id: string, right: number): EditableNode[] {
  return [
    { id: `group-input:${id}`, kind: "input", title: "分组输入", subtitle: "GROUP INPUT", description: "对应父图中分组节点的输入端口。", owner: "分组接口", state: "接口", position: { x: -280, y: 0 }, views: [...sharedViews], origin: "interface", ports: [ports()[1]!] },
    { id: `group-output:${id}`, kind: "output", title: "分组输出", subtitle: "GROUP OUTPUT", description: "对应父图中分组节点的输出端口。", owner: "分组接口", state: "接口", position: { x: right, y: 0 }, views: [...sharedViews], origin: "interface", ports: [ports()[0]!] },
  ];
}

/** This document describes a visual draft. It is never executed by Agent Core. */
export function defaultFlowDocument(): FlowDocument {
  const graphs: EditableGraph[] = flowGraphs.map((graph) => ({
    ...structuredClone(graph),
    interface: graph.parentId ? interfaceFor(graph.id) : { inputs: [], outputs: [] },
    nodes: [...graph.nodes.map((node) => ({ ...structuredClone(node), origin: "system" as const, ports: ports() })),
      ...(graph.parentId ? interfaceNodes(graph.id, Math.max(0, ...graph.nodes.map((node) => node.position.x)) + 350) : [])],
    edges: graph.edges.map((edge) => ({ ...structuredClone(edge), sourcePortId: "out", targetPortId: "in" })),
  }));
  const connectInterface = (graph: EditableGraph, source: string, target: string, views: FlowViewId[]) => {
    graph.edges.push({
      id: `interface:${graph.id}:${source}:${target}`, source, target,
      sourcePortId: "out", targetPortId: "in", relation: "分组接口", views,
    });
  };
  for (const graph of graphs) {
    const input = `group-input:${graph.id}`, output = `group-output:${graph.id}`;
    if (graph.id === "input") {
      connectInterface(graph, input, "web-input", ["web"]);
      connectInterface(graph, input, "qq-input", ["qq"]);
      connectInterface(graph, "channel-entry", output, sharedViews);
    } else if (graph.id === "context") {
      connectInterface(graph, input, "current", sharedViews);
      connectInterface(graph, "context-output", output, sharedViews);
    } else if (graph.id === "model") {
      connectInterface(graph, input, "model-service", sharedViews);
      connectInterface(graph, "model-service", output, sharedViews);
    } else if (graph.id === "tool") {
      connectInterface(graph, input, "tool-request", ["web"]);
      connectInterface(graph, "tool-result", output, ["web"]);
    } else if (graph.id === "output") {
      connectInterface(graph, input, "final", sharedViews);
      connectInterface(graph, "web-output", output, ["web"]);
      connectInterface(graph, "qq-output", output, ["qq"]);
    }
  }
  const addDetail = (parentId: string, nodeId: string, childId: string, title: string, items: { id: string; title: string; description: string; x: number }[]) => {
    const parent = graphs.find((entry) => entry.id === parentId)!;
    parent.nodes.find((entry) => entry.id === nodeId)!.childGraphId = childId;
    const nodes: EditableNode[] = items.map((item) => ({
      id: item.id, kind: "context", title: item.title, subtitle: "", description: item.description,
      owner: "Stardust Core", state: "架构说明", position: { x: item.x, y: 150 }, views: ["web"], origin: "system", ports: ports(),
    }));
    const edges: EditableEdge[] = items.slice(1).map((item, index) => ({
      id: `${childId}:edge:${index}`, source: items[index]!.id, target: item.id,
      sourcePortId: "out", targetPortId: "in", relation: "处理", views: ["web"],
    }));
    graphs.push({
      id: childId, parentId, title, summary: "现有能力的说明性流程。", availableViews: ["web"],
      nodes: [...interfaceNodes(childId, items.length * 320), ...nodes], edges, interface: interfaceFor(childId),
    });
    const child = graphs[graphs.length - 1]!;
    connectInterface(child, `group-input:${childId}`, items[0]!.id, ["web"]);
    connectInterface(child, items[items.length - 1]!.id, `group-output:${childId}`, ["web"]);
  };
  addDetail("context", "global", "global-detail", "全局上下文", [
    { id: "global-source", title: "已完成对话", description: "成功完成的 Web 对话轮次登记综合任务。", x: 0 },
    { id: "global-worker", title: "后台综合", description: "后台任务增量综合对话，并保留来源信息。", x: 320 },
    { id: "global-entries", title: "摘要条目", description: "摘要按作用域持久化，可供上下文组装按相关性选取。", x: 640 },
  ]);
  addDetail("tool", "history", "history-detail", "跨会话历史检索", [
    { id: "history-validate", title: "参数校验", description: "验证搜索关键词和结果数量。", x: 0 },
    { id: "history-search", title: "搜索历史", description: "在允许的 Web 作用域中检索原始消息。", x: 320 },
    { id: "history-results", title: "返回结果", description: "限制结果数量和长度，保留角色及来源。", x: 640 },
  ]);
  return { version: 1, rootId: "overview", graphs };
}

function graphById(document: FlowDocument, id: string): EditableGraph {
  const graph = document.graphs.find((entry) => entry.id === id);
  if (!graph) throw new Error("找不到流程。");
  return graph;
}

export function addCustomNode(document: FlowDocument, graphId: string, kind: FlowKind, position: { x: number; y: number }, group = false): EditableNode {
  const graph = graphById(document, graphId);
  const id = crypto.randomUUID();
  const childId = group ? crypto.randomUUID() : undefined;
  const titles: Record<FlowKind, string> = {
    input: "渠道说明", context: "上下文说明", prompt: "提示词说明", agent: "Agent 说明",
    model: "模型说明", tool: "Tool 说明", output: "输出说明",
  };
  const node: EditableNode = {
    id, kind, title: group ? "新建分组" : titles[kind], subtitle: group ? "GROUP" : "NOTE",
    description: group ? "用于组织节点的分组。" : "流程设计中的说明节点。",
    owner: "用户定义", state: "设计草稿", position: { ...position }, views: [...sharedViews],
    origin: "custom", ports: ports(), ...(childId ? { childGraphId: childId } : {}),
  };
  graph.nodes.push(node);
  if (childId) document.graphs.push({
    id: childId, title: node.title, summary: node.description, parentId: graphId,
    nodes: interfaceNodes(childId, 350), edges: [], interface: interfaceFor(childId),
  });
  return node;
}

export function connectNodes(document: FlowDocument, graphId: string, source: string, sourcePortId: string, target: string, targetPortId: string): EditableEdge {
  const graph = graphById(document, graphId);
  const from = graph.nodes.find((node) => node.id === source);
  const to = graph.nodes.find((node) => node.id === target);
  if (!from || !to || source === target) throw new Error("请选择同一画板中的不同节点。");
  const output = from.ports.find((port) => port.id === sourcePortId && port.direction === "output");
  const input = to.ports.find((port) => port.id === targetPortId && port.direction === "input");
  if (!output || !input || output.type !== input.type) throw new Error("端口方向或类型不匹配。");
  if (graph.edges.some((edge) => edge.source === source && edge.target === target && edge.sourcePortId === sourcePortId && edge.targetPortId === targetPortId)) throw new Error("这两个端口已经连接。");
  const edge: EditableEdge = { id: crypto.randomUUID(), source, target, sourcePortId, targetPortId, relation: "设计连接", views: [...sharedViews] };
  graph.edges.push(edge);
  return edge;
}

export function removeEdge(document: FlowDocument, graphId: string, edgeId: string): void {
  const graph = graphById(document, graphId);
  const index = graph.edges.findIndex((edge) => edge.id === edgeId);
  if (index < 0) throw new Error("找不到连线。");
  graph.edges.splice(index, 1);
}

/** Move a custom node into a group only when doing so preserves all graph boundaries. */
export function moveNodeIntoGroup(document: FlowDocument, graphId: string, nodeId: string, groupId: string): void {
  const graph = graphById(document, graphId);
  const node = graph.nodes.find((entry) => entry.id === nodeId);
  const group = graph.nodes.find((entry) => entry.id === groupId);
  if (!node || node.origin !== "custom" || !group?.childGraphId || node.id === group.id) throw new Error("请选择可移动的自定义节点和不同的节点组。");
  if (graph.edges.some((edge) => edge.source === nodeId || edge.target === nodeId)) throw new Error("请先移除该节点的连线，再将其放入分组。");
  const destination = graphById(document, group.childGraphId);
  let ancestor: EditableGraph | undefined = destination;
  while (ancestor) {
    if (ancestor.id === node.childGraphId) throw new Error("节点组不能包含自身或上级节点组。");
    ancestor = ancestor.parentId ? graphById(document, ancestor.parentId) : undefined;
  }
  graph.nodes.splice(graph.nodes.indexOf(node), 1);
  destination.nodes.push(node);
  if (node.childGraphId) graphById(document, node.childGraphId).parentId = destination.id;
}

export function removeNode(document: FlowDocument, graphId: string, nodeId: string): void {
  const graph = graphById(document, graphId);
  const node = graph.nodes.find((entry) => entry.id === nodeId);
  if (!node || node.origin !== "custom") throw new Error("系统节点不能删除。");
  if (node.childGraphId && graphById(document, node.childGraphId).nodes.some((entry) => entry.origin !== "interface")) throw new Error("请先清空节点组。");
  graph.nodes.splice(graph.nodes.indexOf(node), 1);
  graph.edges = graph.edges.filter((edge) => edge.source !== nodeId && edge.target !== nodeId);
  if (node.childGraphId) document.graphs = document.graphs.filter((entry) => entry.id !== node.childGraphId);
}

/** Reject corrupted documents and references crossing graph or group boundaries. */
export function parseFlowDocument(value: unknown): FlowDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("流程数据格式无效。");
  const candidate = value as FlowDocument;
  if (candidate.version !== 1 || candidate.rootId !== "overview" || !Array.isArray(candidate.graphs) || candidate.graphs.length > 200) throw new Error("流程版本或图数量无效。");
  const graphIds = new Set<string>();
  const builtins = defaultFlowDocument();
  for (const graph of candidate.graphs) {
    if (!graph || typeof graph.id !== "string" || !graph.id || graph.id.length > 100 || graphIds.has(graph.id) ||
        typeof graph.title !== "string" || graph.title.length > 120 || typeof graph.summary !== "string" || graph.summary.length > 4000 ||
        (graph.parentId !== undefined && (typeof graph.parentId !== "string" || graph.parentId.length > 100)) ||
        (graph.availableViews !== undefined && (!Array.isArray(graph.availableViews) || graph.availableViews.some((view) => !sharedViews.includes(view)))) ||
        !Array.isArray(graph.nodes) || graph.nodes.length > 500 || !Array.isArray(graph.edges) || graph.edges.length > 1000 ||
        !graph.interface || !Array.isArray(graph.interface.inputs) || !Array.isArray(graph.interface.outputs)) throw new Error("流程结构无效。");
    graphIds.add(graph.id);
    const input = graph.interface.inputs, output = graph.interface.outputs;
    if (graph.id === candidate.rootId && (input.length !== 0 || output.length !== 0)) throw new Error("总览不应包含分组接口。");
    if (graph.id !== candidate.rootId && (input.length !== 1 || output.length !== 1 ||
        input[0]?.id !== "in" || input[0].direction !== "input" || input[0].type !== "flow" || input[0].nodeId !== `group-input:${graph.id}` || input[0].portId !== "out" ||
        output[0]?.id !== "out" || output[0].direction !== "output" || output[0].type !== "flow" || output[0].nodeId !== `group-output:${graph.id}` || output[0].portId !== "in")) throw new Error("节点组接口无效。");
    const ids = new Set<string>();
    for (const node of graph.nodes) {
      if (!node || typeof node.id !== "string" || !node.id || node.id.length > 100 || ids.has(node.id) ||
          !["input", "context", "prompt", "agent", "model", "tool", "output"].includes(node.kind) ||
          typeof node.title !== "string" || node.title.length > 120 || typeof node.description !== "string" || node.description.length > 4000 ||
          typeof node.subtitle !== "string" || node.subtitle.length > 120 || typeof node.owner !== "string" || node.owner.length > 120 ||
          typeof node.state !== "string" || node.state.length > 120 || !node.position ||
          !Number.isFinite(node.position.x) || !Number.isFinite(node.position.y) ||
          Math.abs(node.position.x) > 1000000 || Math.abs(node.position.y) > 1000000 ||
          !Array.isArray(node.views) || node.views.some((view) => !sharedViews.includes(view)) ||
          (node.childGraphId !== undefined && (typeof node.childGraphId !== "string" || !node.childGraphId || node.childGraphId.length > 100)) ||
          (node.registryId !== undefined && (typeof node.registryId !== "string" || node.registryId.length > 120)) ||
          (node.planned !== undefined && typeof node.planned !== "boolean") ||
          !Array.isArray(node.ports) ||
          !["system", "custom", "interface"].includes(node.origin)) throw new Error("节点数据无效。");
      if (node.positionByView !== undefined) {
        if (!node.positionByView || typeof node.positionByView !== "object" || Array.isArray(node.positionByView)) throw new Error("节点布局无效。");
        for (const [view, point] of Object.entries(node.positionByView)) {
          if (!["all", "web", "qq"].includes(view) || !point || typeof point !== "object" ||
              !Number.isFinite(point.x) || !Number.isFinite(point.y) || Math.abs(point.x) > 1000000 || Math.abs(point.y) > 1000000) throw new Error("节点布局无效。");
        }
      }
      for (const field of [node.descriptionByView, node.stateByView]) {
        if (field !== undefined && (!field || typeof field !== "object" || Array.isArray(field) ||
            Object.entries(field).some(([view, text]) => !["all", "web", "qq"].includes(view) || typeof text !== "string" || text.length > 4000))) throw new Error("节点说明无效。");
      }
      const hasInput = node.ports.some((port) => port.id === "in" && port.direction === "input" && port.type === "flow");
      const hasOutput = node.ports.some((port) => port.id === "out" && port.direction === "output" && port.type === "flow");
      if (node.origin === "interface") {
        if (node.ports.length !== 1 || !((node.id === `group-input:${graph.id}` && hasOutput) || (node.id === `group-output:${graph.id}` && hasInput))) throw new Error("节点组接口节点无效。");
      } else if (node.ports.length !== 2 || !hasInput || !hasOutput) throw new Error("节点端口无效。");
      if (node.origin === "system") {
        const original = builtins.graphs.find((entry) => entry.id === graph.id)?.nodes.find((entry) => entry.id === node.id);
        if (!original || node.kind !== original.kind || node.childGraphId !== original.childGraphId ||
            node.title !== original.title || node.description !== original.description || node.owner !== original.owner ||
            node.state !== original.state || node.subtitle !== original.subtitle ||
            JSON.stringify(node.views) !== JSON.stringify(original.views)) throw new Error("系统节点无效。");
      }
      ids.add(node.id);
    }
    if (graph.parentId && (!graph.nodes.some((node) => node.id === input[0]!.nodeId && node.origin === "interface") || !graph.nodes.some((node) => node.id === output[0]!.nodeId && node.origin === "interface"))) throw new Error("缺少节点组接口。");
    const edgeIds = new Set<string>();
    const connections = new Set<string>();
    for (const edge of graph.edges) {
      if (!edge || typeof edge.id !== "string" || !edge.id || edgeIds.has(edge.id) ||
          !ids.has(edge.source) || !ids.has(edge.target) || edge.source === edge.target ||
          edge.sourcePortId !== "out" || edge.targetPortId !== "in" ||
          !graph.nodes.find((node) => node.id === edge.source)?.ports.some((port) => port.id === edge.sourcePortId && port.direction === "output") ||
          !graph.nodes.find((node) => node.id === edge.target)?.ports.some((port) => port.id === edge.targetPortId && port.direction === "input") ||
          (edge.style !== undefined && !["dependency", "planned"].includes(edge.style)) ||
          (edge.sourcePort !== undefined && !["left", "right", "top", "bottom"].includes(edge.sourcePort)) ||
          (edge.targetPort !== undefined && !["left", "right", "top", "bottom"].includes(edge.targetPort)) ||
          typeof edge.relation !== "string" || edge.relation.length > 200 ||
          !Array.isArray(edge.views) || edge.views.some((view) => !sharedViews.includes(view))) throw new Error("连线数据无效。");
      const key = JSON.stringify([edge.source, edge.sourcePortId, edge.target, edge.targetPortId]);
      if (connections.has(key)) throw new Error("不能重复连接端口。");
      edgeIds.add(edge.id); connections.add(key);
    }
  }
  if (!graphIds.has(candidate.rootId)) throw new Error("缺少总览。");
  for (const original of builtins.graphs) {
    const graph = candidate.graphs.find((entry) => entry.id === original.id);
    if (!graph || original.nodes.some((node) => node.origin === "system" && !graph.nodes.some((entry) => entry.id === node.id && entry.origin === "system"))) throw new Error("缺少系统节点。");
  }
  for (const graph of candidate.graphs) {
    if (graph.id === candidate.rootId ? graph.parentId !== undefined : !graph.parentId || !graphIds.has(graph.parentId)) throw new Error("子流程的上级无效。");
    for (const node of graph.nodes) {
      if (node.childGraphId && (!graphIds.has(node.childGraphId) || graphById(candidate, node.childGraphId).parentId !== graph.id)) throw new Error("节点组引用无效。");
    }
    if (graph.parentId) {
      const parent = graphById(candidate, graph.parentId);
      if (parent.nodes.filter((node) => node.childGraphId === graph.id).length !== 1) throw new Error("节点组归属无效。");
    }
    const ancestors = new Set<string>();
    let current: EditableGraph | undefined = graph;
    while (current) {
      if (ancestors.has(current.id)) throw new Error("节点组不能循环嵌套。");
      ancestors.add(current.id);
      current = current.parentId ? graphById(candidate, current.parentId) : undefined;
    }
  }
  return structuredClone(candidate);
}
