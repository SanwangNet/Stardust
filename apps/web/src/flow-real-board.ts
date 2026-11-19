import { openDesignBoard } from "./flow-design-board.js";

type Connections = { recent: boolean; global: boolean; search: boolean };
type Edge = { from: { node: string; port: string }; to: { node: string; port: string } };
type Graph = { id: string; nodes: { id: string; type: string; graphId?: string }[]; edges: Edge[]; interface: { inputs: { id: string; label?: string }[]; outputs: { id: string; label?: string }[] } };
type CatalogEntry = { owner: string; name: string; status: string; runtime: string; executable?: boolean; requestChain?: boolean; flowSwitch?: boolean; warnings: string[]; interfaces: { groupId: string; graphId: string; inputs: { id: string; node: string; type: string; required: boolean; label: string }[]; outputs: { id: string; node: string; type: string; required: boolean; label: string }[] }[]; contract: null | { nodes: { id: string; name: string; description: string; executable: boolean; inputs: Record<string, { type: string; required?: boolean }>; outputs: Record<string, { type: string }> }[]; groups: { id: string; name: string; description: string; flow: { rootId: string; graphs: Graph[] } }[] } };
type Payload = { canEdit: boolean; editableConnections: { context: boolean; tools: boolean }; revision: string; draft: Connections; currentConnections: Connections; published: { id: string; connections: Connections }; active: { context: boolean; tools: boolean; execution: boolean; skill: boolean }; catalog: CatalogEntry[]; overview: { description: string; publishedInUse: boolean; references: { skill: string; detail: { context: string | null; availability: string | null; execution: string | null; skill: string | null } }; states: { webAvailable: boolean; contextSwitch: boolean; toolSwitch: boolean; executionSwitch: boolean; skillSwitch: boolean; toolSupported: boolean; availableSkills: number }; nodes: VisibleNode[]; edges: VisibleEdge[] }; toolCandidates: { name: string; status: string }[]; skills: { id: string; owner: string; name: string; description: string; enabled: boolean; available: boolean; trusted: boolean; status: string }[]; graphs: { context: { graphs: Graph[] }; tools: { graphs: Graph[] }; execution: { graphs: Graph[] }; skill: { graphs: Graph[] } } };
type VisibleNode = { id: string; title: string; subtitle: string; x: number; y: number; next?: string; state?: string; description?: string; kind?: string };
type VisibleEdge = { from: string; to: string; label: string; editable?: keyof Connections; relation?: string };

const titles: Record<string, string> = { input: "输入", output: "输出", current: "当前消息", recent: "近期上下文", global: "全局上下文", assembler: "上下文组装器", search: "search_history", extensions: "已注册扩展 Tool", filter: "可用性与范围过滤", validate: "参数校验", permission: "权限检查", approval: "等待确认", executor: "Tool 执行", result: "Tool Result" };
const endpoints: Record<keyof Connections, { graph: string; from: string; fromPort: string; to: string; toPort: string }> = {
  recent: { graph: "web-context", from: "recent", fromPort: "value", to: "assembler", toPort: "recent" },
  global: { graph: "web-context", from: "global", fromPort: "value", to: "assembler", toPort: "global" },
  search: { graph: "availability", from: "search", fromPort: "value", to: "filter", toPort: "search" },
};

