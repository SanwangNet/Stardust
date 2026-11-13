import { createConfigStore, ConfigValidationError, type StardustConfig } from "./config.js";
import { createSecretStore } from "./model-secret.js";
import { networkDiagnostic, safeTarget, upstreamDiagnostic, type ModelDiagnostic } from "./model-diagnostics.js";
import { collectModelStream, collectModelTurn } from "./model-stream.js";
import { randomUUID } from "node:crypto";
import { logger, type LogService } from "./logger.js";

export class ModelError extends Error {
  readonly diagnostic: ModelDiagnostic;
  constructor(readonly code: string, readonly status: number, diagnostic?: ModelDiagnostic) {
    super(code);
    this.diagnostic = diagnostic ?? { source: "stardust", category: code, code };
  }
}
type ModelSettings = StardustConfig["model"];
export type ToolCall = { id: string; name: string; arguments: string };
export type ModelTurnMessage = { role: "system" | "user" | "assistant" | "tool"; content: string | null; tool_call_id?: string; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] };
const maxMessage = 32 * 1024;
const maxResponse = 1024 * 1024;

export class ModelService {
  constructor(
    private readonly store: ReturnType<typeof createConfigStore> = createConfigStore(),
    private readonly secrets: ReturnType<typeof createSecretStore> = createSecretStore(),
    private readonly request: typeof fetch = fetch,
    private readonly logs: LogService = logger,
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
      this.logs.write("ERROR", "model", "模型配置保存失败；部分修改可能已写入。");
      throw new ModelError("SAVE_FAILED", 500, { source: "stardust", category: "SAVE_FAILED", code: "SAVE_FAILED", message: "保存失败，部分修改可能已写入，请重新加载后检查。" });
    }
    return this.getConfig();
  }

  async chat(message: unknown, cancellation?: AbortSignal, context?: { eventId?: string }): Promise<string> {
    const requestId = randomUUID();
    const started = Date.now();
    this.logs.write("DEBUG", "model", "模型请求开始。", { requestId, eventId: context?.eventId });
    try {
      const reply = await this.performChat(message, cancellation);
      this.logs.write("INFO", "model", "模型请求完成。", { requestId, eventId: context?.eventId, durationMs: Date.now() - started });
      return reply;
    } catch (error) {
      let secrets: string[] = typeof message === "string" ? [message] : [];
      try { const keys = this.secrets.getKey(); secrets = [...secrets, keys.key, keys.fileKey]; } catch {}
      const diagnostic = error instanceof ModelError ? error.diagnostic : undefined;
      this.logs.write("ERROR", "model", "模型请求失败。", { requestId, eventId: context?.eventId, durationMs: Date.now() - started, status: diagnostic?.status, code: diagnostic?.code, category: diagnostic?.category, message: diagnostic?.message }, secrets);
      throw error;
    }
  }
  async chatWithTools(messages: ModelTurnMessage[], tools: { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }[], cancellation?: AbortSignal): Promise<{ content: string; toolCalls: ToolCall[] }> {
    const { baseUrl, modelId, timeoutMs, stream } = this.store.loadConfig().model;
    if (!baseUrl || !modelId) throw new ModelError("NOT_CONFIGURED", 400);
    const { key, fileKey } = this.secrets.getKey();
    const endpoint = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const privateText = messages.map((entry) => entry.content ?? "").join("\n");
    const headers: Record<string, string> = { "Content-Type": "application/json", Accept: stream ? "text/event-stream" : "application/json" };
    if (key) headers.Authorization = `Bearer ${key}`;
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = cancellation ? AbortSignal.any([timeout, cancellation]) : timeout;
    const started = Date.now(); const requestId = randomUUID();
    this.logs.write("DEBUG", "model", "工具对话模型请求开始。", { requestId });
    try {
      const response = await this.request(endpoint, { method: "POST", headers, body: JSON.stringify({ model: modelId, messages, ...(tools.length ? { tools } : {}), stream }), redirect: "error", signal });
      if (!response.ok) { const diagnostic = await upstreamDiagnostic(response, endpoint, [key, fileKey], privateText); throw new ModelError(diagnostic.category, 502, diagnostic); }
      const invalid = () => new ModelError("INVALID_RESPONSE", 502);
      if (Number(response.headers.get("content-length")) > maxResponse) { await response.body?.cancel(); throw invalid(); }
      let turn: { content: string; toolCalls: ToolCall[] };
      if (stream) {
        turn = await collectModelTurn(response, signal, maxResponse, invalid, () => new ModelError("STREAM_INCOMPLETE", 502), async (data) => {
          const diagnostic = await upstreamDiagnostic(new Response(data, { status: 200, headers: { "content-type": "application/json" } }), endpoint, [key, fileKey], privateText);
          return new ModelError(diagnostic.category, 502, diagnostic);
        });
      } else {
        const reader = response.body?.getReader(); if (!reader) throw invalid();
        const chunks: Uint8Array[] = []; let size = 0; let ended = false;
        const cancel = () => { void reader.cancel().catch(() => {}); };
        signal.addEventListener("abort", cancel, { once: true }); if (signal.aborted) cancel();
        try {
          for (;;) { const part = await reader.read(); if (signal.aborted) throw signal.reason; if (part.done) { ended = true; break; } size += part.value.length; if (size > maxResponse) throw invalid(); chunks.push(part.value); }
        } finally { signal.removeEventListener("abort", cancel); if (!ended) cancel(); try { reader.releaseLock(); } catch {} }
        let data: { choices?: { message?: { content?: unknown; tool_calls?: unknown } }[] };
        try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")) as typeof data; } catch { throw invalid(); }
        const msg = Array.isArray(data?.choices) ? data.choices[0]?.message : undefined;
        if (!msg || (msg.content != null && typeof msg.content !== "string") || (msg.tool_calls != null && !Array.isArray(msg.tool_calls))) throw invalid();
        const calls = (msg.tool_calls ?? []) as { id?: unknown; type?: unknown; function?: { name?: unknown; arguments?: unknown } }[];
        if (calls.length > 8 || calls.some((call) => !call || call.type !== "function" || typeof call.id !== "string" || !call.id || call.id.length > 256 || typeof call.function?.name !== "string" || !call.function.name || call.function.name.length > 128 || typeof call.function.arguments !== "string" || call.function.arguments.length > 32768)) throw invalid();
        turn = { content: (msg.content as string | null | undefined) ?? "", toolCalls: calls.map((call) => ({ id: call.id as string, name: call.function!.name as string, arguments: call.function!.arguments as string })) };
        if (!turn.content.trim() && !turn.toolCalls.length) throw invalid();
      }
      if (new Set(turn.toolCalls.map((call) => call.id)).size !== turn.toolCalls.length || [key, fileKey].filter(Boolean).some((secret) => turn.toolCalls.some((call) => call.arguments.includes(secret) || call.id.includes(secret) || call.name.includes(secret)))) throw invalid();
      turn.content = [key, fileKey].filter(Boolean).reduce((value, secret) => value.replaceAll(secret, "[REDACTED]"), turn.content);
      this.logs.write("INFO", "model", "工具对话模型请求完成。", { requestId, durationMs: Date.now() - started });
      return turn;
    } catch (error) {
      const normalized = error instanceof ModelError ? error : cancellation?.aborted ? new ModelError("REQUEST_CANCELLED", 499) : (() => { const diagnostic = networkDiagnostic(error, timeout.aborted, endpoint, [key, fileKey], privateText); return new ModelError(diagnostic.category, diagnostic.category === "TIMEOUT" ? 504 : 502, diagnostic); })();
      this.logs.write("ERROR", "model", "工具对话模型请求失败。", { requestId, durationMs: Date.now() - started, status: normalized.diagnostic.status, code: normalized.diagnostic.code, category: normalized.diagnostic.category }, [key, fileKey, privateText]);
      throw normalized;
    }
  }
  private async performChat(message: unknown, cancellation?: AbortSignal): Promise<string> {
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
  async testConnection(cancellation?: AbortSignal): Promise<void> {
    try { await this.chat("Hello", cancellation); this.logs.write("INFO", "model", "模型连接测试成功。"); }
    catch (error) { this.logs.write("WARN", "model", "模型连接测试失败。"); throw error; }
  }
}

export const modelService = new ModelService();
