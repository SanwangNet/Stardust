type Connections = { recent: boolean; global: boolean; search: boolean };
type Edge = { from: { node: string; port: string }; to: { node: string; port: string } };
type Graph = { id: string; nodes: { id: string; type: string; graphId?: string }[]; edges: Edge[]; interface: { inputs: { id: string; label?: string }[]; outputs: { id: string; label?: string }[] } };
type CatalogEntry = { owner: string; name: string; status: string; runtime: string; warnings: string[]; interfaces: { groupId: string; graphId: string; inputs: { id: string; node: string; type: string; required: boolean; label: string }[]; outputs: { id: string; node: string; type: string; required: boolean; label: string }[] }[]; contract: null | { nodes: { id: string; name: string; description: string; executable: boolean; inputs: Record<string, { type: string; required?: boolean }>; outputs: Record<string, { type: string }> }[]; groups: { id: string; name: string; description: string; flow: { rootId: string; graphs: Graph[] } }[] } };
type Payload = { revision: string; draft: Connections; published: { id: string; connections: Connections }; active: { context: boolean; tools: boolean; execution: boolean }; graphs: { context: { graphs: Graph[] }; tools: { graphs: Graph[] }; execution: { graphs: Graph[] } } };
type VisibleNode = { id: string; title: string; subtitle: string; x: number; y: number; next?: string; state?: string; description?: string };
type VisibleEdge = { from: string; to: string; label: string; editable?: keyof Connections };

const titles: Record<string, string> = { input: "输入", output: "输出", current: "当前消息", recent: "近期上下文", global: "全局上下文", assembler: "上下文组装器", search: "search_history", extensions: "已注册扩展 Tool", filter: "可用性与范围过滤", validate: "参数校验", permission: "权限检查", approval: "等待确认", executor: "Tool 执行", result: "Tool Result" };
const endpoints: Record<keyof Connections, { graph: string; from: string; fromPort: string; to: string; toPort: string }> = {
  recent: { graph: "context", from: "recent", fromPort: "value", to: "assembler", toPort: "recent" },
  global: { graph: "context", from: "global", fromPort: "value", to: "assembler", toPort: "global" },
  search: { graph: "availability", from: "search", fromPort: "value", to: "filter", toPort: "search" },
};

