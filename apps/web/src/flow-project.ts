export const PORT_SIDES = ["left", "right", "top", "bottom"] as const;
export const LINE_STYLES = ["solid", "dashed", "dotted"] as const;
export const PATH_STYLES = ["bezier", "orthogonal"] as const;
export const EDGE_SEMANTICS = ["unspecified", "data", "trigger", "capability", "feedback", "optional"] as const;
export type PortSide = typeof PORT_SIDES[number];
export type PortKind = "input" | "output";
export type LineStyle = typeof LINE_STYLES[number];
export type PathStyle = typeof PATH_STYLES[number];
export type EdgeSemantic = typeof EDGE_SEMANTICS[number];
export type Port = { id: string; name: string; side?: PortSide };
type EdgeAppearance = { lineStyle?: LineStyle; pathStyle?: PathStyle };
export type DesignNode = { id: string; title: string; subtitle: string; position: { x: number; y: number }; visualStyle: string; inputPorts: Port[]; outputPorts: Port[]; childBoardId?: string };
export type DesignEdge = { id: string; fromNodeId: string; fromPortId: string; toNodeId: string; toPortId: string; appearance?: EdgeAppearance; semantic?: EdgeSemantic };
export type Viewport = { x: number; y: number; scale: number };
export type Board = { id: string; name: string; nodes: DesignNode[]; edges: DesignEdge[]; viewport: Viewport | null };
export type FlowDesignProject = { schemaVersion: 1; projectId: string; projectName: string; rootBoardId: string; boards: Board[] };
export const MAX_FILE_SIZE = 5 * 1024 * 1024;
export const MAX_BOARDS = 200;
export const MAX_NODES_PER_BOARD = 2000;
export const MAX_PORTS_PER_KIND = 16;
const MAX_EDGES_PER_BOARD = 10000;
export const DEFAULT_EDGE_APPEARANCE = { lineStyle: "solid", pathStyle: "bezier" } as const;
export const portSide = (port: Port, kind: PortKind): PortSide => port.side ?? (kind === "input" ? "left" : "right");
export const newId = (): string => crypto.randomUUID();
export const newBoard = (name = "新画板"): Board => ({ id: newId(), name, nodes: [], edges: [], viewport: null });
export const newNode = (title = "新卡片", x = 0, y = 0): DesignNode => ({ id: newId(), title, subtitle: "", position: { x, y }, visualStyle: "context", inputPorts: [{ id: newId(), name: "输入" }], outputPorts: [{ id: newId(), name: "输出" }] });
export function canConnect(board: Board, from: DesignNode, output: Port, to: DesignNode, input: Port): boolean {
  return board.edges.length < MAX_EDGES_PER_BOARD && from.id !== to.id
    && board.nodes.includes(from) && board.nodes.includes(to)
    && from.outputPorts.includes(output) && to.inputPorts.includes(input)
    && !board.edges.some(e => e.fromNodeId === from.id && e.fromPortId === output.id && e.toNodeId === to.id && e.toPortId === input.id);
}
export function connect(board: Board, from: DesignNode, output: Port, to: DesignNode, input: Port): boolean {
  if (!canConnect(board, from, output, to, input)) return false;
  board.edges.push({ id: newId(), fromNodeId: from.id, fromPortId: output.id, toNodeId: to.id, toPortId: input.id }); return true;
}
export function removeNode(board: Board, nodeId: string): void { board.nodes = board.nodes.filter(n => n.id !== nodeId); board.edges = board.edges.filter(e => e.fromNodeId !== nodeId && e.toNodeId !== nodeId); }
export function removePort(board: Board, node: DesignNode, portId: string): void { node.inputPorts = node.inputPorts.filter(p => p.id !== portId); node.outputPorts = node.outputPorts.filter(p => p.id !== portId); board.edges = board.edges.filter(e => e.fromPortId !== portId && e.toPortId !== portId); }
export function boardReferences(project: FlowDesignProject, boardId: string): { board: Board; node: DesignNode }[] {
  return project.boards.flatMap(board =>
    board.nodes.filter(node => node.childBoardId === boardId).map(node => ({ board, node })),
  );
}

export function referenceTargets(project: FlowDesignProject, source: Board): Board[] {
  if (!project.boards.includes(source)) return [];
  const parents = new Map<string, Set<string>>();
  for (const board of project.boards) {
    for (const node of board.nodes) {
      if (!node.childBoardId) continue;
      let incoming = parents.get(node.childBoardId);
      if (!incoming) parents.set(node.childBoardId, incoming = new Set());
      incoming.add(board.id);
    }
  }
  // Any board that can already reach the source would close a cycle.
  const excluded = new Set([source.id]);
  for (const id of excluded) {
    for (const parent of parents.get(id) ?? []) excluded.add(parent);
  }
  return project.boards.filter(board => !excluded.has(board.id));
}

