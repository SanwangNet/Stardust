type Approval = { source: "web" | "qq"; scope?: "private" | "group"; conversationId?: string; requestId?: string; runId: string; callId: string; name: string; providerId: string; operation: string; targetDescription: string; content?: string; risk: string; expiresAt?: string; canApprove: boolean };

/** One bounded poller serves the active conversation and the independent QQ queue. */
export function initializeApprovals(currentConversation: () => string): { refresh(): void } {
  const root = document.getElementById("approval-card")!, status = document.getElementById("approval-status")!;
  let token = "", items: Approval[] = [], selected = 0, revision = 0, signature = "", timer: number | undefined, pending = false;
  let tracking: Approval | undefined;
  const visible = () => document.visibilityState === "visible" && !document.querySelector<HTMLElement>('[data-page="/model/chat"]')?.hidden;
  const element = (tag: string, text: string, className?: string) => { const node = document.createElement(tag); node.textContent = text; if (className) node.className = className; return node; };
  function button(text: string, action: () => void, primary = false): HTMLButtonElement { const b = document.createElement("button"); b.type = "button"; b.textContent = text; b.className = primary ? "setup-primary" : "setup-secondary"; b.addEventListener("click", action); return b; }
  async function poll(): Promise<void> {
    if (!visible() || pending) return;
    const current = ++revision, conversation = currentConversation();
    try {
      if (!token) { const session = await fetch("/api/v1/control-session", { cache: "no-store" }); if (!session.ok) throw new Error("UNAVAILABLE"); token = ((await session.json()) as { token: string }).token; }
      const response = await fetch(`/api/v1/approvals?conversationId=${encodeURIComponent(conversation)}`, { cache: "no-store", headers: { "X-Stardust-Control-Token": token } });
      if (!response.ok) { if (response.status === 403) token = ""; throw new Error("UNAVAILABLE"); }
      const next = ((await response.json()) as { items: Approval[] }).items;
      if (current !== revision || conversation !== currentConversation()) return;
      const previous = items[selected];
      const nextSignature = JSON.stringify(next);
      if (nextSignature !== signature) {
        if (previous && !next.some(item => item.runId === previous.runId && item.callId === previous.callId) && !tracking) status.textContent = previous.expiresAt && Date.parse(previous.expiresAt) <= Date.now() ? "审批已过期。" : "审批已失效或请求已取消。";
        signature = nextSignature; items = next; selected = Math.min(selected, Math.max(0, items.length - 1)); render();
      }
      if (tracking && (tracking.source === "qq" || tracking.conversationId === conversation)) {
        const params = new URLSearchParams({ source: tracking.source, runId: tracking.runId, callId: tracking.callId, ...(tracking.conversationId ? { conversationId: tracking.conversationId } : {}) });
        const checked = await fetch(`/api/v1/approvals/status?${params}`, { cache: "no-store", headers: { "X-Stardust-Control-Token": token } });
        if (current !== revision || conversation !== currentConversation()) return;
        if (checked.ok) {
          const result = ((await checked.json()) as { result: { status: string; code?: string } }).result;
          if (current !== revision || conversation !== currentConversation()) return;
          const labels: Record<string, string> = { executing: "正在执行…", sent: "Tool 已完成。", denied: "已拒绝本次操作。", feedback: "说明已交给对应的 Agent。", expired: "审批已过期。", cancelled: "请求已取消。", unavailable: "Tool 不可用。", rejected: "平台拒绝了操作。", failed: "Tool 执行失败。", unknown_outcome: "执行结果未知，未自动重试。" };
          status.textContent = `${labels[result.status] ?? "正在处理…"}${result.code ? `（${result.code}）` : ""}`;
          if (result.status !== "executing" && result.status !== "waiting") tracking = undefined;
        } else { status.textContent = "无法确认操作结果，请查看对应会话。"; tracking = undefined; }
      }
    } catch { if (current === revision) status.textContent = "无法读取审批，请检查本机控制端连接。"; }
  }
  async function decide(item: Approval, decision: "approve" | "deny" | "feedback", feedback?: string): Promise<void> {
    if (pending) return; pending = true; root.querySelectorAll("button, textarea").forEach(node => { (node as HTMLButtonElement).disabled = true; });
    status.textContent = "正在提交…";
    try {
      const response = await fetch("/api/v1/approvals/decision", { method: "POST", headers: { "Content-Type": "application/json", "X-Stardust-Control-Token": token }, body: JSON.stringify({ source: item.source, runId: item.runId, callId: item.callId, decision, ...(item.source === "web" ? { conversationId: item.conversationId, requestId: item.requestId } : {}), ...(feedback === undefined ? {} : { feedback }) }) });
      if (!response.ok) throw new Error("UNAVAILABLE");
      tracking = item;
      status.textContent = decision === "approve" ? "已允许本次操作，正在处理。" : decision === "feedback" ? "说明已交给对应的 Agent。" : "已拒绝本次操作。";
      items = items.filter(value => value.runId !== item.runId || value.callId !== item.callId); signature = ""; selected = Math.min(selected, Math.max(0, items.length - 1)); render();
    } catch { status.textContent = "审批未完成，可能已过期或不可用；请刷新状态。"; signature = ""; }
    finally { pending = false; void poll(); }
  }
  function render(): void {
    root.replaceChildren(); const item = items[selected]; if (!item) return;
    const card = element("section", "", "approval-card"); card.setAttribute("aria-label", "待审批 Tool 请求");
    card.append(element("strong", item.source === "web" ? "当前 Web 会话的 Tool 请求" : `来自 QQ ${item.scope === "group" ? "群聊" : "私聊"}的 Tool 请求`));
    card.append(element("p", `Tool：${item.name} · 提供者：${item.providerId}\n操作：${item.operation}\n目标：${item.targetDescription}${item.content !== undefined ? `\n消息内容：\n${item.content}` : ""}\n${item.risk}${item.expiresAt ? `\n有效至：${new Date(item.expiresAt).toLocaleString()}` : ""}`, "approval-details"));
    if (items.length > 1) {
      const nav = element("div", "", "approval-actions"); nav.append(element("span", `第 ${selected + 1} / ${items.length} 项待审批`));
      nav.append(button("上一项", () => { selected = (selected + items.length - 1) % items.length; render(); }), button("下一项", () => { selected = (selected + 1) % items.length; render(); })); card.append(nav);
    }
    const actions = element("div", "", "approval-actions"), allow = button("允许本次", () => { void decide(item, "approve"); }, true); allow.disabled = !item.canApprove;
    const feedback = element("div", "", "approval-feedback"); feedback.hidden = true;
    const textarea = document.createElement("textarea"); textarea.rows = 3; textarea.maxLength = 2000; textarea.placeholder = "告诉星尘你希望如何修改"; textarea.setAttribute("aria-label", "补充说明");
    const submit = button("提交说明", () => { const value = textarea.value.trim(); if (!value || new TextEncoder().encode(value).length > 4000) { status.textContent = "请输入不超过 4000 字节的说明。"; return; } void decide(item, "feedback", value); });
    feedback.append(textarea, button("取消编辑", () => { feedback.hidden = true; }), submit);
    actions.append(allow, button("拒绝", () => { void decide(item, "deny"); }), button("补充说明", () => { feedback.hidden = false; textarea.focus(); })); card.append(actions, feedback); root.append(card);
  }
  function updateTimer(): void {
    if (!visible()) { if (timer !== undefined) window.clearInterval(timer); timer = undefined; ++revision; return; }
    if (timer === undefined) timer = window.setInterval(() => { void poll(); }, 2500);
    void poll();
  }
  window.addEventListener("hashchange", updateTimer); document.addEventListener("visibilitychange", updateTimer);
  // Navigation updates its hidden state in the same hashchange turn.
  window.addEventListener("hashchange", () => window.setTimeout(updateTimer, 0));
  window.setTimeout(updateTimer, 0);
  return { refresh() { ++revision; signature = ""; items = []; selected = 0; status.textContent = ""; render(); void poll(); } };
}
