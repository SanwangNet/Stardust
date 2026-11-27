type Job = { id: string; operation: string; phase: string; result: string; reason: string | null; targetSha: string | null };
type Release = { sha: string; version: string; message?: string; rollback?: boolean; sequence?: number; manager?: number; dataFormat?: number | null };
type Backup = { id: string; createdAt: string; size: number; kind: string; version: string | null; restorable: boolean };
type State = { enabled: boolean; pending: boolean; version: string; runningSha: string; current: Release | null; job: Job | null; lastDeployment: Job | null; latest: Release | null; versions: Release[]; backups: Backup[] };
const stages: Record<string,string> = {
  CHECK: "正在检查已发布的软件包…", DOWNLOAD: "正在下载软件包…", EXTRACT: "正在验证并解压软件包…",
  STOP: "正在停止服务…", BACKUP: "正在备份数据…", SWITCH: "正在切换版本…",
  START: "正在启动并核对版本…", RESTORE: "正在恢复数据…", VALIDATE: "正在验证备份…",
  MANAGER: "正在准备软件更新…",
};
const reasons: Record<string,string> = {
  MANAGEMENT_BUSY:"已有操作正在进行。", MANAGEMENT_DISABLED:"软件管理未启用。", MANAGEMENT_UNAVAILABLE:"无法读取软件管理状态。",
  RELEASE_CHANGED:"发布版本已改变，请重新检查。", MANAGER_UPGRADE_REQUIRED:"此版本要求管理员更新生命周期管理器。",
  MANAGER_PREPARE_FAILED:"无法准备软件更新，请检查服务日志。", MANAGER_SWITCH_FAILED:"程序已切换，但软件管理器更新失败，请由部署者检查日志并修复。",
  INCOMPATIBLE_ROLLBACK:"旧版本与当前数据不兼容，需要恢复对应备份。", INCOMPATIBLE_RELEASE:"软件包与当前版本或数据不兼容。",
  PACKAGE_CHECKSUM_MISMATCH:"软件包校验失败。", BACKUP_CHECKSUM_MISMATCH:"备份校验失败。",
  HEALTH_CHECK_FAILED:"服务启动后未通过版本健康检查。", UPLOAD_TOO_LARGE:"备份超过 2 GiB。",
  INTERRUPTED:"操作中断，请由部署者检查日志。", NO_PUBLISHED_RELEASE:"还没有可安装的发布包。",
  NETWORK_RESET:"连接发布服务时被重置，已重试，请检查代理或网络。", NETWORK_TIMEOUT:"连接发布服务超时，已重试，请检查代理或网络。",
  NETWORK_UNAVAILABLE:"发布服务网络暂不可用，已重试，请检查代理或网络。", NETWORK_REQUEST_FAILED:"无法连接发布服务，请检查网络和代理配置。",
  INVALID_BACKUP_METADATA:"备份缺少有效的版本信息。", UNSAFE_ARCHIVE:"归档包含不支持的文件或链接。", ARCHIVE_LIMIT:"归档解压超过大小限制。", VERSION_NOT_AVAILABLE:"备份对应的程序版本已不可用。", SHARED_RESTORE_INCOMPLETE:"恢复中断，原数据和备份已保留，请联系部署者。",
};
const completed: Record<string,string> = {check:"检查完成。",update:"更新成功。",backup:"备份已创建。",restore:"恢复成功。",rollback:"回滚成功。",upload:"备份已上传。",delete:"备份已删除。"};

