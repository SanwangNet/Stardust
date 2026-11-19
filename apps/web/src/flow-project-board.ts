import {
  type Board, type DesignNode, type EdgeSemantic, type FlowDesignProject, type LineStyle, type PathStyle, type PortKind, type PortSide, type Viewport,
  DEFAULT_EDGE_APPEARANCE, EDGE_SEMANTICS, LINE_STYLES, MAX_BOARDS, MAX_FILE_SIZE, MAX_NODES_PER_BOARD,
  MAX_PORTS_PER_KIND, PATH_STYLES, PORT_SIDES, boardReferences, canConnect, connect, copyNode, exampleProject,
  linkBoard, newBoard, newId, newNode, parseProject, portSide, referenceTargets, removeBoard, removeNode, removePort,
} from "./flow-project.js";
import { CARD_HEIGHT, CARD_WIDTH, freeWirePreview, layoutNode, wirePath, type PortPosition } from "./flow-project-geometry.js";
import { loadProject, PROJECT_KEY as key } from "./flow-project-migration.js";

const svg = "http://www.w3.org/2000/svg";
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
const sideLabels: Record<PortSide, string> = { left: "左侧", right: "右侧", top: "上侧", bottom: "下侧" };
const kindLabels: Record<PortKind, string> = { input: "输入", output: "输出" };
const lineLabels: Record<LineStyle, string> = { solid: "实线", dashed: "虚线", dotted: "点线" };
const pathLabels: Record<PathStyle, string> = { bezier: "贝塞尔曲线", orthogonal: "直角折线" };
const semanticLabels: Record<EdgeSemantic, string> = {
  unspecified: "尚未定义", data: "数据传递", trigger: "触发或执行顺序",
  capability: "能力提供或引用", feedback: "反馈或结果返回", optional: "可选关系",
};

function selectControl<T extends string>(label: string, values: readonly T[], labels: Record<T, string>, value: T, change: (next: T) => void): HTMLSelectElement {
  const select = document.createElement("select");
  select.setAttribute("aria-label", label);
  for (const item of values) select.add(new Option(labels[item], item));
  select.value = value;
  select.addEventListener("change", () => {
    const next = values.find(item => item === select.value);
    if (next) change(next);
  });
  return select;
}

