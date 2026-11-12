import { readFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

export interface AppOptions {
  version?: string;
  staticDir?: string;
  startedAt?: Date;
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

const staticFiles: Readonly<Record<string, { filename: string; contentType: string }>> = {
  "/": { filename: "index.html", contentType: "text/html; charset=utf-8" },
  "/index.html": { filename: "index.html", contentType: "text/html; charset=utf-8" },
  "/main.js": { filename: "main.js", contentType: "text/javascript; charset=utf-8" },
  "/style.css": { filename: "style.css", contentType: "text/css; charset=utf-8" },
  "/favicon.svg": { filename: "favicon.svg", contentType: "image/svg+xml" },
};

export function createStardustServer(options: AppOptions = {}): Server {
  const startedAt = options.startedAt ?? new Date();
  const version = options.version ?? "0.1.0";
  const staticDir = options.staticDir ?? defaultStaticDir;

  return createServer(async (request, response) => {
    let pathname: string;
    try {
      pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    } catch {
      sendJson(response, 400, { error: "INVALID_URL" });
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
}
