type Source = { conversationId: string; startSequence: number; endSequence: number };
type Entry = { topic: string; content: string; updatedAt: string; version: number; sources: Source[] };
type Job = { id: number; conversationId: string; startSequence: number; endSequence: number; status: string; attempts: number; updatedAt: string; lastError: string | null; outcome: string | null };
type Counts = Record<string, number>;

export function initializeGlobalContextUI(): void {
  const element = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
  const overview = element<HTMLElement>("global-overview");
  const entries = element<HTMLElement>("global-entries");
  const jobs = element<HTMLElement>("global-jobs");
  const feedback = element<HTMLElement>("global-feedback");
  let loading = false;

  async function request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    const response = await fetch(path, { method, cache: "no-store", ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
    const data = await response.json() as T & { error?: string };
    if (!response.ok) throw new Error(data.error ?? "REQUEST_FAILED");
    return data;
  }
  function paragraph(text: string): HTMLParagraphElement { const node = document.createElement("p"); node.textContent = text; return node; }
  function time(value: string): string { const date = new Date(value); return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString(); }
  async function refresh(): Promise<void> {
    if (loading) return;
    loading = true;
    try {
      const [context, work] = await Promise.all([
        request<{ owner: string; entries: Entry[]; counts: Counts; lastCompletedAt: string | null }>("/api/v1/global-context"),
        request<{ jobs: Job[]; counts: Counts }>("/api/v1/global-context/jobs"),
      ]);
      feedback.textContent = "";
      const latest = context.entries[0]?.updatedAt;
      const lastCompleted = context.lastCompletedAt;
      overview.textContent = `范围：${context.owner} · 摘要更新：${latest ? time(latest) : "暂无"} · 最近综合成功：${lastCompleted ? time(lastCompleted) : "暂无"} · 待处理 ${work.counts.pending ?? 0} · 处理中 ${work.counts.processing ?? 0} · 已完成 ${work.counts.done ?? 0} · 失败 ${work.counts.failed ?? 0}${work.counts.failed ? " · 失败任务会暂停该范围的后续综合" : ""}`;
      entries.replaceChildren();
      if (!context.entries.length) entries.append(paragraph("暂无摘要。成功的对话会在后台排队综合。"));
      for (const entry of context.entries) {
        const card = document.createElement("article"); card.className = "global-context-card";
        const heading = document.createElement("h3"); heading.textContent = entry.topic;
        const body = paragraph(entry.content); body.className = "global-context-text";
        const meta = paragraph(`更新于 ${time(entry.updatedAt)} · 修订 ${entry.version}`); meta.className = "model-note";
        card.append(heading, body, meta);
        if (entry.sources.length) {
          const detail = document.createElement("details");
          const summary = document.createElement("summary"); summary.textContent = "来源"; detail.append(summary);
          for (const source of entry.sources) detail.append(paragraph(`会话 ${source.conversationId} · 消息 ${source.startSequence}–${source.endSequence}`));
          card.append(detail);
        }
        entries.append(card);
      }
      jobs.replaceChildren();
      if (!work.jobs.length) jobs.append(paragraph("暂无综合任务。"));
      const labels: Record<string, string> = { pending: "待处理", processing: "处理中", done: "已完成", failed: "失败" };
      for (const job of work.jobs) {
        const row = document.createElement("div"); row.className = "global-context-job";
        const detail = document.createElement("span"); detail.textContent = `${labels[job.status] ?? job.status}${job.outcome === "no_change" ? "（无需更新）" : ""} · 会话 ${job.conversationId} · 消息 ${job.startSequence}–${job.endSequence} · 尝试 ${job.attempts} 次${job.lastError ? ` · ${job.lastError}` : ""}`;
        row.append(detail);
        if (job.status === "failed") {
          const retry = document.createElement("button"); retry.type = "button"; retry.className = "setup-secondary"; retry.textContent = "重试";
          retry.addEventListener("click", () => { retry.disabled = true; void request(`/api/v1/global-context/jobs/${job.id}/retry`, "POST", {}).then(() => refresh()).catch(() => { feedback.textContent = "任务重试失败。"; retry.disabled = false; }); });
          row.append(retry);
        }
        jobs.append(row);
      }
    } catch { feedback.textContent = "无法读取全局上下文，请检查服务连接。"; }
    finally { loading = false; }
  }
  element<HTMLButtonElement>("global-refresh").addEventListener("click", () => { void refresh(); });
  element<HTMLButtonElement>("global-clear").addEventListener("click", () => {
    if (!window.confirm("清除当前范围内的所有摘要和综合任务？原始会话记录会保留，旧记录不会自动重新综合。")) return;
    void request("/api/v1/global-context", "DELETE").then(() => refresh()).catch(() => { feedback.textContent = "清除失败。"; });
  });
  const onRoute = () => { if (location.hash === "#/model/context") void refresh(); };
  window.addEventListener("hashchange", onRoute);
  window.setInterval(() => { if (!document.hidden && location.hash === "#/model/context") void refresh(); }, 5000);
  onRoute();
}
