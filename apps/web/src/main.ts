import { formatModelError, noModelResponseMessage } from "./model-errors.js";

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
const setupThemeSelect = getElement<HTMLSelectElement>("setup-theme-select");
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
  setupThemeSelect.value = preference;
}

let storedTheme: string | null = null;
try {
  storedTheme = localStorage.getItem(themeKey);
} catch {
  // The interface still follows the system when storage is unavailable.
}
applyTheme(storedTheme === "light" || storedTheme === "dark" ? storedTheme : "system");
function setThemePreference(preference: ThemePreference): void {
  applyTheme(preference);
  try {
    localStorage.setItem(themeKey, preference);
  } catch {
    // The selected theme remains active for this page session.
  }
}
themeSelect.addEventListener("change", () => setThemePreference(themeSelect.value as ThemePreference));
setupThemeSelect.addEventListener("change", () => setThemePreference(setupThemeSelect.value as ThemePreference));
refreshButton.addEventListener("click", () => void refreshStatus());
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void refreshStatus();
});
void refreshStatus();
setInterval(() => {
  if (!document.hidden) void refreshStatus();
}, 30_000);



type SetupConfig = {
  service: { description: string };
  server: { host: string; port: number };
  web: { title: string };
};
const setupDialog = getElement<HTMLDialogElement>("setup-dialog");
const setupForm = getElement<HTMLFormElement>("setup-form");
const setupDescription = getElement<HTMLTextAreaElement>("setup-description");
const setupTitle = getElement<HTMLInputElement>("setup-title");
const setupHost = getElement<HTMLInputElement>("setup-host");
const setupPort = getElement<HTMLInputElement>("setup-port");
const setupDefaults = getElement<HTMLInputElement>("setup-defaults");
const setupBack = getElement<HTMLButtonElement>("setup-back");
const setupNext = getElement<HTMLButtonElement>("setup-next");
const setupSubmit = getElement<HTMLButtonElement>("setup-submit");
const setupError = getElement<HTMLElement>("setup-error");
const setupStateError = getElement<HTMLElement>("setup-state-error");
const setupSteps = Array.from(document.querySelectorAll<HTMLElement>(".setup-step"));
let setupStep = 0;
let setupFinished = false;
let setupLoaded = false;
let setupBusy = false;
let previousServer = { host: "127.0.0.1", port: "8347" };

