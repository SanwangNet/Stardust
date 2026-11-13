import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { AlreadyInitializedError, ConfigValidationError, validateConfigUpdate, type ConfigUpdate } from "./config.js";
import { setupService, type SetupService } from "./setup.js";
import { ModelError, modelService, type ModelService } from "./model.js";
import { ExtensionError, ExtensionManager } from "./extension-manager.js";
import { logger, type LogService, type LogEntry } from "./logger.js";
import { AdminAuth } from "./admin-auth.js";
import { ToolRuns } from "./tool-runs.js";

export interface AppOptions {
  version?: string;
  staticDir?: string;
  startedAt?: Date;
  setupService?: SetupService;
  modelService?: ModelService;
  extensionManager?: ExtensionManager;
  logService?: LogService;
  adminAuth?: AdminAuth;
}

const defaultStaticDir = fileURLToPath(new URL("../../web/dist/", import.meta.url));
const securityHeaders = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
};

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, {
    ...securityHeaders,
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(body));
}

const maxSetupBody = 16 * 1024;
const maxCapabilityUploadBody = 20 * 1024 * 1024 + 64 * 1024;
const maxCapabilityImageSize = 10 * 1024 * 1024;

function isSameOrigin(request: IncomingMessage): boolean {
  if (request.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = request.headers.origin;
  if (!origin) return true; // Non-browser clients may omit Origin; JSON is still required.
  if (!request.headers.host) return false;
  try {
    return new URL(origin).origin === new URL(`http://${request.headers.host}`).origin && origin !== "null";
  } catch {
    return false;
  }
}

function readSetupBody(request: IncomingMessage, limit = maxSetupBody): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on("data", (bytes: Buffer) => {
      size += bytes.length;
      if (size <= limit) chunks.push(bytes);
    });
    request.on("error", reject);
    request.on("end", () => {
      if (size > limit) return reject(new RangeError("BODY_TOO_LARGE"));
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown); }
      catch (error) { reject(error); }
    });
  });
}

function readRawBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on("data", (bytes: Buffer) => {
      size += bytes.length;
      if (size <= limit) chunks.push(bytes);
    });
    request.on("error", reject);
    request.on("end", () => size > limit ? reject(new RangeError("BODY_TOO_LARGE")) : resolve(Buffer.concat(chunks)));
  });
}