export function linkBoard(project: FlowDesignProject, source: Board, node: DesignNode, targetId: string): void {
  if (!project.boards.includes(source) || !source.nodes.includes(node)) throw new Error("当前卡片已不存在。");
  if (!project.boards.some(board => board.id === targetId)) throw new Error("目标画板已不存在。");
  if (!referenceTargets(project, source).some(board => board.id === targetId)) throw new Error("关联会形成画板循环。");
  node.childBoardId = targetId;
}

export function removeBoard(project: FlowDesignProject, boardId: string): void {
  if (boardId === project.rootBoardId) throw new Error("不能删除根画板。");
  if (boardReferences(project, boardId).length) throw new Error("请先解除指向此画板的节点组关联。");
  project.boards = project.boards.filter(b => b.id !== boardId);
}

export function copyNode(project: FlowDesignProject, board: Board, original: DesignNode): DesignNode {
  if (board.nodes.length >= MAX_NODES_PER_BOARD) throw new Error("当前画板的卡片数已达上限。");
  const sources = new Map(project.boards.map(source => [source.id, source]));
  const copies = new Map<string, Board>();

  function cloneBoard(sourceId: string): Board {
    const existing = copies.get(sourceId);
    if (existing) return existing;
    const source = sources.get(sourceId);
    if (!source) throw new Error("找不到节点组引用的画板。");
    if (project.boards.length + copies.size >= MAX_BOARDS) throw new Error("工程画板数已达上限，无法完成复制。");
    const result = newBoard(`${source.name.slice(0, 117)} 副本`);
    copies.set(sourceId, result);
    result.viewport = source.viewport ? { ...source.viewport } : null;
    const nodeIds = new Map<string, string>();
    const portIds = new Map<string, string>();
    result.nodes = source.nodes.map(node => clone(node, nodeIds, portIds));
    result.edges = source.edges.map(edge => ({
      ...edge,
      id: newId(),
      fromNodeId: nodeIds.get(edge.fromNodeId)!,
      fromPortId: portIds.get(edge.fromPortId)!,
      toNodeId: nodeIds.get(edge.toNodeId)!,
      toPortId: portIds.get(edge.toPortId)!,
      ...(edge.appearance && { appearance: { ...edge.appearance } }),
    }));
    return result;
  }
  function clone(node: DesignNode, nodeIds: Map<string, string>, portIds: Map<string, string>): DesignNode {
    const id = newId();
    nodeIds.set(node.id, id);
    const clonePorts = (ports: Port[]) => ports.map(port => {
      const id = newId();
      portIds.set(port.id, id);
      return { ...port, id };
    });
    const result: DesignNode = {
      ...node, id, position: { ...node.position },
      inputPorts: clonePorts(node.inputPorts), outputPorts: clonePorts(node.outputPorts),
    };
    if (node.childBoardId) result.childBoardId = cloneBoard(node.childBoardId).id;
    return result;
  }
  const result = clone(original, new Map(), new Map());
  result.position.x = Math.min(99000, result.position.x + 32);
  result.position.y = Math.min(99000, result.position.y + 32);
  project.boards.push(...copies.values());
  board.nodes.push(result);
  return result;
}
export function exampleProject(): FlowDesignProject {
  const main = newBoard("主流程"), child = newBoard("上下文");
  const specs: [string, number, number, string][] = [["QQ 消息", 20, 20, "input"], ["Web 对话", 20, 200, "input"], ["上下文", 320, 110, "context"], ["Skill", 620, 110, "prompt"], ["Tool 可用性", 920, 110, "tool"], ["Tool 调用与审批", 1220, 110, "tool"], ["Web 回复", 1520, 20, "output"], ["QQ 回复", 1520, 200, "output"]];
  main.nodes = specs.map(([title,x,y,style]) => { const n = newNode(title,x,y); n.visualStyle = style; return n; }); main.nodes[2]!.childBoardId = child.id;
  for (const [a,b] of [[0,2],[1,2],[2,3],[3,4],[4,5],[5,6],[5,7]]) connect(main, main.nodes[a!]!, main.nodes[a!]!.outputPorts[0]!, main.nodes[b!]!, main.nodes[b!]!.inputPorts[0]!);
  child.nodes = [["输入：QQ 上下文",0,0],["输入：Web 上下文",0,180],["上下文总结",300,90],["全局上下文池",600,90],["输出：模型",900,90]].map(([title,x,y]) => newNode(String(title),Number(x),Number(y)));
  for (const [a,b] of [[0,2],[1,2],[2,3],[3,4]]) connect(child, child.nodes[a!]!, child.nodes[a!]!.outputPorts[0]!, child.nodes[b!]!, child.nodes[b!]!.inputPorts[0]!);
  return { schemaVersion: 1, projectId: newId(), projectName: "Stardust 设计工程", rootBoardId: main.id, boards: [main, child] };
}

