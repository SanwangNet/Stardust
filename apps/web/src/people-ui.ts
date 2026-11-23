type Row = Record<string, string | number | null>;
type Page<T = Row> = { items: T[]; hasMore: boolean; offset: number; limit: number };
type Kind = "people" | "spaces";
type Tab = "profile" | "identities" | "groups" | "history" | "overview" | "members";
type Detail = { kind: Kind; id: string; tab: Tab; row?: Row; summary?: Row };
type View = { signal: AbortSignal; active(): boolean };
type BatchPreview = {
  source: Row; target: Row | null; identities: Row[]; spaceCount: number;
  membershipCount: number; fingerprint: string; final?: { manualName: string | null; note: string | null };
};
type Audit = {
  id: string; operation: string; createdAt: string; reason: string | null; sourcePersonId: string | null;
  targetPersonId: string | null; before: Record<string, unknown>; after: Record<string, unknown>;
  canUndo: boolean; undone?: number;
};

const PAGE_SIZE = 20;
const short = (id: unknown) => typeof id === "string" ? id.slice(0, 8) : "—";
const date = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleDateString("zh-CN") : "暂无记录";
const time = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString("zh-CN") : "暂无记录";
const provider = (value: unknown) => String(value || "").split(",").filter(Boolean).map(name => name === "qq" ? "QQ" : name === "web" ? "Web" : "其他平台").join("、") || "暂无平台记录";
const identity = (value: unknown) => value === "qq_c2c_user" ? "QQ 私聊身份" : value === "qq_group_member" ? "QQ 群成员身份" : "平台身份";
const title = (row: Row, space = false) => String(row.displayName || (space ? "未命名群组" : "未知姓名"));
const spacePlatform = (row: Row) => row.providerId === "qq" ? "QQ 群聊" : `${provider(row.providerId)} · 交流空间`;
const personStatus = (row: Row) => row.mergedIntoId ? "已合并" : row.status === "confirmed" ? "已确认" : "待确认";
const counts = (row: Row) => `${row.identityCount} 个平台身份 · ${row.spaceCount ? `${row.spaceCount} 个已观察群组` : "尚无群组记录"}`;
const sources: Record<string, string> = { message_sender: "平台消息发送者", manual: "人工维护", manual_confirmation: "人工确认", platform_verified: "平台验证" };
const auditLabels: Record<string, string> = {
  name_set: "更新人物名称", name_clear: "清除人工名称", note_set: "更新人物备注",
  identity_reassign: "关联平台身份", identity_detach: "解除身份关联", identity_undo: "撤销身份变更",
  person_merge: "合并人物", person_split: "拆分身份", person_merge_undo: "恢复合并",
};
const tabLabels: Record<Tab, string> = { profile: "资料", identities: "身份", groups: "群组", history: "历史", overview: "概要", members: "已观察成员" };

function node<K extends keyof HTMLElementTagNameMap>(tag: K, text = "", className = ""): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (text) element.textContent = text;
  if (className) element.className = className;
  return element;
}
function button(label: string, action: () => void, primary = false): HTMLButtonElement {
  const element = node("button", label, primary ? "setup-primary" : "setup-secondary");
  element.type = "button";
  element.addEventListener("click", action);
  return element;
}
function avatar(row: Row, space: boolean): string {
  return space ? "#" : Array.from(String(row.displayName || "？"))[0]!.toUpperCase();
}
function facts(items: [string, string][]): HTMLElement {
  const list = node("dl", "", "people-facts");
  for (const [label, value] of items) {
    const pair = node("div");
    pair.append(node("dt", label), node("dd", value));
    list.append(pair);
  }
  return list;
}
function menu(label: string, items: [string, () => void][]): HTMLElement {
  const menu = node("details", "", "people-menu");
  const summary = node("summary", label, "setup-secondary");
  const options = node("div", "", "people-menu-options");
  for (const [name, select] of items) {
    options.append(button(name, () => { menu.open = false; select(); }));
  }
  menu.append(summary, options);
  return menu;
}
function paging(target: HTMLElement, page: Page<unknown>, go: (offset: number) => void): void {
  target.replaceChildren();
  target.hidden = !page.offset && !page.hasMore;
  if (target.hidden) return;
  if (page.offset) target.append(button("上一页", () => go(Math.max(0, page.offset - page.limit))));
  if (page.items.length) target.append(node("span", `第 ${page.offset + 1}–${page.offset + page.items.length} 条`));
  if (page.hasMore) target.append(button("下一页", () => go(page.offset + page.limit)));
}
function errorText(error: unknown): string {
  switch (error instanceof Error ? error.message : "") {
    case "AUTH": return "无法访问本机控制端，请检查监听地址和访问来源。";
    case "NOT_FOUND": return "记录不存在或已不可用，请刷新。";
    case "CONFLICT": return "资料或身份归属已变化，请重新加载后确认。";
    case "INVALID_INPUT": return "请检查输入长度、操作原因和平台标识。";
    case "BATCH_LIMIT": return "身份数量超过单次操作上限（100 个）。";
    default: return "读取失败，请稍后重试。";
  }
}

