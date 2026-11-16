type Conversation = { id: string; title: string };
type Message = { id: string; requestId: string; sequence: number; role: "user" | "assistant"; content: string; status: "pending" | "complete" | "failed" | "unknown" };
type ToolRun = { status: string; calls: { id: string; name: string; status: string; input?: Record<string, unknown>; approval?: { operation: string; targetDescription: string; channel?: string; content?: string; risk: string }; result?: unknown }[] };

export function initializeConversationUI(): void {
  const element = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
  const list = element<HTMLElement>("conversation-list");
  const listStatus = element<HTMLElement>("conversation-list-status");
  const title = element<HTMLElement>("conversation-title");
  const messages = element<HTMLElement>("conversation-messages");
  const form = element<HTMLFormElement>("conversation-form");
  const input = element<HTMLTextAreaElement>("conversation-input");
  const send = element<HTMLButtonElement>("conversation-send");
  const status = element<HTMLElement>("conversation-status");
  const create = element<HTMLButtonElement>("conversation-new");
  const rename = element<HTMLButtonElement>("conversation-rename");
  const remove = element<HTMLButtonElement>("conversation-delete");
  const storageKey = "stardust.conversation.selected";
  let selected = "";
  let generation = 0;
  let available = false;
  let entries: Conversation[] = [];
  const sending = new Set<string>();
  const pending = new Map<string, { requestId: string; content: string; uncertain: boolean }>();
  let renderRevision = 0;

  async function request<T>(url: string, method = "GET", body?: unknown): Promise<T> {
    const response = await fetch(url, { method, cache: "no-store", ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
    const data = await response.json() as T & { error?: string };
    if (!response.ok) throw new Error(data.error ?? "REQUEST_FAILED");
    return data;
  }
  const base = (id: string) => `/api/v1/conversations/${encodeURIComponent(id)}`;
  function updateControls(): void {
    const canUseConversation = available && Boolean(selected);
    input.disabled = !canUseConversation || sending.has(selected);
    send.disabled = input.disabled;
    rename.disabled = !canUseConversation;
    remove.disabled = !canUseConversation || sending.has(selected);
    create.disabled = !available;
  }
  function renderList(): void {
    list.replaceChildren();
    for (const entry of entries) {
      const button = document.createElement("button");
      button.type = "button"; button.textContent = entry.title; button.title = entry.title;
      if (entry.id === selected) button.setAttribute("aria-current", "true");
      button.addEventListener("click", () => { void select(entry.id); });
      list.append(button);
    }
  }
  async function refreshList(): Promise<void> {
    const data = await request<{ conversations: Conversation[] }>("/api/v1/conversations");
    entries = data.conversations;
    renderList();
    listStatus.textContent = entries.length ? "" : "还没有会话，请新建会话。";
  }
  async function readMessages(id: string): Promise<Message[]> {
    const result: Message[] = [];
    let after = 0;
    for (;;) {
      const page = await request<{ messages: Message[] }>(`${base(id)}/messages?after=${after}&limit=200`);
      result.push(...page.messages);
      if (page.messages.length < 200) return result;
      after = page.messages[page.messages.length - 1]!.sequence;
    }
  }
  function appendMessage(role: "user" | "assistant", content: string, requestId: string): HTMLElement {
    const row = document.createElement("div"); row.className = "chat-message"; row.dataset.role = role; row.dataset.requestId = requestId;
    const label = document.createElement("strong"); label.textContent = role === "user" ? "你" : "模型";
    const body = document.createElement("p"); body.textContent = content; row.append(label, body);
    messages.append(row);
    return row;
  }
  function appendPendingReply(requestId: string, uncertain = false): void {
    const row = appendMessage("assistant", uncertain ? "无法确认回复状态，请稍后重新选择会话查看。" : "正在生成回复…", requestId);
    row.classList.add("conversation-reply-placeholder");
    row.setAttribute("role", "status");
  }
  async function renderToolRun(id: string, requestId: string, token: number, revision: number): Promise<void> {
    const data = await request<{ run: ToolRun | null }>(`${base(id)}/messages/${encodeURIComponent(requestId)}/tool`);
    if (!data.run || selected !== id || token !== generation || revision !== renderRevision) return;
    const placeholder = Array.from(messages.querySelectorAll<HTMLElement>(".conversation-reply-placeholder")).find((row) => row.dataset.requestId === requestId);
    if (!placeholder) return;
    for (const call of data.run.calls) {
      const card = document.createElement("div"); card.className = "tool-call";
      const heading = document.createElement("strong"); heading.textContent = `Tool：${call.name}`; card.append(heading);
      if (call.approval) {
        const details = document.createElement("p");
        details.textContent = `${call.approval.operation} · ${call.approval.targetDescription}${call.approval.content ? `\n${call.approval.content}` : ""}${call.approval.risk ? `\n${call.approval.risk}` : ""}`;
        card.append(details);
      }
      if (call.input) {
        const parameters = document.createElement("pre"); parameters.textContent = JSON.stringify(call.input, null, 2); card.append(parameters);
      }
      if (call.status === "waiting") {
        const controls = document.createElement("div"); controls.className = "extension-actions";
        for (const [label, approved] of [["确定", true], ["取消", false]] as const) {
          const button = document.createElement("button"); button.type = "button"; button.className = approved ? "setup-primary" : "setup-secondary"; button.textContent = label;
          button.addEventListener("click", () => {
            controls.querySelectorAll("button").forEach((item) => { item.disabled = true; });
            void request(`${base(id)}/messages/${encodeURIComponent(requestId)}/tool/decision`, "POST", { toolCallId: call.id, approved })
              .then(() => refreshMessages(id, token)).catch(() => { if (selected === id && token === generation) status.textContent = "操作未完成，请重试。"; });
          });
          controls.append(button);
        }
        card.append(controls);
      } else {
        const state = document.createElement("p"); state.textContent = ({ executing: "正在执行…", sent: "已完成", denied: "已取消", expired: "已过期", failed: "执行失败", unavailable: "不可用", rejected: "已拒绝", unknown_outcome: "结果未知" } as Record<string, string>)[call.status] ?? "处理中…";
        card.append(state);
      }
      placeholder.append(card);
    }
  }
  async function refreshMessages(id: string, token: number): Promise<void> {
    const revision = ++renderRevision;
    const history = await readMessages(id);
    if (selected !== id || token !== generation || revision !== renderRevision) return;
    const local = pending.get(id);
    messages.replaceChildren();
    for (const message of history) {
      const row = appendMessage(message.role, message.content, message.requestId);
      if (message.role === "user" && message.status !== "complete" && message.status !== "pending" && !(local?.requestId === message.requestId && !local.uncertain)) {
        const state = document.createElement("div"); state.className = "conversation-message-state";
        const description = document.createElement("span");
        description.textContent = message.status === "unknown" ? "上次请求结果未知。" : "回复失败。";
        state.append(description);
        if (history.at(-1)?.id === message.id) {
          const retry = document.createElement("button"); retry.type = "button"; retry.className = "setup-secondary"; retry.textContent = "重试";
          retry.addEventListener("click", () => {
            if (message.status === "unknown" && !window.confirm("上次请求可能已到达模型。重试会再次调用模型，是否继续？")) return;
            void submit(id, message.content, message.requestId, true);
          });
          state.append(retry);
        }
        row.append(state);
      }
      if (message.role === "user" && (message.status === "pending" || (local?.requestId === message.requestId && !local.uncertain)) && !history.some((entry) => entry.role === "assistant" && entry.requestId === message.requestId)) {
        appendPendingReply(message.requestId);
      }
    }
    if (local && !history.some((message) => message.requestId === local.requestId)) {
      appendMessage("user", local.content, local.requestId);
      appendPendingReply(local.requestId, local.uncertain);
    }
    messages.scrollTop = messages.scrollHeight;
    for (const message of history) {
      if (message.role === "user" && message.status === "pending") void renderToolRun(id, message.requestId, token, revision).catch(() => {});
    }
    if (history.some((message) => message.status === "pending") || (local && !local.uncertain)) {
      window.setTimeout(() => {
        if (selected === id && token === generation) void refreshMessages(id, token).catch(() => { status.textContent = "无法刷新消息状态。"; });
      }, 2000);
    }
  }
  async function select(id: string): Promise<void> {
    selected = id; const token = ++generation;
    try { localStorage.setItem(storageKey, id); } catch { /* Storage can be disabled. */ }
    title.textContent = entries.find((entry) => entry.id === id)?.title ?? "会话";
    messages.replaceChildren(); status.textContent = "正在读取会话…"; renderList(); updateControls();
    try { await refreshMessages(id, token); if (selected === id && token === generation) status.textContent = ""; }
    catch { if (selected === id && token === generation) status.textContent = "无法读取会话，请重新选择。"; }
  }
  async function load(): Promise<void> {
    try {
      await refreshList();
      available = true;
      let remembered = ""; try { remembered = localStorage.getItem(storageKey) ?? ""; } catch { /* Optional preference. */ }
      const next = entries.find((entry) => entry.id === selected || entry.id === remembered) ?? entries[0];
      if (next) await select(next.id); else { selected = ""; messages.replaceChildren(); title.textContent = "选择或新建会话"; updateControls(); }
    } catch { available = false; listStatus.textContent = "无法读取会话，请检查服务连接。"; updateControls(); }
  }
  async function submit(id: string, content: string, requestId: string, retry = false): Promise<void> {
    if (sending.has(id)) return;
    sending.add(id);
    pending.set(id, { requestId, content, uncertain: false });
    updateControls();
    if (selected === id) {
      ++renderRevision;
      status.textContent = "";
      if (retry) {
        const existing = Array.from(messages.querySelectorAll<HTMLElement>('.chat-message[data-role="user"]')).find((row) => row.dataset.requestId === requestId);
        existing?.querySelector(".conversation-message-state")?.remove();
      } else appendMessage("user", content, requestId);
      appendPendingReply(requestId);
      messages.scrollTop = messages.scrollHeight;
    }
    let failed = false;
    try {
      const submitted = request(`${base(id)}/messages`, "POST", { content, requestId, ...(retry ? { retry: true } : {}) });
      if (selected === id) void refreshMessages(id, generation).catch(() => {});
      await submitted;
    }
    catch { failed = true; }
    finally {
      sending.delete(id); updateControls();
      if (selected === id) {
        try {
          const history = await readMessages(id);
          if (selected !== id) return;
          pending.delete(id);
          const token = generation;
          await refreshMessages(id, token);
          if (selected !== id || token !== generation) return;
          status.textContent = failed ? "请求未完成，请查看消息状态。" : "";
          if (failed && !retry && !history.some((message) => message.requestId === requestId) && selected === id && !input.value) input.value = content;
        } catch {
          const local = pending.get(id);
          if (local?.requestId === requestId) local.uncertain = true;
          const placeholder = selected === id ? Array.from(messages.querySelectorAll<HTMLElement>(".conversation-reply-placeholder")).find((row) => row.dataset.requestId === requestId) : undefined;
          if (placeholder) placeholder.querySelector("p")!.textContent = "无法确认回复状态，请稍后重新选择会话查看。";
          if (selected === id) status.textContent = "无法读取消息状态，请重新选择会话。";
        }
      } else {
        if (failed) pending.get(id)!.uncertain = true;
        else pending.delete(id);
      }
      try { await refreshList(); } catch { /* Keep the current list if the server is unavailable. */ }
    }
  }
  create.addEventListener("click", () => { void (async () => { try { const data = await request<{ conversation: Conversation }>("/api/v1/conversations", "POST", {}); await refreshList(); await select(data.conversation.id); input.focus(); } catch { listStatus.textContent = "无法新建会话。"; } })(); });
  rename.addEventListener("click", () => { const id = selected; const value = window.prompt("会话标题", title.textContent ?? ""); if (value === null) return; void (async () => { try { await request(base(id), "PATCH", { title: value }); await refreshList(); if (selected === id) title.textContent = entries.find((entry) => entry.id === id)?.title ?? value; } catch { status.textContent = "重命名失败，请检查标题。"; } })(); });
  remove.addEventListener("click", () => { const id = selected; if (!window.confirm("删除该会话及其原始消息？此操作无法撤销。")) return; void (async () => { try { await request(base(id), "DELETE"); if (selected === id) { selected = ""; ++generation; } await refreshList(); if (!selected) { if (entries[0]) await select(entries[0].id); else { messages.replaceChildren(); title.textContent = "选择或新建会话"; updateControls(); } } } catch { status.textContent = "删除失败。"; } })(); });
  input.addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && !event.isComposing) { event.preventDefault(); if (!event.repeat && !send.disabled && input.value.trim()) form.requestSubmit(); } });
  form.addEventListener("submit", (event) => { event.preventDefault(); if (!selected || send.disabled || !input.value.trim()) return; const content = input.value; input.value = ""; void submit(selected, content, crypto.randomUUID()); });
  window.addEventListener("stardust-conversations-ready", () => { void load(); });
  updateControls(); void load();
}