/** Returns false only when the development editor is disabled. */
export async function initializeRealFlowBoard(root: HTMLElement): Promise<boolean> {
  let response: Response;
  try { response = await fetch("/api/v1/flow-publication", { cache: "no-store" }); } catch { return false; }
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    if (body.error === "FLOW_EDITOR_DISABLED") return false;
    root.textContent = "真实流程编辑需要本机管理员登录。登录后请刷新页面。"; return true;
  }
  let data = await response.json() as Payload, draft = { ...data.draft }, dirty = false, validated = false, previewPublished = false, current = "overview";
  let catalog: CatalogEntry[] = [];
  const positions = new Map<string, Map<string, { x: number; y: number }>>();
  let scale = 1, panX = 30, panY = 80;
  root.className = "flow-board is-real";
  root.innerHTML = `<header class="flow-toolbar"><div class="flow-heading"><h2>可视化流程</h2><p class="flow-real-status" role="status"></p></div><div class="flow-controls"><button data-act="preview">查看已发布版本</button><button data-act="save">保存草稿</button><button data-act="validate">校验</button><button data-act="publish">发布</button><button data-act="reset">恢复默认草稿</button><button data-act="fit">适应视图</button></div></header><nav class="flow-path" aria-label="流程路径"></nav><div class="flow-content"><div class="flow-canvas-wrap"><div class="flow-canvas" tabindex="0"><div class="flow-world"><svg class="flow-wires"><defs><marker id="real-flow-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" /></marker></defs></svg><div class="flow-nodes"></div></div></div><div class="flow-hud"><span>拖动节点 · 拖动端口重连 · 点击可编辑连线断开</span><span class="flow-zoom"></span><button data-act="minus">−</button><button data-act="plus">＋</button></div></div></div><div class="flow-footer"><span class="flow-real-detail"></span></div>`;
  const el = <T extends Element>(query: string) => root.querySelector<T>(query)!;
  const canvas = el<HTMLElement>(".flow-canvas"), world = el<HTMLElement>(".flow-world"), nodesEl = el<HTMLElement>(".flow-nodes"), wires = el<SVGSVGElement>(".flow-wires"), path = el<HTMLElement>(".flow-path"), status = el<HTMLElement>(".flow-real-status"), detail = el<HTMLElement>(".flow-real-detail");
  wires.setAttribute("viewBox", "-10000 -10000 20000 20000");
  const message = (text: string) => { detail.textContent = text; };
  function updateStatus(): void {
    const changed = JSON.stringify(draft) !== JSON.stringify(data.published.connections);
    status.textContent = `${previewPublished ? "正在查看已发布版本（只读）" : dirty ? "未保存草稿" : validated ? "草稿校验通过" : changed ? "草稿未发布" : "草稿与已发布版本一致"} · 发布版本 ${data.published.id}`;
    el<HTMLButtonElement>('[data-act="preview"]').textContent = previewPublished ? "返回草稿" : "查看已发布版本";
    detail.textContent = `上下文图：${data.active.context ? "已启用" : "已保存但未生效"}；Tool 可用性图：${data.active.tools ? "已启用" : "已保存但未生效"}；审批执行图：${data.active.execution ? "已启用" : "未启用，使用原审批流程"}（只读）。`;
  }
  function graphs(): Graph[] { return [data.graphs.context.graphs.find(g => g.id === "context")!, data.graphs.tools.graphs.find(g => g.id === "availability")!, data.graphs.execution.graphs.find(g => g.id === "tool")!]; }
  function view(): { nodes: VisibleNode[]; edges: VisibleEdge[] } {
    if (current === "overview") return { nodes: [{ id: "context", title: "上下文", subtitle: "Web 上下文组", x: 50, y: 100, next: "context" }, { id: "tools", title: "Tool", subtitle: "可用性与调用", x: 420, y: 100, next: "tools" }, { id: "starcores", title: "星核流程", subtitle: "只读声明与能力", x: 790, y: 100, next: "starcores" }], edges: [{ from: "context", to: "tools", label: "模型请求" }] };
    if (current === "tools") return { nodes: [{ id: "availability", title: "Tool 可用性", subtitle: "提供给模型", x: 50, y: 100, next: "availability" }, { id: "execution", title: "Tool 调用与审批", subtitle: "只读", x: 420, y: 100, next: "execution" }], edges: [{ from: "availability", to: "execution", label: "Tool 调用" }] };
    if (current === "starcores") {
      const nodes: VisibleNode[] = [];
      for (const entry of catalog) {
        if (!entry.contract) nodes.push({ id: entry.owner, title: entry.name, subtitle: `星核 · ${entry.owner}`, state: "协议不兼容 · 不可执行", description: entry.warnings.join("；"), x: 50 + nodes.length * 300, y: 100 });
        for (const group of entry.contract?.groups ?? []) nodes.push({ id: `${entry.owner}:${group.id}`, title: group.name, subtitle: `星核 · ${entry.owner}`, state: entry.status === "enabled" ? entry.runtime === "connected" ? "已启用 · 只读声明" : "已启用但未连接 · 声明只读" : entry.status === "disabled" ? "星核已停用 · 不可执行" : entry.status === "uninstalled" ? "星核未安装 · 不可执行" : "协议不兼容 · 不可执行", description: group.description, x: 50 + nodes.length * 300, y: 100, next: `catalog/${entry.owner}/${group.id}/${group.flow.rootId}` });
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
          state: entry.status !== "enabled" || entry.runtime !== "connected" ? "星核不可用 · 不可执行" : definition?.executable ? "Core 路径已绑定 · 声明只读" : interfaceNode || node.type === "group" || node.type === "pass" ? "接口 / 结构 · 只读" : "说明节点 · 不可执行",
          description: [definition?.description ?? group.description, ports, ...entry.warnings].filter(Boolean).join(" · "), x: 50 + index * 290, y: node.id === "recent" ? 20 : node.id === "global" ? 260 : 140,
          ...(node.graphId ? { next: `catalog/${owner}/${groupId}/${node.graphId}` } : {}) };
      });
      return { nodes: visual, edges: graph.edges.map(edge => ({ from: edge.from.node, to: edge.to.node, label: `${edge.from.port} → ${edge.to.port}` })) };
    }
    const graph = graphs()[current === "context" ? 0 : current === "availability" ? 1 : 2]!;
    const visual: VisibleNode[] = graph.nodes.map((n, i) => ({ id: n.id, title: titles[n.id] ?? n.id, subtitle: n.id === "input" ? graph.interface.inputs[0]?.label ?? n.type : n.id === "output" ? graph.interface.outputs[0]?.label ?? n.type : n.type, x: 50 + i * 290, y: (n.id === "recent" || n.id === "search") ? 20 : n.id === "global" || n.id === "extensions" ? 260 : 140 }));
    const edges: VisibleEdge[] = graph.edges.filter(e => !Object.values(endpoints).some(p => p.graph === graph.id && p.from === e.from.node && p.to === e.to.node && p.toPort === e.to.port)).map(e => ({ from: e.from.node, to: e.to.node, label: `${e.from.port} → ${e.to.port}` }));
    const connections = previewPublished ? data.published.connections : draft;
    for (const key of Object.keys(endpoints) as (keyof Connections)[]) { const p = endpoints[key]; if (p.graph === graph.id && connections[key]) edges.push({ from: p.from, to: p.to, label: `${p.fromPort} → ${p.toPort}`, ...(!previewPublished ? { editable: key } : {}) }); }
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
    nodesEl.replaceChildren(); wires.querySelectorAll(".flow-wire").forEach(n => n.remove());
    for (const edge of edges) {
      const a = map.get(edge.from), b = map.get(edge.to); if (!a || !b) continue;
      const wire = document.createElementNS("http://www.w3.org/2000/svg", "path"); wire.classList.add("flow-wire");
      if (edge.editable) { wire.classList.add("is-draft"); wire.dataset.editable = edge.editable; }
      const targetPorts = Object.values(endpoints).filter(p => p.graph === current && p.to === edge.to);
      const targetIndex = edge.editable ? targetPorts.findIndex(p => p.toPort === endpoints[edge.editable!].toPort) : -1;
      const targetY = targetIndex < 0 ? 63 : 42 + targetIndex * 40;
      wire.setAttribute("d", `M ${a.x + 234} ${a.y + 63} C ${a.x + 334} ${a.y + 63}, ${b.x - 100} ${b.y + targetY}, ${b.x} ${b.y + targetY}`); wire.setAttribute("marker-end", "url(#real-flow-arrow)");
      const title = document.createElementNS("http://www.w3.org/2000/svg", "title"); title.textContent = `${edge.label}${edge.editable ? " · 点击断开" : " · 只读"}`; wire.append(title); wires.append(wire);
    }
    for (const n of nodes) {
      const p = map.get(n.id)!; const node = document.createElement("button"); node.type = "button"; node.className = "flow-node kind-context"; node.dataset.node = n.id; if (n.next) node.dataset.next = n.next;
      node.style.transform = `translate(${p.x}px, ${p.y}px)`;
      const head = document.createElement("span"); head.className = "flow-node-head"; head.textContent = n.next ? "节点组 · 双击进入" : "服务端节点";
      const title = document.createElement("strong"); title.className = "flow-node-title"; title.textContent = n.title;
      const sub = document.createElement("span"); sub.className = "flow-node-subtitle"; sub.textContent = n.subtitle;
      const state = document.createElement("span"); state.className = "flow-node-state"; state.textContent = n.state ?? `ID: ${n.id}`;
      if (n.description) node.title = n.description;
      node.append(head, title, sub, state);
      if (!previewPublished && Object.values(endpoints).some(p => p.graph === current && p.from === n.id)) { const marker = document.createElement("span"); marker.className = "flow-port is-output"; marker.dataset.out = n.id; marker.dataset.port = "value"; marker.title = "输出端口 value：拖动到对应输入端口"; node.append(marker); }
      if (!previewPublished) Object.values(endpoints).filter(p => p.graph === current && p.to === n.id).forEach((p, index) => { const marker = document.createElement("span"); marker.className = "flow-port is-input"; marker.dataset.in = n.id; marker.dataset.port = p.toPort; marker.style.top = `${36 + index * 40}px`; marker.title = `输入端口 ${p.toPort}`; node.append(marker); });
      nodesEl.append(node);
    }
    path.replaceChildren(); let parts = current === "overview" ? ["overview"] : current === "starcores" ? ["overview", "starcores"] : current.startsWith("catalog/") ? ["overview", "starcores"] : ["overview", ...(current === "context" ? ["context"] : current === "tools" ? ["tools"] : ["tools", current])];
    if (current.startsWith("catalog/")) {
      const [, owner, groupId, graphId] = current.split("/"); const group = catalog.find(e => e.owner === owner)?.contract?.groups.find(g => g.id === groupId);
      const chain: string[] = []; let graph = graphId;
      while (graph && group && !chain.includes(graph)) { chain.unshift(graph); graph = group.flow.graphs.find(g => g.nodes.some(node => node.graphId === graph))?.id; }
      parts = [...parts, ...chain.map(id => `catalog/${owner}/${groupId}/${id}`)];
    }
    for (const id of parts) { if (path.childElementCount) path.append(" / "); const b = document.createElement("button"); b.dataset.nav = id; b.textContent = ({ overview: "总览", context: "上下文", tools: "Tool", availability: "Tool 可用性", execution: "Tool 调用与审批", starcores: "星核流程" } as Record<string,string>)[id] ?? id.split("/").at(-1)!; path.append(b); }
    draw(); updateStatus();
  }
  function fit(): void { const map = positions.get(current); if (!map?.size) return; const ps = [...map.values()], right = Math.max(...ps.map(p => p.x + 234)), bottom = Math.max(...ps.map(p => p.y + 126)); scale = Math.min(1, Math.max(.12, Math.min((canvas.clientWidth - 60) / (right + 20), (canvas.clientHeight - 60) / (bottom + 20)))); panX = 20; panY = 20; draw(); }
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
      else { const refreshed = await fetch("/api/v1/flow-publication", { cache: "no-store" }); if (!refreshed.ok) throw new Error("刷新状态失败"); data = await refreshed.json() as Payload; draft = { ...data.draft }; dirty = false; validated = false; if (action === "publish") await refreshCatalog(); render(); message(action === "publish" ? "已发布；仅启用的图会影响新请求。" : "草稿已保存。"); }
    } catch (error) { message(error instanceof Error ? error.message : "操作失败"); } finally { button.disabled = false; }
  });
  let sized = false;
  const resize = new ResizeObserver(() => { if (!sized && canvas.clientWidth && canvas.clientHeight) { sized = true; fit(); } });
  resize.observe(canvas);
  const refreshCatalog = async () => { try { const response = await fetch("/api/v1/starcore-flows", { cache: "no-store" }); if (!response.ok) throw new Error(); const body = await response.json() as { entries: CatalogEntry[] }; catalog = body.entries; if (current === "starcores" || current.startsWith("catalog/")) render(); } catch { catalog = []; if (current === "starcores" || current.startsWith("catalog/")) { render(); message("星核流程目录暂不可用。"); } } };
  window.addEventListener("stardust-channel-tools-changed", () => { void refreshCatalog(); });
  render(); void refreshCatalog(); requestAnimationFrame(() => { if (canvas.clientWidth && canvas.clientHeight) { sized = true; fit(); } }); return true;
}
