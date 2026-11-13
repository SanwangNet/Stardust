import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { isIP } from "node:net";
import type { StreamMessageRequest } from "@tencent-connect/qqbot-nodejs/protocol";
import { setTimeout as delay } from "node:timers/promises";
import type { CapabilityFrameResult, CapabilityImageUploadResult, CapabilityStageResult, CapabilityTarget, CapabilityTestResult } from "../channel.js";

export interface QQTestTarget extends CapabilityTarget { targetOpenid: string; messageId: string }
export type DiagnosticFetch = typeof fetch;
type Stage = "auth" | "upload" | "send" | "direct_send";
type ApiResult = { status: number; data: Record<string, unknown> };
class PlatformFailure extends Error {
  constructor(readonly status: number, readonly data: Record<string, unknown>, readonly stage: Stage) { super("PLATFORM_FAILURE"); }
}

export function isPublicHttpsImageUrl(value: string): boolean {
  if (value.length > 2048) return false;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (url.protocol !== "https:" || url.username || url.password || url.hash || isIP(host) !== 0 || !host.includes(".")) return false;
    if (/(?:^|\.)(?:localhost|local|internal|lan|test|example|invalid)$/.test(host)) return false;
    return true;
  } catch { return false; }
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
  kind: string; target: QQTestTarget; mode?: "active" | "passive"; getToken: () => Promise<string>; signal: AbortSignal;
  appId: string; appSecret: string; request: DiagnosticFetch;
  onSent: (messageId: string) => void;
  textContent?: string;
  imageUrl1?: string; imageUrl2?: string; imageFiles?: [Buffer, Buffer]; getNextSequence?: (messageId: string) => number;
}): Promise<CapabilityTestResult> {
  const { getNextMsgSeq } = await import("@tencent-connect/qqbot-nodejs/protocol");
  const { kind, target, signal } = options;
  const requestedAt = new Date().toISOString();
  const directPng = kind.endsWith("-png-direct");
  const emptyContentPng = kind.endsWith("-png-empty-content");
  const markdownMultiImage = kind.endsWith("-markdown-multi-image");
  const markdownLocalMultiImage = kind.endsWith("-markdown-local-multi-image");
  const pngMedia = kind.endsWith("-png") || directPng || emptyContentPng;
  const media = kind.endsWith("-file") || pngMedia;
  const experimental = directPng || emptyContentPng;
  const group = target.scope === "group";
  const base = group ? "/v2/groups/{group_openid}" : "/v2/users/{openid}";
  const result = { interface: markdownMultiImage || markdownLocalMultiImage ? `POST ${base}/messages` : "未调用消息接口", requestedAt, serverAccepted: false, clientReceived: "unconfirmed" as const, ...(markdownMultiImage || markdownLocalMultiImage ? { requestMessageId: `•••${target.messageId.slice(-4)}` } : {}) };
  if (markdownMultiImage && (!options.imageUrl1 || !options.imageUrl2 || options.imageUrl1 === options.imageUrl2 || !isPublicHttpsImageUrl(options.imageUrl1) || !isPublicHttpsImageUrl(options.imageUrl2))) return { ...result, state: "unavailable", stage: "validate", message: "请提供两个不同的公网 HTTPS 图片 URL。" };
  if (markdownLocalMultiImage && (!options.imageFiles || options.imageFiles.length !== 2 || options.imageFiles.some((file) => !Buffer.isBuffer(file) || file.length < 8 || file.length > 10 * 1024 * 1024 || !file.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) || options.imageFiles[0].equals(options.imageFiles[1]))) return { ...result, state: "unavailable", stage: "validate", message: "请选择两张内容不同、有效且不超过 10 MB 的 PNG 图片。" };
  const stages: CapabilityStageResult[] = [];
  let stage: Stage = "auth"; let token = "";
  const expired = () => !target.replyExpiresAt || Date.now() >= Date.parse(target.replyExpiresAt);
  try {
    if (signal.aborted || ((media || markdownMultiImage || markdownLocalMultiImage) && !directPng && expired())) return { ...result, state: "unavailable", stage, message: "扩展已停止或被动回复已过期。" };
    token = await options.getToken();
    if (signal.aborted || ((media || markdownMultiImage || markdownLocalMultiImage) && !directPng && expired())) return { ...result, state: "unavailable", stage, message: "扩展已停止或被动回复已过期。" };
    const path = `/v2/${group ? "groups" : "users"}/${encodeURIComponent(target.targetOpenid)}`;
    const post = async (endpoint: string, body: Record<string, unknown>, extraSecrets: string[] = []): Promise<ApiResult> => {
      const response = await options.request(`https://api.sgroup.qq.com${path}/${endpoint}`, {
        method: "POST", headers: { Authorization: `QQBot ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body), redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      });
      const data = await responseBody(response);
      const code = data.code ?? data.err_code;
      const businessCode = typeof code === "number" && Number.isSafeInteger(code) ? String(code) : typeof code === "string" && /^\d{1,15}$/.test(code) ? code : undefined;
      if (!response.ok || (businessCode !== undefined && Number(businessCode) !== 0)) {
        if (experimental) stages.push({ stage: stage === "auth" ? "send" : stage, state: "rejected", httpStatus: response.status, ...(businessCode ? { businessCode } : {}), ...(safeMessage(data.message, [options.appSecret, options.appId, token, target.targetOpenid, target.messageId, ...extraSecrets]) ? { message: safeMessage(data.message, [options.appSecret, options.appId, token, target.targetOpenid, target.messageId, ...extraSecrets]) } : {}) });
        throw new PlatformFailure(response.status, data, stage);
      }
      if (experimental) stages.push({ stage: stage === "direct_send" ? "direct_send" : stage === "upload" ? "upload" : "send", state: "success", httpStatus: response.status, ...(businessCode ? { businessCode } : {}), ...(stage !== "upload" ? { messageIdReturned: typeof data.id === "string" && Boolean(data.id) } : {}) });
      return { status: response.status, data };
    };
    if (markdownLocalMultiImage) {
      const imageUploads: CapabilityImageUploadResult[] = [{ image: 1, state: "not_started" }, { image: 2, state: "not_started" }];
      const images = options.imageFiles!;
      const md5s = images.map((file) => createHash("md5").update(file).digest("hex"));
      const sha1s = images.map((file) => createHash("sha1").update(file).digest("hex"));
      const md5FromEtag = (value: string | null): string | undefined => {
        const etag = value?.trim().replace(/^"|"$/g, "");
        return etag && /^[a-f\d]{32}$/i.test(etag) ? etag.toLowerCase() : undefined;
      };
      const describeFailure = async (response: Response, additionalSecrets: string[] = [], parsedData?: Record<string, unknown>): Promise<{ businessCode?: string; message?: string }> => {
        const data = parsedData ?? await responseBody(response);
        const value = data.code ?? data.err_code;
        const businessCode = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : typeof value === "string" && /^\d{1,15}$/.test(value) ? value : undefined;
        const message = safeMessage(data.message, [options.appSecret, options.appId, token, target.targetOpenid, target.messageId, ...additionalSecrets]);
        return { ...(businessCode ? { businessCode } : {}), ...(message ? { message } : {}) };
      };
      const businessCodeOf = (data: Record<string, unknown>): string | undefined => {
        const value = data.code ?? data.err_code;
        return typeof value === "number" && Number.isSafeInteger(value) ? String(value) : typeof value === "string" && /^\d{1,15}$/.test(value) ? value : undefined;
      };
      const uploadOne = async (index: 0 | 1): Promise<{ result: CapabilityImageUploadResult; reference?: string }> => {
        const image = (index + 1) as 1 | 2;
        let phase: "prepare" | "put" | "complete" = "prepare";
        let uploadId = "";
        let signedAddress = "";
        const fail = (state: CapabilityImageUploadResult["state"], status?: number, details: { businessCode?: string; message?: string } = {}): { result: CapabilityImageUploadResult } => ({ result: { image, state, phase, ...(status === undefined ? {} : { httpStatus: status }), ...details } });
        try {
          const prepare = await options.request("https://api.sgroup.qq.com/v2/media-images/prepare", {
            method: "POST", headers: { Authorization: `QQBot ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ file_name: `stardust-image-${image}.png`, file_size: images[index].length, content_type: "image/png", md5: md5s[index], sha1: sha1s[index] }),
            redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
          });
          const prepareData = await responseBody(prepare);
          if (!prepare.ok || (businessCodeOf(prepareData) !== undefined && Number(businessCodeOf(prepareData)) !== 0)) return fail("rejected", prepare.status, await describeFailure(prepare, [], prepareData));
          uploadId = typeof prepareData.upload_id === "string" ? prepareData.upload_id : "";
          signedAddress = typeof prepareData.presigned_url === "string" ? prepareData.presigned_url : "";
          let signed: URL;
          try { signed = new URL(signedAddress); } catch { return fail("rejected", prepare.status, { message: "素材准备响应缺少有效的预签名上传地址。" }); }
          if (!uploadId || signed.protocol !== "https:" || signed.username || signed.password || !/(?:^|\.)cos\.[a-z0-9-]+\.myqcloud\.com$/i.test(signed.hostname)) return fail("rejected", prepare.status, { message: "素材准备响应不符合腾讯云 COS HTTPS 预签名协议。" });
          phase = "put";
          const put = await options.request(signed.href, {
            method: "PUT", headers: { "Content-Type": "image/png" }, body: images[index],
            redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
          });
          if (!put.ok) return fail("rejected", put.status, { message: `预签名上传请求被拒绝（HTTP ${put.status}）。` });
          const uploadedMd5 = md5FromEtag(put.headers.get("etag"));
          if (!uploadedMd5) return fail("rejected", put.status, { message: "预签名上传成功响应缺少有效 ETag，未完成素材登记。" });
          phase = "complete";
          const complete = await options.request("https://api.sgroup.qq.com/v2/media-images/complete", {
            method: "POST", headers: { Authorization: `QQBot ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ upload_id: uploadId, md5: uploadedMd5 }),
            redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
          });
          const completeData = await responseBody(complete);
          if (!complete.ok || (businessCodeOf(completeData) !== undefined && Number(businessCodeOf(completeData)) !== 0)) return fail("rejected", complete.status, await describeFailure(complete, [uploadId, signedAddress], completeData));
          const imageId = typeof completeData.image_id === "string" && completeData.image_id.length <= 256 ? completeData.image_id : "";
          const reference = typeof completeData.url === "string" && /^qqbot-media:\/\/image\/v1\/[^\s()<>{}\[\]]+$/.test(completeData.url) ? completeData.url : "";
          if (!imageId || !reference || reference.length > 2048) return fail("rejected", complete.status, { message: "素材完成响应缺少有效 image_id 或 QQ 图片引用。" });
          return { result: { image, state: "success", phase, httpStatus: complete.status, imageId: `•••${imageId.slice(-4)}` }, reference };
        } catch (error) {
          const aborted = signal.aborted;
          return fail(phase === "prepare" && !aborted ? "network_failure" : "unknown_outcome", undefined, { message: aborted ? "扩展已停止；素材处理结果未知。" : phase === "prepare" ? "素材准备请求未获得 HTTP 响应。" : "素材上传请求未获得 HTTP 响应，结果未知。" });
        } finally {
          // Signed URLs and upload IDs are request credentials; keep them out of all results and logs.
          signedAddress = ""; uploadId = "";
        }
      };
      let first: Awaited<ReturnType<typeof uploadOne>>;
      try { first = await uploadOne(0); } catch { first = { result: { image: 1, state: "network_failure", phase: "prepare", message: "第一张图片素材准备失败。" } }; }
      imageUploads[0] = first.result;
      if (!first.reference || signal.aborted || expired()) return { ...result, state: first.result.state === "not_started" ? "unavailable" : first.result.state, stage: `image_1_${first.result.phase ?? "prepare"}`, httpStatus: first.result.httpStatus, ...(first.result.businessCode ? { businessCode: first.result.businessCode } : {}), ...(first.result.message ? { message: first.result.message } : {}), imageUploads };
      let second: Awaited<ReturnType<typeof uploadOne>>;
      try { second = await uploadOne(1); } catch { second = { result: { image: 2, state: "network_failure", phase: "prepare", message: "第二张图片素材准备失败。" } }; }
      imageUploads[1] = second.result;
      if (!second.reference || signal.aborted || expired()) return { ...result, state: second.result.state === "not_started" ? "unavailable" : second.result.state, stage: `image_2_${second.result.phase ?? "prepare"}`, httpStatus: second.result.httpStatus, ...(second.result.businessCode ? { businessCode: second.result.businessCode } : {}), ...(second.result.message ? { message: second.result.message } : {}), imageUploads };
      if (signal.aborted || expired()) return { ...result, state: "unavailable", stage: "send", message: "图片上传完成，但被动回复已过期或扩展已停止，未发送 Markdown。", imageUploads };
      const content = `## Stardust 本地多图测试\n\n![图片一 #320px #180px](${first.reference})\n\n![图片二 #320px #180px](${second.reference})`;
      stage = "send";
      let sent: ApiResult;
      try {
        sent = await post("messages", { msg_type: 2, markdown: { content }, msg_id: target.messageId, msg_seq: options.getNextSequence?.(target.messageId) ?? getNextMsgSeq(target.messageId) }, [first.reference, second.reference]);
      } catch (error) {
        if (error instanceof PlatformFailure) {
          const code = error.data.code ?? error.data.err_code;
          const businessCode = typeof code === "number" && Number.isSafeInteger(code) ? String(code) : typeof code === "string" && /^\d{1,15}$/.test(code) ? code : undefined;
          const message = safeMessage(error.data.message, [options.appSecret, options.appId, token, target.targetOpenid, target.messageId, first.reference, second.reference]);
          return { ...result, state: "rejected", stage: "send", httpStatus: error.status, ...(businessCode ? { businessCode } : {}), message: message || "QQ 未提供可显示的错误信息。", imageUploads };
        }
        return { ...result, state: signal.aborted ? "unavailable" : "unknown_outcome", stage: "send", message: signal.aborted ? "扩展已停止；Markdown 发送结果未知。" : "Markdown 请求未获得 HTTP 响应，发送结果未知。", imageUploads };
      }
      const messageId = typeof sent.data.id === "string" && sent.data.id ? sent.data.id : undefined;
      if (!messageId) return { ...result, state: "unavailable", stage, httpStatus: sent.status, message: "QQ 响应缺少消息 ID，无法确认 Markdown 发送结果。", imageUploads };
      options.onSent(messageId);
      return { ...result, state: "success", stage, httpStatus: sent.status, serverAccepted: true, messageId: `•••${messageId.slice(-4)}`, messageIdReturned: true, imageUploads };
    }
    if (directPng) {
      stage = "direct_send";
      result.interface = `POST ${base}/files`;
      const sent = await post("files", { file_type: 1, file_data: png().toString("base64"), srv_send_msg: true });
      const messageId = typeof sent.data.id === "string" && sent.data.id.length > 0 ? sent.data.id : undefined;
      if (messageId) options.onSent(messageId);
      const messageIdReturned = Boolean(messageId);
      return { ...result, state: "success", stage, httpStatus: sent.status, serverAccepted: true, messageIdReturned, stages };
    }
    let body: Record<string, unknown>;
    if (media || emptyContentPng) {
      stage = "upload";
      result.interface = `POST ${base}/files`;
      const file = pngMedia ? png() : Buffer.from("Hello, Stardust!\n", "utf8");
      const uploaded = await post("files", { file_type: pngMedia ? 1 : 4, file_data: file.toString("base64"), srv_send_msg: false, ...(kind.endsWith("-file") ? { file_name: "hello-stardust.txt" } : {}) });
      if (typeof uploaded.data.file_info !== "string" || !uploaded.data.file_info) return { ...result, state: "unavailable", stage, httpStatus: uploaded.status, message: "上传响应缺少 file_info，未发送消息。", ...(experimental ? { stages } : {}) };
      if (signal.aborted || expired()) return { ...result, state: "unavailable", stage, httpStatus: uploaded.status, message: "上传后回复期限已过或扩展已停止，未发送消息。", ...(experimental ? { stages } : {}) };
      body = { msg_type: 7, content: emptyContentPng ? "" : " ", media: { file_info: uploaded.data.file_info }, msg_id: target.messageId, msg_seq: options.getNextSequence?.(target.messageId) ?? getNextMsgSeq(target.messageId) };
    } else if (markdownMultiImage) {
      const content = `## Stardust 多图测试\n\n![图片一 #320px #180px](${options.imageUrl1})\n\n![图片二 #320px #180px](${options.imageUrl2})`;
      body = { msg_type: 2, markdown: { content }, msg_id: target.messageId, msg_seq: options.getNextSequence?.(target.messageId) ?? getNextMsgSeq(target.messageId) };
    } else {
      body = { msg_type: 0, content: options.textContent ?? "Hello, Stardust!", ...(options.mode === "passive" ? { msg_id: target.messageId, msg_seq: options.getNextSequence?.(target.messageId) ?? getNextMsgSeq(target.messageId) } : {}) };
    }
    stage = "send";
    result.interface = media ? `${result.interface} + POST ${base}/messages` : `POST ${base}/messages`;
    const sent = await post("messages", body);
    const messageId = typeof sent.data.id === "string" && sent.data.id ? sent.data.id : undefined;
    if (!messageId) return { ...result, state: "unavailable", stage, httpStatus: sent.status, message: "QQ 响应缺少消息 ID，无法确认请求是否成功。", ...(experimental ? { stages, messageIdReturned: false } : {}) };
    options.onSent(messageId);
    return { ...result, state: "success", stage, httpStatus: sent.status, serverAccepted: true, ...(markdownMultiImage ? { messageId: `•••${messageId.slice(-4)}` } : {}), ...(experimental ? { stages, messageIdReturned: true } : {}) };
  } catch (error) {
    if (error instanceof PlatformFailure) {
      const code = error.data.code ?? error.data.err_code;
      const businessCode = typeof code === "number" && Number.isSafeInteger(code) ? String(code) : typeof code === "string" && /^\d{1,15}$/.test(code) ? code : undefined;
      const message = safeMessage(error.data.message, [options.appSecret, options.appId, token, target.targetOpenid, target.messageId, options.textContent ?? ""]);
      return { ...result, state: "rejected", stage: error.stage, httpStatus: error.status, ...(businessCode ? { businessCode } : {}), message: message || "QQ 未提供可显示的错误信息。", ...(experimental ? { stages, messageIdReturned: stages.some((item) => item.messageIdReturned === true) } : {}) };
    }
    const networkState = experimental ? "unknown_outcome" : signal.aborted ? "unavailable" : "network_failure";
    if (experimental) stages.push({ stage: stage === "auth" ? "send" : stage === "direct_send" ? "direct_send" : stage, state: "unknown_outcome", message: signal.aborted ? "请求已取消，发送结果未知。" : "请求未获得 HTTP 响应，发送结果未知。" });
    return { ...result, state: networkState, stage, message: signal.aborted ? (experimental ? "请求已取消，发送结果未知。" : "扩展已停止，请求已取消。") : "请求未获得 HTTP 响应；发送状态可能未知，请先检查 QQ 客户端。", ...(experimental ? { stages, messageIdReturned: stages.some((item) => item.messageIdReturned === true) } : {}) };
  }
}

export async function performQQStreamCapabilityTest(options: {
  target: QQTestTarget;
  mode: "active" | "passive";
  signal: AbortSignal;
  appId: string;
  appSecret: string;
  requestId: string;
  getNextSequence: (messageId: string) => number;
  getToken: () => Promise<string>;
  request: DiagnosticFetch;
  onEvent: (level: "DEBUG" | "INFO" | "WARN" | "ERROR", message: string, details: { requestId: string; scope: "private" | "group"; stage: string; frame?: number; status?: number; code?: string; durationMs?: number }) => void;
}): Promise<CapabilityTestResult> {
  const { StreamContentType, StreamInputMode, StreamInputState } = await import("@tencent-connect/qqbot-nodejs/protocol");
  const { target, signal, requestId } = options;
  const requestedAt = new Date().toISOString();
  const startedAt = Date.now();
  const scope = target.scope;
  const endpoint = scope === "private" ? `/v2/users/${encodeURIComponent(target.targetOpenid)}/stream_messages` : `/v2/groups/${encodeURIComponent(target.targetOpenid)}/stream_messages`;
  const base = {
    interface: `POST ${scope === "private" ? "/v2/users/{openid}" : "/v2/groups/{group_openid}"}/stream_messages${scope === "group" ? "（实验性、未验证候选接口）" : ""}`,
    requestedAt, serverAccepted: false, clientReceived: "unconfirmed" as const,
    mode: options.mode, stream: true as const, frameCount: 0,
    completion: "not_started" as const,
  };
  const frames: CapabilityFrameResult[] = [];
  const texts = ["Stardust", "Stardust 正在测试", "Stardust 正在测试流式消息", "Stardust 正在测试流式消息"];
  const lastState = [StreamInputState.GENERATING, StreamInputState.GENERATING, StreamInputState.GENERATING, StreamInputState.DONE] as const;
  let streamMsgId: string | undefined;
  let lastResponseAt = 0;
  let lastHttpStatus: number | undefined;
  let lastBusinessCode: string | undefined;
  const receivedAt = Date.parse(target.receivedAt);
  if (options.mode === "passive" && (!Number.isFinite(receivedAt) || Date.now() - receivedAt >= 5 * 60_000 || !target.replyExpiresAt || Date.now() >= Date.parse(target.replyExpiresAt))) return { ...base, state: "unavailable", stage: "target", message: "被动流式实验要求使用 5 分钟内且仍在有效期内的真实入站消息。" };
  let sequence: number;
  try { sequence = options.mode === "passive" ? options.getNextSequence(target.messageId) : 1; }
  catch { return { ...base, state: "unavailable", stage: "prepare", message: "无法生成 QQ 流式消息序号。" }; }
  const duration = (): number => Date.now() - startedAt;
  options.onEvent("INFO", "QQ 流式能力测试开始。", { requestId, scope, stage: "stream_start" });
  for (let index = 0; index < texts.length; index++) {
    const inputState = lastState[index]!;
    if (signal.aborted) {
      const partial = frames.length > 0;
      options.onEvent("WARN", "QQ 流式能力测试已取消。", { requestId, scope, stage: "cancelled", frame: index, durationMs: duration() });
      return { ...base, state: partial ? "partial_success" : "unavailable", stage: "cancelled", serverAccepted: partial, frameCount: frames.filter((frame) => frame.state === "success").length, completion: partial ? "partial" : "not_started", frames, ...(streamMsgId ? { streamMsgId: `•••${streamMsgId.slice(-4)}` } : {}), durationMs: duration(), message: "扩展停止，流式测试未完成。" };
    }
    if (lastResponseAt) {
      const waitMs = Math.max(0, 300 - (Date.now() - lastResponseAt));
      if (waitMs) await delay(waitMs, undefined, { signal }).catch(() => {});
      if (signal.aborted) continue;
    }
    const request: Omit<StreamMessageRequest, "msg_id" | "event_id"> & Partial<Pick<StreamMessageRequest, "msg_id" | "event_id">> = {
      input_mode: StreamInputMode.REPLACE,
      input_state: inputState,
      content_type: StreamContentType.MARKDOWN,
      content_raw: texts[index]!,
      msg_seq: sequence,
      index,
      ...(options.mode === "passive" ? { event_id: target.messageId, msg_id: target.messageId } : {}),
      ...(streamMsgId ? { stream_msg_id: streamMsgId } : {}),
    };
    options.onEvent("DEBUG", index === 0 ? "QQ 流式消息已创建，发送首帧。" : inputState === StreamInputState.DONE ? "QQ 流式消息发送完成帧。" : "QQ 流式消息更新帧。", { requestId, scope, stage: inputState === StreamInputState.DONE ? "complete" : "frame", frame: index });
    try {
      const token = await options.getToken();
      const response = await options.request(`https://api.sgroup.qq.com${endpoint}`, {
        method: "POST", headers: { Authorization: `QQBot ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(request), redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      });
      const responseData = await responseBody(response);
      const businessValue = responseData.code ?? responseData.err_code;
      const businessCode = typeof businessValue === "number" && Number.isSafeInteger(businessValue) ? String(businessValue) : typeof businessValue === "string" && /^\d{1,15}$/.test(businessValue) ? businessValue : undefined;
      const responseMessage = safeMessage(responseData.message, [options.appSecret, options.appId, token, target.targetOpenid, target.messageId, ...Object.values(request).filter((value): value is string => typeof value === "string")]);
      if (!response.ok || (businessCode !== undefined && Number(businessCode) !== 0)) {
        const failure = new Error("QQ_STREAM_REJECTED") as Error & { httpStatus: number; bizCode?: string; bizMessage?: string };
        failure.httpStatus = response.status; failure.bizCode = businessCode; failure.bizMessage = responseMessage;
        throw failure;
      }
      const responseId = typeof responseData.id === "string" ? responseData.id : undefined;
      const responseValue = { id: responseId, httpStatus: response.status, businessCode };
      lastHttpStatus = response.status; lastBusinessCode = businessCode;
      lastResponseAt = Date.now();
      if (index === 0) {
        if (typeof responseValue.id !== "string" || !responseValue.id) {
          options.onEvent("ERROR", "QQ 流式首帧响应缺少流 ID。", { requestId, scope, stage: "stream_id_missing", status: response.status, frame: index });
          frames.push({ index, inputState, state: "success", httpStatus: response.status, ...(businessCode ? { businessCode } : {}) });
          return { ...base, state: "partial_success", stage: "stream_id_missing", httpStatus: response.status, ...(businessCode ? { businessCode } : {}), serverAccepted: true, frameCount: 1, completion: "partial", frames, durationMs: duration(), message: "首帧已获 HTTP 成功响应，但响应缺少流 ID，无法安全发送后续帧。" };
        }
        streamMsgId = responseValue.id;
        options.onEvent("INFO", "QQ 流式消息已创建。", { requestId, scope, stage: "stream_created", status: response.status, frame: index });
      }
      frames.push({ index, inputState, state: "success", httpStatus: response.status, ...(businessCode ? { businessCode } : {}), ...(responseValue.id ? { responseId: `•••${responseValue.id.slice(-4)}` } : {}) });
      options.onEvent("INFO", inputState === StreamInputState.DONE ? "QQ 流式消息完成帧已接受。" : "QQ 流式帧已接受。", { requestId, scope, stage: inputState === StreamInputState.DONE ? "complete" : "frame", status: response.status, frame: index });
    } catch (error) {
      const value = error && typeof error === "object" ? error as { httpStatus?: unknown; bizCode?: unknown; bizMessage?: unknown; message?: unknown } : {};
      const httpStatus = typeof value.httpStatus === "number" && value.httpStatus >= 100 && value.httpStatus <= 599 ? value.httpStatus : undefined;
      const code = typeof value.bizCode === "number" || (typeof value.bizCode === "string" && /^\d{1,15}$/.test(value.bizCode)) ? String(value.bizCode) : undefined;
      const safe = safeMessage(typeof value.bizMessage === "string" ? value.bizMessage : value.message, [options.appSecret, options.appId, target.targetOpenid, target.messageId]);
      const state = httpStatus === undefined ? "unknown_outcome" as const : "rejected" as const;
      frames.push({ index, inputState, state: state === "unknown_outcome" ? state : "rejected", ...(httpStatus === undefined ? {} : { httpStatus }), ...(code ? { businessCode: code } : {}) } as CapabilityFrameResult);
      options.onEvent(httpStatus === undefined ? "ERROR" : "WARN", httpStatus === undefined ? "QQ 流式帧请求未获得 HTTP 响应，结果未知。" : "QQ 平台拒绝流式帧。", { requestId, scope, stage: inputState === StreamInputState.DONE ? "complete" : "frame", ...(httpStatus === undefined ? {} : { status: httpStatus }), ...(code ? { code } : {}), frame: index, durationMs: duration() });
      const anyAccepted = frames.some((frame) => frame.state === "success");
      return {
        ...base,
        state: state === "unknown_outcome" ? "unknown_outcome" : anyAccepted ? "partial_success" : "rejected",
        stage: inputState === StreamInputState.DONE ? "complete" : "frame",
        ...(httpStatus === undefined ? {} : { httpStatus }), ...(code ? { businessCode: code } : {}),
        ...(safe ? { message: safe } : {}), serverAccepted: anyAccepted, frameCount: frames.filter((frame) => frame.state === "success").length,
        completion: state === "unknown_outcome" ? "unknown" : anyAccepted ? "partial" : "not_started", frames,
        ...(streamMsgId ? { streamMsgId: `•••${streamMsgId.slice(-4)}` } : {}), durationMs: duration(),
      };
    }
  }
  options.onEvent("INFO", "QQ 流式消息协议已完成。", { requestId, scope, stage: "complete", frame: texts.length - 1, durationMs: duration() });
  return { ...base, state: "success", stage: "complete", ...(lastHttpStatus === undefined ? {} : { httpStatus: lastHttpStatus }), ...(lastBusinessCode ? { businessCode: lastBusinessCode } : {}), serverAccepted: true, frameCount: frames.length, completion: "complete", frames, ...(streamMsgId ? { streamMsgId: `•••${streamMsgId.slice(-4)}` } : {}), durationMs: duration() };
}
