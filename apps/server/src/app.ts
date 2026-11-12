import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { AlreadyInitializedError, ConfigValidationError, validateConfigUpdate, type ConfigUpdate } from "./config.js";
import { setupService, type SetupService } from "./setup.js";
import { ModelError, modelService, type ModelService } from "./model.js";
import { ExtensionError, ExtensionManager } from "./extension-manager.js";

export interface AppOptions {
  version?: string;
  staticDir?: string;
  startedAt?: Date;
  setupService?: SetupService;
  modelService?: ModelService;
  extensionManager?: ExtensionManager;
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

const staticFiles: Readonly<Record<string, { filename: string; contentType: string }>> = {
  "/": { filename: "index.html", contentType: "text/html; charset=utf-8" },
  "/index.html": { filename: "index.html", contentType: "text/html; charset=utf-8" },
  "/main.js": { filename: "main.js", contentType: "text/javascript; charset=utf-8" },
  "/model-errors.js": { filename: "model-errors.js", contentType: "text/javascript; charset=utf-8" },
  "/navigation-motion.js": { filename: "navigation-motion.js", contentType: "text/javascript; charset=utf-8" },
  "/style.css": { filename: "style.css", contentType: "text/css; charset=utf-8" },
  "/favicon.svg": { filename: "favicon.svg", contentType: "image/svg+xml" },
};

export function createStardustServer(options: AppOptions = {}): Server {
  const startedAt = options.startedAt ?? new Date();
  const version = options.version ?? "0.1.0";
  const staticDir = options.staticDir ?? defaultStaticDir;
  const setup = options.setupService ?? setupService;
  const model = options.modelService ?? modelService;
  const extensions = options.extensionManager ?? new ExtensionManager(undefined, model, []);

  const server = createServer(async (request, response) => {
    let pathname: string;
    try {
      pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    } catch {
      sendJson(response, 400, { error: "INVALID_URL" });
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
        if (request.method !== "POST") throw new ExtensionError("METHOD_NOT_ALLOWED", 405);
        if (!isSameOrigin(request)) throw new ExtensionError("INVALID_ORIGIN", 403);
        if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers["content-type"] ?? "")) throw new ExtensionError("INVALID_INPUT");
        const match = /^\/api\/v1\/extensions\/([a-z0-9-]+)\/(install|config|enable|disable|uninstall)$/.exec(pathname);
        if (!match) throw new ExtensionError("EXTENSION_NOT_FOUND", 404);
        let body: unknown;
        try { body = await readSetupBody(request, 32 * 1024); } catch (error) { throw error instanceof RangeError ? new ExtensionError("BODY_TOO_LARGE", 413) : new ExtensionError("INVALID_INPUT"); }
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new ExtensionError("INVALID_INPUT");
        const fields = body as Record<string, unknown>;
        const id = match[1]!;
        switch (match[2]) {
          case "install": if (Object.keys(fields).length) throw new ExtensionError("INVALID_INPUT"); await extensions.install(id); break;
          case "config": await extensions.saveConfig(id, fields); break;
          case "enable": if (Object.keys(fields).length) throw new ExtensionError("INVALID_INPUT"); await extensions.enable(id); break;
          case "disable": if (Object.keys(fields).length) throw new ExtensionError("INVALID_INPUT"); await extensions.disable(id); break;
          case "uninstall": if (Object.keys(fields).length !== 1 || typeof fields.deleteConfig !== "boolean") throw new ExtensionError("INVALID_INPUT"); await extensions.uninstall(id, fields.deleteConfig); break;
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
          console.error("[Stardust] 模型服务内部错误，无法安全提供详细信息。");
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
      console.error("[Stardust] Failed to serve static file:", staticFile.filename, error);
      sendJson(response, 500, { error: "STATIC_FILE_UNAVAILABLE" });
    }
  });
  server.on("listening", () => { try { if (setup.getInitializationState().initialized) void extensions.restore().catch(() => {}); } catch {} });
  server.on("close", () => { void extensions.shutdown(); });
  return server;
}
