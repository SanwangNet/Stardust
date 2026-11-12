import { createConfigStore, ConfigValidationError, type StardustConfig } from "./config.js";
import { createSecretStore } from "./model-secret.js";
import { networkDiagnostic, safeTarget, upstreamDiagnostic, type ModelDiagnostic } from "./model-diagnostics.js";
import { collectModelStream } from "./model-stream.js";

export class ModelError extends Error {
  readonly diagnostic: ModelDiagnostic;
  constructor(readonly code: string, readonly status: number, diagnostic?: ModelDiagnostic) {
    super(code);
    this.diagnostic = diagnostic ?? { source: "stardust", category: code, code };
  }
}
type ModelSettings = StardustConfig["model"];
const maxMessage = 32 * 1024;
const maxResponse = 1024 * 1024;

export class ModelService {
  constructor(
    private readonly store: ReturnType<typeof createConfigStore> = createConfigStore(),
    private readonly secrets: ReturnType<typeof createSecretStore> = createSecretStore(),
    private readonly request: typeof fetch = fetch,
  ) {}

  getConfig() {
    const model = this.store.loadConfig().model;
    const { key, fileKey, source, fileConfigured } = this.secrets.getKey();
    const redact = (value: string) => [key, fileKey].filter(Boolean).reduce((text, secret) => text.replaceAll(secret, "[REDACTED]"), value);
    return { baseUrl: redact(model.baseUrl), modelId: redact(model.modelId), timeoutMs: model.timeoutMs, stream: model.stream, keyConfigured: Boolean(key), keySource: source, fileKeyConfigured: fileConfigured, processOverride: source === "process" };
  }

