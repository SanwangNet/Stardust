import { deflateSync } from "node:zlib";
import type { CapabilityTarget, CapabilityTestResult } from "../channel.js";

export interface PrivateTarget extends CapabilityTarget { targetOpenid: string; messageId: string }
export type DiagnosticFetch = typeof fetch;
type Stage = "auth" | "upload" | "send";
type ApiResult = { status: number; data: Record<string, unknown> };
class PlatformFailure extends Error {
  constructor(readonly status: number, readonly data: Record<string, unknown>, readonly stage: Stage) { super("PLATFORM_FAILURE"); }
}

// A complete, generated 1x1 RGBA PNG; no user files are read.
function png(): Buffer {
  const chunk = (name: string, data: Buffer): Buffer => {
    const tag = Buffer.from(name), length = Buffer.alloc(4), crc = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    let sum = 0xffffffff;
    for (const byte of Buffer.concat([tag, data])) {
      sum ^= byte;
      for (let bit = 0; bit < 8; bit++) sum = (sum >>> 1) ^ (0xedb88320 & -(sum & 1));
    }
    crc.writeUInt32BE((sum ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, tag, data, crc]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.from([0, 100, 55, 180, 255]))), chunk("IEND", Buffer.alloc(0))]);
}

function safeMessage(value: unknown, secrets: string[]): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  let result = value.slice(0, 1024).replace(/[\x00-\x1f\x7f]/g, " ");
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) {
    for (const part of [secret, encodeURIComponent(secret), Buffer.from(secret).toString("base64")]) if (part) result = result.replaceAll(part, "[REDACTED]");
  }
  result = result.replace(/https?:\/\/\S+/gi, "[URL 已隐藏]")
    .replace(/\b(?:authorization|cookie|set-cookie|access[_ -]?token|app[_ -]?secret|client[_ -]?secret|openid|msg[_ -]?id|file[_ -]?(?:data|info)|content)\s*["']?\s*[:=]\s*["']?[^\s,;"}]+/gi, "[REDACTED]")
    .replace(/\b(?:bearer|qqbot|basic)\s+[^\s,;]+/gi, "[REDACTED]")
    .replace(/\b[A-Za-z0-9_+\/=-]{24,}\b/g, "[REDACTED]");
  return result.slice(0, 512);
}

async function responseBody(response: Response): Promise<Record<string, unknown>> {
  if (!response.body) return {};
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  try {
    while (true) {
      const item = await reader.read(); if (item.done) break;
      total += item.value.length;
      if (total > 16384) { await reader.cancel().catch(() => {}); return {}; }
      chunks.push(item.value);
    }
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { return {}; } finally { reader.releaseLock(); }
}

export async function performQQCapabilityTest(options: {
  kind: string; target: PrivateTarget; getToken: () => Promise<string>; signal: AbortSignal;
  appId: string; appSecret: string; request: DiagnosticFetch;
  onSent: (messageId: string) => void;
}): Promise<CapabilityTestResult> {
  const { kind, target, signal } = options;
  const requestedAt = new Date().toISOString();
  const media = kind.endsWith("-file") || kind.endsWith("-png");
  const group = target.scope === "group";
  const base = group ? "/v2/groups/{group_openid}" : "/v2/users/{openid}";
  const result = { interface: "未调用消息接口", requestedAt, serverAccepted: false, clientReceived: "unconfirmed" as const };
  let stage: Stage = "auth"; let token = "";
  const expired = () => !target.replyExpiresAt || Date.now() >= Date.parse(target.replyExpiresAt);
  try {
    if (signal.aborted || (media && expired())) return { ...result, state: "unavailable", stage, message: "扩展已停止或被动回复已过期。" };
    token = await options.getToken();
    if (signal.aborted || (media && expired())) return { ...result, state: "unavailable", stage, message: "扩展已停止或被动回复已过期。" };
    const path = `/v2/${group ? "groups" : "users"}/${encodeURIComponent(target.targetOpenid)}`;
    const post = async (endpoint: string, body: Record<string, unknown>): Promise<ApiResult> => {
      const response = await options.request(`https://api.sgroup.qq.com${path}/${endpoint}`, {
        method: "POST", headers: { Authorization: `QQBot ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body), redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      });
      const data = await responseBody(response);
      const code = data.code ?? data.err_code;
      if (!response.ok || (typeof code === "number" && code !== 0) || (typeof code === "string" && /^\d+$/.test(code) && Number(code) !== 0)) throw new PlatformFailure(response.status, data, stage);
      return { status: response.status, data };
    };
    let body: Record<string, unknown>;
    if (media) {
      stage = "upload";
      result.interface = `POST ${base}/files`;
      const file = kind.endsWith("-png") ? png() : Buffer.from("Hello, Stardust!\n", "utf8");
      const uploaded = await post("files", { file_type: kind.endsWith("-png") ? 1 : 4, file_data: file.toString("base64"), srv_send_msg: false, ...(kind.endsWith("-file") ? { file_name: "hello-stardust.txt" } : {}) });
      if (typeof uploaded.data.file_info !== "string" || !uploaded.data.file_info) return { ...result, state: "unavailable", stage, httpStatus: uploaded.status, message: "上传响应缺少 file_info，未发送消息。" };
      if (signal.aborted || expired()) return { ...result, state: "unavailable", stage, httpStatus: uploaded.status, message: "上传后回复期限已过或扩展已停止，未发送消息。" };
      const { getNextMsgSeq } = await import("@tencent-connect/qqbot-nodejs/protocol");
      if (signal.aborted || expired()) return { ...result, state: "unavailable", stage, httpStatus: uploaded.status, message: "上传后回复期限已过或扩展已停止，未发送消息。" };
      body = { msg_type: 7, content: " ", media: { file_info: uploaded.data.file_info }, msg_id: target.messageId, msg_seq: getNextMsgSeq(target.messageId) };
    } else {
      body = { msg_type: 0, content: "Hello, Stardust!" };
    }
    stage = "send";
    result.interface = media ? `${result.interface} + POST ${base}/messages` : `POST ${base}/messages`;
    const sent = await post("messages", body);
    if (typeof sent.data.id !== "string" || !sent.data.id) return { ...result, state: "unavailable", stage, httpStatus: sent.status, message: "QQ 响应缺少消息 ID，无法确认请求是否成功。" };
    options.onSent(sent.data.id);
    return { ...result, state: "success", stage, httpStatus: sent.status, serverAccepted: true };
  } catch (error) {
    if (error instanceof PlatformFailure) {
      const code = error.data.code ?? error.data.err_code;
      const businessCode = typeof code === "number" && Number.isSafeInteger(code) ? String(code) : typeof code === "string" && /^\d{1,15}$/.test(code) ? code : undefined;
      const message = safeMessage(error.data.message, [options.appSecret, options.appId, token, target.targetOpenid, target.messageId]);
      return { ...result, state: "rejected", stage: error.stage, httpStatus: error.status, ...(businessCode ? { businessCode } : {}), message: message || "QQ 未提供可显示的错误信息。" };
    }
    return { ...result, state: signal.aborted ? "unavailable" : "network_failure", stage, message: signal.aborted ? "扩展已停止，请求已取消。" : "请求未获得 HTTP 响应；发送状态可能未知，请先检查 QQ 客户端。" };
  }
}