function setSetupError(message: string): void {
  setupError.textContent = message;
  setupError.hidden = !message;
}
function showSetupStep(step: number): void {
  setupStep = step;
  setSetupError("");
  setupSteps.forEach((section, index) => { section.hidden = index !== step; });
  setupBack.hidden = step === 0;
  setupNext.hidden = step === 3;
  setupSubmit.hidden = step !== 3;
  const heading = setupSteps[step]?.querySelector("h2");
  if (heading) {
    heading.id ||= `setup-step-heading-${step}`;
    setupDialog.setAttribute("aria-labelledby", heading.id);
    heading.tabIndex = -1;
    if (setupDialog.open) heading.focus();
  }
  if (step === 3) {
    getElement<HTMLElement>("summary-description").textContent = setupDescription.value || "—";
    getElement<HTMLElement>("summary-title").textContent = setupTitle.value;
    getElement<HTMLElement>("summary-host").textContent = setupHost.value;
    getElement<HTMLElement>("summary-port").textContent = setupPort.value;
  }
}
function validateSetupStep(): boolean {
  const fields = setupStep === 1 ? [setupTitle] : setupStep === 2 ? [setupHost, setupPort] : [];
  for (const field of fields) {
    field.setCustomValidity(field.type !== "number" && !field.value.trim() ? "此项不能为空。" : "");
    if (!field.reportValidity()) return false;
  }
  return true;
}
async function refreshSetupState(): Promise<void> {
  if (setupFinished) return;
  try {
    const response = await fetch("/api/v1/setup/state", { cache: "no-store", signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error("状态不可用");
    const state = await response.json() as { initialized: boolean; config?: SetupConfig; webTitle?: string };
    if (setupFinished) return;
    if (typeof state.initialized !== "boolean") throw new Error("状态不可用");
    setupStateError.hidden = true;
    if (state.initialized) {
      setupFinished = true;
      if (typeof state.webTitle === "string") document.title = state.webTitle;
      if (setupDialog.open) setupDialog.close();
      showModel();
    } else if (!setupLoaded && state.config) {
      setupDescription.value = state.config.service.description;
      setupTitle.value = state.config.web.title;
      setupHost.value = state.config.server.host;
      setupPort.value = String(state.config.server.port);
      setupLoaded = true;
      showSetupStep(0);
      setupDialog.showModal();
    } else if (!setupLoaded) throw new Error("状态不可用");
  } catch {
    if (!setupLoaded) setupStateError.hidden = false;
  }
}
setupDialog.addEventListener("cancel", (event) => event.preventDefault());
setupDefaults.addEventListener("change", () => {
  if (setupDefaults.checked) {
    previousServer = { host: setupHost.value, port: setupPort.value };
    setupHost.value = "127.0.0.1";
    setupPort.value = "8347";
  } else {
    setupHost.value = previousServer.host;
    setupPort.value = previousServer.port;
  }
  setupHost.disabled = setupDefaults.checked;
  setupPort.disabled = setupDefaults.checked;
});
setupNext.addEventListener("click", () => { if (validateSetupStep()) showSetupStep(setupStep + 1); });
setupBack.addEventListener("click", () => showSetupStep(setupStep - 1));
getElement<HTMLButtonElement>("setup-retry").addEventListener("click", () => void refreshSetupState());
setupForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (setupBusy || setupStep !== 3) return;
  setupBusy = true;
  setupSubmit.disabled = true;
  setupBack.disabled = true;
  setSetupError("");
  void (async () => {
    try {
      const response = await fetch("/api/v1/setup/complete", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service: { description: setupDescription.value }, server: { host: setupHost.value, port: Number(setupPort.value) }, web: { title: setupTitle.value } }),
        signal: AbortSignal.timeout(10000),
      });
      if (response.status === 409) {
        await refreshSetupState();
        setupFinished = true;
        if (setupDialog.open) setupDialog.close();
        showModel();
        return;
      }
      if (!response.ok) {
        const data = await response.json() as { message?: string };
        throw new Error(response.status === 400 ? data.message || "请检查填写的配置。" : "保存失败，请重试。");
      }
      setupFinished = true;
      document.title = setupTitle.value;
      setupDialog.close();
      showModel();
    } catch (error) {
      setSetupError(error instanceof Error ? error.message : "保存失败，请重试。");
    } finally {
      setupBusy = false;
      setupSubmit.disabled = false;
      setupBack.disabled = false;
    }
  })();
});
document.addEventListener("visibilitychange", () => { if (!document.hidden) void refreshSetupState(); });
void refreshSetupState();
setInterval(() => { if (!document.hidden) void refreshSetupState(); }, 3000);

type ModelView = { baseUrl: string; modelId: string; timeoutMs: number; stream: boolean; keyConfigured: boolean; keySource: "process" | "file" | "none"; fileKeyConfigured: boolean; processOverride: boolean };
const modelSection = getElement<HTMLElement>("model-section");
const modelForm = getElement<HTMLFormElement>("model-form");
const modelUrl = getElement<HTMLInputElement>("model-url");
const modelId = getElement<HTMLInputElement>("model-id");
const modelTimeout = getElement<HTMLInputElement>("model-timeout");
const modelStream = getElement<HTMLInputElement>("model-stream");
const modelKey = getElement<HTMLInputElement>("model-key");
const modelClearKey = getElement<HTMLInputElement>("model-clear-key");
const modelKeyStatus = getElement<HTMLElement>("model-key-status");
const modelStatus = getElement<HTMLElement>("model-status");
const modelSave = getElement<HTMLButtonElement>("model-save");
const modelTest = getElement<HTMLButtonElement>("model-test");
const chatForm = getElement<HTMLFormElement>("chat-form");
const chatInput = getElement<HTMLTextAreaElement>("chat-input");
const chatSend = getElement<HTMLButtonElement>("chat-send");
const chatStatus = getElement<HTMLElement>("chat-status");
const chatMessages = getElement<HTMLElement>("chat-messages");
let modelLoaded = false;

