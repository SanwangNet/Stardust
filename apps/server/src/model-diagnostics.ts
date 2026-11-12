export interface ModelDiagnostic {
  source: "stardust" | "upstream";
  category: string;
  code?: string;
  type?: string;
  message?: string;
  status?: number;
  requestId?: string;
  target?: string;
}

const maxErrorBytes = 16 * 1024;
const maxText = 1024;
const sensitiveHeader = /\b(?:authorization|proxy-authorization|cookie|set-cookie|www-authenticate|proxy-authenticate|headers|x-[a-z0-9-]*(?:auth|token|secret|api-key|signature|credential|session)[a-z0-9-]*)\b/i;
const requestContent = /\b(?:request[-_ ]?body|request[-_ ]?payload|user[-_ ]?message|chat[-_ ]?messages|messages|prompt|payload)\b/i;

function safeText(value: unknown, secrets: string[], prompt: string, limit = maxText): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  let text = value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
  // Do not attempt to display text that looks like headers or a request dump.
  if (sensitiveHeader.test(text) || requestContent.test(text)) return undefined;
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) {
    for (const variant of [secret, encodeURIComponent(secret), Buffer.from(secret).toString("base64")]) {
      if (variant) text = text.replaceAll(variant, "[REDACTED]");
    }
  }
  if (prompt) {
    const escaped = JSON.stringify(prompt).slice(1, -1);
    for (const variant of [prompt, escaped, encodeURIComponent(prompt), Buffer.from(prompt).toString("base64")]) {
      if (variant) text = text.replaceAll(variant, "[REDACTED]");
    }
  }
  text = text.replace(/\b(?:Bearer|Basic)\s+[^\s,;"'}]+/gi, "[REDACTED]")
    .replace(/\b(?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|password|secret|token)\s*["']?\s*[:=]\s*["']?[^\s,;"'}]+/gi, "[REDACTED]")
    .replace(/\b(?:sk|secret|token|api[-_]?key)[-_][A-Za-z0-9_-]{4,}\b/gi, "[REDACTED]")
    .replace(/https?:\/\/[^\s"'<>]+/gi, (candidate) => {
      try { const url = new URL(candidate); url.username = ""; url.password = ""; url.search = ""; url.hash = ""; return url.toString(); }
      catch { return "[URL 已隐藏]"; }
    }).trim();
  // Upstreams may echo only part of a message. Suppress a candidate rather than
  // expose a substantial verbatim excerpt when its context cannot be trusted.
  if (prompt.length >= 8) {
    const lowerPrompt = prompt.toLowerCase();
    const visible = text.slice(0, limit).toLowerCase();
    for (let i = 0; i + 8 <= visible.length; i++) {
      if (lowerPrompt.includes(visible.slice(i, i + 8))) return undefined;
    }
  }
  return text ? text.slice(0, limit) : undefined;
}

function safeIdentifier(value: unknown, secrets: string[], prompt: string): string | undefined {
  const text = safeText(value, secrets, prompt, 128);
  if (!text || text.includes("[REDACTED]") || !/^[\w.:/-]+$/.test(text)) return undefined;
  return text;
}

export function safeTarget(endpoint: string, secrets: string[], prompt: string): string | undefined {
  try {
    const url = new URL(endpoint);
    url.username = ""; url.password = ""; url.search = ""; url.hash = "";
    return safeText(url.toString(), secrets, prompt, 512);
  } catch { return undefined; }
}

function statusCategory(status: number): string {
  if (status === 401 || status === 403) return "AUTH_FAILED";
  if (status === 404) return "MODEL_NOT_FOUND";
  if (status === 429) return "RATE_LIMITED";
  if (status === 400) return "UPSTREAM_BAD_REQUEST";
  return "UPSTREAM_ERROR";
}

