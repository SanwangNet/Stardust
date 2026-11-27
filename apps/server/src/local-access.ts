import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { isIP, type AddressInfo } from "node:net";

const proxyHeaders = /^(?:forwarded|x-forwarded-.+|x-real-ip|x-original-.+|cf-connecting-ip|true-client-ip|via)$/i;
const loopback = (address: string | undefined) => address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
const hostPattern = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::(\d{1,5}))?$/i;
const hasProxyHeaders = (request: IncomingMessage) => Object.keys(request.headers).some(name => proxyHeaders.test(name));

/** Existing read-only local boundary; it is not evidence that a proxy's original client was local. */
export function isLocalRead(request: IncomingMessage): boolean {
  return loopback(request.socket.remoteAddress) && hostPattern.test(request.headers.host ?? "");
}

function validOrigin(request: IncomingMessage, required: boolean): boolean {
  const origin = request.headers.origin, host = request.headers.host;
  if (!origin) return !required;
  if (!host || origin === "null") return false;
  try { const parsed = new URL(origin); return parsed.protocol === "http:" && parsed.origin === new URL(`http://${host}`).origin && parsed.href === `${parsed.origin}/`; }
  catch { return false; }
}

/** Called by the loopback-only Vite proxy before it attaches its per-launch transport proof. */
export function isTrustedDevProxyClient(request: IncomingMessage): boolean {
  const match = hostPattern.exec(request.headers.host ?? ""), port = Number(match?.[1] ?? 80);
  const site = request.headers["sec-fetch-site"];
  return !!match && port === request.socket.localPort && loopback(request.socket.remoteAddress) && loopback(request.socket.localAddress)
    && !hasProxyHeaders(request) && (!site || site === "same-origin" || site === "none") && validOrigin(request, false);
}

/** Flow and management writes fail closed on wildcard listeners and unknown proxy hops. */
export function isTrustedLocalAccess(request: IncomingMessage, listener: AddressInfo | string | null, requireOrigin: boolean, devProxyProof?: string): boolean {
  if (!listener || typeof listener === "string" || !loopback(listener.address) || request.socket.localPort !== listener.port || !loopback(request.socket.localAddress) || !loopback(request.socket.remoteAddress) || hasProxyHeaders(request)) return false;
  const match = hostPattern.exec(request.headers.host ?? ""), port = Number(match?.[1] ?? 80), site = request.headers["sec-fetch-site"];
  if (!match || port < 1 || port > 65535 || (site && site !== "same-origin" && site !== "none") || !validOrigin(request, requireOrigin)) return false;
  const supplied = request.headers["x-stardust-dev-proxy"];
  if (supplied !== undefined) {
    if (typeof supplied !== "string" || !devProxyProof || !/^[A-Za-z0-9_-]{43}$/.test(supplied) || !/^[A-Za-z0-9_-]{43}$/.test(devProxyProof)) return false;
    return timingSafeEqual(Buffer.from(supplied), Buffer.from(devProxyProof));
  }
  return port === listener.port && request.socket.localPort === listener.port;
}


/** Exact proxy IPs only; forwarded client addresses are never used for authorization. */
function canonicalIp(value: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(value);
  if (mapped) value = mapped[1]!;
  if (!isIP(value)) throw new Error("STARDUST_TRUSTED_PROXIES 必须是逗号分隔的 IP 地址");
  return new URL(isIP(value) === 6 ? `http://[${value}]/` : `http://${value}/`).hostname.replace(/^\[|\]$/g, "");
}
export function parseTrustedProxies(value: string): Set<string> {
  const result = new Set<string>();
  if (!value.trim()) return result;
  for (const item of value.split(",")) {
    const ip = item.trim();
    if (!ip) throw new Error("STARDUST_TRUSTED_PROXIES 必须是逗号分隔的 IP 地址");
    result.add(canonicalIp(ip));
  }
  return result;
}
/** Browser-origin and transport checks. This is not user authentication. */
export function isWebAccess(request: IncomingMessage, listener: AddressInfo | string | null, requireOrigin: boolean, proxies: Set<string>, devProxyProof?: string): boolean {
  if (isTrustedLocalAccess(request, listener, requireOrigin, devProxyProof)) return true;
  const site = request.headers["sec-fetch-site"];
  if (site && site !== "same-origin" && site !== "none") return false;
  const rawHost = request.headers.host, origin = request.headers.origin;
  if (!rawHost || (requireOrigin && !origin)) return false;
  try {
    const remote = canonicalIp(request.socket.remoteAddress ?? "");
    const proxy = proxies.has(remote);
    if (!proxy && hasProxyHeaders(request)) return false;
    const forwardedProto = request.headers["x-forwarded-proto"];
    if (proxy && forwardedProto !== undefined && forwardedProto !== "http" && forwardedProto !== "https") return false;
    const protocol = proxy ? forwardedProto ?? "http" : "http";
    const hostUrl = new URL(`${protocol}://${rawHost}/`);
    if (hostUrl.username || hostUrl.password || hostUrl.pathname !== "/" || hostUrl.search || hostUrl.hash) return false;
    if (!proxy) {
      const local = canonicalIp(request.socket.localAddress ?? "");
      const hostname = hostUrl.hostname.replace(/^\[|\]$/g, "");
      if (!(hostname === "localhost" && loopback(local)) && canonicalIp(hostname) !== local) return false;
      if (Number(hostUrl.port || (protocol === "https" ? 443 : 80)) !== request.socket.localPort) return false;
    }
    if (!origin) return true;
    const parsed = new URL(origin);
    return origin !== "null" && parsed.href === `${parsed.origin}/` && parsed.origin === hostUrl.origin;
  } catch { return false; }
}