async function modelRequest(path: string, body?: unknown): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path, body === undefined ? { cache: "no-store" } : {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(130000),
    });
  } catch {
    throw new Error(noModelResponseMessage());
  }
  let data: unknown;
  try { data = await response.json(); }
  catch {
    if (!response.ok) throw new Error(formatModelError(undefined, response.status));
    throw new Error("Stardust 服务端返回了无法识别的响应。");
  }
  if (!response.ok) {
    throw new Error(formatModelError((data as { error?: unknown })?.error, response.status));
  }
  return data;
}
function renderModelConfig(config: ModelView): void {
  modelUrl.value = config.baseUrl;
  modelId.value = config.modelId;
  modelTimeout.value = String(config.timeoutMs);
  modelStream.checked = config.stream;
  modelKey.value = "";
  modelClearKey.checked = false;
  modelKey.disabled = false;
  if (config.processOverride) {
    modelKeyStatus.textContent = `当前使用进程环境变量，文件中的密钥修改不会生效，直至移除进程变量并重启。文件密钥${config.fileKeyConfigured ? "已配置" : "未配置"}。`;
  } else {
    modelKeyStatus.textContent = config.keyConfigured ? "API Key 已配置；留空可保留。" : "API Key 未配置；本地无鉴权服务可留空。";
  }
}
function showModel(): void {
  modelSection.hidden = false;
  if (modelLoaded) return;
  modelLoaded = true;
  void modelRequest("/api/v1/model/config").then((value) => renderModelConfig(value as ModelView)).catch((error: unknown) => {
    modelLoaded = false;
    modelStatus.textContent = error instanceof Error ? error.message : "无法读取模型配置。";
  });
}
function setModelBusy(busy: boolean): void { modelSave.disabled = busy; modelTest.disabled = busy; }
modelClearKey.addEventListener("change", () => { modelKey.disabled = modelClearKey.checked; });
modelForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (modelSave.disabled) return;
  setModelBusy(true);
  modelStatus.textContent = "正在保存…";
  const keyAction = modelClearKey.checked ? "clear" : modelKey.value ? "set" : "keep";
  const input: Record<string, unknown> = { baseUrl: modelUrl.value, modelId: modelId.value, timeoutMs: modelTimeout.valueAsNumber, stream: modelStream.checked, keyAction };
  if (keyAction === "set") input.apiKey = modelKey.value;
  void modelRequest("/api/v1/model/config", input).then((value) => {
    renderModelConfig(value as ModelView);
    modelStatus.textContent = "配置已保存。";
  }).catch((error: unknown) => { modelStatus.textContent = error instanceof Error ? error.message : "保存失败，请重试。"; })
    .finally(() => setModelBusy(false));
});
modelTest.addEventListener("click", () => {
  if (modelTest.disabled) return;
  setModelBusy(true);
  modelStatus.textContent = "正在测试已保存的配置…";
  void modelRequest("/api/v1/model/test", {}).then(() => { modelStatus.textContent = "连接测试成功。"; })
    .catch((error: unknown) => { modelStatus.textContent = error instanceof Error ? error.message : "连接测试失败。"; })
    .finally(() => setModelBusy(false));
});
function addMessage(role: string, message: string): void {
  const entry = document.createElement("div");
  entry.className = "chat-message";
  const label = document.createElement("strong");
  label.textContent = role;
  const content = document.createElement("p");
  content.textContent = message;
  entry.append(label, content);
  chatMessages.append(entry);
}
chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (chatSend.disabled || !chatInput.value.trim()) return;
  const message = chatInput.value;
  addMessage("你", message);
  chatInput.value = "";
  chatSend.disabled = true;
  chatStatus.textContent = "正在等待回复…";
  void modelRequest("/api/v1/model/chat", { message }).then((value) => {
    addMessage("模型", (value as { reply: string }).reply);
    chatStatus.textContent = "";
  }).catch((error: unknown) => { chatStatus.textContent = error instanceof Error ? error.message : "发送失败，请重试。"; })
    .finally(() => { chatSend.disabled = false; });
});
