import { randomUUID } from "node:crypto";

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";
export type LogDetails = { status?: number; code?: string; category?: string; message?: string; requestId?: string; eventId?: string; durationMs?: number; reason?: string; scope?: string; rawEventType?: string; kind?: string; msgType?: number | null; mentionsPresent?: boolean; mentionCount?: number; hasGroupOpenid?: boolean; mentionBranch?: string };
export interface LogEntry { id: number; timestamp: string; level: LogLevel; source: string; message: string; details?: LogDetails }
type Sink = (entry: LogEntry) => void;

function clean(value: string, limit: number, secrets: string[]): string {
  let text = value.replace(/[\x00-\x1f\x7f]/g, " ");
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) {
    for (const variant of [secret, encodeURIComponent(secret), Buffer.from(secret).toString("base64")]) if (variant) text = text.replaceAll(variant, "[REDACTED]");
  }
  text = text.replace(/\b(?:authorization|cookie|set-cookie)\s*[:=]\s*[^\r\n]*/gi, "[REDACTED]")
    .replace(/\b(?:Bearer|Basic|QQBot)\s+[^\s,;"']+/gi, "[REDACTED]")
    .replace(/\b(?:api[-_ ]?key|app[-_ ]?secret|access[-_ ]?token|refresh[-_ ]?token|password|secret|token)\s*["']?\s*[:=]\s*["']?[^\s,;"'}]+/gi, "[REDACTED]")
    .replace(/\b(?:sk|secret|token|api[-_]?key)[-_][A-Za-z0-9_-]{4,}\b/gi, "[REDACTED]")
    .replace(/https?:\/\/[^\s"'<>]+/gi, (candidate) => { try { const url = new URL(candidate); url.username = ""; url.password = ""; url.search = ""; url.hash = ""; return url.toString(); } catch { return "[URL 已隐藏]"; } });
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

export class LogService {
  readonly instanceId = randomUUID();
  private readonly entries: Array<LogEntry | undefined>;
  private start = 0;
  private count = 0;
  private sequence = 0;
  private readonly subscribers = new Set<Sink>();
  constructor(private readonly capacity = 1000, private readonly output: (line: string) => void = (line) => console.log(line)) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error("INVALID_LOG_CAPACITY");
    this.entries = new Array(capacity);
  }
  write(level: LogLevel, source: string, message: string, details?: LogDetails, secrets: string[] = []): void {
    try {
      const safeDetails: LogDetails = {};
      for (const key of ["status", "durationMs", "msgType", "mentionCount"] as const) if (typeof details?.[key] === "number" && Number.isFinite(details[key])) safeDetails[key] = details[key];
      if (details?.msgType === null) safeDetails.msgType = null;
      for (const key of ["mentionsPresent", "hasGroupOpenid"] as const) if (typeof details?.[key] === "boolean") safeDetails[key] = details[key];
      for (const key of ["code", "category", "message", "requestId", "eventId", "reason", "scope", "rawEventType", "kind", "mentionBranch"] as const) {
        const value = details?.[key];
        if (typeof value !== "string") continue;
        const sanitized = clean(value, key === "message" ? 512 : 128, secrets);
        if (key === "message" || /^[\w.:-]+$/.test(sanitized) || /^[\w.:-]+(?:-[\w.:-]+)+$/.test(sanitized)) safeDetails[key] = sanitized;
      }
      const entry: LogEntry = { id: ++this.sequence, timestamp: new Date().toISOString(), level, source: clean(source, 48, secrets), message: clean(message, 512, secrets), ...(Object.keys(safeDetails).length ? { details: safeDetails } : {}) };
      const index = (this.start + this.count) % this.capacity;
      if (this.count === this.capacity) { this.entries[this.start] = entry; this.start = (this.start + 1) % this.capacity; }
      else { this.entries[index] = entry; this.count++; }
      try { this.output(`${entry.timestamp} #${entry.id} ${entry.level} [${entry.source}] ${entry.message}${entry.details ? ` ${JSON.stringify(entry.details)}` : ""}`); } catch {}
      for (const subscriber of this.subscribers) { try { subscriber(entry); } catch { this.subscribers.delete(subscriber); } }
    } catch { /* Logging must never break the caller. */ }
  }
  read(after = 0, limit = this.capacity): { entries: LogEntry[]; oldest: number; latest: number; gap: boolean; instanceId: string } {
    const oldest = this.count ? this.entries[this.start]!.id : this.sequence + 1;
    const result: LogEntry[] = [];
    const first = Math.max(0, after > 0 ? after - oldest + 1 : this.count - Math.max(1, limit));
    for (let i = first; i < this.count && result.length < limit; i++) result.push(this.entries[(this.start + i) % this.capacity]!);
    return { entries: result, oldest, latest: this.sequence, gap: after > 0 && (after < oldest - 1 || after > this.sequence), instanceId: this.instanceId };
  }
  subscribe(sink: Sink): () => void { this.subscribers.add(sink); return () => { this.subscribers.delete(sink); }; }
}
export const logger = new LogService();
