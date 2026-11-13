import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { loadCoreEnv } from "./env.js";

// Only loopback clients can use the administrator session; no remote plaintext login.
export class AdminAuth {
  private readonly sessions = new Map<string, number>();
  private attempts: number[] = [];
  constructor(private readonly configured = process.env.STARDUST_ADMIN_TOKEN ?? loadCoreEnv().STARDUST_ADMIN_TOKEN ?? "") {}
  local(request: IncomingMessage): boolean {
    const address = request.socket.remoteAddress ?? "";
    const host = request.headers.host ?? "";
    return (address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1") && /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host);
  }
  configuredSecurely(): boolean { return this.configured.length >= 32 && this.configured.length <= 1024; }
  login(value: unknown): string | undefined {
    const now = Date.now(); this.attempts = this.attempts.filter((time) => now - time < 60_000);
    if (this.attempts.length >= 10 || !this.configuredSecurely() || typeof value !== "string" || value.length > 1024) return undefined;
    this.attempts.push(now);
    const hash = (text: string) => createHash("sha256").update(text).digest();
    if (!timingSafeEqual(hash(value), hash(this.configured))) return undefined;
    this.attempts = [];
    for (const [key, expiry] of this.sessions) if (expiry <= now) this.sessions.delete(key);
    if (this.sessions.size >= 32) this.sessions.delete(this.sessions.keys().next().value!);
    const id = randomBytes(32).toString("base64url"); this.sessions.set(id, now + 8 * 60 * 60_000); return id;
  }
  session(request: IncomingMessage): string | undefined {
    if (!this.local(request)) return undefined;
    const match = /(?:^|;\s*)stardust_admin=([A-Za-z0-9_-]{43})(?:;|$)/.exec(request.headers.cookie ?? "");
    const id = match?.[1]; if (!id) return undefined;
    const expiry = this.sessions.get(id);
    if (!expiry || expiry <= Date.now()) { this.sessions.delete(id); return undefined; }
    return id;
  }
}