async function readErrorBody(response: Response): Promise<string | undefined> {
  const type = (response.headers.get("content-type") ?? "").toLowerCase();
  if (type && !type.includes("json") && !type.startsWith("text/plain")) { await response.body?.cancel(); return undefined; }
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxErrorBytes) { await reader.cancel(); return undefined; }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function upstreamDiagnostic(response: Response, endpoint: string, secrets: string[], prompt: string): Promise<ModelDiagnostic> {
  const category = statusCategory(response.status);
  const diagnostic: ModelDiagnostic = { source: "upstream", category, status: response.status, target: safeTarget(endpoint, secrets, prompt) };
  diagnostic.requestId = safeIdentifier(response.headers.get("x-request-id") ?? response.headers.get("request-id"), secrets, prompt);
  let raw: string | undefined;
  try { raw = await readErrorBody(response); } catch { raw = undefined; }
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const top = parsed as Record<string, unknown>;
        const firstError = Array.isArray(top.errors) ? top.errors[0] : undefined;
        const nested = top.error && typeof top.error === "object" && !Array.isArray(top.error) ? top.error : firstError;
        const error = nested && typeof nested === "object" && !Array.isArray(nested) ? nested as Record<string, unknown> : undefined;
        diagnostic.code = safeIdentifier(error?.code ?? top.code, secrets, prompt);
        diagnostic.type = safeIdentifier(error?.type ?? top.type, secrets, prompt);
        diagnostic.message = safeText(error?.message ?? (typeof top.error === "string" ? top.error : top.message ?? top.detail), secrets, prompt);
        if (!diagnostic.requestId) diagnostic.requestId = safeIdentifier(top.request_id ?? top.requestId, secrets, prompt);
      } else if (typeof parsed === "string") diagnostic.message = safeText(parsed, secrets, prompt);
    } catch {
      // Only plain text is exposed; HTML and JSON-like dumps can contain requests or credentials.
      if (!/^\s*[<{\[]/.test(raw)) diagnostic.message = safeText(raw, secrets, prompt);
    }
  }
  if (!diagnostic.message) console.warn(`[Stardust] 上游错误详情不可安全获取 (HTTP ${response.status}, ${category})。`);
  return diagnostic;
}

function errorCodes(error: unknown, seen = new Set<unknown>()): string[] {
  if (!error || typeof error !== "object" || seen.has(error) || seen.size >= 12) return [];
  seen.add(error);
  const item = error as { code?: unknown; cause?: unknown; errors?: unknown };
  const own = typeof item.code === "string" ? [item.code] : [];
  const nested = Array.isArray(item.errors) ? item.errors.flatMap((value) => errorCodes(value, seen)) : [];
  return [...own, ...errorCodes(item.cause, seen), ...nested];
}

export function networkDiagnostic(error: unknown, timedOut: boolean, endpoint: string, secrets: string[], prompt: string): ModelDiagnostic {
  const codes = errorCodes(error);
  let category = "NETWORK_ERROR";
  if (timedOut || codes.some((code) => ["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"].includes(code))) category = "TIMEOUT";
  else if (codes.some((code) => ["ENOTFOUND", "EAI_AGAIN", "EAI_FAIL", "EAI_NONAME", "ENODATA"].includes(code))) category = "DNS_ERROR";
  else if (codes.includes("ECONNREFUSED")) category = "CONNECTION_REFUSED";
  else if (codes.some((code) => /^(?:CERT_|ERR_TLS_|ERR_SSL_|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT)/.test(code))) category = "TLS_ERROR";
  else if (codes.some((code) => ["ECONNRESET", "ECONNABORTED", "EPIPE", "UND_ERR_SOCKET"].includes(code))) category = "CONNECTION_INTERRUPTED";
  else if (codes.some((code) => ["EHOSTUNREACH", "ENETUNREACH"].includes(code))) category = "CONNECTION_FAILED";
  const knownCode = codes.find((code) => ["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "ENOTFOUND", "EAI_AGAIN", "EAI_FAIL", "EAI_NONAME", "ENODATA", "ECONNREFUSED", "ECONNRESET", "ECONNABORTED", "EPIPE", "UND_ERR_SOCKET", "EHOSTUNREACH", "ENETUNREACH", "CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID", "ERR_TLS_CERT_ALTNAME_INVALID", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT"].includes(code));
  console.warn(`[Stardust] 模型连接失败：${category}${knownCode ? ` (${knownCode})` : ""}。`);
  return { source: "stardust", category, code: knownCode, target: safeTarget(endpoint, secrets, prompt) };
}