  saveConfig(input: unknown) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new ModelError("INVALID_INPUT", 400);
    const data = input as Record<string, unknown>;
    if (Object.keys(data).some((key) => !["baseUrl", "modelId", "timeoutMs", "stream", "keyAction", "apiKey"].includes(key))) throw new ModelError("INVALID_INPUT", 400);
    if (typeof data.baseUrl !== "string" || typeof data.modelId !== "string" || typeof data.timeoutMs !== "number" || !["keep", "set", "clear"].includes(data.keyAction as string)) throw new ModelError("INVALID_INPUT", 400);
    if (data.keyAction === "set" && (typeof data.apiKey !== "string" || !data.apiKey || data.apiKey.length > 4096 || /[^\x21-\x7e]/.test(data.apiKey))) throw new ModelError("INVALID_INPUT", 400);
    if (data.keyAction !== "set" && data.apiKey !== undefined) throw new ModelError("INVALID_INPUT", 400);
    if (data.stream !== undefined && typeof data.stream !== "boolean") throw new ModelError("INVALID_INPUT", 400);
    const current = this.store.loadConfig();
    const model: ModelSettings = { baseUrl: data.baseUrl.trim(), modelId: data.modelId.trim(), timeoutMs: data.timeoutMs, stream: data.stream === undefined ? current.model.stream : data.stream as boolean };
    const { key: active, fileKey } = this.secrets.getKey();
    const newKey = data.keyAction === "set" ? data.apiKey as string : "";
    if ([active, fileKey, newKey].some((key) => key && (model.baseUrl.includes(key) || model.modelId.includes(key)))) throw new ModelError("INVALID_INPUT", 400);
    try { this.secrets.validateKey(newKey); } catch { throw new ModelError("INVALID_INPUT", 400); }
    try {
      // Config schema validates all fields before either file is changed.
      this.store.validateConfig({ ...current, model });
    } catch (error) {
      if (error instanceof ConfigValidationError) throw new ModelError("INVALID_INPUT", 400, { source: "stardust", category: "INVALID_INPUT", code: "INVALID_INPUT", message: error.message });
      throw error;
    }
    try {
      this.store.saveConfig({ ...current, model });
      if (data.keyAction !== "keep") this.secrets.saveKey(data.keyAction === "set" ? newKey : "");
    } catch {
      console.warn("[Stardust] 模型配置保存失败；部分修改可能已写入。");
      throw new ModelError("SAVE_FAILED", 500, { source: "stardust", category: "SAVE_FAILED", code: "SAVE_FAILED", message: "保存失败，部分修改可能已写入，请重新加载后检查。" });
    }
    return this.getConfig();
  }

  async chat(message: unknown, cancellation?: AbortSignal): Promise<string> {
    if (typeof message !== "string" || !message.trim() || Buffer.byteLength(message, "utf8") > maxMessage) throw new ModelError("INVALID_INPUT", 400);
    const { baseUrl, modelId, timeoutMs, stream } = this.store.loadConfig().model;
    if (!baseUrl || !modelId) throw new ModelError("NOT_CONFIGURED", 400);
    const { key, fileKey } = this.secrets.getKey();
    const endpoint = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const headers: Record<string, string> = { "Content-Type": "application/json", Accept: stream ? "text/event-stream" : "application/json" };
    if (key) headers.Authorization = `Bearer ${key}`;
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = cancellation ? AbortSignal.any([timeout, cancellation]) : timeout;
    try {
      const response = await this.request(endpoint, { method: "POST", headers, body: JSON.stringify({ model: modelId, messages: [{ role: "user", content: message }], stream }), redirect: "error", signal });
      if (!response.ok) {
        const diagnostic = await upstreamDiagnostic(response, endpoint, [key, fileKey], message);
        throw new ModelError(diagnostic.category, 502, diagnostic);
      }
      const invalidResponse = () => new ModelError("INVALID_RESPONSE", 502, { source: "upstream", category: "INVALID_RESPONSE", status: response.status, target: safeTarget(endpoint, [key, fileKey], message) });
      if (Number(response.headers.get("content-length")) > maxResponse) { await response.body?.cancel(); throw invalidResponse(); }
      if (stream) {
        const incomplete = () => new ModelError("STREAM_INCOMPLETE", 502, { source: "upstream", category: "STREAM_INCOMPLETE", status: response.status, target: safeTarget(endpoint, [key, fileKey], message) });
        const streamError = async (data: string) => {
          const errorHeaders = new Headers({ "content-type": "application/json" });
          const requestId = response.headers.get("x-request-id") ?? response.headers.get("request-id");
          if (requestId) errorHeaders.set("x-request-id", requestId);
          const diagnostic = await upstreamDiagnostic(new Response(data, { status: 200, headers: errorHeaders }), endpoint, [key, fileKey], message);
          diagnostic.status = response.status;
          return new ModelError(diagnostic.category, 502, diagnostic);
        };
        const text = await collectModelStream(response, signal, maxResponse, invalidResponse, incomplete, streamError);
        return [key, fileKey].filter(Boolean).reduce((value, secret) => value.replaceAll(secret, "[REDACTED]"), text);
      }
      const reader = response.body?.getReader();
      if (!reader) throw invalidResponse();
      const chunks: Uint8Array[] = [];
      let size = 0;
      let reachedEnd = false;
      const cancel = () => { void reader.cancel().catch(() => {}); };
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (signal.aborted) throw signal.reason;
          if (done) { reachedEnd = true; break; }
          size += value.byteLength;
          if (size > maxResponse) throw invalidResponse();
          chunks.push(value);
        }
      } finally {
        signal.removeEventListener("abort", cancel);
        if (!reachedEnd) cancel();
        try { reader.releaseLock(); } catch { /* Cancellation can still be settling. */ }
      }
      let data: unknown;
      try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { throw invalidResponse(); }
      const choices = (data as { choices?: unknown })?.choices;
      const text = Array.isArray(choices) ? choices[0]?.message?.content : undefined;
      if (typeof text !== "string" || !text.trim()) throw invalidResponse();
      return [key, fileKey].filter(Boolean).reduce((value, secret) => value.replaceAll(secret, "[REDACTED]"), text);
    } catch (error) {
      if (error instanceof ModelError) throw error;
      if (cancellation?.aborted) throw new ModelError("REQUEST_CANCELLED", 499);
      const diagnostic = networkDiagnostic(error, timeout.aborted, endpoint, [key, fileKey], message);
      throw new ModelError(diagnostic.category, diagnostic.category === "TIMEOUT" ? 504 : 502, diagnostic);
    }
  }
  async testConnection(cancellation?: AbortSignal): Promise<void> { await this.chat("Hello", cancellation); }
}

export const modelService = new ModelService();