/** The composition is locally readable; editing requires a trusted local connection. */
export async function initializeRealFlowBoard(root: HTMLElement): Promise<boolean> {
  let response: Response;
  try { response = await fetch("/api/v1/flow-overview", { cache: "no-store" }); } catch { root.textContent = "无法读取服务端流程。"; return true; }
  if (!response.ok) {
    root.textContent = "流程总览仅在初始化完成后通过本机访问。"; return true;
  }
  let data = await response.json() as Payload, draft = { ...data.draft }, dirty = false, validated = false, previewPublished = false, current = "overview";
  let catalog: CatalogEntry[] = data.catalog;
  const positions = new Map<string, Map<string, { x: number; y: number }>>();
  let scale = 1, panX = 30, panY = 80;
  root.className = "flow-board is-real";
  root.innerHTML = `<header class="flow-toolbar"><div class="flow-heading"><h2>可视化流程</h2><p class="flow-real-status" role="status"></p></div><div class="flow-controls"><button data-act="preview">查看已发布版本</button><button data-act="save">保存草稿</button><button data-act="validate">校验</button><button data-act="publish">发布</button><button data-act="reset">恢复默认草稿</button><button data-act="fit">适应视图</button></div></header><nav class="flow-path" aria-label="流程路径"></nav><div class="flow-content"><div class="flow-canvas-wrap"><div class="flow-canvas" tabindex="0" aria-label="流程画板：拖动空白处平移，滚轮缩放"><div class="flow-world"><svg class="flow-wires"><defs><marker id="real-flow-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" /></marker></defs></svg><div class="flow-nodes"></div></div></div><div class="flow-hud"><span>拖动平移 · 滚轮缩放</span><span class="flow-zoom"></span><button data-act="minus">−</button><button data-act="plus">＋</button></div></div></div><div class="flow-footer"><span class="flow-real-detail"></span><span class="flow-real-legend">虚线：只读模块关系 · 实线：子图连接 · 粗紫线：可编辑连接</span></div>`;
  const el = <T extends Element>(query: string) => root.querySelector<T>(query)!;
  const canvas = el<HTMLElement>(".flow-canvas"), world = el<HTMLElement>(".flow-world"), nodesEl = el<HTMLElement>(".flow-nodes"), wires = el<SVGSVGElement>(".flow-wires"), path = el<HTMLElement>(".flow-path"), status = el<HTMLElement>(".flow-real-status"), detail = el<HTMLElement>(".flow-real-detail");
  wires.setAttribute("viewBox", "-10000 -10000 20000 20000");
  const message = (text: string) => { detail.textContent = text; };
  const designButton = document.createElement("button");
  designButton.type = "button"; designButton.textContent = "设计草稿";
  el<HTMLElement>(".flow-controls").prepend(designButton);
  designButton.addEventListener("click", () => {
    const original = Array.from(root.children) as HTMLElement[];
    original.forEach(child => { child.hidden = true; });
    const designRoot = document.createElement("div"); designRoot.className = "flow-design"; root.append(designRoot);
    const overviewPositions = positions.get("overview");
    openDesignBoard(designRoot, () => ({
      nodes: data.overview.nodes.map(node => ({ id: node.id, title: node.title, subtitle: node.subtitle, kind: node.kind ?? "context", x: overviewPositions?.get(node.id)?.x ?? node.x, y: overviewPositions?.get(node.id)?.y ?? node.y })),
      edges: data.overview.edges.map(edge => ({ from: edge.from, to: edge.to })),
    }), () => { designRoot.remove(); original.forEach(child => { child.hidden = false; }); });
  });
  function updateStatus(): void {
    const changed = JSON.stringify(draft) !== JSON.stringify(data.published.connections);
    const short = (value: string) => value.length > 16 ? `${value.slice(0, 8)}…` : value;
    status.textContent = `${data.canEdit ? previewPublished ? "正在查看已发布版本（只读）" : dirty ? "未保存草稿" : validated ? "草稿校验通过" : changed ? "草稿未发布" : "草稿与已发布版本一致" : "只读 · 当前连接未通过本机写入检查"} · 发布版本 ${short(data.published.id)} · ${data.overview.publishedInUse ? "已应用于开启的图" : "发布连接未生效"}${data.canEdit ? ` · Revision ${short(data.revision)}` : ""}`;
    status.title = `发布版本 ${data.published.id}${data.canEdit ? ` · Revision ${data.revision}` : ""}`;
    for (const action of ["preview", "save", "validate", "publish", "reset"]) el<HTMLButtonElement>(`[data-act="${action}"]`).hidden = !data.canEdit;
    el<HTMLButtonElement>('[data-act="preview"]').textContent = previewPublished ? "返回草稿" : "查看已发布版本";
    detail.textContent = current === "overview" ? `${data.overview.description} Global Context 后台综合与同步读取分开；Tool 仅在模型调用时执行。` : `当前配置：上下文图 ${data.active.context ? "开" : "关"}；Tool 可用性图 ${data.active.tools ? "开" : "关"}；Tool 执行图 ${data.active.execution ? "开" : "关"}；Skill 图 ${data.active.skill ? "开" : "关"}。`;
  }
  function graphs(): (Graph | undefined)[] { const refs = data.overview.references.detail; return [data.graphs.context.graphs.find(g => g.id === refs.context), data.graphs.tools.graphs.find(g => g.id === refs.availability), data.graphs.execution.graphs.find(g => g.id === refs.execution)]; }
  function view(): { nodes: VisibleNode[]; edges: VisibleEdge[] } {
    if (current === "overview") return { nodes: data.overview.nodes, edges: data.overview.edges };
    if (current === "context") return { nodes: [
      { id: "web-context", title: "Web 上下文", subtitle: "近期消息与全局摘要", state: graphs()[0] ? data.overview.nodes.find(node => node.id === "context")?.state : "图定义不可用", description: "进入当前服务端 Web 上下文执行图；仅已授权连接可发布。", x: 50, y: 100, ...(graphs()[0] ? { next: "web-context" } : {}) },
      { id: "background", title: "后台摘要综合", subtitle: "完成后异步处理", state: "独立任务 · 非同步节点", description: "已完成的 Web 对话可排入后台综合；断开全局摘要读取不会停止后台更新。", x: 380, y: 100, kind: "note" },
      { id: "qq-context", title: "QQ 上下文", subtitle: "当前消息", state: "未接入 Web 会话与记忆", description: "QQ 当前使用本次消息和主 Agent 提示词。", x: 710, y: 100, kind: "note" },
    ], edges: [] };
    if (current === "tools") return { nodes: [{ id: "availability", title: "Tool 可用性", subtitle: "模型请求前准备", state: graphs()[1] ? data.overview.nodes.find(node => node.id === "tools")?.state : "图定义不可用", x: 50, y: 60, ...(graphs()[1] ? { next: "availability" } : {}) }, { id: "execution", title: "Tool 调用与审批", subtitle: "模型按需调用后", state: graphs()[2] ? data.overview.nodes.find(node => node.id === "tool-call")?.state : "图定义不可用", x: 420, y: 60, ...(graphs()[2] ? { next: "execution" } : {}) }, ...data.toolCandidates.map((tool, index) => ({ id: `tool-candidate-${index}`, title: tool.name, subtitle: "Core 注册候选", state: tool.status, description: "由服务端根据当前注册、开关和权限配置推算；实际请求仍会复核。", kind: "note", x: 50 + index * 290, y: 290 }))], edges: [] };
    if (current === "skill" || current === "skill-stages") {
      const skillGraphId = current === "skill" ? data.overview.references.skill : data.overview.references.detail.skill;
      const graph = data.graphs.skill.graphs.find(item => item.id === skillGraphId);
      if (!graph) return { nodes: [{ id: "unavailable", title: "Skill 图不可用", subtitle: "服务端图定义缺失", state: "无法导航或执行", kind: "note", x: 50, y: 100 }], edges: [] };
      const stageNames: Record<string, string> = { stages: "Skill 处理", discover: "Skill 候选发现", select: "适用性选择", scope: "范围过滤", load: "Skill 内容加载", budget: "预算处理" };
      const visual: VisibleNode[] = graph.nodes.map((node, index) => {
        const match = /^candidate-(\d+)$/.exec(node.id), skill = match ? data.skills[Number(match[1])] : undefined;
        return { id: node.id, title: node.id === "input" ? "输入" : node.id === "output" ? "输出" : skill?.name ?? stageNames[node.id] ?? node.id,
          subtitle: node.id === "input" ? graph.interface.inputs[0]?.label ?? "" : node.id === "output" ? graph.interface.outputs[0]?.label ?? "" : skill ? `星核 · ${skill.owner}` : "Skill 执行图",
          state: skill ? skill.status === "incompatible" ? "已声明 · 契约不兼容" : !skill.trusted ? "已声明 · 未绑定可信加载器" : !skill.enabled ? "已注册 · 已停用" : skill.available ? "已注册 · 可用" : "已注册 · 当前不可用" : node.id === "input" || node.id === "output" || node.graphId ? "接口 / 结构 · 只读" : !data.overview.states.webAvailable ? "已绑定 · Web 星核不可用" : data.active.skill ? "已绑定 · 接入 Web 请求" : "已绑定 · 开关关闭",
          description: skill?.description, x: 50 + index * 290, y: 140, ...(node.graphId && node.id === "stages" && data.overview.references.detail.skill ? { next: "skill-stages" } : {}) };
      });
      if (current === "skill") visual.push({ id: "skill-injection", title: "模型请求注入", subtitle: "由现有 Web 会话链完成", state: !data.overview.states.webAvailable ? "Web 星核不可用" : data.active.skill ? "路径开启 · 仅非空结果注入" : "Skill 图开关关闭", description: "这是现有会话链中的请求准备步骤，不是 Skill 图内的执行节点；本页不显示请求级选中状态。", kind: "note", x: 50 + graph.nodes.length * 290, y: 140 });
      return { nodes: visual, edges: graph.edges.map(edge => ({ from: edge.from.node, to: edge.to.node, label: `${edge.from.port} → ${edge.to.port}` })) };
    }
    if (current === "starcores") {
      const nodes: VisibleNode[] = [];
      for (const entry of catalog) {
        if (!entry.contract) nodes.push({ id: entry.owner, title: entry.name, subtitle: `星核 · ${entry.owner}`, state: "协议不兼容 · 不可执行", description: entry.warnings.join("；"), x: 50 + nodes.length * 300, y: 100 });
        for (const group of entry.contract?.groups ?? []) nodes.push({ id: `${entry.owner}:${group.id}`, title: group.name, subtitle: `星核 · ${entry.owner}`, state: (entry.status === "enabled" ? entry.runtime === "connected" ? entry.owner === "qq-bot" ? entry.requestChain ? "已注册 · 可执行 · 已接入 QQ 请求" : "已注册 · 可执行 · 未接入 QQ 请求" : "已启用 · 只读声明" : "已启用但未连接 · 声明只读" : entry.status === "disabled" ? "星核已停用 · 不可执行" : entry.status === "uninstalled" ? "星核未安装 · 不可执行" : "协议不兼容 · 不可执行") + (entry.owner === "qq-bot" ? entry.flowSwitch ? " · 开关开启" : " · 开关关闭" : ""), description: group.description, x: 50 + nodes.length * 300, y: 100, next: `catalog/${entry.owner}/${group.id}/${group.flow.rootId}` });
      }
      return { nodes, edges: [] };
    }
    if (current.startsWith("catalog/")) {
      const [, owner, groupId, graphId] = current.split("/");
      const entry = catalog.find(item => item.owner === owner), group = entry?.contract?.groups.find(item => item.id === groupId), graph = group?.flow.graphs.find(item => item.id === graphId);
      if (!entry || !group || !graph) return { nodes: [], edges: [] };
      const visual: VisibleNode[] = graph.nodes.map((node, index) => {
        const definition = entry.contract?.nodes.find(item => item.id === node.type);
        const child = node.graphId ? group.flow.graphs.find(item => item.id === node.graphId) : undefined;
        const resolved = entry.interfaces.find(item => item.groupId === groupId && item.graphId === (child?.id ?? graph.id));
        const ports = child && resolved ? [...resolved.inputs.map(p => `输入 ${p.id}:${p.type}${p.required ? " 必需" : " 可选"} · ${p.label}`), ...resolved.outputs.map(p => `输出 ${p.id}:${p.type} · ${p.label}`)].join("；") : definition ? [...Object.entries(definition.inputs).map(([id, port]) => `输入 ${id}:${port.type}${port.required ? " 必需" : " 可选"}`), ...Object.entries(definition.outputs).map(([id, port]) => `输出 ${id}:${port.type}`)].join("；") : resolved ? [...resolved.inputs.filter(p => p.node === node.id).map(p => `输入 ${p.id}:${p.type}${p.required ? " 必需" : " 可选"} · ${p.label}`), ...resolved.outputs.filter(p => p.node === node.id).map(p => `输出 ${p.id}:${p.type} · ${p.label}`)].join("；") : "";
        const interfaceNode = node.type === "input" || node.type === "output";
        return { id: node.id, title: node.type === "input" ? "输入" : node.type === "output" || node.type.endsWith(":json-output") ? "输出" : definition?.name ?? (node.type === "group" ? "节点组" : node.type),
          subtitle: node.type === "input" ? graph.interface.inputs[0]?.label ?? "" : node.type === "output" || node.type.endsWith(":json-output") ? graph.interface.outputs[0]?.label ?? "" : `星核 · ${owner}`,
          state: entry.status !== "enabled" || (entry.owner === "web-chat" ? !data.overview.states.webAvailable : entry.runtime !== "connected") ? "星核不可用 · 不可执行" : definition?.executable ? entry.owner === "qq-bot" ? entry.requestChain ? "Core 已绑定 · QQ 请求执行" : "Core 已绑定 · 开关关闭" : entry.owner === "web-chat" ? data.overview.states.contextSwitch && data.overview.states.webAvailable ? "Core 已绑定 · Web 图开关开启" : "Core 已绑定 · Web 图未生效" : "Core 路径已绑定 · 声明只读" : interfaceNode || node.type === "group" || node.type === "pass" ? "接口 / 结构 · 只读" : "说明节点 · 不可执行",
          description: [definition?.description ?? group.description, ports, ...entry.warnings].filter(Boolean).join(" · "), x: 50 + index * 290, y: node.id === "recent" ? 20 : node.id === "global" ? 260 : 140,
          ...(node.graphId ? { next: `catalog/${owner}/${groupId}/${node.graphId}` } : {}) };
      });
      return { nodes: visual, edges: graph.edges.map(edge => ({ from: edge.from.node, to: edge.to.node, label: `${edge.from.port} → ${edge.to.port}` })) };
    }
    const graph = graphs()[current === "web-context" ? 0 : current === "availability" ? 1 : 2];
    if (!graph) return { nodes: [{ id: "unavailable", title: "执行图不可用", subtitle: "服务端图定义缺失", state: "无法导航或执行", kind: "note", x: 50, y: 100 }], edges: [] };
    const graphState = current === "web-context" ? data.overview.nodes.find(node => node.id === "context")?.state : current === "availability" ? data.overview.nodes.find(node => node.id === "tools")?.state : data.overview.nodes.find(node => node.id === "tool-call")?.state;
    const visual: VisibleNode[] = graph.nodes.map((n, i) => ({ id: n.id, title: titles[n.id] ?? n.id, subtitle: n.id === "input" ? graph.interface.inputs[0]?.label ?? n.type : n.id === "output" ? graph.interface.outputs[0]?.label ?? n.type : n.type, state: n.id === "input" || n.id === "output" ? "组接口 · 只读" : graphState, x: 50 + i * 290, y: (n.id === "recent" || n.id === "search") ? 20 : n.id === "global" || n.id === "extensions" ? 260 : 140 }));
    const edges: VisibleEdge[] = graph.edges.filter(e => !Object.values(endpoints).some(p => p.graph === current && p.from === e.from.node && p.to === e.to.node && p.toPort === e.to.port)).map(e => ({ from: e.from.node, to: e.to.node, label: `${e.from.port} → ${e.to.port}` }));
    const connections = !data.canEdit ? data.currentConnections : previewPublished ? data.published.connections : draft;
    for (const key of Object.keys(endpoints) as (keyof Connections)[]) { const p = endpoints[key], managed = key === "search" ? data.editableConnections.tools : data.editableConnections.context; const connected = managed ? connections[key] : data.currentConnections[key]; if (p.graph === current && connected) edges.push({ from: p.from, to: p.to, label: `${p.fromPort} → ${p.toPort}`, ...(!previewPublished && data.canEdit && managed ? { editable: key } : {}) }); }
    return { nodes: visual, edges };
  }
  function draw(): void { world.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`; el<HTMLElement>(".flow-zoom").textContent = `${Math.round(scale * 100)}%`; }
  function render(): void {
    const { nodes, edges } = view(); let map = positions.get(current);
    if (!map) {
      map = new Map();
      try {
        const saved: unknown = JSON.parse(localStorage.getItem(`stardust.realflow.layout.${current}`) ?? "{}");
        if (saved && typeof saved === "object" && !Array.isArray(saved)) for (const [id, value] of Object.entries(saved)) {
          if (value && typeof value === "object" && "x" in value && "y" in value && typeof value.x === "number" && typeof value.y === "number" && Number.isFinite(value.x) && Number.isFinite(value.y) && Math.abs(value.x) < 100000 && Math.abs(value.y) < 100000) map.set(id, { x: value.x, y: value.y });
        }
      } catch { /* Layout is only a local visual preference. */ }
      positions.set(current, map);
    }
    for (const n of nodes) if (!map.has(n.id)) map.set(n.id, { x: n.x, y: n.y });
    nodesEl.replaceChildren(); wires.querySelectorAll(".flow-wire, .flow-wire-label").forEach(n => n.remove());
    for (const edge of edges) {
      const a = map.get(edge.from), b = map.get(edge.to); if (!a || !b) continue;
      const wire = document.createElementNS("http://www.w3.org/2000/svg", "path"); wire.classList.add("flow-wire");
      wire.dataset.from = edge.from; wire.dataset.to = edge.to;
      if (edge.relation) { wire.classList.add("is-dependency"); wire.dataset.relation = edge.relation; }
      if (edge.editable) { wire.classList.add("is-draft"); wire.dataset.editable = edge.editable; }
      const targetPorts = Object.values(endpoints).filter(p => p.graph === current && p.to === edge.to);
      const targetIndex = edge.editable ? targetPorts.findIndex(p => p.toPort === endpoints[edge.editable!].toPort) : -1;
      const targetY = targetIndex < 0 ? 63 : 42 + targetIndex * 40;
      const vertical = Math.abs(a.x - b.x) < 10 && Math.abs(a.y - b.y) > 150;
      const reverse = vertical && a.y > b.y, offset = reverse ? 24 : -24;
      const backwards = a.x > b.x, startX = backwards ? a.x : a.x + 234, endX = backwards ? b.x + 234 : b.x;
      const cycleOffset = edge.from === "web-model" && edge.to === "tool-call" ? -20 : edge.from === "tool-call" && edge.to === "web-model" ? 20 : 0;
      const d = vertical ? `M ${a.x + 117 + offset} ${a.y + (reverse ? 0 : 126)} L ${b.x + 117 + offset} ${b.y + (reverse ? 126 : 0)}` : `M ${startX} ${a.y + 63 + cycleOffset} C ${startX + (backwards ? -100 : 100)} ${a.y + 63 + cycleOffset}, ${endX + (backwards ? 100 : -100)} ${b.y + targetY + cycleOffset}, ${endX} ${b.y + targetY + cycleOffset}`;
      wire.setAttribute("d", d); wire.setAttribute("marker-end", "url(#real-flow-arrow)");
      const title = document.createElementNS("http://www.w3.org/2000/svg", "title"); title.textContent = `${edge.label}${edge.relation ? " · 模块关系，只读" : edge.editable ? " · 点击断开" : " · 只读执行连接"}`; wire.append(title); wires.append(wire);
      if (edge.relation && (edge.relation === "conditional" || edge.relation === "data")) {
        const label = document.createElementNS("http://www.w3.org/2000/svg", "text"); label.classList.add("flow-wire-label");
        label.setAttribute("x", String(vertical ? a.x + 117 + offset + 8 : (startX + endX) / 2));
        label.setAttribute("y", String(vertical ? (a.y + b.y + 126) / 2 + (reverse ? 14 : -8) : (a.y + b.y) / 2 + 55 + cycleOffset));
        label.textContent = edge.label; wires.append(label);
      }
    }
    for (const n of nodes) {
      const p = map.get(n.id)!; const node = document.createElement("button"); node.type = "button"; const kind = n.kind === "channel" ? "input" : n.kind === "model" ? "model" : n.kind === "output" ? "output" : n.kind === "group" ? "prompt" : "context"; node.className = `flow-node kind-${kind}${n.kind === "note" ? " is-readonly-note" : ""}`; node.dataset.node = n.id; if (n.next) node.dataset.next = n.next;
      node.style.transform = `translate(${p.x}px, ${p.y}px)`;
      const head = document.createElement("span"); head.className = "flow-node-head"; head.textContent = n.next ? "节点组 · 双击进入" : n.kind === "note" || current === "overview" ? "只读说明" : n.id === "input" || n.id === "output" ? "组接口" : current.startsWith("catalog/") ? "星核节点" : "执行节点 · 只读";
      const title = document.createElement("strong"); title.className = "flow-node-title"; title.textContent = n.title;
      const sub = document.createElement("span"); sub.className = "flow-node-subtitle"; sub.textContent = n.subtitle;
      const state = document.createElement("span"); state.className = "flow-node-state"; state.textContent = n.state ?? `ID: ${n.id}`;
      if (n.description) node.title = n.description;
      node.append(head, title, sub, state);
      const editable = (key: keyof Connections) => key === "search" ? data.editableConnections.tools : data.editableConnections.context;
      if (data.canEdit && !previewPublished && (Object.keys(endpoints) as (keyof Connections)[]).some(key => editable(key) && endpoints[key].graph === current && endpoints[key].from === n.id)) { const marker = document.createElement("span"); marker.className = "flow-port is-output"; marker.dataset.out = n.id; marker.dataset.port = "value"; marker.title = "输出端口 value：拖动到对应输入端口"; node.append(marker); }
      if (data.canEdit && !previewPublished) (Object.keys(endpoints) as (keyof Connections)[]).filter(key => editable(key) && endpoints[key].graph === current && endpoints[key].to === n.id).forEach((key, index) => { const p = endpoints[key]; const marker = document.createElement("span"); marker.className = "flow-port is-input"; marker.dataset.in = n.id; marker.dataset.port = p.toPort; marker.style.top = `${36 + index * 40}px`; marker.title = `输入端口 ${p.toPort}`; node.append(marker); });
      nodesEl.append(node);
    }
    path.replaceChildren(); let parts = current === "overview" ? ["overview"] : current === "starcores" ? ["overview", "starcores"] : current.startsWith("catalog/") ? ["overview", "starcores"] : current === "skill" || current === "skill-stages" ? ["overview", "skill", ...(current === "skill-stages" ? ["skill-stages"] : [])] : current === "context" || current === "web-context" ? ["overview", "context", ...(current === "web-context" ? ["web-context"] : [])] : ["overview", ...(current === "tools" ? ["tools"] : ["tools", current])];
    if (current.startsWith("catalog/")) {
      const [, owner, groupId, graphId] = current.split("/"); const group = catalog.find(e => e.owner === owner)?.contract?.groups.find(g => g.id === groupId);
      const chain: string[] = []; let graph = graphId;
      while (graph && group && !chain.includes(graph)) { chain.unshift(graph); graph = group.flow.graphs.find(g => g.nodes.some(node => node.graphId === graph))?.id; }
      parts = [...parts, ...chain.map(id => `catalog/${owner}/${groupId}/${id}`)];
    }
    for (const id of parts) { if (path.childElementCount) path.append(" / "); const b = document.createElement("button"); b.dataset.nav = id; b.textContent = ({ overview: "主流程", context: "上下文", "web-context": "Web 上下文", skill: "Skill", "skill-stages": "Skill 处理", tools: "Tool", availability: "Tool 可用性", execution: "Tool 调用与审批", starcores: "星核流程" } as Record<string,string>)[id] ?? id.split("/").at(-1)!; path.append(b); }
    draw(); updateStatus();
  }
  function fit(): void { const map = positions.get(current); if (!map?.size) return; const ps = view().nodes.map(node => map.get(node.id)).filter((point): point is { x: number; y: number } => !!point); if (!ps.length) return; const left = Math.min(0, ...ps.map(p => p.x)), top = Math.min(0, ...ps.map(p => p.y)), right = Math.max(...ps.map(p => p.x + 234)), bottom = Math.max(...ps.map(p => p.y + 126)); const minimum = canvas.clientWidth < 700 ? .6 : .35; scale = Math.min(1, Math.max(minimum, Math.min((canvas.clientWidth - 60) / (right - left + 20), (canvas.clientHeight - 60) / (bottom - top + 20)))); panX = 20 - left * scale; panY = 20 - top * scale; draw(); }
  let lastClick: { id: string; time: number } | undefined;
  let drag: { node?: string; out?: string; x: number; y: number; ox: number; oy: number } | undefined;
  canvas.addEventListener("pointerdown", e => { const target = e.target as HTMLElement; if (target.closest(".flow-wire")) return; const node = target.closest<HTMLElement>("[data-node]"); const point = node?.dataset.node ? positions.get(current)?.get(node.dataset.node) : undefined; drag = { node: node?.dataset.node, out: target.dataset.out, x: e.clientX, y: e.clientY, ox: point?.x ?? panX, oy: point?.y ?? panY }; canvas.setPointerCapture(e.pointerId); e.preventDefault(); });
  canvas.addEventListener("pointermove", e => { if (!drag || drag.out) return; if (drag.node) { positions.get(current)?.set(drag.node, { x: drag.ox + (e.clientX - drag.x) / scale, y: drag.oy + (e.clientY - drag.y) / scale }); render(); } else { panX = drag.ox + e.clientX - drag.x; panY = drag.oy + e.clientY - drag.y; draw(); } });
  canvas.addEventListener("pointerup", e => {
    if (drag?.out) { const input = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>("[data-in]"); const key = (Object.keys(endpoints) as (keyof Connections)[]).find(k => endpoints[k].graph === current && endpoints[k].from === drag?.out && endpoints[k].to === input?.dataset.in && endpoints[k].toPort === input.dataset.port); if (key) { draft[key] = true; dirty = true; validated = false; render(); } else message("只能重新连接标记的端口。"); }
    else if (drag?.node && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 4) {
      const next = nodesEl.querySelector<HTMLElement>(`[data-node="${drag.node}"]`)?.dataset.next;
      if (next && lastClick?.id === drag.node && Date.now() - lastClick.time < 400) { current = next; lastClick = undefined; render(); fit(); if (next === "starcores") void refreshCatalog(); }
      else { lastClick = { id: drag.node, time: Date.now() }; const item = view().nodes.find(n => n.id === drag?.node); if (item?.description) message(item.description); }
    }
    if (drag?.node && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) >= 4) {
      try { localStorage.setItem(`stardust.realflow.layout.${current}`, JSON.stringify(Object.fromEntries(positions.get(current) ?? []))); } catch { message("布局未能保存；执行图不受影响。"); }
    }
    drag = undefined;
  });
  canvas.addEventListener("pointercancel", () => { drag = undefined; });
  wires.addEventListener("click", e => { const key = (e.target as SVGElement).dataset.editable as keyof Connections | undefined; if (key) { draft[key] = false; dirty = true; validated = false; render(); } else message("该连线只读。"); });
  canvas.addEventListener("wheel", e => { e.preventDefault(); const r = canvas.getBoundingClientRect(), x = e.clientX-r.left, y=e.clientY-r.top, next = Math.max(.12, Math.min(2, scale * Math.exp(-e.deltaY * .0015))), ratio = next / scale; panX=x-(x-panX)*ratio; panY=y-(y-panY)*ratio; scale=next; draw(); }, { passive: false });
  root.addEventListener("click", async e => {
    const button = (e.target as Element).closest<HTMLButtonElement>("button"); if (!button) return;
    if (button.dataset.nav) { current = button.dataset.nav; render(); fit(); return; }
    const action = button.dataset.act; if (!action) return;
    if (!data.canEdit && ["preview", "save", "validate", "publish", "reset"].includes(action)) return;
    if (action === "preview") { previewPublished = !previewPublished; render(); return; }
    if (previewPublished && ["save", "validate", "publish", "reset"].includes(action)) { message("请先返回草稿。"); return; }
    if (action === "fit") { fit(); return; } if (action === "plus" || action === "minus") { scale = Math.max(.12, Math.min(2, scale * (action === "plus" ? 1.2 : 1/1.2))); draw(); return; }
    if ((action === "validate" || action === "publish") && dirty) { message("请先保存草稿。"); return; }
    if (action === "publish" && !validated) { message("请先校验草稿。"); return; }
    button.disabled = true;
    try {
      const body = action === "save" ? { revision: data.revision, connections: draft } : { revision: data.revision };
      const result = await fetch(`/api/v1/flow-publication/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const value = await result.json() as { error?: string; revision?: string };
      if (!result.ok) throw new Error(value.error === "FLOW_CONFLICT" ? "版本冲突，请刷新后重新编辑。" : value.error ?? "操作失败");
      if (action === "validate") { validated = true; updateStatus(); message("校验通过，可以发布。"); }
      else { const refreshed = await fetch("/api/v1/flow-overview", { cache: "no-store" }); if (!refreshed.ok) throw new Error("刷新状态失败"); data = await refreshed.json() as Payload; catalog = data.catalog; draft = { ...data.draft }; dirty = false; validated = false; render(); message(action === "publish" ? "已发布；仅启用的图会影响新请求。" : "草稿已保存。"); }
    } catch (error) { message(error instanceof Error ? error.message : "操作失败"); } finally { button.disabled = false; }
  });
  let sized = false;
  const resize = new ResizeObserver(() => { if (!sized && canvas.clientWidth && canvas.clientHeight) { sized = true; fit(); } });
  resize.observe(canvas);
  const refreshCatalog = async () => { try { const response = await fetch("/api/v1/flow-overview", { cache: "no-store" }); if (!response.ok) throw new Error(); const fresh = await response.json() as Payload, retainDraft = dirty || validated; catalog = fresh.catalog; if (!retainDraft) draft = { ...fresh.draft }; data = { ...fresh, revision: retainDraft ? data.revision : fresh.revision, draft: retainDraft ? data.draft : fresh.draft }; render(); } catch { message("当前流程状态暂不可用。 "); } };
  window.addEventListener("stardust-channel-tools-changed", () => { void refreshCatalog(); });
  render(); void refreshCatalog(); requestAnimationFrame(() => { if (canvas.clientWidth && canvas.clientHeight) { sized = true; fit(); } }); return true;
}
