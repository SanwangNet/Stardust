type Card = { id: string; title: string; subtitle: string; kind: string; x: number; y: number; inputs: string[]; outputs: string[] };
type Wire = { id: string; from: string; to: string; output: string; input: string };
type Camera = { scale: number; x: number; y: number };
type Design = { version: 1; cards: Card[]; wires: Wire[]; camera: Camera | null };
type Snapshot = { nodes: { id: string; title: string; subtitle: string; kind: string; x: number; y: number }[]; edges: { from: string; to: string }[] };
const storageKey = "stardust.flow-design.v1";
const svg = "http://www.w3.org/2000/svg";
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
const id = () => crypto.randomUUID();

function initialDesign(snapshot: Snapshot): Design {
  const cards = snapshot.nodes.map(n => ({ ...n, inputs: ["input"], outputs: ["output"] }));
  const seen = new Set<string>();
  const wires: Wire[] = [];
  for (const edge of snapshot.edges) {
    const key = JSON.stringify([edge.from, edge.to]);
    if (!seen.has(key) && cards.some(c => c.id === edge.from) && cards.some(c => c.id === edge.to)) {
      seen.add(key); wires.push({ id: id(), ...edge, output: "output", input: "input" });
    }
  }
  return { version: 1, cards, wires, camera: null };
}

function readDesign(): Design | undefined {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "null");
    if (!value || typeof value !== "object") return;
    const d = value as Design;
    const validPoint = (n: number) => typeof n === "number" && Number.isFinite(n) && Math.abs(n) < 1000000;
    if (d.version !== 1 || !Array.isArray(d.cards) || !Array.isArray(d.wires) || !d.cards.every(c => c && typeof c.id === "string" && typeof c.title === "string" && typeof c.subtitle === "string" && typeof c.kind === "string" && validPoint(c.x) && validPoint(c.y) && Array.isArray(c.inputs) && c.inputs.length === 1 && c.inputs[0] === "input" && Array.isArray(c.outputs) && c.outputs.length === 1 && c.outputs[0] === "output")) return;
    const ids = new Set(d.cards.map(c => c.id));
    if (ids.size !== d.cards.length || !d.wires.every(w => w && typeof w.id === "string" && ids.has(w.from) && ids.has(w.to) && w.output === "output" && w.input === "input") || new Set(d.wires.map(w => w.id)).size !== d.wires.length || new Set(d.wires.map(w => JSON.stringify([w.from, w.output, w.to, w.input]))).size !== d.wires.length) return;
    if (d.camera !== null && (!d.camera || !validPoint(d.camera.x) || !validPoint(d.camera.y) || !validPoint(d.camera.scale) || d.camera.scale < .12 || d.camera.scale > 2)) return;
    return d;
  } catch { return; }
}