async function readCapabilityForm(request: IncomingMessage): Promise<Record<string, unknown>> {
  const contentType = request.headers["content-type"] ?? "";
  if (!/^multipart\/form-data\s*;/i.test(contentType)) throw new TypeError("INVALID_INPUT");
  const raw = await readRawBody(request, maxCapabilityUploadBody);
  const form = await new Request("http://localhost/", { method: "POST", headers: { "Content-Type": contentType }, body: raw }).formData();
  const fields: Record<string, unknown> = {};
  const images: Buffer[] = [];
  const imageSeen = new Set<string>();
  for (const [key, value] of form.entries()) {
    if (key === "image1" || key === "image2") {
      if (imageSeen.has(key) || !(value instanceof File) || value.type.toLowerCase() !== "image/png" || !value.name.toLowerCase().endsWith(".png") || value.size < 33 || value.size > maxCapabilityImageSize) throw new TypeError("INVALID_INPUT");
      const bytes = Buffer.from(await value.arrayBuffer());
      if (bytes.length !== value.size || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR" || bytes.readUInt32BE(16) === 0 || bytes.readUInt32BE(20) === 0) throw new TypeError("INVALID_INPUT");
      imageSeen.add(key);
      images[key === "image1" ? 0 : 1] = bytes;
    } else {
      if (typeof value !== "string" || Object.hasOwn(fields, key)) throw new TypeError("INVALID_INPUT");
      fields[key] = value;
    }
  }
  if (!images[0] || !images[1] || images[0].equals(images[1])) throw new TypeError("INVALID_INPUT");
  fields.imageFiles = [images[0], images[1]];
  return fields;
}

const staticFiles: Readonly<Record<string, { filename: string; contentType: string }>> = {
  "/": { filename: "index.html", contentType: "text/html; charset=utf-8" },
  "/index.html": { filename: "index.html", contentType: "text/html; charset=utf-8" },
  "/main.js": { filename: "main.js", contentType: "text/javascript; charset=utf-8" },
  "/model-errors.js": { filename: "model-errors.js", contentType: "text/javascript; charset=utf-8" },
  "/style.css": { filename: "style.css", contentType: "text/css; charset=utf-8" },
  "/favicon.svg": { filename: "favicon.svg", contentType: "image/svg+xml" },
};

export function createStardustServer(options: AppOptions = {}): Server {
  const startedAt = options.startedAt ?? new Date();
  const version = options.version ?? "0.1.0";
  const staticDir = options.staticDir ?? defaultStaticDir;
  const setup = options.setupService ?? setupService;
  const model = options.modelService ?? modelService;
  const logs = options.logService ?? logger;
  const extensions = options.extensionManager ?? new ExtensionManager(undefined, model, [], logs);
  const admin = options.adminAuth ?? new AdminAuth();
  const toolRuns = new ToolRuns(model, extensions, logs);
  const streams = new Set<ServerResponse>();

  const server = createServer(async (request, response) => {
    let pathname: string;
    try {
      pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    } catch {
      sendJson(response, 400, { error: "INVALID_URL" });
      return;
    }

    if (pathname.startsWith("/api/v1/admin/") || pathname === "/api/v1/tool-runs" || pathname.startsWith("/api/v1/tool-runs/")) {
      try {
        if (!setup.getInitializationState().initialized) { sendJson(response, 403, { error: "SETUP_REQUIRED" }); return; }
        if (!admin.local(request)) { sendJson(response, 403, { error: "LOCAL_ONLY" }); return; }
        if (pathname === "/api/v1/admin/state" && request.method === "GET") { sendJson(response, 200, { configured: admin.configuredSecurely(), authenticated: Boolean(admin.session(request)) }); return; }
        if (request.method === "POST") {
          if (!request.headers.origin || !isSameOrigin(request)) { sendJson(response, 403, { error: "INVALID_ORIGIN" }); return; }
          if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers["content-type"] ?? "")) { sendJson(response, 400, { error: "INVALID_INPUT" }); return; }
          let body: unknown; try { body = await readSetupBody(request, 32768); } catch { sendJson(response, 400, { error: "INVALID_INPUT" }); return; }
          if (!body || typeof body !== "object" || Array.isArray(body)) { sendJson(response, 400, { error: "INVALID_INPUT" }); return; }
          const fields = body as Record<string, unknown>;
          if (pathname === "/api/v1/admin/login") {
            if (Object.keys(fields).length !== 1 || typeof fields.token !== "string") { sendJson(response, 400, { error: "INVALID_INPUT" }); return; }
            const session = admin.login(fields.token);
            if (!session) { sendJson(response, 401, { error: "AUTH_FAILED" }); return; }
            response.setHeader("Set-Cookie", `stardust_admin=${session}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800`);
            sendJson(response, 200, { authenticated: true }); return;
          }
          const owner = admin.session(request);
          if (!owner) { sendJson(response, 401, { error: "AUTH_REQUIRED" }); return; }
          if (pathname === "/api/v1/tool-runs") {
            if (Object.keys(fields).length !== 1 || typeof fields.message !== "string") { sendJson(response, 400, { error: "INVALID_INPUT" }); return; }
            const id = toolRuns.start(owner, fields.message); sendJson(response, 202, { id }); return;
          }
          const decision = /^\/api\/v1\/tool-runs\/([0-9a-f-]{36})\/decision$/.exec(pathname);
          if (decision) {
            if (Object.keys(fields).length !== 2 || typeof fields.toolCallId !== "string" || typeof fields.approved !== "boolean") { sendJson(response, 400, { error: "INVALID_INPUT" }); return; }
            toolRuns.decide(owner, decision[1]!, fields.toolCallId, fields.approved); sendJson(response, 202, { ok: true }); return;
          }
        } else if (request.method === "GET") {
          const owner = admin.session(request);
          if (!owner) { sendJson(response, 401, { error: "AUTH_REQUIRED" }); return; }
          const match = /^\/api\/v1\/tool-runs\/([0-9a-f-]{36})$/.exec(pathname);
          if (match) { sendJson(response, 200, toolRuns.get(owner, match[1]!)); return; }
        }
        sendJson(response, 404, { error: "NOT_FOUND" });
      } catch (error) {
        const code = error instanceof Error && ["INVALID_INPUT", "RUN_LIMIT", "RUN_NOT_FOUND", "APPROVAL_UNAVAILABLE"].includes(error.message) ? error.message : "TOOL_RUN_FAILED";
        sendJson(response, code === "RUN_NOT_FOUND" ? 404 : code === "APPROVAL_UNAVAILABLE" ? 409 : code === "INVALID_INPUT" ? 400 : 500, { error: code });
      }
      return;
    }
    if (pathname === "/api/v1/logs" || pathname === "/api/v1/logs/stream") {
      if (request.method !== "GET") { sendJson(response, 405, { error: "METHOD_NOT_ALLOWED" }); return; }
      if (!isSameOrigin(request)) { sendJson(response, 403, { error: "INVALID_ORIGIN" }); return; }
      const url = new URL(request.url ?? "/", "http://localhost");
      const lastEventId = request.headers["last-event-id"];
      const rawAfter = pathname.endsWith("/stream") ? ((typeof lastEventId === "string" ? lastEventId : "") || url.searchParams.get("after") || "0") : (url.searchParams.get("after") || "0");
      const rawLimit = url.searchParams.get("limit") ?? "200";
      if (!/^\d{1,15}$/.test(rawAfter) || !/^\d{1,4}$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 1000 || !Number.isSafeInteger(Number(rawAfter))) { sendJson(response, 400, { error: "INVALID_CURSOR" }); return; }
      const after = Number(rawAfter);
      if (pathname === "/api/v1/logs") { sendJson(response, 200, logs.read(after, Number(rawLimit))); return; }
      if (streams.size >= 32) { sendJson(response, 503, { error: "TOO_MANY_SUBSCRIBERS" }); return; }
      response.writeHead(200, { ...securityHeaders, "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
      streams.add(response);
      let closed = false;
      let unsubscribe = (): void => {};
      let blocked = false;
      let timeout: NodeJS.Timeout | undefined;
      let queuedBytes = 0;
      const queued: string[] = [];
      const close = (): void => { if (closed) return; closed = true; clearInterval(heartbeat); if (timeout) clearTimeout(timeout); unsubscribe(); streams.delete(response); };
      const disconnect = (): void => { close(); response.destroy(); };
      const send = (text: string): void => {
        if (closed || response.destroyed) { disconnect(); return; }
        try {
          if (!response.write(text)) {
            blocked = true;
            timeout = setTimeout(disconnect, 10_000); timeout.unref();
          }
        } catch { disconnect(); }
      };
      const format = (entry: LogEntry): string => `id: ${entry.id}\ndata: ${JSON.stringify(entry)}\n\n`;
      const snapshot = logs.read(after, 1000);
      if ((url.searchParams.has("instance") && url.searchParams.get("instance") !== logs.instanceId) || after > snapshot.latest) {
        response.end(`event: reset\ndata: {}\n\n`); streams.delete(response); return;
      }
      let replayIndex = 0;
      const pump = (): void => {
        while (!closed && !blocked && replayIndex < snapshot.entries.length) send(format(snapshot.entries[replayIndex++]!));
        while (!closed && !blocked && queued.length) { const frame = queued.shift()!; queuedBytes -= Buffer.byteLength(frame); send(frame); }
      };
      const heartbeat = setInterval(() => { if (!blocked && !closed) send(": keepalive\n\n"); }, 20_000);
      heartbeat.unref();
      response.on("close", close);
      response.on("drain", () => { if (timeout) clearTimeout(timeout); timeout = undefined; blocked = false; pump(); });
      unsubscribe = logs.subscribe((entry) => {
        const frame = format(entry);
        if (blocked || replayIndex < snapshot.entries.length || queued.length) {
          queuedBytes += Buffer.byteLength(frame);
          if (queuedBytes > 64 * 1024) { disconnect(); return; }
          queued.push(frame); pump();
        } else send(frame);
      });
      if (snapshot.gap) send(`event: gap\ndata: ${JSON.stringify({ oldest: snapshot.oldest, latest: snapshot.latest })}\n\n`);
      if (!blocked) send(": connected\n\n");
      pump();
      return;
    }

    if (pathname === "/api/v1/setup/state") {
      if (request.method !== "GET") {
        response.setHeader("Allow", "GET");
        sendJson(response, 405, { error: "METHOD_NOT_ALLOWED" });
        return;
      }
      try {
        const state = setup.getInitializationState();
        const config = setup.getSetupConfig();
        sendJson(response, 200, state.initialized ? { ...state, webTitle: config.web.title } : { ...state, config });
      } catch {
        sendJson(response, 500, { error: "SETUP_STATE_UNAVAILABLE" });
      }
      return;
    }

    if (pathname === "/api/v1/setup/complete") {
      if (request.method !== "POST") {
        response.setHeader("Allow", "POST");
        sendJson(response, 405, { error: "METHOD_NOT_ALLOWED" });
        return;
      }
      if (!isSameOrigin(request)) {
        sendJson(response, 403, { error: "INVALID_ORIGIN" });
        return;
      }
      if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers["content-type"] ?? "")) {
        sendJson(response, 400, { error: "INVALID_INPUT" });
        return;
      }
      let input: ConfigUpdate;
      try {
        input = await readSetupBody(request) as ConfigUpdate;
        validateConfigUpdate(input);
      } catch (error) {
        if (error instanceof RangeError) sendJson(response, 413, { error: "BODY_TOO_LARGE" });
        else sendJson(response, 400, { error: "INVALID_INPUT", message: error instanceof ConfigValidationError ? error.message : "无效的请求数据" });
        return;
      }
      try {
        await setup.completeInitialization(input);
        void extensions.restore().catch(() => {});
        sendJson(response, 200, { initialized: true });
      } catch (error) {
        if (error instanceof AlreadyInitializedError) sendJson(response, 409, { error: "ALREADY_INITIALIZED" });
        else sendJson(response, 500, { error: "SETUP_FAILED" });
      }
      return;
    }

    if (pathname === "/api/v1/extensions" || pathname.startsWith("/api/v1/extensions/")) {
      try {
        if (!setup.getInitializationState().initialized) throw new ExtensionError("SETUP_REQUIRED", 403);
        if (pathname === "/api/v1/extensions" && request.method === "GET") { sendJson(response, 200, { extensions: extensions.list() }); return; }
        const targetsMatch = /^\/api\/v1\/extensions\/([a-z0-9-]+)\/capability-targets$/.exec(pathname);
        if (targetsMatch && request.method === "GET") { sendJson(response, 200, { targets: extensions.capabilityTargets(targetsMatch[1]!) }); return; }
        if (request.method !== "POST") throw new ExtensionError("METHOD_NOT_ALLOWED", 405);
        if (!isSameOrigin(request)) throw new ExtensionError("INVALID_ORIGIN", 403);
        const match = /^\/api\/v1\/extensions\/([a-z0-9-]+)\/(install|config|enable|disable|uninstall|capability-test|tool)$/.exec(pathname);
        if (!match) throw new ExtensionError("EXTENSION_NOT_FOUND", 404);
        const multipartCapability = match[2] === "capability-test" && /^multipart\/form-data\s*;/i.test(request.headers["content-type"] ?? "");
        if (!multipartCapability && !/^application\/json(?:\s*;|\s*$)/i.test(request.headers["content-type"] ?? "")) throw new ExtensionError("INVALID_INPUT");
        let body: unknown;
        try { body = multipartCapability ? await readCapabilityForm(request) : await readSetupBody(request, match[2] === "capability-test" ? 32 * 1024 : 32 * 1024); }
        catch (error) { throw error instanceof RangeError ? new ExtensionError("BODY_TOO_LARGE", 413) : new ExtensionError("INVALID_INPUT"); }
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new ExtensionError("INVALID_INPUT");
        const fields = body as Record<string, unknown>;
        const id = match[1]!;
        switch (match[2]) {
          case "install": if (Object.keys(fields).length) throw new ExtensionError("INVALID_INPUT"); await extensions.install(id); break;
          case "config": await extensions.saveConfig(id, fields); break;
          case "enable": if (Object.keys(fields).length) throw new ExtensionError("INVALID_INPUT"); await extensions.enable(id); break;
          case "disable": if (Object.keys(fields).length) throw new ExtensionError("INVALID_INPUT"); await extensions.disable(id); break;
          case "uninstall": if (Object.keys(fields).length !== 1 || typeof fields.deleteConfig !== "boolean") throw new ExtensionError("INVALID_INPUT"); await extensions.uninstall(id, fields.deleteConfig); break;
          case "tool": if (Object.keys(fields).length !== 2 || typeof fields.name !== "string" || typeof fields.enabled !== "boolean") throw new ExtensionError("INVALID_INPUT"); await extensions.setToolEnabled(id, fields.name, fields.enabled); break;
          case "capability-test": {
            const allowed = new Set(["targetId", "kind", "requestId", "mode", "stream", "imageUrl1", "imageUrl2", "imageFiles"]);
            const localImageTest = fields.kind === "private-markdown-local-multi-image" || fields.kind === "group-markdown-local-multi-image";
            if (!Object.hasOwn(fields, "targetId") || !Object.hasOwn(fields, "kind") || !Object.hasOwn(fields, "requestId") || Object.keys(fields).some((key) => !allowed.has(key)) || typeof fields.targetId !== "string" || typeof fields.kind !== "string" || typeof fields.requestId !== "string" || (fields.mode !== undefined && fields.mode !== "active" && fields.mode !== "passive") || (fields.stream !== undefined && typeof fields.stream !== "boolean") || (fields.imageUrl1 !== undefined && typeof fields.imageUrl1 !== "string") || (fields.imageUrl2 !== undefined && typeof fields.imageUrl2 !== "string") || (localImageTest !== multipartCapability) || (multipartCapability && !localImageTest) || (!multipartCapability && Object.hasOwn(fields, "imageFiles"))) throw new ExtensionError("INVALID_INPUT");
            const result = await extensions.runCapabilityTest(id, { targetId: fields.targetId, kind: fields.kind, requestId: fields.requestId, ...(fields.mode === undefined ? {} : { mode: fields.mode as "active" | "passive" }), ...(fields.stream === undefined ? {} : { stream: fields.stream }), ...(fields.imageUrl1 === undefined ? {} : { imageUrl1: fields.imageUrl1 }), ...(fields.imageUrl2 === undefined ? {} : { imageUrl2: fields.imageUrl2 }), ...(fields.imageFiles === undefined ? {} : { imageFiles: fields.imageFiles as [Buffer, Buffer] }) });
            sendJson(response, 200, { result }); return;
          }
        }
        sendJson(response, 200, { ok: true });
      } catch (error) {
        if (error instanceof ExtensionError) sendJson(response, error.status, { error: error.code });
        else sendJson(response, 500, { error: "EXTENSION_FAILED" });
      }
      return;
    }

    if (["/api/v1/model/config", "/api/v1/model/test", "/api/v1/model/chat"].includes(pathname)) {
      try {
        if (!setup.getInitializationState().initialized) throw new ModelError("SETUP_REQUIRED", 403);
        if (pathname === "/api/v1/model/config" && request.method === "GET") { sendJson(response, 200, model.getConfig()); return; }
        if (request.method !== "POST") { response.setHeader("Allow", pathname.endsWith("/config") ? "GET, POST" : "POST"); throw new ModelError("METHOD_NOT_ALLOWED", 405); }
        if (!isSameOrigin(request)) throw new ModelError("INVALID_ORIGIN", 403);
        if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers["content-type"] ?? "")) throw new ModelError("INVALID_INPUT", 400);
        let body: unknown;
        try { body = await readSetupBody(request, 64 * 1024); }
        catch (error) { throw error instanceof RangeError ? new ModelError("BODY_TOO_LARGE", 413) : new ModelError("INVALID_INPUT", 400); }
        if (pathname === "/api/v1/model/config") { sendJson(response, 200, model.saveConfig(body)); return; }
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new ModelError("INVALID_INPUT", 400);
        const fields = body as Record<string, unknown>;
        const cancellation = new AbortController();
        const onClose = () => { if (!response.writableEnded) cancellation.abort(); };
        response.on("close", onClose);
        if (response.destroyed) cancellation.abort();
        try {
          if (pathname === "/api/v1/model/test") {
            if (Object.keys(fields).length) throw new ModelError("INVALID_INPUT", 400);
            await model.testConnection(cancellation.signal);
            if (!response.destroyed) sendJson(response, 200, { ok: true });
          } else {
            if (Object.keys(fields).some((key) => key !== "message")) throw new ModelError("INVALID_INPUT", 400);
            const reply = await model.chat(fields.message, cancellation.signal);
            if (!response.destroyed) sendJson(response, 200, { reply });
          }
        } finally { response.off("close", onClose); }
      } catch (error) {
        if (response.destroyed) return;
        if (error instanceof ModelError) sendJson(response, error.status, { error: error.diagnostic });
        else {
          logs.write("ERROR", "server", "模型服务内部错误，无法安全提供详细信息。");
          sendJson(response, 500, { error: { source: "stardust", category: "MODEL_SERVICE_FAILED", code: "MODEL_SERVICE_FAILED" } });
        }
      }
      return;
    }

    if (pathname === "/api/health") {
      if (request.method !== "GET") {
        response.setHeader("Allow", "GET");
        sendJson(response, 405, { error: "METHOD_NOT_ALLOWED" });
        return;
      }
      sendJson(response, 200, {
        status: "ok",
        service: "Stardust",
        version,
        startedAt: startedAt.toISOString(),
        uptimeMs: Math.max(0, Date.now() - startedAt.getTime()),
        checkedAt: new Date().toISOString(),
      });
      return;
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      response.setHeader("Allow", "GET, HEAD");
      sendJson(response, 405, { error: "METHOD_NOT_ALLOWED" });
      return;
    }

    const staticFile = staticFiles[pathname];
    if (!staticFile) {
      sendJson(response, 404, { error: "NOT_FOUND" });
      return;
    }

    try {
      const file = await readFile(join(staticDir, staticFile.filename));
      response.writeHead(200, {
        ...securityHeaders,
        "Content-Type": staticFile.contentType,
        "Cache-Control": "no-cache",
      });
      response.end(request.method === "HEAD" ? undefined : file);
    } catch (error) {
      logs.write("ERROR", "server", "静态资源读取失败。");
      sendJson(response, 500, { error: "STATIC_FILE_UNAVAILABLE" });
    }
  });
  server.on("listening", () => { try { if (setup.getInitializationState().initialized) void extensions.restore().catch(() => logs.write("ERROR", "extensions", "恢复已启用扩展失败。")); } catch { logs.write("ERROR", "server", "读取初始化状态失败。"); } });
  server.on("close", () => { toolRuns.shutdown(); void extensions.shutdown(); });
  const closeServer = server.close.bind(server);
  server.close = ((callback?: (error?: Error) => void) => { for (const stream of streams) stream.end(); return closeServer(callback); }) as typeof server.close;
  return server;
}