/** Validate untrusted design data before it reaches the editor or persistent storage. */
export function parseProject(value: unknown): FlowDesignProject {
  const fail = (): never => { throw new Error("工程格式无效、引用错误或超出限制。"); };
  const obj = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : fail();
  const str = (v: unknown, max = 120): string => typeof v === "string" && v.length > 0 && v.length <= max ? v : fail();
  const text = (v: unknown): string => typeof v === "string" && v.length <= 500 ? v : fail();
  const num = (v: unknown): number => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 100000 ? v : fail();
  const arr = (v: unknown, max: number): unknown[] => Array.isArray(v) && v.length <= max ? v : fail();
  const option = <T extends string>(v: unknown, allowed: readonly T[]): T | undefined => {
    if (v === undefined) return undefined;
    return allowed.find(item => item === v) ?? fail();
  };
  const allIds = new Set<string>(); const unique = (v: unknown) => { const s = str(v); if (allIds.has(s)) fail(); allIds.add(s); return s; };
  const p = obj(value); if (p.schemaVersion !== 1) throw new Error("不支持的工程版本。");
  const projectId = unique(p.projectId), projectName = str(p.projectName), rootBoardId = str(p.rootBoardId);
  const boards: Board[] = arr(p.boards, MAX_BOARDS).map(raw => {
    const b = obj(raw), boardId = unique(b.id), name = str(b.name);
    let viewport: Viewport | null = null;
    if (b.viewport !== null) { const v = obj(b.viewport); const scale = num(v.scale); if (scale < .12 || scale > 2) fail(); viewport = { x: num(v.x), y: num(v.y), scale }; }
    const nodes: DesignNode[] = arr(b.nodes, MAX_NODES_PER_BOARD).map(rawNode => {
      const n = obj(rawNode), position = obj(n.position), childBoardId = n.childBoardId === undefined ? undefined : str(n.childBoardId);
      const ports = (rawPorts: unknown) => arr(rawPorts, MAX_PORTS_PER_KIND).map(rawPort => {
        const port = obj(rawPort), side = option(port.side, PORT_SIDES);
        return { id: unique(port.id), name: text(port.name), ...(side && { side }) };
      });
      const result: DesignNode = { id: unique(n.id), title: str(n.title), subtitle: text(n.subtitle), position: { x: num(position.x), y: num(position.y) }, visualStyle: str(n.visualStyle), inputPorts: ports(n.inputPorts), outputPorts: ports(n.outputPorts) };
      if (!["input", "context", "prompt", "model", "tool", "output"].includes(result.visualStyle)) fail();
      if (childBoardId) result.childBoardId = childBoardId; return result;
    });
    const edges: DesignEdge[] = arr(b.edges, MAX_EDGES_PER_BOARD).map(rawEdge => {
      const e = obj(rawEdge);
      const result: DesignEdge = {
        id: unique(e.id), fromNodeId: str(e.fromNodeId), fromPortId: str(e.fromPortId),
        toNodeId: str(e.toNodeId), toPortId: str(e.toPortId),
      };
      if (e.appearance !== undefined) {
        const appearance = obj(e.appearance);
        const lineStyle = option(appearance.lineStyle, LINE_STYLES), pathStyle = option(appearance.pathStyle, PATH_STYLES);
        result.appearance = { ...(lineStyle && { lineStyle }), ...(pathStyle && { pathStyle }) };
      }
      const semantic = option(e.semantic, EDGE_SEMANTICS);
      if (semantic) result.semantic = semantic;
      return result;
    });
    const pairs = new Set<string>();
    for (const e of edges) { const from = nodes.find(n => n.id === e.fromNodeId), to = nodes.find(n => n.id === e.toNodeId); const key = JSON.stringify([e.fromNodeId,e.fromPortId,e.toNodeId,e.toPortId]); if (!from || !to || from === to || !from.outputPorts.some(q => q.id === e.fromPortId) || !to.inputPorts.some(q => q.id === e.toPortId) || pairs.has(key)) fail(); pairs.add(key); }
    return { id: boardId, name, nodes, edges, viewport };
  });
  const byId = new Map(boards.map(board => [board.id, board]));
  if (!byId.has(rootBoardId)) fail();
  const visited = new Set<string>();
  const active = new Set<string>();
  function visit(boardId: string): void {
    if (active.has(boardId)) throw new Error("工程包含循环画板引用。");
    if (visited.has(boardId)) return;
    const board = byId.get(boardId) ?? fail();
    active.add(boardId);
    for (const node of board.nodes) {
      if (node.childBoardId) visit(node.childBoardId);
    }
    active.delete(boardId);
    visited.add(boardId);
  }
  for (const board of boards) visit(board.id);
  return { schemaVersion: 1, projectId, projectName, rootBoardId, boards };
}