export function initManagement(): void {
  const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;
  const check = element<HTMLButtonElement>("update-check"), install = element<HTMLButtonElement>("update-install");
  const create = element<HTMLButtonElement>("backup-create"), upload = element<HTMLButtonElement>("backup-upload");
  const file = element<HTMLInputElement>("backup-file"), feedback = element("update-feedback"), backupFeedback = element("backup-feedback");
  const versions = element("managed-versions"), backups = element("managed-backups");
  const jobKey = "stardust.management.pending";
  type Page = "update" | "backup";
  const messages: Record<Page,string> = {update:"", backup:""}, results: Record<Page,string> = {update:"暂无记录", backup:"暂无记录"};
  let state: State | undefined, fetching = false, sending = false, rendered = "", transportPage: Page | undefined;
  let pending: {previous: string | null; id?: string; time: number; operation?: string} | undefined;
  try { pending = JSON.parse(sessionStorage.getItem(jobKey) ?? "null") ?? undefined; } catch { /* The server also publishes the active job. */ }

  function remember(): void {
    try { if (pending) sessionStorage.setItem(jobKey, JSON.stringify(pending)); else sessionStorage.removeItem(jobKey); } catch { /* Storage is optional. */ }
  }
  function blocking(): boolean { return sending || !!pending || !!state?.pending || state?.job?.result === "running"; }
  function pageFor(operation?: string): Page { return ["backup","restore","upload","delete"].includes(operation ?? "") ? "backup" : "update"; }
  function activePage(): Page { return pending?.operation ? pageFor(pending.operation) : state?.job?.result === "running" ? pageFor(state.job.operation) : location.hash === "#/settings/backups" ? "backup" : "update"; }
  function expectedStop(): boolean {
    const operation = pending?.operation ?? (state?.job?.result === "running" ? state.job.operation : undefined);
    return !!operation && ["backup","restore","update","rollback"].includes(operation);
  }
  function showError(text: string): void {
    const page = activePage();
    messages[page] = text;
    transportPage = page;
    (page === "update" ? feedback : backupFeedback).textContent = text;
  }
  function button(label: string, action: () => void, disabled: boolean): HTMLButtonElement {
    const result = document.createElement("button");
    result.type = "button"; result.className = "setup-secondary"; result.textContent = label; result.disabled = disabled;
    result.addEventListener("click", action);
    return result;
  }
  function row(title: string, description: string, ...controls: HTMLElement[]): HTMLElement {
    const result = document.createElement("div"), label = document.createElement("strong"), detail = document.createElement("p");
    label.textContent = title; detail.textContent = description;
    result.className = "form-section"; result.append(label, detail, ...controls);
    return result;
  }
  function resultText(value: State, job = value.job, includePending = true): string {
    if (includePending && value.pending) return "等待服务处理请求…";
    if (!job) return includePending && pending ? "正在确认请求是否已受理…" : "暂无记录";
    if (job.result === "running") return stages[job.phase] ?? "正在处理…";
    if (job.result === "failed") return reasons[job.reason ?? ""] ?? `操作失败（${job.reason ?? "未知原因"}）。`;
    if (job.result === "unchanged") return "目标版本已经运行。";
    if (job.targetSha && value.runningSha !== job.targetSha) return "操作已结束，当前运行版本与目标版本不一致。";
    return completed[job.operation] ?? "操作完成。";
  }
  function render(): void {
    if (!state) return;
    const busy = blocking(), latest = state.latest;
    check.disabled = !state.enabled || busy;
    install.disabled = check.disabled || !latest || latest.sha === state.runningSha || (latest.manager ?? 1) > 1 ||
      (!!state.current && ((latest.sequence ?? 0) <= (state.current.sequence ?? 0) || (latest.dataFormat ?? 0) < (state.current.dataFormat ?? 1)));
    create.disabled = file.disabled = check.disabled;
    upload.disabled = create.disabled || !file.files?.length;
    element("update-current").textContent = `${state.version} · ${state.runningSha}`;
    element("update-latest").textContent = latest ? `${latest.version} · ${latest.sha}` : "尚未检查";
    element("update-message").textContent = (latest?.message || "—") + ((latest?.manager ?? 1) > 1 ? " 此版本需要部署者先更新生命周期管理器。" : "");
    if (state.job && (!pending || state.job.id !== pending.previous)) results[pageFor(state.job.operation)] = resultText(state, state.job, false);
    if (pending?.operation && (state.pending || !state.job || state.job.id === pending.previous)) results[pageFor(pending.operation)] = state.pending ? "等待服务处理请求…" : "正在确认请求是否已受理…";
    feedback.textContent = messages.update || (!state.enabled ? "请由部署者启用软件管理。" : results.update);
    backupFeedback.textContent = messages.backup || (!state.enabled ? "请由部署者启用软件管理。" : results.backup);
    const deployment = state.job && ["update","install","rollback","restore"].includes(state.job.operation) ? state.job : state.lastDeployment;
    element("update-result").textContent = resultText(state, deployment, false);
    const signature = JSON.stringify([state.versions,state.backups,state.runningSha,busy]);
    if (rendered === signature) return;
    rendered = signature;
    versions.replaceChildren(...state.versions.map(item => row(item.version, item.sha === state!.runningSha ? `${item.sha}（正在运行）` : item.sha,
      button("回滚程序", () => { if (confirm("切换到此版本并短暂停止服务？现有数据将保留。")) void submit("rollback", {target:item.sha}); }, busy || !item.rollback || item.sha === state!.runningSha))));
    backups.replaceChildren(...state.backups.map(item => {
      const link = document.createElement("a");
      link.textContent = "下载"; link.href = "/api/v1/management/backups/" + item.id; link.className = "text-link";
      const date = new Date(item.createdAt).toLocaleString();
      return row(date, `${({ manual:"手动", automatic:"自动", uploaded:"上传", legacy:"旧格式", safety:"恢复前安全副本" } as Record<string,string>)[item.kind] ?? "备份"} · ${(item.size / 1024 ** 2).toFixed(2)} MiB · ${item.version ?? "版本未知"}${item.restorable ? "" : " · 当前无法恢复"}`, link,
        button("恢复", () => { if (confirm("恢复会用此备份替换当前数据，并启动备份对应的程序版本。备份之后的更改将不再可见，端口和代理配置也将恢复为备份中的值。确认恢复？")) void submit("restore", {backup:item.id}); }, busy || !item.restorable),
        button("删除", () => { if (confirm("永久删除此备份？")) void submit("delete", {backup:item.id}); }, busy));
    }));
  }

  async function poll(): Promise<void> {
    if (fetching || (sending && !pending)) return;
    fetching = true;
    try {
      let response: Response;
      try {
        response = await fetch("/api/v1/management/status", {cache:"no-store", signal:AbortSignal.timeout(4500)});
      } catch {
        showError(expectedStop() ? "连接暂时中断，正在等待服务恢复…" : "网络连接中断，无法读取软件管理状态。");
        return;
      }
      if (!response.ok) {
        const text = expectedStop() && [502,504].includes(response.status) ? "连接暂时中断，正在等待服务恢复…" : response.status === 503 ? "软件管理服务暂不可用（HTTP 503），请检查管理器状态和文件权限。" : `无法读取软件管理状态（HTTP ${response.status}）。`;
        showError(text);
        return;
      }
      state = await response.json() as State;
      if (transportPage) { messages[transportPage] = ""; transportPage = undefined; }
      if (pending && !sending && !state.pending) {
        const job = state.job;
        const matches = job && (pending.id ? job.id === pending.id : job.id !== pending.previous);
        if (matches && job.result !== "running") {
          pending = undefined; remember();
          if (job.result === "success" && job.targetSha === state.runningSha && ["update","rollback","restore"].includes(job.operation)) setTimeout(() => location.reload(), 1500);
        } else if ((!matches && job?.result !== "running") && Date.now() - pending.time > 20000) {
          messages[pageFor(pending.operation)] = "暂时无法确认任务是否已受理。"; pending = undefined; remember();
        }
      }
      render();
    } catch {
      const text = "软件管理状态响应无效，请检查服务日志。";
      showError(text);
    } finally { fetching = false; }
  }

  async function submit(operation: string, args: Record<string,string> = {}, archive?: File): Promise<void> {
    if (blocking() || !state?.enabled) return;
    sending = true;
    const page = pageFor(operation);
    messages[page] = archive ? "正在上传备份…" : "";
    pending = {previous:state.job?.id ?? null,time:Date.now(),operation};
    remember(); render();
    let rejected = false;
    try {
      const response = await fetch("/api/v1/management/" + (archive ? "upload" : "request"), {
        method:"POST", headers:{"Content-Type":archive ? "application/gzip" : "application/json"},
        body:archive ?? JSON.stringify({operation,...args}),
        signal:AbortSignal.timeout(archive ? 30 * 60 * 1000 : 8000),
      });
      if (!response.ok) {
        if (expectedStop() && [502,504].includes(response.status)) throw new Error("RESPONSE_INTERRUPTED");
        rejected = true;
        const result = await response.json().catch(() => ({})) as {error?:string};
        throw new Error(reasons[result.error ?? ""] ?? `请求未被接受（HTTP ${response.status}）。`);
      }
      const result = await response.json() as {id?:string;error?:string};
      if (!result.id) { rejected = true; throw new Error("请求响应无效，请检查软件管理状态。"); }
      pending.id = result.id; pending.time = Date.now(); remember();
      if (archive) file.value = "";
      messages[page] = "";
    } catch (error) {
      if (rejected) { pending = undefined; remember(); messages[page] = (error as Error).message; }
      else { if (pending) pending.time = Date.now(); remember(); messages[page] = ""; }
    } finally { sending = false; render(); void poll(); }
  }
  check.addEventListener("click", () => void submit("check"));
  install.addEventListener("click", () => { if (state?.latest && confirm("安装此版本？切换期间服务会短暂停止。")) void submit("update", {target:state.latest.sha}); });
  create.addEventListener("click", () => { if (confirm("创建备份会短暂停止服务。继续？")) void submit("backup"); });
  upload.addEventListener("click", () => { const selected = file.files?.[0]; if (selected) void submit("upload", {}, selected); });
  file.addEventListener("change", render);
  const visible = () => !document.hidden && (pending || ["#/settings/update", "#/settings/backups"].includes(location.hash));
  window.addEventListener("hashchange", () => { if (visible()) void poll(); });
  if (visible()) void poll();
  setInterval(() => { if (visible()) void poll(); }, 2000);
}