export function initializePeopleUI(): void {
  const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const page = document.querySelector<HTMLElement>(".people-page")!;
  const query = el<HTMLInputElement>("people-query"), state = el<HTMLSelectElement>("people-state");
  const list = el("people-list"), pages = el("people-pagination"), status = el("people-status");
  const personTab = el<HTMLButtonElement>("people-tab-person"), spaceTab = el<HTMLButtonElement>("people-tab-space");
  const dialog = el<HTMLDialogElement>("people-dialog"), heading = el("people-dialog-title");
  const summary = el("people-dialog-summary"), portrait = el("people-dialog-avatar");
  const nav = el("people-dialog-nav"), actions = el("people-dialog-actions"), content = el("people-dialog-content");
  const feedback = el("people-dialog-status"), discard = el("people-dialog-discard"), close = el<HTMLButtonElement>("people-dialog-close");

  let kind: Kind = "people", search = "", offset = 0, listRequest: AbortController | undefined;
  let controlToken = "";
  let current: Detail | undefined, viewRequest: AbortController | undefined, opener: HTMLButtonElement | undefined;
  let dirty = false, submitting = false, needsRefresh = false;
  const history: Detail[] = [];

  async function request<T>(path: string, method = "GET", body?: unknown, signal?: AbortSignal): Promise<T> {
    const timeout = AbortSignal.timeout(10_000);
    const fetchSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    if (!controlToken) {
      const session = await fetch("/api/v1/control-session", { cache: "no-store", signal: fetchSignal });
      if (!session.ok) throw new Error("AUTH");
      controlToken = ((await session.json()) as { token: string }).token;
    }
    const response = await fetch(path, {
      method, cache: "no-store", signal: fetchSignal,
      headers: { "X-Stardust-Control-Token": controlToken, ...(method === "GET" ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.ok) return response.json() as Promise<T>;
    if (response.status === 403) { controlToken = ""; throw new Error("AUTH"); }
    if (response.status === 404) throw new Error("NOT_FOUND");
    if (response.status === 409) throw new Error("CONFLICT");
    if (response.status === 400) {
      const data = await response.json().catch(() => null) as { error?: string } | null;
      throw new Error(data?.error === "BATCH_LIMIT" ? "BATCH_LIMIT" : "INVALID_INPUT");
    }
    throw new Error("FAILED");
  }

  function card(row: Row, type: Kind): HTMLButtonElement {
    const isSpace = type === "spaces";
    const result = button("", () => {
      opener = result;
      openDetail({ kind: type, id: String(row.id), tab: isSpace ? "overview" : "profile", summary: row });
    });
    result.className = "people-card";
    result.dataset.recordId = String(row.id);
    const top = node("span", "", "people-card-top");
    const icon = node("span", avatar(row, isSpace), "people-avatar");
    icon.setAttribute("aria-hidden", "true");
    const labels = node("span", "", "people-card-labels");
    labels.append(node("strong", title(row, isSpace)), node("small", isSpace ? spacePlatform(row) : provider(row.providers)));
    result.title = title(row, isSpace);
    top.append(icon, labels);
    if (!isSpace) top.append(node("span", personStatus(row), "people-badge"));
    result.append(top, node("span", isSpace ? `已观察成员 · ${row.memberCount} 人` : counts(row), "people-card-counts"));
    const foot = node("span", "", "people-card-foot");
    foot.append(node("small", `最近观察 · ${date(row.lastSeenAt)}`), node("small", short(row.id)));
    result.append(foot);
    return result;
  }
  async function refresh(): Promise<void> {
    listRequest?.abort();
    const controller = listRequest = new AbortController(), selected = kind;
    status.textContent = "正在读取…";
    list.setAttribute("aria-busy", "true");
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset), q: search });
      if (selected === "people") params.set("state", state.value);
      const data = await request<Page>(`/api/v1/${selected}?${params}`, "GET", undefined, controller.signal);
      if (controller.signal.aborted) return;
      const focusedId = (document.activeElement as HTMLElement | null)?.dataset.recordId;
      list.replaceChildren(...data.items.map(row => card(row, selected)));
      paging(pages, data, at => { offset = at; void refresh(); });
      status.textContent = data.items.length ? "" : search ? "没有符合搜索条件的记录。"
        : selected === "spaces" ? "还没有观察到群组。" : state.value === "merged" ? "还没有已合并人物。" : "还没有观察到人物。";
      if (focusedId) Array.from(list.querySelectorAll<HTMLButtonElement>("button")).find(item => item.dataset.recordId === focusedId)?.focus({ preventScroll: true });
    } catch (error) {
      if (!controller.signal.aborted) status.textContent = errorText(error);
    } finally {
      if (listRequest === controller) list.removeAttribute("aria-busy");
    }
  }
  function switchTo(value: Kind): void {
    if (kind === value) return;
    kind = value;
    offset = 0;
    query.value = search = "";
    personTab.setAttribute("aria-pressed", String(value === "people"));
    spaceTab.setAttribute("aria-pressed", String(value === "spaces"));
    el("people-state-label").hidden = value === "spaces";
    query.placeholder = value === "people" ? "搜索人物名称或平台身份" : "搜索群组名称或平台";
    list.replaceChildren();
    pages.hidden = true;
    void refresh();
  }

  function hideDiscard(): void { discard.hidden = true; discard.replaceChildren(); }
  function navigate(action: () => void): void {
    if (submitting) return;
    if (!dirty) { action(); return; }
    const previousFocus = document.activeElement as HTMLElement | null;
    const keep = button("继续编辑", () => { hideDiscard(); (previousFocus?.isConnected ? previousFocus : heading).focus(); });
    discard.replaceChildren(node("p", "有未保存的修改。是否放弃？"), keep,
      button("放弃修改", () => { dirty = false; hideDiscard(); action(); }));
    discard.hidden = false;
    keep.focus();
  }
  function beginView(): View {
    viewRequest?.abort();
    const controller = viewRequest = new AbortController();
    dirty = false;
    hideDiscard();
    feedback.textContent = "";
    content.replaceChildren();
    content.scrollTop = 0;
    return { signal: controller.signal, active: () => dialog.open && !controller.signal.aborted };
  }
  function openDetail(next: Detail, push = false): void {
    if (push && current) history.push(current);
    current = next;
    if (!dialog.open) dialog.showModal();
    const view = beginView();
    nav.hidden = true;
    content.removeAttribute("role");
    content.removeAttribute("aria-labelledby");
    actions.replaceChildren();
    const isSpace = next.kind === "spaces";
    heading.textContent = next.summary ? title(next.summary, isSpace) : isSpace ? "群组详情" : "人物详情";
    heading.title = heading.textContent;
    portrait.textContent = avatar(next.summary ?? {}, isSpace);
    summary.textContent = "正在读取详情…";
    heading.focus();
    void loadDetail(next, view);
  }
  async function loadDetail(item: Detail, view: View): Promise<void> {
    try {
      const data = await request<{ person?: Row; space?: Row }>(`/api/v1/${item.kind}/${encodeURIComponent(item.id)}`, "GET", undefined, view.signal);
      if (!view.active()) return;
      item.row = item.kind === "people" ? data.person! : data.space!;
      showTab(item.tab);
    } catch (error) {
      if (!view.active()) return;
      summary.textContent = "";
      feedback.textContent = errorText(error);
      content.append(button("重新加载", () => openDetail(item)));
    }
  }
  function showTab(tab: Tab, focusTab = false, message = ""): void {
    const item = current;
    if (!item?.row) return;
    const row = item.row, isSpace = item.kind === "spaces", view = beginView();
    item.tab = tab;
    heading.textContent = title(row, isSpace);
    heading.title = heading.textContent;
    portrait.textContent = avatar(row, isSpace);
    summary.textContent = isSpace ? `${spacePlatform(row)} · 已观察成员 ${row.memberCount} 人`
      : row.mergedIntoId ? "已合并" : item.summary ? counts(item.summary) : personStatus(row);
    feedback.textContent = message;
    nav.hidden = false;
    const tabs: Tab[] = isSpace ? ["overview", "members"] : ["profile", "identities", "groups", "history"];
    nav.replaceChildren(...tabs.map((value, index) => {
      const select = button(tabLabels[value], () => navigate(() => showTab(value, true)));
      select.id = `people-tab-${value}`;
      select.setAttribute("role", "tab");
      select.setAttribute("aria-controls", content.id);
      select.setAttribute("aria-selected", String(tab === value));
      select.tabIndex = tab === value ? 0 : -1;
      select.addEventListener("keydown", event => {
        const keys = { ArrowLeft: (index + tabs.length - 1) % tabs.length, ArrowRight: (index + 1) % tabs.length, Home: 0, End: tabs.length - 1 };
        const next = keys[event.key as keyof typeof keys];
        if (next === undefined) return;
        event.preventDefault();
        navigate(() => showTab(tabs[next]!, true));
      });
      return select;
    }));
    content.setAttribute("role", "tabpanel");
    content.setAttribute("aria-labelledby", `people-tab-${tab}`);
    content.tabIndex = 0;
    if (focusTab) el(`people-tab-${tab}`).focus();
    actions.replaceChildren();
    if (history.length) actions.append(button("返回", () => navigate(() => openDetail(history.pop()!))));
    const options: [string, () => void][] = [["查看内部标识", () => operation("内部标识", holder => holder.append(facts([[isSpace ? "空间 ID" : "人物 ID", item.id]])))]];
    if (!isSpace && !row.mergedIntoId) options.unshift(
      ["合并人物", () => operation("合并人物", (holder, scope) => batchPanel("merge", item, holder, scope))],
      ["批量拆分身份", () => operation("批量拆分身份", (holder, scope) => batchPanel("split", item, holder, scope))],
    );
    actions.append(menu("更多操作", options));
    if (!isSpace && !item.summary && !row.mergedIntoId) void loadSummary(item, view);
    if (tab === "profile" || tab === "overview") renderProfile(item, row);
    else renderRelations(item, tab, view);
  }
  async function loadSummary(item: Detail, view: View): Promise<void> {
    try {
      const data = await request<Page>(`/api/v1/people?limit=1&q=${encodeURIComponent(item.id)}`, "GET", undefined, view.signal);
      if (!view.active()) return;
      const row = data.items.find(row => row.id === item.id);
      if (row) { item.summary = row; summary.textContent = counts(row); }
    } catch { /* The detail remains usable without list counts. */ }
  }
  function renderProfile(item: Detail, row: Row): void {
    if (item.kind === "spaces") {
      content.append(facts([["平台", spacePlatform(row)], ["已观察成员", `${row.memberCount} 人`], ["首次观察", time(row.firstSeenAt)], ["最近观察", time(row.lastSeenAt)]]),
        button("查看已观察成员", () => showTab("members", true)));
      return;
    }
    if (row.mergedIntoId) {
      const banner = node("div", "", "people-notice");
      banner.append(node("p", `此人物已合并到 ${short(row.mergedIntoId)}，原资料与历史仍可查看。`),
        button("查看合并目标", () => openDetail({ kind: "people", id: String(row.mergedIntoId), tab: "profile" }, true)),
        button("查看合并历史", () => showTab("history", true)));
      content.append(banner);
    } else content.append(button("编辑资料", () => operation("编辑资料", holder => editProfile(item, row, holder))));
    content.append(facts([
      ["状态", personStatus(row)], ["人工名称", String(row.manualName || "未设置")],
      ["观察名称", String(row.observedName || "暂无记录")],
      ["名称来源", row.manualName ? "人工维护" : row.observedName ? "平台观察" : "暂无记录"],
      ["创建时间", time(row.createdAt)], ["更新时间", time(row.updatedAt)],
    ]));
    content.append(node("h3", "备注"), node("p", String(row.note || "暂无备注。"), "people-note"));
  }

  function relationList<T>(holder: HTMLElement, path: string, view: View, empty: string, render: (row: T) => HTMLElement): void {
    let revision = 0;
    async function load(at: number): Promise<void> {
      const ticket = ++revision;
      holder.setAttribute("aria-busy", "true");
      if (!holder.childElementCount) holder.append(node("p", "正在读取…", "people-muted"));
      try {
        const data = await request<Page<T>>(`${path}?limit=${PAGE_SIZE}&offset=${at}`, "GET", undefined, view.signal);
        if (!view.active() || ticket !== revision) return;
        const grid = node("div", "", "people-relation-grid"), controls = node("div", "", "people-pagination");
        grid.append(...data.items.map(render));
        holder.replaceChildren(data.items.length ? grid : node("p", empty, "people-empty"), controls);
        paging(controls, data, next => { void load(next); });
      } catch (error) {
        if (view.active() && ticket === revision) holder.replaceChildren(node("p", errorText(error)), button("重试", () => { void load(at); }));
      } finally {
        if (ticket === revision) holder.removeAttribute("aria-busy");
      }
    }
    void load(0);
  }
  function relatedCard(label: string, subtitle: string, observed: unknown, select: () => void): HTMLButtonElement {
    const item = button("", select);
    item.className = "people-related-card";
    item.append(node("strong", label), node("span", subtitle, "people-muted"), node("small", `最近观察 · ${date(observed)}`, "people-muted"));
    return item;
  }
  function renderRelations(item: Detail, tab: Tab, view: View): void {
    const path = `/api/v1/${item.kind}/${encodeURIComponent(item.id)}`;
    const holder = node("div");
    content.append(holder);
    if (tab === "identities") relationList<Row>(holder, `${path}/identities`, view, "暂无平台身份。", entry => identityCard(item, entry));
    if (tab === "groups") relationList<Row>(holder, `${path}/spaces`, view, "尚无群组记录。", entry => relatedCard(
      String(entry.spaceName || "未命名群组"),
      [spacePlatform(entry), entry.displayName && `群内昵称 ${entry.displayName}`, entry.role].filter(Boolean).join(" · "), entry.lastSeenAt,
      () => openDetail({ kind: "spaces", id: String(entry.spaceId), tab: "overview" }, true),
    ));
    if (tab === "history") relationList<Audit>(holder, `${path}/audit`, view, "暂无变更记录。", entry => auditCard(entry));
    if (tab === "members") {
      holder.before(node("p", "仅显示曾观察到的成员。", "people-muted"));
      relationList<Row>(holder, `${path}/members`, view, "尚无已观察成员。", entry => relatedCard(
        String(entry.displayName || entry.personName || "未知姓名"),
        [entry.displayName && entry.personName !== entry.displayName && entry.personName, identity(entry.identityType), entry.role].filter(Boolean).join(" · "), entry.lastSeenAt,
        () => openDetail({ kind: "people", id: String(entry.personId), tab: "profile" }, true),
      ));
    }
  }
  function identityCard(item: Detail, entry: Row): HTMLElement {
    const card = node("article", "", "people-identity");
    const header = node("header", "", "people-identity-header");
    const labels = node("div");
    labels.append(node("h3", String(entry.displayName || "未知昵称")), node("p", identity(entry.identityType), "people-muted"));
    const options: [string, () => void][] = [
      ["关联到其他人物", () => operation("关联身份", (holder, view) => linkIdentity(item, entry, holder, view, false))],
      ["查看关联历史", () => showTab("history", true)],
    ];
    if (entry.linkMethod === "manual_confirmation") options.splice(1, 0,
      ["解除人工关联", () => operation("解除关联", (holder, view) => linkIdentity(item, entry, holder, view, true))]);
    header.append(labels, menu("身份操作", options));
    card.append(header, facts([
      ["已观察群组", `${entry.spaceCount} 个`], ["最近观察", date(entry.lastSeenAt)],
      ["标识范围", entry.scopeKind === "space" ? "群组或空间内" : "应用账号内"],
      ["关联状态", sources[String(entry.linkMethod)] ?? "平台观察"],
    ]));
    return card;
  }
  function auditCard(entry: Audit): HTMLElement {
    const record = node("details", "", "people-audit");
    const label = auditLabels[entry.operation] ?? "人物变更";
    const top = node("summary");
    top.append(node("strong", label), node("small", date(entry.createdAt), "people-muted"));
    const body = node("div", "", "people-audit-body");
    const values: [string, string][] = [["操作时间", time(entry.createdAt)], ["操作者", "本机管理员"]];
    if (entry.reason) values.push(["原因", entry.reason]);
    if (entry.operation === "note_set" || entry.operation.startsWith("name_")) {
      const field = entry.operation === "note_set" ? "note" : "manualName";
      values.push(["修改前", String(entry.before[field] || "未设置")], ["修改后", String(entry.after[field] || "未设置")]);
    } else {
      values.push(["来源人物", short(entry.sourcePersonId)], ["目标人物", short(entry.targetPersonId)]);
      const moved = entry.before.identities ?? entry.after.identities;
      if (Array.isArray(moved)) values.push(["受影响身份", `${moved.length} 个`]);
    }
    body.append(facts(values));
    if (entry.canUndo) body.append(button(entry.operation === "person_merge" ? "撤销合并" : "撤销此操作",
      () => operation("确认撤销", holder => {
        const merge = entry.operation === "person_merge";
        holder.append(node("p", merge ? "恢复合并前的身份归属和人工资料，保留之后的平台观察。" : "将此身份移回操作前的人物。", "people-note"));
        const path = merge ? `/api/v1/people/merge/${entry.id}/undo` : `/api/v1/people/audit/${entry.id}/undo`;
        reasonAction(holder, "撤销原因", "确认撤销", path, {}, "已撤销变更。");
      })));
    else if (["identity_reassign", "identity_detach", "person_merge"].includes(entry.operation)) body.append(
      node("p", entry.undone ? "此操作已撤销。" : "相关资料或身份归属已变化，当前无法撤销。", "people-muted"));
    record.append(top, body);
    return record;
  }

  function operation(label: string, build: (holder: HTMLElement, view: View) => void): void {
    navigate(() => {
      const view = beginView();
      nav.hidden = true;
      actions.replaceChildren(button("返回详情", () => navigate(() => showTab(current!.tab, true))));
      content.removeAttribute("role");
      content.removeAttribute("aria-labelledby");
      const title = node("h3", label);
      title.tabIndex = -1;
      const holder = node("div", "", "people-operation");
      content.append(title, holder);
      build(holder, view);
      title.focus();
    });
  }
  function field(label: string, value = "", multiline = false, maxLength = 100): HTMLInputElement | HTMLTextAreaElement {
    const input = multiline ? node("textarea") : node("input");
    input.value = value;
    input.maxLength = maxLength;
    input.setAttribute("aria-label", label);
    if (input instanceof HTMLTextAreaElement) input.rows = 3;
    return input;
  }
  function labelled(label: string, input: HTMLElement): HTMLElement {
    const wrapper = node("label", "", "people-edit-field");
    wrapper.append(node("span", label), input);
    return wrapper;
  }
  async function save(trigger: HTMLButtonElement, path: string, method: string, values: unknown, success: string): Promise<void> {
    if (submitting) return;
    submitting = true;
    close.disabled = true;
    actions.inert = nav.inert = content.inert = true;
    hideDiscard();
    feedback.textContent = "正在提交…";
    heading.focus({ preventScroll: true });
    const item = current!;
    let saved = false;
    try {
      const result = await request<{ result?: Row }>(path, method, values);
      saved = true;
      needsRefresh = true;
      dirty = false;
      if (page.hidden) return;
      item.summary = undefined;
      const updated = method === "PATCH" ? result.result : (await request<{ person: Row }>(`/api/v1/people/${item.id}`)).person;
      if (updated) item.row = updated;
      showTab(item.tab, false, success);
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      const uncertain = !["AUTH", "NOT_FOUND", "CONFLICT", "INVALID_INPUT", "BATCH_LIMIT"].includes(code);
      feedback.textContent = saved ? "操作已完成，详情刷新失败。请重新加载详情。"
        : uncertain ? "暂时无法确认提交结果，请重新加载详情。" : errorText(error);
      if (uncertain || code === "CONFLICT") {
        trigger.disabled = true;
        actions.replaceChildren(button("重新加载详情", () => navigate(() => openDetail(item))));
      }
    } finally {
      submitting = close.disabled = actions.inert = nav.inert = content.inert = false;
      if (page.hidden) dismiss();
      else if (trigger.isConnected && !trigger.disabled) trigger.focus({ preventScroll: true });
      else if (saved && !nav.hidden) el(`people-tab-${item.tab}`).focus({ preventScroll: true });
      else if (!content.contains(document.activeElement)) (actions.querySelector("button") ?? heading).focus({ preventScroll: true });
    }
  }
  function editProfile(item: Detail, row: Row, holder: HTMLElement): void {
    const name = field("人工名称", String(row.manualName ?? ""), false, 512), note = field("备注", String(row.note ?? ""), true, 4000);
    const track = () => { dirty = name.value !== String(row.manualName ?? "") || note.value !== String(row.note ?? ""); };
    name.addEventListener("input", track);
    note.addEventListener("input", track);
    const submit = button("保存", () => {
      const manualName = name.value.trim() || null, memo = note.value.trim() || null, bytes = new TextEncoder();
      if (bytes.encode(manualName ?? "").length > 512 || bytes.encode(memo ?? "").length > 4000) { feedback.textContent = "名称或备注过长。"; return; }
      void save(submit, `/api/v1/people/${item.id}`, "PATCH", { manualName, note: memo, version: row.version }, "资料已保存。");
    }, true);
    holder.append(labelled("人工名称", name), labelled("备注", note), node("p", "清除人工名称后将显示观察名称。", "people-muted"),
      button("清除人工名称", () => { name.value = ""; track(); name.focus(); }), submit,
      button("取消", () => navigate(() => showTab("profile", true))));
  }
  function reasonAction(holder: HTMLElement, label: string, confirm: string, path: string, values: object, success: string): void {
    const reason = field(label, "", true, 1000);
    reason.addEventListener("input", () => { dirty = true; });
    const submit = button(confirm, () => {
      const value = reason.value.trim();
      if (!value || new TextEncoder().encode(value).length > 1000) {
        feedback.textContent = "请输入有效的操作原因（最多 1000 字节）。";
        reason.focus();
        return;
      }
      void save(submit, path, "POST", { ...values, reason: value }, success);
    }, true);
    holder.append(labelled(label, reason), submit);
  }
  function choosePerson(holder: HTMLElement, view: View, sourceId: string, allowNew: boolean, select: (row: Row | null) => void): void {
    const search = node("form", "", "people-picker-search"), input = field("搜索目标人物");
    input.placeholder = "搜索目标人物";
    const submit = node("button", "搜索", "setup-secondary");
    submit.type = "submit";
    search.append(input, submit);
    const results = node("div", "", "people-target-results"), controls = node("div", "", "people-pagination");
    holder.append(search, results, controls);
    if (allowNew) holder.append(button("创建新的待确认人物", () => select(null)));
    let query = "", revision = 0;
    async function load(at: number): Promise<void> {
      const ticket = ++revision;
      results.textContent = "正在查找…";
      controls.hidden = true;
      try {
        const page = await request<Page>(`/api/v1/people?limit=${PAGE_SIZE}&offset=${at}&q=${encodeURIComponent(query)}`, "GET", undefined, view.signal);
        if (!view.active() || ticket !== revision) return;
        const candidates = page.items.filter(item => item.id !== sourceId);
        results.replaceChildren(...candidates.map(row => {
          const candidate = button("", () => select(row));
          candidate.className = "people-candidate";
          candidate.append(node("strong", title(row)), node("small", `${provider(row.providers)} · ${row.identityCount} 个身份 · ${short(row.id)}`));
          return candidate;
        }));
        if (!candidates.length) results.append(node("p", "此页没有可选人物。", "people-muted"));
        paging(controls, page, next => { void load(next); });
      } catch (error) {
        if (view.active() && ticket === revision) results.textContent = errorText(error);
      }
    }
    search.addEventListener("submit", event => { event.preventDefault(); query = input.value.trim(); void load(0); });
    void load(0);
  }
  function readFailure(holder: HTMLElement, error: unknown): void {
    holder.replaceChildren(node("p", errorText(error), "people-note"));
  }
  async function linkIdentity(item: Detail, entry: Row, holder: HTMLElement, view: View, detach: boolean): Promise<void> {
    holder.textContent = "正在读取身份…";
    const path = `/api/v1/identities/${entry.id}`;
    try {
      const { identity: info } = await request<{ identity: Row }>(path, "GET", undefined, view.signal);
      if (!view.active()) return;
      if (info.personId !== item.id || (detach && info.linkMethod !== "manual_confirmation")) throw new Error("CONFLICT");
      holder.replaceChildren(facts([
        ["平台身份", `${identity(info.identityType)} · ${info.displayName || "未知昵称"}`],
        ["当前人物", `${info.personName || "未知姓名"} · ${short(info.personId)}`], ["已观察群组", `${info.spaceCount} 个`],
      ]));
      if (detach) {
        holder.append(node("p", "解除后会创建一个待确认人物，仅转移此身份，原人物和成员观察保留。", "people-note"));
        reasonAction(holder, "解除原因", "确认解除", `${path}/detach`, { version: info.linkVersion }, "身份已解除。");
        return;
      }
      const picker = node("div", "", "people-picker"), review = node("div", "", "people-operation");
      holder.append(picker, review);
      choosePerson(picker, view, item.id, false, target => {
        if (!target) return;
        dirty = true;
        review.replaceChildren(node("h4", "确认身份归属"), node("p", `仅将此身份转移至 ${title(target)}（${short(target.id)}），保留关联的成员观察。`, "people-note"));
        reasonAction(review, "关联依据", "确认关联", `${path}/reassign`, { targetPersonId: target.id, version: info.linkVersion }, "身份已关联。");
      });
    } catch (error) { if (view.active()) readFailure(holder, error); }
  }

  async function batchPanel(mode: "merge" | "split", item: Detail, holder: HTMLElement, view: View): Promise<void> {
    const merging = mode === "merge", label = merging ? "合并" : "拆分";
    const picker = node("div", "", "people-picker"), options = node("div", "", "people-operation"), review = node("div", "", "people-operation");
    const selected = new Set<string>();
    let destination: Row | null | undefined, selectionVersion = 0, targetVersion = 0;
    let readOptions = (): object => ({});
    const invalidate = () => { selectionVersion++; dirty = true; review.replaceChildren(); };
    if (!merging) {
      holder.append(node("p", "选择要移动的身份。", "people-muted"));
      const choices = node("div", "正在读取身份…", "people-batch-identities");
      holder.append(choices);
      try {
        const all: Row[] = [];
        for (let at = 0; ; at += 50) {
          const data = await request<Page>(`/api/v1/people/${item.id}/identities?limit=50&offset=${at}`, "GET", undefined, view.signal);
          if (!view.active()) return;
          all.push(...data.items);
          if (!data.hasMore) break;
          if (all.length >= 100) throw new Error("BATCH_LIMIT");
        }
        choices.replaceChildren();
        if (!all.length) { choices.textContent = "没有可拆分的身份。"; return; }
        for (const entry of all) {
          const choice = node("label", "", "people-batch-choice"), check = node("input");
          check.type = "checkbox";
          check.addEventListener("change", () => { if (check.checked) selected.add(String(entry.id)); else selected.delete(String(entry.id)); invalidate(); });
          choice.append(check, node("span", `${entry.displayName || "未知昵称"} · ${identity(entry.identityType)} · ${short(entry.id)}`));
          choices.append(choice);
        }
      } catch (error) { if (view.active()) readFailure(choices, error); return; }
    }
    holder.append(picker, options);
    const previewButton = button(`生成${label}预览`, () => { void preview(); });
    previewButton.disabled = true;
    holder.append(previewButton, review);
    choosePerson(picker, view, item.id, !merging, target => {
      invalidate();
      const ticket = ++targetVersion;
      destination = target;
      options.replaceChildren(node("p", target ? `目标 · ${title(target)}（${short(target.id)}）` : "目标 · 新建待确认人物", "people-note"));
      previewButton.disabled = merging;
      if (merging && target) void showOptions(target, ticket);
    });
    async function showOptions(target: Row, ticket: number): Promise<void> {
      try {
        const data = await request<{ person: Row }>(`/api/v1/people/${target.id}`, "GET", undefined, view.signal);
        if (!view.active() || ticket !== targetVersion) return;
        const compare = node("div", "", "people-compare");
        for (const [label, row] of [["来源", item.row!], ["目标", data.person]] as const) {
          const block = node("section");
          block.append(node("h4", `${label} · ${title(row)}`), facts([
            ["人工名称", String(row.manualName || "未设置")], ["观察名称", String(row.observedName || "暂无记录")], ["备注", String(row.note || "无")],
          ]));
          compare.append(block);
        }
        options.append(compare);
        const name = mergeChoice("人工名称", false), note = mergeChoice("备注", true);
        readOptions = () => ({ nameChoice: name.select.value, noteChoice: note.select.value,
          ...(name.select.value === "custom" ? { manualName: name.custom.value.trim() || null } : {}),
          ...(note.select.value === "custom" ? { note: note.custom.value.trim() || null } : {}),
        });
        previewButton.disabled = false;
      } catch (error) { if (view.active() && ticket === targetVersion) readFailure(options, error); }
    }
    function mergeChoice(label: string, multiline: boolean) {
      const select = node("select");
      for (const [value, name] of [["target", "保留目标"], ["source", "使用来源"], ["custom", "手动填写"]] as const) {
        const option = node("option", name);
        option.value = value;
        select.append(option);
      }
      select.value = "target";
      const custom = field(`手动填写${label}`, "", multiline, multiline ? 4000 : 512);
      const wrapper = labelled(`手动填写${label}`, custom);
      wrapper.hidden = true;
      select.addEventListener("change", () => { wrapper.hidden = select.value !== "custom"; invalidate(); });
      custom.addEventListener("input", invalidate);
      options.append(labelled(`${label}处理`, select), wrapper);
      return { select, custom };
    }
    async function preview(): Promise<void> {
      if (destination === undefined || (!merging && !selected.size)) { feedback.textContent = "请选择身份和目标。"; return; }
      const ticket = ++selectionVersion;
      const values = { sourceId: item.id, targetId: destination?.id ?? null, ...(merging ? { options: readOptions() } : { identities: [...selected].sort() }) };
      review.textContent = "正在生成预览…";
      try {
        const { result } = await request<{ result: BatchPreview }>(`/api/v1/people/${mode}/preview`, "POST", values, view.signal);
        if (!view.active() || ticket !== selectionVersion) return;
        review.replaceChildren(node("h4", "操作预览"), facts([
          ["来源人物", `${title(result.source)} · ${short(result.source.id)}`],
          ["目标人物", result.target ? `${title(result.target)} · ${short(result.target.id)}` : "新建待确认人物"],
          ["影响范围", `${result.identities.length} 个身份 · ${result.spaceCount} 个交流空间 · ${result.membershipCount} 条成员观察`],
          ...(result.final ? [["合并后人工名称", result.final.manualName || "未设置"], ["合并后备注", result.final.note || "无"]] as [string, string][] : []),
        ]));
        const moved = node("ul", "", "people-batch-identities");
        moved.append(...result.identities.map(entry => node("li", `${entry.displayName || "未知昵称"} · ${identity(entry.identityType)} · ${short(entry.id)}`)));
        review.append(moved, node("p", merging ? "来源人物会标记为已合并，原资料和成员观察保留。" : "仅移动所选身份，来源人物和成员观察保留。", "people-note"));
        reasonAction(review, `${label}原因`, `确认${label}`, `/api/v1/people/${mode}`, { ...values, fingerprint: result.fingerprint }, `${label}已完成。`);
        feedback.textContent = "请核对预览，填写原因后确认。";
      } catch (error) { if (view.active() && ticket === selectionVersion) readFailure(review, error); }
    }
  }

  function dismiss(): void {
    viewRequest?.abort();
    dialog.close();
    current = undefined;
    history.length = 0;
    content.replaceChildren();
    hideDiscard();
    dirty = false;
    if (!page.hidden) {
      const sameCard = opener?.isConnected ? opener : Array.from(list.querySelectorAll<HTMLButtonElement>("button"))
        .find(item => item.dataset.recordId === opener?.dataset.recordId);
      (sameCard ?? query).focus({ preventScroll: true });
      if (needsRefresh) void refresh();
    }
    opener = undefined;
    needsRefresh = false;
  }
  close.addEventListener("click", () => navigate(dismiss));
  dialog.addEventListener("cancel", event => { event.preventDefault(); navigate(dismiss); });
  personTab.addEventListener("click", () => switchTo("people"));
  spaceTab.addEventListener("click", () => switchTo("spaces"));
  state.addEventListener("change", () => { offset = 0; void refresh(); });
  el("people-search").addEventListener("submit", event => { event.preventDefault(); search = query.value.trim(); offset = 0; void refresh(); });
  el("people-refresh").addEventListener("click", () => { void refresh(); });
  function syncPage(): void {
    if (location.hash === "#/model/people") { void refresh(); return; }
    listRequest?.abort();
    if (dialog.open && !submitting) dismiss();
  }
  window.addEventListener("hashchange", syncPage);
  window.addEventListener("stardust-conversations-ready", syncPage);
  syncPage();
}