/** A local visual sketch. It never reads or writes publication or runtime state. */
export function openDesignBoard(root: HTMLElement, snapshot: () => Snapshot, close: () => void): void {
  const abort = new AbortController(), signal = abort.signal;
  let design = readDesign() ?? initialDesign(snapshot());
  let camera: Camera = design.camera ?? { scale: 1, x: 0, y: 0 };
  let selected: { type: "card" | "wire"; id: string } | undefined;
  let drag: { type: "card" | "pan" | "wire"; id?: string; pointer: number; x: number; y: number; ox: number; oy: number; moved: boolean } | undefined;
  root.innerHTML = `<header class="flow-toolbar"><div class="flow-heading"><h2>可视化流程 · 设计草稿</h2><p class="flow-view-note">仅保存在当前浏览器，用于自由设计</p></div><div class="flow-controls"><button data-design="add">新增卡片</button><button data-design="fit">适应视图</button><button data-design="reset">恢复初始设计</button><button data-design="close">返回真实执行视图</button></div></header><nav class="flow-path">主流程 / 设计草稿</nav><div class="flow-content"><div class="flow-canvas-wrap"><div class="flow-canvas" tabindex="0" aria-label="设计草稿画板：拖动卡片，拖动空白处平移，滚轮缩放"><div class="flow-world"><svg class="flow-wires" viewBox="-10000 -10000 20000 20000"></svg><div class="flow-nodes"></div></div></div><div class="flow-hud"><span>拖动端口连线 · Ctrl+D 复制 · Delete 删除</span><span class="flow-zoom"></span><button data-design="minus" aria-label="缩小">−</button><button data-design="plus" aria-label="放大">＋</button></div></div><aside class="flow-inspector" aria-label="编辑卡片"><div class="flow-inspector-top"><span>编辑卡片</span><button data-design="dismiss" aria-label="关闭">×</button></div><div class="flow-inspector-body"></div></aside></div><div class="flow-footer"><span class="flow-design-status" role="status"></span></div><div class="flow-design-menu" hidden><button data-design="duplicate">复制卡片</button><button data-design="edit">编辑卡片</button><button data-design="delete">删除卡片</button></div>`;
  const el = <T extends Element>(query: string) => root.querySelector<T>(query)!;
  const canvas = el<HTMLElement>(".flow-canvas"), world = el<HTMLElement>(".flow-world"), nodes = el<HTMLElement>(".flow-nodes"), wires = el<SVGSVGElement>(".flow-wires"), inspector = el<HTMLElement>(".flow-inspector"), body = el<HTMLElement>(".flow-inspector-body"), menu = el<HTMLElement>(".flow-design-menu"), status = el<HTMLElement>(".flow-design-status");
  function save(): void {
    design.camera = { ...camera };
    try { localStorage.setItem(storageKey, JSON.stringify(design)); status.textContent = "设计草稿已保存在当前浏览器"; }
    catch { status.textContent = "无法保存设计草稿，请检查浏览器存储。"; }
  }
  function drawCamera(): void {
    world.style.transform = `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})`;
    el<HTMLElement>(".flow-zoom").textContent = `${Math.round(camera.scale * 100)}%`;
    let grid = 24 * camera.scale; while (grid < 12) grid *= 2;
    canvas.style.backgroundSize = `${grid}px ${grid}px`; canvas.style.backgroundPosition = `${camera.x}px ${camera.y}px`;
  }
  function point(x: number, y: number): { x: number; y: number } {
    const rect = canvas.getBoundingClientRect(); return { x: (x - rect.left - camera.x) / camera.scale, y: (y - rect.top - camera.y) / camera.scale };
  }
  function curve(a: { x: number; y: number }, b: { x: number; y: number }): string {
    const reach = clamp(Math.hypot(b.x - a.x, b.y - a.y) * .42, 65, 200);
    return `M ${a.x} ${a.y} C ${a.x + reach} ${a.y}, ${b.x - reach} ${b.y}, ${b.x} ${b.y}`;
  }
  function renderWires(preview?: { from: string; x: number; y: number }): void {
    wires.replaceChildren();
    for (const edge of design.wires) {
      const a = design.cards.find(c => c.id === edge.from), b = design.cards.find(c => c.id === edge.to); if (!a || !b) continue;
      const d = curve({ x: a.x + 234, y: a.y + 63 }, { x: b.x, y: b.y + 63 });
      const hit = document.createElementNS(svg, "path"); hit.setAttribute("d", d); hit.setAttribute("class", "flow-design-wire-hit"); hit.dataset.wire = edge.id;
      const line = document.createElementNS(svg, "path"); line.setAttribute("d", d); line.setAttribute("class", `flow-wire flow-design-wire${selected?.type === "wire" && selected.id === edge.id ? " is-selected" : ""}`);
      wires.append(hit, line);
    }
    if (preview) { const a = design.cards.find(c => c.id === preview.from); if (a) { const line = document.createElementNS(svg, "path"); line.setAttribute("class", "flow-wire is-preview"); line.setAttribute("d", curve({ x: a.x + 234, y: a.y + 63 }, preview)); wires.append(line); } }
  }
  function renderCards(): void {
    nodes.replaceChildren();
    for (const card of design.cards) {
      const node = document.createElement("button"); node.type = "button";
      const kind = ["input", "context", "prompt", "agent", "model", "tool", "output"].includes(card.kind) ? card.kind : card.kind === "channel" ? "input" : card.kind === "group" ? "prompt" : "context";
      node.className = `flow-node kind-${kind}${selected?.type === "card" && selected.id === card.id ? " is-selected" : ""}`; node.dataset.card = card.id;
      node.style.transform = `translate(${card.x}px, ${card.y}px)`;
      for (const [cls, value] of [["flow-node-head", "设计卡片"], ["flow-node-title", card.title], ["flow-node-subtitle", card.subtitle]]) { const part = document.createElement(cls === "flow-node-title" ? "strong" : "span"); part.className = cls!; part.textContent = value!; node.append(part); }
      for (const side of ["input", "output"]) { const port = document.createElement("span"); port.className = `flow-port is-${side}`; port.dataset.designPort = side; port.title = side === "input" ? "输入端口" : "拖动输出端口以连线"; node.append(port); }
      nodes.append(node);
    }
  }
  function render(): void { renderCards(); renderWires(); drawCamera(); }
  function selectCard(cardId: string, edit = true): void {
    selected = { type: "card", id: cardId }; render();
    if (!edit) { inspector.classList.remove("is-open"); return; }
    const card = design.cards.find(c => c.id === cardId); if (!card) return;
    body.replaceChildren(); const form = document.createElement("form"); form.className = "flow-editor-form";
    const fields = [["标题", "title", card.title], ["副标题", "subtitle", card.subtitle]];
    for (const [labelText, name, value] of fields) { const label = document.createElement("label"); label.textContent = labelText!; const input = document.createElement("input"); input.name = name!; input.value = value!; input.maxLength = 120; if (name === "title") input.required = true; label.append(input); form.append(label); }
    const submit = document.createElement("button"); submit.type = "submit"; submit.textContent = "保存修改"; form.append(submit);
    form.addEventListener("submit", event => { event.preventDefault(); const values = new FormData(form), title = String(values.get("title") ?? "").trim(); if (!title) return; card.title = title; card.subtitle = String(values.get("subtitle") ?? "").trim(); save(); render(); }, { signal });
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "flow-enter"; remove.textContent = "删除卡片"; remove.addEventListener("click", deleteSelection, { signal }); body.append(form, remove); inspector.classList.add("is-open");
  }
  function duplicate(): void { if (selected?.type !== "card") return; const card = design.cards.find(c => c.id === selected?.id); if (!card) return; const copy = { ...card, id: id(), x: card.x + 32, y: card.y + 32, inputs: [...card.inputs], outputs: [...card.outputs] }; design.cards.push(copy); save(); selectCard(copy.id); }
  function deleteSelection(): void { if (!selected) return; if (selected.type === "card") { design.cards = design.cards.filter(c => c.id !== selected!.id); design.wires = design.wires.filter(w => w.from !== selected!.id && w.to !== selected!.id); } else design.wires = design.wires.filter(w => w.id !== selected!.id); selected = undefined; inspector.classList.remove("is-open"); save(); render(); }
  function fit(): void { if (!design.cards.length || !canvas.clientWidth || !canvas.clientHeight) return; const left = Math.min(...design.cards.map(c => c.x)), top = Math.min(...design.cards.map(c => c.y)), right = Math.max(...design.cards.map(c => c.x + 234)), bottom = Math.max(...design.cards.map(c => c.y + 126)); camera.scale = clamp(Math.min((canvas.clientWidth - 80) / (right - left), (canvas.clientHeight - 80) / (bottom - top)), .12, 1); camera.x = (canvas.clientWidth - (right - left) * camera.scale) / 2 - left * camera.scale; camera.y = (canvas.clientHeight - (bottom - top) * camera.scale) / 2 - top * camera.scale; drawCamera(); }
  function zoom(factor: number, x: number, y: number): void { const scale = clamp(camera.scale * factor, .12, 2), ratio = scale / camera.scale; camera.x = x - (x - camera.x) * ratio; camera.y = y - (y - camera.y) * ratio; camera.scale = scale; drawCamera(); }
  canvas.addEventListener("pointerdown", e => {
    if (e.button !== 0) return; menu.hidden = true;
    canvas.focus({ preventScroll: true });
    const target = e.target as Element, wire = target.closest<SVGElement>("[data-wire]");
    if (wire) { selected = { type: "wire", id: wire.dataset.wire! }; inspector.classList.remove("is-open"); render(); canvas.focus(); return; }
    const node = target.closest<HTMLElement>("[data-card]"), card = design.cards.find(c => c.id === node?.dataset.card), port = target.closest<HTMLElement>("[data-design-port]");
    if (port?.dataset.designPort === "input") return;
    if (card) { selectCard(card.id, false); drag = { type: port ? "wire" : "card", id: card.id, pointer: e.pointerId, x: e.clientX, y: e.clientY, ox: card.x, oy: card.y, moved: false }; }
    else { selected = undefined; inspector.classList.remove("is-open"); render(); drag = { type: "pan", pointer: e.pointerId, x: e.clientX, y: e.clientY, ox: camera.x, oy: camera.y, moved: false }; }
    canvas.setPointerCapture(e.pointerId); e.preventDefault();
  }, { signal });
  canvas.addEventListener("pointermove", e => {
    if (!drag || e.pointerId !== drag.pointer) return; const dx = e.clientX - drag.x, dy = e.clientY - drag.y; if (Math.hypot(dx, dy) > 3) drag.moved = true;
    if (drag.type === "wire") { const p = point(e.clientX, e.clientY); renderWires({ from: drag.id!, ...p }); }
    else if (drag.type === "card" && drag.moved) { const card = design.cards.find(c => c.id === drag?.id); if (card) { card.x = drag.ox + dx / camera.scale; card.y = drag.oy + dy / camera.scale; const node = Array.from(nodes.children).find(n => (n as HTMLElement).dataset.card === card.id) as HTMLElement | undefined; if (node) node.style.transform = `translate(${card.x}px, ${card.y}px)`; renderWires(); } }
    else if (drag.type === "pan" && drag.moved) { camera.x = drag.ox + dx; camera.y = drag.oy + dy; drawCamera(); }
  }, { signal });
  function finish(e: PointerEvent, cancel: boolean): void {
    if (!drag || e.pointerId !== drag.pointer) return; const active = drag; drag = undefined;
    if (!cancel && active.type === "wire") { const target = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-design-port="input"]'), to = target?.closest<HTMLElement>("[data-card]")?.dataset.card; if (to && to !== active.id && !design.wires.some(w => w.from === active.id && w.to === to && w.output === "output" && w.input === "input")) { design.wires.push({ id: id(), from: active.id!, to, output: "output", input: "input" }); save(); } renderWires(); }
    else if (active.type === "wire") renderWires();
    else if (active.moved) save();
    else if (!cancel && active.type === "card") selectCard(active.id!);
  }
  canvas.addEventListener("pointerup", e => finish(e, false), { signal }); canvas.addEventListener("pointercancel", e => finish(e, true), { signal });
  canvas.addEventListener("wheel", e => { e.preventDefault(); const r = canvas.getBoundingClientRect(); zoom(Math.exp(-e.deltaY * .0015), e.clientX-r.left, e.clientY-r.top); save(); }, { signal, passive: false });
  canvas.addEventListener("contextmenu", e => { const card = (e.target as Element).closest<HTMLElement>("[data-card]"); if (!card) return; e.preventDefault(); selectCard(card.dataset.card!, false); const rect = root.getBoundingClientRect(); menu.style.left = `${clamp(e.clientX - rect.left, 0, Math.max(0, rect.width - 130))}px`; menu.style.top = `${clamp(e.clientY - rect.top, 0, Math.max(0, rect.height - 110))}px`; menu.hidden = false; }, { signal });
  root.addEventListener("keydown", e => { if ((e.target as Element).closest("input, textarea, select")) return; if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d" && selected?.type === "card") { e.preventDefault(); duplicate(); } else if ((e.key === "Delete" || e.key === "Backspace") && selected) { e.preventDefault(); deleteSelection(); } else if (e.key === "Escape") { menu.hidden = true; inspector.classList.remove("is-open"); } }, { signal });
  root.addEventListener("click", e => { e.stopPropagation(); const action = (e.target as Element).closest<HTMLElement>("[data-design]")?.dataset.design; menu.hidden = true; if (!action) return;
    if (action === "close") { abort.abort(); close(); }
    else if (action === "add") { const p = point(canvas.getBoundingClientRect().left + canvas.clientWidth / 2, canvas.getBoundingClientRect().top + canvas.clientHeight / 2); const card: Card = { id: id(), title: "新卡片", subtitle: "", kind: "context", x: p.x - 117, y: p.y - 63, inputs: ["input"], outputs: ["output"] }; design.cards.push(card); save(); selectCard(card.id); }
    else if (action === "duplicate") duplicate(); else if (action === "delete") deleteSelection(); else if (action === "edit" && selected?.type === "card") selectCard(selected.id);
    else if (action === "dismiss") inspector.classList.remove("is-open");
    else if (action === "fit") { fit(); save(); }
    else if (action === "plus" || action === "minus") { zoom(action === "plus" ? 1.2 : 1/1.2, canvas.clientWidth / 2, canvas.clientHeight / 2); save(); }
    else if (action === "reset" && window.confirm("恢复初始设计？当前浏览器中的设计草稿将被替换。")) { design = initialDesign(snapshot()); selected = undefined; inspector.classList.remove("is-open"); render(); fit(); save(); }
  }, { signal });
  render(); requestAnimationFrame(() => { if (!design.camera) { fit(); save(); } });
}
