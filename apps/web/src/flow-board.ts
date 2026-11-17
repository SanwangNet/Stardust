import { flowGraphs, flowViews, visibleFlowGraph, type FlowGraph, type FlowKind, type FlowNode, type FlowPort, type FlowViewId } from "./flow-data.js";

const nodeWidth = 234, nodeHeight = 126;
const minScale = .12, maxScale = 2;
const labels: Record<FlowKind, string> = { input: "输入", context: "上下文", prompt: "提示词 / Skill", agent: "Agent", model: "模型", tool: "工具", output: "输出" };
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const svgNamespace = "http://www.w3.org/2000/svg";

/** A read-only architecture diagram. Positions and camera exist only in this page. */
export function initializeFlowBoard(): void {
  const host = document.getElementById("flow-board");
  if (!host) return;
  const root: HTMLElement = host;
  const abort = new AbortController(), signal = abort.signal;
  type Camera = { scale: number; panX: number; panY: number };
  type Layout = { positions: Map<string, { x: number; y: number }>; camera?: Camera };
  const layouts = new Map<string, Layout>();
  const nodeElements = new Map<string, HTMLButtonElement>();
  const edgeElements = new Map<string, SVGPathElement>();
  const liveStatus = new Map<string, string>();
  let registeredChannels: { id: string; name: string; type: string; installed: boolean; enabled: boolean }[] = [];
  let activeView: FlowViewId = "web", selected: string | undefined;
  let graphId = "overview";
  let graph: FlowGraph = flowGraphs[0]!;
  let positions = new Map<string, { x: number; y: number }>();
  let scale = 1, panX = 0, panY = 0, initialized = false;

  root.className = "flow-board";
  root.innerHTML = `<div class="flow-toolbar"><div class="flow-view-picker" role="group" aria-label="流程视图"></div><div class="flow-controls"><button type="button" data-action="fit">适应视图</button><button type="button" data-action="reset">重置布局</button></div></div><nav class="flow-breadcrumb" aria-label="功能流程"></nav><div class="flow-summary"><strong>流程总览</strong><span></span></div>
    <div class="flow-content"><div class="flow-canvas-wrap"><div class="flow-canvas" tabindex="0" aria-label="架构画板。拖动空白处平移，滚轮或双指缩放；可用加减号缩放。"><div class="flow-world"><svg class="flow-wires" aria-hidden="true"><defs><marker id="flow-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" /></marker></defs></svg><div class="flow-nodes"></div></div></div><div class="flow-hud"><span class="flow-hint">拖动空白处平移 · 滚轮缩放</span><span class="flow-zoom" aria-live="polite"></span><button type="button" data-action="zoom-out" aria-label="缩小">−</button><button type="button" data-action="zoom-in" aria-label="放大">＋</button></div></div>
    <aside class="flow-inspector" aria-label="节点详情"><div class="flow-inspector-top"><span>NODE / 节点详情</span><button type="button" data-action="close" aria-label="关闭节点详情">×</button></div><div class="flow-inspector-body"></div></aside></div>
    <div class="flow-footer"><span class="flow-view-note"></span><div class="flow-legend"><span><i></i>实际路径</span><span><i class="is-dashed"></i>依赖 / 后台</span><span><i class="is-planned"></i>未接入</span></div></div>`;
  const element = <T extends Element>(selector: string): T => root.querySelector<T>(selector)!;
  const picker = element<HTMLElement>(".flow-view-picker");
  const breadcrumb = element<HTMLElement>(".flow-breadcrumb");
  const summary = element<HTMLElement>(".flow-summary span");
  const canvas = element<HTMLElement>(".flow-canvas");
  const world = element<HTMLElement>(".flow-world");
  const wires = element<SVGSVGElement>(".flow-wires");
  const nodes = element<HTMLElement>(".flow-nodes");
  const inspector = element<HTMLElement>(".flow-inspector");
  const inspectorBody = element<HTMLElement>(".flow-inspector-body");
  const zoomLabel = element<HTMLElement>(".flow-zoom");
  const note = element<HTMLElement>(".flow-view-note");

  function graphFor(id: string): FlowGraph {
    const base = flowGraphs.find((item) => item.id === id)!;
    if (id !== "input") return base;
    const extra: FlowNode[] = registeredChannels.filter((item) => item.type === "channel" && item.installed && item.id !== "web-chat" && item.id !== "qq-bot").map((item, index) => ({
      id: `channel-${item.id}`, kind: "input", title: item.name, subtitle: "REGISTERED CHANNEL", description: "已安装的渠道；具体执行路径尚未在此图中定义。", owner: `星核 · ${item.id}`, state: "注册信息", registryId: item.id, position: { x: 40, y: 560 + index * 210 }, views: [],
    }));
    return { ...base, nodes: [...base.nodes, ...extra] };
  }
  function layoutFor(current: FlowGraph): Layout {
    let layout = layouts.get(current.id);
    if (!layout) { layout = { positions: new Map() }; layouts.set(current.id, layout); }
    for (const node of current.nodes) if (!layout.positions.has(node.id)) layout.positions.set(node.id, { ...node.position });
    for (const id of layout.positions.keys()) if (!current.nodes.some((node) => node.id === id)) layout.positions.delete(id);
    return layout;
  }
  function port(position: { x: number; y: number }, name: FlowPort): { x: number; y: number; dx: number; dy: number } {
    if (name === "top") return { x: position.x + nodeWidth / 2, y: position.y, dx: 0, dy: -1 };
    if (name === "bottom") return { x: position.x + nodeWidth / 2, y: position.y + nodeHeight, dx: 0, dy: 1 };
    if (name === "left") return { x: position.x, y: position.y + 63, dx: -1, dy: 0 };
    return { x: position.x + nodeWidth, y: position.y + 63, dx: 1, dy: 0 };
  }
  function lineFor(id: string): void {
    const edge = graph.edges.find((item) => item.id === id)!;
    const source = positions.get(edge.source)!, target = positions.get(edge.target)!;
    const from = port(source, edge.sourcePort ?? "right"), to = port(target, edge.targetPort ?? "left");
    const reach = clamp(Math.hypot(to.x - from.x, to.y - from.y) * .42, 65, 200);
    edgeElements.get(id)?.setAttribute("d", `M ${from.x} ${from.y} C ${from.x + from.dx * reach} ${from.y + from.dy * reach}, ${to.x + to.dx * reach} ${to.y + to.dy * reach}, ${to.x} ${to.y}`);
  }
  function draw(): void {
    world.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
    let grid = 24 * scale;
    while (grid < 12) grid *= 2;
    canvas.style.backgroundSize = `${grid}px ${grid}px`;
    canvas.style.backgroundPosition = `${panX}px ${panY}px`;
    zoomLabel.textContent = `${Math.round(scale * 100)}%`;
  }
  function positionNode(id: string): void {
    const point = positions.get(id)!;
    const node = nodeElements.get(id)!;
    node.style.transform = `translate(${point.x}px, ${point.y}px)`;
    for (const edge of graph.edges) if (edge.source === id || edge.target === id) lineFor(edge.id);
  }
  function fit(): void {
    const width = canvas.clientWidth, height = canvas.clientHeight;
    if (!width || !height) return;
    const all = visibleFlowGraph(graph, activeView).nodes.map((node) => positions.get(node.id)!);
    if (!all.length) return;
    const left = Math.min(...all.map((item) => item.x)), top = Math.min(...all.map((item) => item.y));
    const right = Math.max(...all.map((item) => item.x + nodeWidth)), bottom = Math.max(...all.map((item) => item.y + nodeHeight));
    scale = clamp(Math.min((width - 60) / (right - left), (height - 60) / (bottom - top)), minScale, 1);
    panX = (width - (right - left) * scale) / 2 - left * scale;
    panY = (height - (bottom - top) * scale) / 2 - top * scale;
    draw();
  }
  function zoomAt(next: number, x: number, y: number): void {
    const nextScale = clamp(next, minScale, maxScale);
    const ratio = nextScale / scale;
    panX = x - (x - panX) * ratio; panY = y - (y - panY) * ratio; scale = nextScale; draw();
  }
  function refreshInspector(): void {
    inspectorBody.replaceChildren();
    const node = graph.nodes.find((item) => item.id === selected);
    if (!node) {
      const empty = document.createElement("p"); empty.className = "flow-inspector-empty";
      empty.textContent = "选择一个节点，查看它的职责与连接关系。"; inspectorBody.append(empty); return;
    }
    const eyebrow = document.createElement("span"); eyebrow.className = `flow-detail-kind kind-${node.kind}`; eyebrow.textContent = labels[node.kind];
    const title = document.createElement("h2"); title.textContent = node.title;
    const description = document.createElement("p"); description.className = "flow-detail-description"; description.textContent = node.descriptionByView?.[activeView] ?? node.description;
    const meta = document.createElement("dl"); meta.className = "flow-detail-meta";
    for (const [key, value] of [["归属", node.owner], ["状态", (node.registryId && liveStatus.get(node.registryId)) || node.stateByView?.[activeView] || node.state], ["信息来源", node.registryId ? "星核注册信息与架构说明" : "静态架构说明"]]) {
      const row = document.createElement("div"), term = document.createElement("dt"), detail = document.createElement("dd");
      term.textContent = key!; detail.textContent = value!; row.append(term, detail); meta.append(row);
    }
    const heading = document.createElement("h3"); heading.textContent = "连接关系";
    const list = document.createElement("ul"); list.className = "flow-relations";
    for (const edge of visibleFlowGraph(graph, activeView).edges.filter((item) => item.source === node.id || item.target === node.id)) {
      const other = graph.nodes.find((item) => item.id === (edge.source === node.id ? edge.target : edge.source));
      const row = document.createElement("li");
      row.textContent = `${edge.source === node.id ? "→" : "←"} ${other?.title ?? ""} · ${edge.relation}${edge.style === "planned" ? "（规划）" : ""}`;
      list.append(row);
    }
    inspectorBody.append(eyebrow, title, description, meta);
    if (node.childGraphId) {
      const child = flowGraphs.find((item) => item.id === node.childGraphId)!;
      const enter = document.createElement("button"); enter.type = "button"; enter.className = "flow-enter"; enter.dataset.graph = child.id;
      enter.textContent = "进入子流程 ↗";
      if (child.availableViews && !child.availableViews.includes(activeView)) { enter.disabled = true; enter.textContent = "当前渠道尚未接入"; }
      inspectorBody.append(enter);
    }
    inspectorBody.append(heading, list);
  }
  function select(id: string | undefined): void {
    selected = id;
    for (const [nodeId, node] of nodeElements) node.classList.toggle("is-selected", nodeId === id);
    inspector.classList.toggle("is-open", Boolean(id)); refreshInspector();
    if (id && matchMedia("(max-width: 700px)").matches) requestAnimationFrame(() => {
      if (selected === id && inspector.isConnected) inspector.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
  }
  function setView(view: FlowViewId): void {
    activeView = view;
    if (graph.availableViews && !graph.availableViews.includes(view)) navigateGraph("overview");
    renderBreadcrumb();
    picker.querySelectorAll<HTMLButtonElement>("button").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.view === view)));
    const visible = visibleFlowGraph(graph, view);
    const nodeIds = new Set(visible.nodes.map((node) => node.id));
    const edgeIds = new Set(visible.edges.map((edge) => edge.id));
    for (const node of graph.nodes) {
      const element = nodeElements.get(node.id);
      if (element) element.hidden = !nodeIds.has(node.id);
      const state = element?.querySelector(".flow-node-state");
      if (state) state.textContent = (node.registryId && liveStatus.get(node.registryId)) || node.stateByView?.[view] || node.state;
    }
    for (const edge of graph.edges) {
      const element = edgeElements.get(edge.id);
      if (element) element.style.display = edgeIds.has(edge.id) ? "" : "none";
    }
    if (selected && !nodeIds.has(selected)) select(undefined);
    note.textContent = flowViews.find((entry) => entry.id === view)?.note ?? "";
    refreshInspector();
  }
  for (const view of flowViews) {
    const button = document.createElement("button"); button.type = "button"; button.textContent = view.label; button.dataset.view = view.id;
    button.addEventListener("click", () => setView(view.id), { signal }); picker.append(button);
  }
  function renderBreadcrumb(): void {
    breadcrumb.replaceChildren();
    const label = document.createElement("span"); label.className = "flow-breadcrumb-label"; label.textContent = "STARDUST / 流程"; breadcrumb.append(label);
    for (const item of flowGraphs) {
      const button = document.createElement("button"); button.type = "button"; button.dataset.graph = item.id; button.textContent = item.title;
      button.setAttribute("aria-pressed", String(item.id === graph.id));
      button.disabled = Boolean(item.availableViews && !item.availableViews.includes(activeView));
      breadcrumb.append(button);
    }
  }
  function renderGraph(): void {
    nodes.replaceChildren(); wires.querySelectorAll(".flow-wire").forEach((item) => item.remove()); nodeElements.clear(); edgeElements.clear();
    root.dataset.graph = graph.id;
    summary.textContent = graph.summary;
    for (const edge of graph.edges) {
      const path = document.createElementNS(svgNamespace, "path"); path.classList.add("flow-wire");
      if (edge.style) path.classList.add(`is-${edge.style}`);
      path.setAttribute("marker-end", "url(#flow-arrow)"); path.dataset.edge = edge.id;
      const title = document.createElementNS(svgNamespace, "title"); title.textContent = edge.relation; path.append(title);
      wires.append(path); edgeElements.set(edge.id, path);
    }
    for (const data of graph.nodes) {
      const node = document.createElement("button"); node.type = "button"; node.className = `flow-node kind-${data.kind}${data.planned ? " is-planned" : ""}`; node.dataset.node = data.id;
      if (data.id === selected) node.classList.add("is-selected");
      node.setAttribute("aria-label", `${data.title}，${labels[data.kind]}，查看详情${data.childGraphId ? "，包含子流程" : ""}`);
      const head = document.createElement("span"); head.className = "flow-node-head";
      const kind = document.createElement("span"); kind.textContent = labels[data.kind];
      const badge = document.createElement("span"); badge.textContent = data.childGraphId ? "子流程 ↗" : data.planned ? "规划" : data.registryId ? "CHANNEL" : "CORE";
      head.append(kind, badge);
      const title = document.createElement("strong"); title.className = "flow-node-title"; title.textContent = data.title;
      const subtitle = document.createElement("span"); subtitle.className = "flow-node-subtitle"; subtitle.textContent = data.subtitle;
      const state = document.createElement("span"); state.className = "flow-node-state"; state.textContent = data.registryId ? "读取注册状态…" : data.state;
      const input = document.createElement("span"); input.className = "flow-port is-input"; input.setAttribute("aria-hidden", "true");
      const output = document.createElement("span"); output.className = "flow-port is-output"; output.setAttribute("aria-hidden", "true");
      node.append(head, title, subtitle, state, input, output);
      for (const direction of ["top", "bottom"] as const) {
        if (graph.edges.some((edge) => (edge.source === data.id && edge.sourcePort === direction) || (edge.target === data.id && edge.targetPort === direction))) {
          const marker = document.createElement("span"); marker.className = `flow-port is-${direction}`; marker.setAttribute("aria-hidden", "true"); node.append(marker);
        }
      }
      nodes.append(node); nodeElements.set(data.id, node);
    }
    for (const node of graph.nodes) positionNode(node.id);
    renderBreadcrumb(); setView(activeView); draw();
  }
  function navigateGraph(id: string): void {
    const next = flowGraphs.find((item) => item.id === id);
    if (!next || (next.availableViews && !next.availableViews.includes(activeView))) return;
    if (initialized) layoutFor(graph).camera = { scale, panX, panY };
    graphId = id; graph = graphFor(id); const layout = layoutFor(graph); positions = layout.positions;
    select(undefined); renderGraph();
    if (layout.camera) { ({ scale, panX, panY } = layout.camera); draw(); }
    else fit();
  }
  graph = graphFor(graphId); positions = layoutFor(graph).positions; renderGraph();

  type Pointer = { x: number; y: number };
  const pointers = new Map<number, Pointer>();
  let lastClick: { id: string; time: number } | undefined;
  let drag: { pointer: number; x: number; y: number; panX: number; panY: number; node?: string; nodeX?: number; nodeY?: number; moved: boolean } | undefined;
  let pinch: { distance: number; scale: number; worldX: number; worldY: number } | undefined;
  const coordinates = (event: PointerEvent): Pointer => { const rect = canvas.getBoundingClientRect(); return { x: event.clientX - rect.left, y: event.clientY - rect.top }; };
  const pair = () => [...pointers.values()].slice(0, 2);
  canvas.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse" && event.button !== 0 && event.button !== 1) return;
    event.preventDefault(); const point = coordinates(event); pointers.set(event.pointerId, point); canvas.setPointerCapture(event.pointerId);
    if (pointers.size === 1) {
      const node = (event.target as Element).closest<HTMLButtonElement>(".flow-node");
      const nodeId = node?.dataset.node, original = nodeId ? positions.get(nodeId) : undefined;
      drag = { pointer: event.pointerId, x: point.x, y: point.y, panX, panY, node: nodeId, nodeX: original?.x, nodeY: original?.y, moved: false };
      canvas.classList.add(nodeId ? "is-dragging-node" : "is-panning");
    } else if (pointers.size === 2) {
      const [a, b] = pair() as [Pointer, Pointer]; const x = (a.x + b.x) / 2, y = (a.y + b.y) / 2;
      pinch = { distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), scale, worldX: (x - panX) / scale, worldY: (y - panY) / scale }; drag = undefined;
      canvas.classList.remove("is-dragging-node"); canvas.classList.add("is-panning");
    }
  }, { signal });
  canvas.addEventListener("pointermove", (event) => {
    if (!pointers.has(event.pointerId)) return;
    const point = coordinates(event); pointers.set(event.pointerId, point);
    if (pinch && pointers.size >= 2) {
      const [a, b] = pair() as [Pointer, Pointer], centerX = (a.x + b.x) / 2, centerY = (a.y + b.y) / 2;
      scale = clamp(pinch.scale * Math.hypot(a.x - b.x, a.y - b.y) / pinch.distance, minScale, maxScale);
      panX = centerX - pinch.worldX * scale; panY = centerY - pinch.worldY * scale; draw(); return;
    }
    if (!drag || drag.pointer !== event.pointerId) return;
    const dx = point.x - drag.x, dy = point.y - drag.y; if (Math.hypot(dx, dy) > 4) drag.moved = true;
    if (drag.node && drag.nodeX !== undefined && drag.nodeY !== undefined) { positions.set(drag.node, { x: drag.nodeX + dx / scale, y: drag.nodeY + dy / scale }); positionNode(drag.node); }
    else { panX = drag.panX + dx; panY = drag.panY + dy; draw(); }
  }, { signal });
  const endPointer = (event: PointerEvent) => {
    if (drag && drag.pointer === event.pointerId && !drag.moved && drag.node && event.type === "pointerup") {
      const node = graph.nodes.find((item) => item.id === drag?.node);
      if (event.pointerType === "mouse" && lastClick?.id === drag.node && Date.now() - lastClick.time < 400 && node?.childGraphId) {
        lastClick = undefined; navigateGraph(node.childGraphId);
      } else { lastClick = { id: drag.node, time: Date.now() }; select(drag.node); }
    }
    pointers.delete(event.pointerId); drag = undefined; pinch = undefined;
    canvas.classList.remove("is-panning", "is-dragging-node");
    // Start a new pan when one finger remains after a pinch.
    if (pointers.size === 1) { const [id, point] = [...pointers.entries()][0]!; drag = { pointer: id, x: point.x, y: point.y, panX, panY, moved: true }; canvas.classList.add("is-panning"); }
  };
  canvas.addEventListener("pointerup", endPointer, { signal }); canvas.addEventListener("pointercancel", endPointer, { signal });
  canvas.addEventListener("lostpointercapture", (event) => { if (pointers.has(event.pointerId)) endPointer(event); }, { signal });
  canvas.addEventListener("wheel", (event) => { event.preventDefault(); const rect = canvas.getBoundingClientRect(); zoomAt(scale * Math.exp(-event.deltaY * .0015), event.clientX - rect.left, event.clientY - rect.top); }, { passive: false, signal });
  canvas.addEventListener("keydown", (event) => {
    if (event.target !== canvas) return;
    if (event.key === "+" || event.key === "=") zoomAt(scale * 1.2, canvas.clientWidth / 2, canvas.clientHeight / 2);
    else if (event.key === "-") zoomAt(scale / 1.2, canvas.clientWidth / 2, canvas.clientHeight / 2);
    else if (event.key === "ArrowLeft") panX += 40; else if (event.key === "ArrowRight") panX -= 40;
    else if (event.key === "ArrowUp") panY += 40; else if (event.key === "ArrowDown") panY -= 40; else return;
    event.preventDefault(); draw();
  }, { signal });
  nodes.addEventListener("click", (event) => {
    if (event.detail !== 0) return;
    const node = (event.target as Element).closest<HTMLButtonElement>(".flow-node");
    if (node?.dataset.node) select(node.dataset.node);
  }, { signal });
  root.addEventListener("click", (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>("button");
    if (button?.dataset.graph && !button.disabled) { navigateGraph(button.dataset.graph); return; }
    const action = button?.dataset.action;
    if (action === "fit") fit();
    else if (action === "reset") { for (const node of graph.nodes) { positions.set(node.id, { ...node.position }); positionNode(node.id); } fit(); }
    else if (action === "close") select(undefined);
    else if (action === "zoom-in") zoomAt(scale * 1.2, canvas.clientWidth / 2, canvas.clientHeight / 2);
    else if (action === "zoom-out") zoomAt(scale / 1.2, canvas.clientWidth / 2, canvas.clientHeight / 2);
  }, { signal });
  const resize = new ResizeObserver(() => {
    if (!initialized && canvas.clientWidth && canvas.clientHeight) {
      initialized = true;
      if (canvas.clientWidth < 500) { scale = .72; panX = 24 - 40 * scale; panY = canvas.clientHeight / 2 - 300 * scale; draw(); }
      else fit();
    }
  });
  resize.observe(canvas);
  async function loadRegistry(): Promise<void> {
    try {
      const response = await fetch("/api/v1/extensions", { cache: "no-store", signal }); if (!response.ok) throw new Error();
      const data = await response.json() as { extensions?: { id: string; name: string; type: string; installed: boolean; enabled: boolean }[] };
      registeredChannels = Array.isArray(data.extensions) ? data.extensions.filter((item) => typeof item.id === "string" && typeof item.name === "string" && typeof item.type === "string") : [];
      liveStatus.clear();
      for (const item of registeredChannels) liveStatus.set(item.id, !item.installed ? "已注册 · 未安装" : item.enabled ? "已安装 · 已启用" : "已安装 · 已停用");
      for (const id of ["web-chat", "qq-bot"]) if (!liveStatus.has(id)) liveStatus.set(id, "未找到注册信息");
      if (graphId === "input") { graph = graphFor(graphId); positions = layoutFor(graph).positions; renderGraph(); }
      else setView(activeView);
    } catch {
      for (const id of ["web-chat", "qq-bot"]) liveStatus.set(id, "注册信息暂不可用");
      setView(activeView);
    }
  }
  window.addEventListener("stardust-conversations-ready", () => { void loadRegistry(); }, { signal });
  window.addEventListener("stardust-channel-tools-changed", () => { void loadRegistry(); }, { signal });
  window.addEventListener("pagehide", (event) => { if (!event.persisted) { abort.abort(); resize.disconnect(); } }, { signal });
  void loadRegistry();
}