export function initializeProjectBoard(root: HTMLElement): void {
  let project: FlowDesignProject;
  let lastSaved: string | null = null;
  let protectStorage = false;
  let migrated = false;
  const readError = "工程替换或读取失败。原存储已保留，自动保存已暂停，请检查浏览器存储。";
  try {
    const loaded = loadProject(localStorage);
    project = loaded.project;
    lastSaved = loaded.serialized;
    migrated = loaded.migrated;
  } catch {
    try {
      lastSaved = localStorage.getItem(key);
      project = lastSaved === null ? exampleProject() : parseProject(JSON.parse(lastSaved));
    } catch {
      project = exampleProject();
    }
    protectStorage = true;
  }
  let current = project.rootBoardId, trail = [current], selection: { type: "node" | "edge"; id: string } | undefined;
  type PositionedPort = { node: DesignNode; anchor: PortPosition };
  type Drag = { pointer: number; x: number; y: number; moved: boolean } & (
    { type: "wire"; from: PositionedPort }
    | { type: "node"; node: DesignNode; ox: number; oy: number }
    | { type: "pan"; ox: number; oy: number }
  );
  let drag: Drag | undefined;
  let pendingGroupClick: { id: string; timer: number } | undefined;
  root.className = "flow-board is-real";
  root.innerHTML = `<div class="flow-design flow-project"><header class="flow-toolbar"><div class="flow-heading"><h2>可视化流程</h2><p class="flow-view-note">设计工程 · 自动保存在当前浏览器</p></div><div class="flow-controls"><button data-action="new-project">新建工程</button><button data-action="add-board">新增画板</button><button data-action="add-node">新增卡片</button><button data-action="add-group">新增节点组</button><button data-action="fit">适应视图</button><button data-action="export">导出工程</button><button data-action="import">导入工程</button><input type="file" accept=".json,application/json" hidden></div></header><div class="flow-project-navigation"><label>画板 <select aria-label="选择画板"></select></label><button data-action="rename-board">重命名</button><button data-action="root-board">设为根画板</button><button data-action="delete-board">删除画板</button><nav class="flow-path" aria-label="画板层级"></nav></div><div class="flow-content"><div class="flow-canvas-wrap"><div class="flow-canvas" tabindex="0" aria-label="设计画板：拖动卡片，拖动空白处平移，滚轮缩放"><div class="flow-world"><svg class="flow-wires" viewBox="-10000 -10000 20000 20000"></svg><div class="flow-nodes"></div></div></div><div class="flow-hud"><span>拖动端口连线 · 双击节点组进入 · Ctrl+D 复制 · Delete 删除</span><span class="flow-zoom"></span><button data-action="minus" aria-label="缩小">−</button><button data-action="plus" aria-label="放大">＋</button></div></div><aside class="flow-inspector" aria-label="编辑卡片"><div class="flow-inspector-top"><span>编辑卡片</span><button data-action="dismiss" aria-label="关闭">×</button></div><div class="flow-inspector-body"></div></aside></div><div class="flow-footer"><span class="flow-design-status" role="status"></span></div><div class="flow-design-menu" hidden><button data-action="duplicate">复制卡片</button><button data-action="edit">编辑卡片</button><button data-action="delete">删除卡片</button></div></div>`;
  const el = <T extends Element>(s: string) => root.querySelector<T>(s)!;
  const canvas = el<HTMLElement>(".flow-canvas"), world = el<HTMLElement>(".flow-world"), nodes = el<HTMLElement>(".flow-nodes"), wires = el<SVGSVGElement>(".flow-wires"), inspector = el<HTMLElement>(".flow-inspector"), body = el<HTMLElement>(".flow-inspector-body"), menu = el<HTMLElement>(".flow-design-menu"), status = el<HTMLElement>(".flow-design-status"), selector = el<HTMLSelectElement>("select[aria-label]"), path = el<HTMLElement>(".flow-path"), file = el<HTMLInputElement>('input[type="file"]');
  wires.setAttribute("viewBox", "-110000 -110000 220000 220000");
  const dialog = document.createElement("dialog");
  dialog.className = "flow-project-dialog";
  dialog.setAttribute("aria-labelledby", "flow-project-dialog-message");
  dialog.innerHTML = `<form method="dialog"><p id="flow-project-dialog-message"></p><input maxlength="120" aria-label="名称"><ul class="flow-project-reference-list" hidden></ul><div><button value="confirm">确定</button><button value="cancel" formnovalidate>取消</button></div></form>`;
  const picker = document.createElement("dialog");
  picker.className = "flow-project-dialog flow-project-picker";
  picker.setAttribute("aria-labelledby", "flow-project-picker-title");
  picker.innerHTML = `<form method="dialog"><h3 id="flow-project-picker-title">关联已有画板</h3><p></p><input type="search" placeholder="搜索画板名称" aria-label="搜索画板名称" autofocus><select aria-label="目标画板" size="6"></select><p class="flow-project-picker-empty" role="status" hidden></p><div><button value="confirm" disabled>确认关联</button><button value="cancel">取消</button></div></form>`;
  root.append(dialog, picker);

  function showDialog(modal: HTMLDialogElement): Promise<boolean> {
    return new Promise(resolve => {
      const listeners = new AbortController();
      function finish(confirmed: boolean): void {
        listeners.abort();
        modal.close();
        resolve(confirmed);
      }
      modal.addEventListener("submit", event => {
        event.preventDefault();
        finish(event.submitter?.getAttribute("value") === "confirm");
      }, { signal: listeners.signal });
      modal.addEventListener("cancel", event => {
        event.preventDefault();
        finish(false);
      }, { signal: listeners.signal });
      modal.showModal();
    });
  }

  async function ask(message: string, { initial, details }: { initial?: string; details?: string[] } = {}): Promise<string | null> {
    if (dialog.open || picker.open) return null;
    const input = dialog.querySelector<HTMLInputElement>("input")!;
    const list = dialog.querySelector<HTMLUListElement>("ul")!;
    dialog.querySelector("p")!.textContent = message;
    input.hidden = initial === undefined;
    input.required = initial !== undefined;
    input.value = initial ?? "";
    list.hidden = !details;
    const items = document.createDocumentFragment();
    for (const detail of details ?? []) {
      const item = document.createElement("li");
      item.textContent = detail;
      items.append(item);
    }
    list.replaceChildren(items);
    dialog.querySelector<HTMLButtonElement>('[value="cancel"]')!.hidden = !!details;
    dialog.querySelector<HTMLButtonElement>('[value="confirm"]')!.textContent = details ? "关闭" : "确定";
    const confirmed = showDialog(dialog);
    if (initial !== undefined) {
      input.focus();
      input.select();
    }
    if (!await confirmed) return null;
    return initial === undefined ? "yes" : input.value.trim();
  }

  async function chooseBoard(source: Board, node: DesignNode): Promise<string | undefined> {
    if (dialog.open || picker.open) return;
    const previous = project.boards.find(candidate => candidate.id === node.childBoardId);
    const candidates = referenceTargets(project, source).filter(candidate => candidate !== previous);
    const search = picker.querySelector<HTMLInputElement>("input")!;
    const choices = picker.querySelector<HTMLSelectElement>("select")!;
    const empty = picker.querySelector<HTMLElement>(".flow-project-picker-empty")!;
    const confirm = picker.querySelector<HTMLButtonElement>('[value="confirm"]')!;
    picker.querySelector("p")!.textContent = previous
      ? `确认后将替换当前关联「${previous.name}」，原画板会保留。`
      : "选择要关联的画板。此节点会与其他入口共享画板内容。";
    confirm.textContent = previous ? "替换关联" : "确认关联";
    const names = new Map<string, number>();
    for (const candidate of candidates) names.set(candidate.name, (names.get(candidate.name) ?? 0) + 1);

    function filterChoices(): void {
      const query = search.value.trim().toLocaleLowerCase();
      const selected = choices.value;
      const matches = candidates.filter(candidate => candidate.name.toLocaleLowerCase().includes(query));
      choices.replaceChildren(...matches.map(candidate => {
        const suffix = candidate.id === project.rootBoardId ? " · 根画板" : "";
        const index = names.get(candidate.name)! > 1 ? ` · 画板 ${project.boards.indexOf(candidate) + 1}` : "";
        return new Option(candidate.name + suffix + index, candidate.id);
      }));
      choices.value = selected;
      confirm.disabled = !choices.value;
      choices.hidden = matches.length === 0;
      empty.hidden = !choices.hidden;
      empty.textContent = candidates.length ? "没有匹配的画板。" : "没有可关联的画板。";
    }

    search.value = "";
    choices.replaceChildren();
    filterChoices();
    search.oninput = filterChoices;
    choices.onchange = () => { confirm.disabled = !choices.value; };
    const confirmed = await showDialog(picker);
    search.oninput = null;
    choices.onchange = null;
    return confirmed ? choices.value : undefined;
  }

  const board = () => project.boards.find(b => b.id === current)!;
  const boardCamera = (): Viewport => ({ ...(board().viewport ?? { x: 40, y: 50, scale: 1 }) });
  let camera = boardCamera();
  function save(replace = false): boolean {
    if (protectStorage) {
      status.textContent = readError;
      return false;
    }
    try {
      if (!replace && localStorage.getItem(key) !== lastSaved) {
        status.textContent = "已保存的工程在此页面之外发生了变化。请先导出当前改动，再刷新页面。";
        return false;
      }
      const serialized = JSON.stringify(project);
      localStorage.setItem(key, serialized);
      lastSaved = serialized;
      status.textContent = "设计工程已保存到当前浏览器";
      return true;
    } catch {
      status.textContent = "无法保存工程，请导出 JSON 备份。";
      return false;
    }
  }
  function saveCamera(): void {
    board().viewport = { ...camera };
    save();
  }
  function appendBoard(name: string): Board {
    if (project.boards.length >= MAX_BOARDS) throw new Error("工程画板数已达上限。");
    const added = newBoard(name);
    project.boards.push(added);
    return added;
  }
  function showError(error: unknown): void {
    status.textContent = error instanceof Error ? error.message : "未能完成操作。";
  }
  function cameraDraw(): void { world.style.transform = `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})`; el<HTMLElement>(".flow-zoom").textContent = `${Math.round(camera.scale*100)}%`; let grid = 24*camera.scale; while (grid < 12) grid *= 2; canvas.style.backgroundSize = `${grid}px ${grid}px`; canvas.style.backgroundPosition = `${camera.x}px ${camera.y}px`; }
  function point(x: number, y: number) { const r = canvas.getBoundingClientRect(); return { x: (x-r.left-camera.x)/camera.scale, y: (y-r.top-camera.y)/camera.scale }; }
  function navigation(): void {
    selector.replaceChildren(); for (const b of project.boards) { const option = document.createElement("option"); option.value = b.id; option.textContent = `${b.name}${b.id === project.rootBoardId ? " · 根画板" : ""}`; selector.append(option); } selector.value = current;
    path.replaceChildren(); trail.forEach((boardId,index) => { if (index) path.append(" / "); const b = project.boards.find(item => item.id === boardId)!; const button = document.createElement("button"); button.dataset.trail = String(index); button.textContent = b.name; if (index === trail.length-1) button.setAttribute("aria-current", "page"); path.append(button); });
  }
  const cards = new Map<string, { node: DesignNode; element: HTMLButtonElement; layout: ReturnType<typeof layoutNode> }>();
  const dots = new Map<string, HTMLElement>();
  const wirePreview = document.createElementNS(svg, "path");
  wirePreview.setAttribute("class", "flow-wire is-preview");
  let targetDot: HTMLElement | undefined;
  function clearWirePreview(): void {
    targetDot?.classList.remove("is-target");
    targetDot = undefined;
    wirePreview.remove();
  }

  function wireDraw(): void {
    const paths = document.createDocumentFragment();
    for (const edge of board().edges) {
      const from = cards.get(edge.fromNodeId), to = cards.get(edge.toNodeId);
      const start = from?.layout.ports.get(edge.fromPortId), end = to?.layout.ports.get(edge.toPortId);
      if (!from || !to || !start || !end) continue;
      const style = edge.appearance?.pathStyle ?? DEFAULT_EDGE_APPEARANCE.pathStyle;
      const pathData = wirePath(start, end, style);
      const hit = document.createElementNS(svg, "path");
      hit.setAttribute("class", "flow-design-wire-hit");
      hit.dataset.edge = edge.id;
      hit.setAttribute("d", pathData);
      const hint = document.createElementNS(svg, "title");
      hint.textContent = `${from.node.title} → ${to.node.title} · ${semanticLabels[edge.semantic ?? "unspecified"]}`;
      hit.append(hint);
      const line = document.createElementNS(svg, "path");
      line.setAttribute("class", "flow-wire flow-design-wire");
      line.classList.toggle("is-selected", selection?.type === "edge" && selection.id === edge.id);
      line.dataset.lineStyle = edge.appearance?.lineStyle ?? DEFAULT_EDGE_APPEARANCE.lineStyle;
      line.dataset.pathStyle = style;
      line.setAttribute("d", pathData);
      paths.append(hit, line);
    }
    wires.replaceChildren(paths);
  }

  function nodeDraw(): void {
    const boardById = new Map(project.boards.map(item => [item.id, item]));
    nodes.replaceChildren();
    cards.clear();
    dots.clear();
    for (const n of board().nodes) {
      const layout = layoutNode(n);
      const card = document.createElement("button");
      card.type = "button";
      card.className = `flow-node kind-${n.visualStyle}`;
      card.classList.toggle("is-selected", selection?.type === "node" && selection.id === n.id);
      card.dataset.node = n.id;
      card.style.transform = `translate(${n.position.x}px, ${n.position.y}px)`;
      card.style.width = `${layout.width}px`;
      card.style.height = `${layout.height}px`;
      const header = document.createElement("span");
      header.className = "flow-node-head";
      const target = n.childBoardId ? boardById.get(n.childBoardId) : undefined;
      if (target) {
        const icon = document.createElement("i");
        icon.className = "flow-group-icon";
        icon.setAttribute("aria-hidden", "true");
        const label = document.createElement("span");
        label.className = "flow-group-target";
        label.textContent = target.name;
        const hint = document.createElement("span");
        hint.textContent = "双击进入";
        header.classList.add("flow-group-head");
        header.title = `节点组 · 双击进入「${target.name}」`;
        card.setAttribute("aria-label", `${n.title}，节点组，双击进入${target.name}`);
        header.append(icon, label, hint);
      } else {
        header.textContent = "设计卡片";
      }
      const title = document.createElement("strong");
      title.className = "flow-node-title";
      title.textContent = n.title;
      const subtitle = document.createElement("span");
      subtitle.className = "flow-node-subtitle";
      subtitle.textContent = n.subtitle;
      card.append(header, title, subtitle);
      const ports = document.createElement("span");
      ports.className = "flow-project-ports";
      for (const { port, kind, side, x, y } of layout.ports.values()) {
        const dot = document.createElement("span");
        dot.className = "flow-port";
        dot.dataset.side = side;
        dot.dataset.portKind = kind;
        dot.dataset.port = port.id;
        dot.style.left = `${x - n.position.x}px`;
        dot.style.top = `${y - n.position.y}px`;
        dot.title = `${kindLabels[kind]} · ${sideLabels[side]} · ${port.name}`;
        dots.set(port.id, dot);
        ports.append(dot);
      }
      card.append(ports);
      cards.set(n.id, { node: n, element: card, layout });
      nodes.append(card);
    }
  }
  function render(): void { navigation(); nodeDraw(); wireDraw(); cameraDraw(); }
  function fit(): void {
    if (!cards.size || !canvas.clientWidth || !canvas.clientHeight) return;
    const bounds = Array.from(cards.values(), card => card.layout.bounds);
    const left = Math.min(...bounds.map(box => box.left)), right = Math.max(...bounds.map(box => box.right));
    const top = Math.min(...bounds.map(box => box.top)), bottom = Math.max(...bounds.map(box => box.bottom));
    camera.scale = clamp(Math.min((canvas.clientWidth - 80) / (right - left), (canvas.clientHeight - 80) / (bottom - top)), .12, 1);
    camera.x = clamp((canvas.clientWidth - (right - left) * camera.scale) / 2 - left * camera.scale, -100000, 100000);
    camera.y = clamp((canvas.clientHeight - (bottom - top) * camera.scale) / 2 - top * camera.scale, -100000, 100000);
    cameraDraw();
  }
  function zoom(factor: number,x: number,y: number): void { const scale = clamp(camera.scale*factor,.12,2), ratio = scale/camera.scale; camera.x=clamp(x-(x-camera.x)*ratio,-99000,99000); camera.y=clamp(y-(y-camera.y)*ratio,-99000,99000); camera.scale=scale; cameraDraw(); }
  function cancelPendingGroupClick(): void {
    if (pendingGroupClick) window.clearTimeout(pendingGroupClick.timer);
    pendingGroupClick = undefined;
  }
  function switchBoard(id: string, nextTrail: string[]): void {
    cancelPendingGroupClick();
    const activeDrag = drag;
    drag = undefined;
    if (activeDrag && canvas.hasPointerCapture(activeDrag.pointer)) canvas.releasePointerCapture(activeDrag.pointer);
    clearWirePreview();
    current = id;
    trail = nextTrail;
    selection = undefined;
    inspector.classList.remove("is-open");
    menu.hidden = true;
    camera = boardCamera();
    render();
    if (!board().viewport) fit();
  }
  function enterGroup(node: DesignNode): void {
    const id = node.childBoardId;
    if (id && project.boards.some(candidate => candidate.id === id)) switchBoard(id, [...trail, id]);
  }
  function groupControls(source: Board, node: DesignNode): HTMLElement {
    const group = document.createElement("section");
    group.className = "flow-project-group";
    const title = document.createElement("h3");
    title.textContent = "节点组";
    group.append(title);
    function action(label: string, run: () => void): void {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "flow-enter";
      button.textContent = label;
      button.addEventListener("click", run);
      group.append(button);
    }
    const target = project.boards.find(candidate => candidate.id === node.childBoardId);
    if (target) {
      const name = document.createElement("p");
      name.textContent = `已关联「${target.name}」`;
      group.append(name);
      action("进入画板 ↗", () => enterGroup(node));
    } else {
      action("创建节点组", () => {
        try {
          node.childBoardId = appendBoard(node.title).id;
          save();
          enterGroup(node);
        } catch (error) {
          showError(error);
        }
      });
    }
    action("关联已有画板", async () => {
      const targetId = await chooseBoard(source, node);
      if (!targetId) return;
      try {
        linkBoard(project, source, node, targetId);
        save();
        showEditor(node.id);
      } catch (error) {
        showError(error);
      }
    });
    if (target) {
      action("解除节点组关联", () => {
        delete node.childBoardId;
        save();
        showEditor(node.id);
      });
    }
    return group;
  }
  function showEditor(nodeId: string): void {
    const source = board();
    const n = source.nodes.find(item => item.id === nodeId);
    if (!n) return;
    cancelPendingGroupClick();
    selection = { type: "node", id: nodeId };
    nodeDraw();
    body.replaceChildren(groupControls(source, n));
    const form = document.createElement("form"); form.className="flow-editor-form";
    for (const [labelText,name,value] of [["标题","title",n.title],["副标题","subtitle",n.subtitle]]) { const label=document.createElement("label"); label.textContent=labelText!; const input=document.createElement("input"); input.name=name!; input.value=value!; input.maxLength=120; if(name==="title") input.required=true; label.append(input); form.append(label); }
    const label=document.createElement("label"); label.textContent="类别颜色"; const colors=document.createElement("select"); colors.name="color"; for (const [value,text] of [["context","蓝"],["input","青"],["prompt","橙"],["model","紫"],["tool","玫红"],["output","绿"]]) colors.add(new Option(text,value)); colors.value=n.visualStyle; label.append(colors); form.append(label);
    const submit=document.createElement("button"); submit.type="submit"; submit.textContent="保存修改"; form.append(submit); form.addEventListener("submit",e => { e.preventDefault(); const data=new FormData(form), title=String(data.get("title")??"").trim(); if(!title)return; n.title=title; n.subtitle=String(data.get("subtitle")??"").trim(); n.visualStyle=String(data.get("color")); save(); render(); }); body.append(form);
    for (const kind of ["input", "output"] as const) {
      const ports = kind === "input" ? n.inputPorts : n.outputPorts;
      const heading = document.createElement("h3");
      heading.textContent = `${kindLabels[kind]}端口`;
      body.append(heading);
      for (const [index, port] of ports.entries()) {
        const row = document.createElement("div");
        row.className = "flow-project-port-row";
        row.dataset.editPort = port.id;
        const label = `${kindLabels[kind]}端口 ${index + 1}`;
        const input = document.createElement("input");
        input.value = port.name;
        input.maxLength = 40;
        input.setAttribute("aria-label", `${label}名称`);
        input.addEventListener("change", () => { port.name = input.value.trim(); save(); nodeDraw(); });
        const side = selectControl(`${label}方位`, PORT_SIDES, sideLabels, portSide(port, kind), next => {
          port.side = next;
          save();
          nodeDraw();
          wireDraw();
        });
        const del = document.createElement("button");
        del.type = "button";
        del.textContent = "删除";
        del.setAttribute("aria-label", `删除${label}`);
        del.addEventListener("click", () => {
          removePort(source, n, port.id);
          save();
          showEditor(n.id);
        });
        row.append(input, side, del);
        body.append(row);
      }
      const add = document.createElement("button");
      add.type = "button";
      add.className = "flow-enter";
      add.textContent = `新增${kindLabels[kind]}端口`;
      add.disabled = ports.length >= MAX_PORTS_PER_KIND;
      add.addEventListener("click", () => {
        ports.push({ id: newId(), name: kindLabels[kind] });
        save();
        showEditor(n.id);
      });
      body.append(add);
    }
    showInspector("编辑卡片", "删除卡片");
    wireDraw();
  }
  function showInspector(title: string, deleteLabel: string): void {
    el<HTMLElement>(".flow-inspector-top span").textContent = title;
    inspector.setAttribute("aria-label", title);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "flow-enter";
    remove.textContent = deleteLabel;
    remove.addEventListener("click", deleteSelection);
    body.append(remove);
    inspector.classList.add("is-open");
  }
  function showEdgeEditor(id: string): void {
    const edge = board().edges.find(item => item.id === id);
    if (!edge) return;
    selection = { type: "edge", id };
    nodeDraw();
    wireDraw();
    body.replaceChildren();
    const describePort = (nodeId: string, portId: string) => {
      const card = cards.get(nodeId)!;
      return `${card.node.title} · ${card.layout.ports.get(portId)!.port.name}`;
    };
    const summary = document.createElement("p");
    summary.className = "flow-detail-description flow-project-edge-summary";
    summary.textContent = `${describePort(edge.fromNodeId, edge.fromPortId)} → ${describePort(edge.toNodeId, edge.toPortId)}`;
    const settings = document.createElement("div");
    settings.className = "flow-editor-form";
    function field(labelText: string, select: HTMLSelectElement): void {
      const label = document.createElement("label");
      label.textContent = labelText;
      label.append(select);
      settings.append(label);
    }
    field("线型", selectControl("线型", LINE_STYLES, lineLabels, edge.appearance?.lineStyle ?? DEFAULT_EDGE_APPEARANCE.lineStyle, lineStyle => {
      edge.appearance = { ...edge.appearance, lineStyle };
      save();
      wireDraw();
    }));
    field("路径风格", selectControl("路径风格", PATH_STYLES, pathLabels, edge.appearance?.pathStyle ?? DEFAULT_EDGE_APPEARANCE.pathStyle, pathStyle => {
      edge.appearance = { ...edge.appearance, pathStyle };
      save();
      wireDraw();
    }));
    field("连接语义", selectControl("连接语义", EDGE_SEMANTICS, semanticLabels, edge.semantic ?? "unspecified", semantic => {
      edge.semantic = semantic;
      save();
      wireDraw();
    }));
    body.append(summary, settings);
    showInspector("编辑连线", "删除连线");
  }
  function deleteSelection(): void {
    if (!selection) return;
    cancelPendingGroupClick();
    const { id, type } = selection;
    if (type === "node") removeNode(board(), id);
    else board().edges = board().edges.filter(edge => edge.id !== id);
    selection = undefined;
    inspector.classList.remove("is-open");
    save();
    render();
  }
  function duplicate(): void {
    if (selection?.type !== "node") return;
    const n = board().nodes.find(item => item.id === selection!.id);
    if (!n) return;
    try {
      const copy = copyNode(project, board(), n);
      save();
      render();
      showEditor(copy.id);
    } catch (error) {
      showError(error);
    }
  }
  function addNode(group: boolean): void {
    const source = board();
    if (source.nodes.length >= MAX_NODES_PER_BOARD) throw new Error("当前画板的卡片数已达上限。");
    const rect = canvas.getBoundingClientRect();
    const p = point(rect.left + canvas.clientWidth / 2, rect.top + canvas.clientHeight / 2);
    const n = newNode(group ? "新节点组" : "新卡片", clamp(p.x - CARD_WIDTH / 2, -99000, 99000), clamp(p.y - CARD_HEIGHT / 2, -99000, 99000));
    if (group) n.childBoardId = appendBoard(n.title).id;
    source.nodes.push(n);
    save();
    render();
    showEditor(n.id);
  }
  function portAt(clientX: number, clientY: number): PositionedPort | undefined {
    const hit = document.elementFromPoint(clientX, clientY);
    if (!hit || !canvas.contains(hit)) return;
    const cardId = hit.closest<HTMLElement>("[data-node]")?.dataset.node;
    const dotId = hit.closest<HTMLElement>("[data-port]")?.dataset.port;
    if (cardId && dotId) {
      const card = cards.get(cardId);
      const anchor = card?.layout.ports.get(dotId);
      if (card && anchor) return { node: card.node, anchor };
    }
    const cursor = point(clientX, clientY);
    const radius = 9 / camera.scale;
    let nearest: PositionedPort | undefined;
    let distance = radius ** 2;
    for (const { node, layout } of cards.values()) {
      const box = layout.bounds;
      if ((cardId && node.id !== cardId) || cursor.x < box.left - radius || cursor.x > box.right + radius
        || cursor.y < box.top - radius || cursor.y > box.bottom + radius) continue;
      for (const anchor of layout.ports.values()) {
        const squared = (cursor.x - anchor.x) ** 2 + (cursor.y - anchor.y) ** 2;
        if (squared < distance) {
          nearest = { node, anchor };
          distance = squared;
        }
      }
    }
    return nearest;
  }
  function wireDestination(e: PointerEvent, from: PositionedPort): PositionedPort | undefined {
    const to = portAt(e.clientX, e.clientY);
    if (to?.anchor.kind === "input" && canConnect(board(), from.node, from.anchor.port, to.node, to.anchor.port)) return to;
  }

  canvas.addEventListener("pointerdown", e => {
    if (e.button !== 0) return;
    if (drag) {
      if (drag.pointer !== e.pointerId || canvas.hasPointerCapture(e.pointerId)) return;
      finish(e, true);
    }
    menu.hidden = true;
    canvas.focus({ preventScroll: true });
    const target = e.target as Element;
    const port = portAt(e.clientX, e.clientY);
    const edge = target.closest<SVGElement>("[data-edge]");
    const card = target.closest<HTMLElement>("[data-node]");
    const node = port?.node ?? cards.get(card?.dataset.node ?? "")?.node;
    if (port || pendingGroupClick?.id !== node?.id) cancelPendingGroupClick();
    if (edge && !port) {
      showEdgeEditor(edge.dataset.edge!);
      e.preventDefault();
      return;
    }
    if (port?.anchor.kind === "input") return;
    const start = { pointer: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
    inspector.classList.remove("is-open");
    if (node) {
      selection = { type: "node", id: node.id };
      drag = port ? { ...start, type: "wire", from: port } : { ...start, type: "node", node, ox: node.position.x, oy: node.position.y };
    } else {
      selection = undefined;
      drag = { ...start, type: "pan", ox: camera.x, oy: camera.y };
    }
    // Keep the original pointer target mounted while transferring capture to the canvas.
    for (const [id, card] of cards) card.element.classList.toggle("is-selected", id === node?.id);
    wires.querySelector(".flow-design-wire.is-selected")?.classList.remove("is-selected");
    canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  // Keep receiving the gesture inside the page if the browser releases capture mid-drag.
  document.addEventListener("pointermove", e => {
    if (!drag || drag.pointer !== e.pointerId) return;
    if (!(e.buttons & 1)) {
      finish(e, true);
      return;
    }
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.hypot(dx, dy) > 3) drag.moved = true;
    if (drag.type === "wire") {
      const to = wireDestination(e, drag.from);
      const nextDot = to && dots.get(to.anchor.port.id);
      if (targetDot !== nextDot) {
        targetDot?.classList.remove("is-target");
        targetDot = nextDot;
        targetDot?.classList.add("is-target");
      }
      const from = drag.from.anchor;
      wirePreview.setAttribute("d", to ? wirePath(from, to.anchor, "bezier") : freeWirePreview(from, point(e.clientX, e.clientY)));
      if (!wirePreview.parentNode) wires.append(wirePreview);
    } else if (drag.type === "node" && drag.moved) {
      const node = drag.node;
      node.position = {
        x: clamp(drag.ox + dx / camera.scale, -99000, 99000),
        y: clamp(drag.oy + dy / camera.scale, -99000, 99000),
      };
      const card = cards.get(node.id)!;
      card.element.style.transform = `translate(${node.position.x}px, ${node.position.y}px)`;
      card.layout = layoutNode(node);
      wireDraw();
    } else if (drag.type === "pan" && drag.moved) {
      camera.x = clamp(drag.ox + dx, -99000, 99000);
      camera.y = clamp(drag.oy + dy, -99000, 99000);
      cameraDraw();
    }
  });
  function finish(e: PointerEvent, cancel: boolean): void {
    if (!drag || drag.pointer !== e.pointerId) return;
    const d = drag;
    drag = undefined;
    if (d.type === "wire") {
      clearWirePreview();
      const to = cancel ? undefined : wireDestination(e, d.from);
      if (to && connect(board(), d.from.node, d.from.anchor.port, to.node, to.anchor.port)) {
        save();
        wireDraw();
      }
      return;
    }
    if (d.moved) {
      cancelPendingGroupClick();
      if (d.type === "pan") saveCamera();
      else save();
      return;
    }
    if (cancel || d.type !== "node") return;
    const node = d.node;
    if (!node.childBoardId) {
      showEditor(node.id);
    } else if (pendingGroupClick?.id === node.id) {
      enterGroup(node);
    } else {
      // Opening the inspector on the first click can cover the card before the second click.
      pendingGroupClick = { id: node.id, timer: window.setTimeout(() => showEditor(node.id), 400) };
    }
  }
  document.addEventListener("pointerup", e => finish(e, false));
  document.addEventListener("pointercancel", e => finish(e, true));
  canvas.addEventListener("lostpointercapture", e => {
    if (!(e.buttons & 1)) finish(e, true);
  });
  canvas.addEventListener("wheel",e=>{e.preventDefault();const r=canvas.getBoundingClientRect();zoom(Math.exp(-e.deltaY*.0015),e.clientX-r.left,e.clientY-r.top);saveCamera();},{passive:false});
  canvas.addEventListener("contextmenu", e => {
    const card = (e.target as Element).closest<HTMLElement>("[data-node]");
    const node = board().nodes.find(item => item.id === card?.dataset.node);
    if (!node) return;
    e.preventDefault();
    cancelPendingGroupClick();
    selection = { type: "node", id: node.id };
    nodeDraw();
    wireDraw();
    const r = root.getBoundingClientRect();
    menu.style.left = `${clamp(e.clientX - r.left, 0, Math.max(0, r.width - 165))}px`;
    menu.style.top = `${clamp(e.clientY - r.top, 0, Math.max(0, r.height - 110))}px`;
    menu.querySelector('[data-action="duplicate"]')!.textContent = node.childBoardId ? "复制节点组（独立副本）" : "复制卡片";
    menu.hidden = false;
  });
  nodes.addEventListener("click", e => {
    if (e.detail !== 0) return;
    const card = (e.target as Element).closest<HTMLButtonElement>("[data-node]");
    if (card?.dataset.node) {
      showEditor(card.dataset.node);
      body.querySelector("button")?.focus();
    }
  });
  selector.addEventListener("change",()=>switchBoard(selector.value,[selector.value]));
  root.addEventListener("keydown", e => {
    if ((e.target as Element).closest("input,textarea,select,dialog")) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d" && selection?.type === "node") {
      e.preventDefault();
      duplicate();
    } else if ((e.key === "Delete" || e.key === "Backspace") && selection) {
      e.preventDefault();
      deleteSelection();
    } else if (e.key === "Escape") {
      cancelPendingGroupClick();
      menu.hidden = true;
      inspector.classList.remove("is-open");
    }
  });
  function replaceProject(next: FlowDesignProject): boolean {
    if (protectStorage) {
      status.textContent = readError;
      return false;
    }
    project = next;
    switchBoard(project.rootBoardId, [project.rootBoardId]);
    return save(true);
  }
  file.addEventListener("change", async () => {
    const chosen = file.files?.[0];
    file.value = "";
    if (!chosen) return;
    try {
      if (chosen.size > MAX_FILE_SIZE) throw new Error("工程文件不能超过 5 MB。");
      const imported = parseProject(JSON.parse(await chosen.text()));
      if (!await ask("导入将替换当前设计工程。请先导出需要保留的内容。继续吗？")) return;
      if (replaceProject(imported)) status.textContent = "工程导入成功，已保存在当前浏览器。";
    } catch (error) {
      const message = error instanceof SyntaxError ? "JSON 格式无效。" : error instanceof Error ? error.message : "导入失败。";
      status.textContent = `${message} 当前工程未改变。`;
    }
  });
  async function deleteBoard(): Promise<void> {
    const id = current;
    if (id === project.rootBoardId) throw new Error("不能删除根画板。");
    const references = boardReferences(project, id);
    if (references.length) {
      const locations = references.map(({ board, node }) => `「${board.name}」 → 「${node.title}」`);
      await ask(`请先解除以下 ${references.length} 个节点的关联，再删除「${board().name}」。`, { details: locations });
      return;
    }
    if (!await ask(`删除「${board().name}」及其内部卡片和连线？它引用的其他画板会保留。`)) return;
    removeBoard(project, id);
    switchBoard(project.rootBoardId, [project.rootBoardId]);
    save();
  }

  root.addEventListener("click", async e => {
    const target = (e.target as Element).closest<HTMLElement>("[data-action], [data-trail]");
    if (!target) return;
    menu.hidden = true;
    if (target.dataset.trail !== undefined) {
      const index = Number(target.dataset.trail);
      switchBoard(trail[index]!, trail.slice(0, index + 1));
      return;
    }
    const action = target.dataset.action;
    try {
      if (action === "new-project") {
        if (!await ask("新建工程将替换当前工程。请先导出需要保留的内容。继续吗？")) return;
        const b = newBoard("主画板");
        replaceProject({ schemaVersion: 1, projectId: newId(), projectName: "新设计工程", rootBoardId: b.id, boards: [b] });
      } else if (action === "add-board") {
        const name = await ask("画板名称", { initial: "新画板" });
        if (!name) return;
        const b = appendBoard(name);
        switchBoard(b.id, [b.id]);
        save();
      } else if (action === "rename-board") {
        const source = board();
        const name = await ask("画板名称", { initial: source.name });
        if (!name) return;
        source.name = name;
        save();
        render();
      } else if (action === "root-board") {
        project.rootBoardId = current;
        save();
        render();
      } else if (action === "delete-board") {
        await deleteBoard();
      } else if (action === "add-node" || action === "add-group") {
        addNode(action === "add-group");
      } else if (action === "duplicate") {
        duplicate();
      } else if (action === "delete") {
        deleteSelection();
      } else if (action === "edit" && selection?.type === "node") {
        showEditor(selection.id);
      } else if (action === "dismiss") {
        inspector.classList.remove("is-open");
      } else if (action === "fit") {
        fit();
        saveCamera();
      } else if (action === "plus" || action === "minus") {
        zoom(action === "plus" ? 1.2 : 1 / 1.2, canvas.clientWidth / 2, canvas.clientHeight / 2);
        saveCamera();
      } else if (action === "import") {
        file.click();
      } else if (action === "export") {
        const format = { type: "application/json" };
        const formatted = new Blob([JSON.stringify(project, null, 2)], format);
        const blob = formatted.size <= MAX_FILE_SIZE ? formatted : new Blob([JSON.stringify(project)], format);
        if (blob.size > MAX_FILE_SIZE) status.textContent = "已导出备份。工程超过 5 MB 导入上限。";
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${project.projectName.replace(/[\\/:*?"<>|]/g, "_")}.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (error) {
      showError(error);
    }
  });
  render();
  if (protectStorage) status.textContent = readError;
  else if (migrated) status.textContent = "已备份原设计并更新画板。";
  const resize = new ResizeObserver(() => { if (!board().viewport && canvas.clientWidth && canvas.clientHeight) fit(); });
  resize.observe(canvas);
}
