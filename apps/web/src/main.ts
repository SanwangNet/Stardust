interface HealthResponse {
  status: "ok";
  service: string;
  version: string;
  startedAt: string;
  uptimeMs: number;
  checkedAt: string;
}

function getElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`缺少页面元素 #${id}`);
  return element as T;
}

const refreshButton = getElement<HTMLButtonElement>("refresh-button");
const statusLabel = getElement<HTMLElement>("connection-label");
const statusDot = getElement<HTMLElement>("connection-dot");
const serverVersion = getElement<HTMLElement>("server-version");
const serverUptime = getElement<HTMLElement>("server-uptime");
const lastChecked = getElement<HTMLElement>("last-checked");
const refreshLabel = getElement<HTMLElement>("refresh-label");
const themeSelect = getElement<HTMLSelectElement>("theme-select");
const mainStatus = getElement<HTMLElement>("main-status");
const statusDescription = getElement<HTMLElement>("status-description");

function formatUptime(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours} 小时 ${minutes} 分钟`;
  if (minutes > 0) return `${minutes} 分钟`;
  return `${seconds} 秒`;
}

function formatTime(value: string): string {
  return new Date(value).toLocaleTimeString("zh-CN", { hour12: false });
}

function isHealthResponse(value: unknown): value is HealthResponse {
  if (!value || typeof value !== "object") return false;
  const data = value as Record<string, unknown>;
  return data.status === "ok"
    && typeof data.service === "string"
    && typeof data.version === "string"
    && typeof data.uptimeMs === "number"
    && Number.isFinite(data.uptimeMs)
    && typeof data.startedAt === "string"
    && typeof data.checkedAt === "string";
}

async function refreshStatus(): Promise<void> {
  if (refreshButton.disabled) return;
  refreshButton.disabled = true;
  refreshButton.classList.add("is-busy");
  refreshLabel.textContent = "正在刷新";
  try {
    const response = await fetch("/api/health", {
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload: unknown = await response.json();
    if (!isHealthResponse(payload)) throw new Error("服务返回了不符合约定的数据");

    statusDot.className = "status-dot is-online";
    statusLabel.textContent = "后端已连接";
    mainStatus.textContent = "服务运行正常";
    statusDescription.textContent = "已连接到 Stardust Server";
    serverVersion.textContent = `v${payload.version}`;
    serverUptime.textContent = formatUptime(payload.uptimeMs);
    lastChecked.textContent = formatTime(payload.checkedAt);
  } catch (error) {
    statusDot.className = "status-dot is-offline";
    statusLabel.textContent = "后端未连接";
    mainStatus.textContent = "无法连接到服务";
    statusDescription.textContent = error instanceof Error ? error.message : "未知错误";
    serverVersion.textContent = "—";
    serverUptime.textContent = "—";
    lastChecked.textContent = "—";
  } finally {
    refreshButton.disabled = false;
    refreshButton.classList.remove("is-busy");
    refreshLabel.textContent = "刷新状态";
  }
}

type ThemePreference = "system" | "light" | "dark";
const themeKey = "stardust-theme";

function applyTheme(preference: ThemePreference): void {
  if (preference === "system") {
    delete document.documentElement.dataset.theme;
  } else {
    document.documentElement.dataset.theme = preference;
  }
  themeSelect.value = preference;
}

let storedTheme: string | null = null;
try {
  storedTheme = localStorage.getItem(themeKey);
} catch {
  // The interface still follows the system when storage is unavailable.
}
applyTheme(storedTheme === "light" || storedTheme === "dark" ? storedTheme : "system");
themeSelect.addEventListener("change", () => {
  const preference = themeSelect.value as ThemePreference;
  applyTheme(preference);
  try {
    localStorage.setItem(themeKey, preference);
  } catch {
    // The selected theme remains active for this page session.
  }
});
refreshButton.addEventListener("click", () => void refreshStatus());
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void refreshStatus();
});
void refreshStatus();
setInterval(() => {
  if (!document.hidden) void refreshStatus();
}, 30_000);


