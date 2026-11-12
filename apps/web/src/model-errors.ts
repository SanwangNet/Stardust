const titles: Record<string, string> = {
  SETUP_REQUIRED: "请先完成初始化", NOT_CONFIGURED: "模型尚未配置",
  INVALID_INPUT: "配置或消息无效", INVALID_ORIGIN: "请求来源不被允许", BODY_TOO_LARGE: "请求内容过大",
  AUTH_FAILED: "模型认证失败", MODEL_NOT_FOUND: "模型或接口未找到", RATE_LIMITED: "模型请求受到限流",
  UPSTREAM_BAD_REQUEST: "上游拒绝了请求", UPSTREAM_ERROR: "上游模型服务返回错误",
  DNS_ERROR: "模型地址解析失败", CONNECTION_REFUSED: "模型连接被拒绝", CONNECTION_FAILED: "无法连接模型服务",
  CONNECTION_INTERRUPTED: "模型连接中断", TLS_ERROR: "模型服务的 TLS 证书连接失败",
  TIMEOUT: "模型请求超时", NETWORK_ERROR: "模型请求未获得 HTTP 响应",
  INVALID_RESPONSE: "模型服务返回了无法识别的响应", SAVE_FAILED: "模型配置保存失败",
  STREAM_INCOMPLETE: "模型流在结束标记前中断", REQUEST_CANCELLED: "模型请求已取消",
  MODEL_SERVICE_FAILED: "Stardust 模型服务出错", METHOD_NOT_ALLOWED: "请求方法不受支持",
};

type ErrorDetails = { source?: unknown; category?: unknown; code?: unknown; type?: unknown; message?: unknown; status?: unknown; requestId?: unknown; target?: unknown };

export function noModelResponseMessage(): string {
  return "无法连接 Stardust 服务端：请求未获得 HTTP 响应。";
}

export function formatModelError(value: unknown, responseStatus: number): string {
  const details: ErrorDetails = typeof value === "string" ? { category: value, code: value, source: "stardust" } : value && typeof value === "object" ? value as ErrorDetails : {};
  const category = typeof details.category === "string" ? details.category : "";
  const source = details.source === "upstream" ? "上游模型服务" : "Stardust 本地";
  const title = titles[category] ?? "模型请求失败";
  const status = typeof details.status === "number" && Number.isInteger(details.status) ? `（HTTP ${details.status}）` : "";
  const lines = [`${title}${status}`, `来源：${source}`];
  if (typeof details.code === "string" && details.code) lines.push(`错误代码：${details.code}`);
  if (typeof details.type === "string" && details.type) lines.push(`类型：${details.type}`);
  if (typeof details.message === "string" && details.message) lines.push(details.message);
  if (typeof details.target === "string" && details.target) lines.push(`目标：${details.target}`);
  if (typeof details.requestId === "string" && details.requestId) lines.push(`请求 ID：${details.requestId}`);
  if (details.source !== "upstream" && responseStatus > 0) lines.push(`Stardust HTTP ${responseStatus}`);
  return lines.join("\n");
}
