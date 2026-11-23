import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type { AgentCore } from "./agent-core.js";
import type { ChannelMessage, ChannelDeliver } from "./channel.js";
import type { ExtensionManager } from "./extension-manager.js";
import type { ToolRuns } from "./tool-runs.js";

/** Server-owned allowlists. No entry is inferred from the Tool provider or QQ identity. */
export type QQToolPolicy = { private?: readonly string[]; group?: readonly string[]; privateSenders?: readonly string[]; groups?: readonly string[]; groupSenders?: readonly string[] };
export type QQToolStarter = (message: ChannelMessage, signal?: AbortSignal) => Promise<string>;
type Entry = { owner: string; scope: "private" | "group"; conversationRef: string; senderRef: string; eventRef: string; contentRef: string; createdAt: string; providers: Map<string, string>; signal: AbortSignal; onAbort: () => void; deadline: number; removeAt: number; deliver?: ChannelDeliver; delivery: "not_attempted" | "delivering" | "delivered" | "unavailable" | "rejected" | "unknown_outcome"; deliveryReason?: string; deliveryAt?: string };

/** In-memory adapter over the existing Core run; no QQ delivery is attempted here. */
export class QQToolRuns {
  private readonly entries = new Map<string, Entry>();
  private readonly key = randomBytes(32);
  private readonly allowed: Record<"private" | "group", Set<string>>;
  private readonly privateSenders: Set<string>;
  private readonly groups: Set<string>;
  private readonly groupSenders: Set<string>;
  private readonly timer: ReturnType<typeof setInterval>;
  private closed = false;
  constructor(private readonly runs: ToolRuns, private readonly extensions: ExtensionManager, private readonly core: () => Promise<AgentCore>, policy: QQToolPolicy = {}, private readonly timeoutMs = 10 * 60_000, private readonly retentionMs = 30 * 60_000, private readonly maxActive = 20) {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 30 * 60_000) throw new Error("INVALID_RUN_TIMEOUT");
    if (!Number.isFinite(retentionMs) || retentionMs < 100 || retentionMs > 30 * 60_000) throw new Error("INVALID_RUN_RETENTION");
    if (!Number.isSafeInteger(maxActive) || maxActive < 1 || maxActive > 20) throw new Error("INVALID_RUN_LIMIT");
    this.allowed = { private: new Set(policy.private ?? []), group: new Set(policy.group ?? []) };
    this.privateSenders = new Set(policy.privateSenders ?? []); this.groups = new Set(policy.groups ?? []); this.groupSenders = new Set(policy.groupSenders ?? []);
    this.timer = setInterval(() => this.sweep(), Math.min(1000, timeoutMs)); this.timer.unref();
  }
  private ref(...parts: string[]): string { return createHmac("sha256", this.key).update(JSON.stringify(parts)).digest("hex").slice(0, 24); }
  /** Only verified QQ gateway messages and explicit identity + Tool allowlists reach production mode. */
  productionAllowed(message: ChannelMessage): boolean {
    return message.channelId === "qq-bot" && (message.conversationType === "private"
      ? this.privateSenders.has(message.senderId)
      : message.conversationType === "group" && this.groups.has(message.conversationId) && this.groupSenders.has(message.senderId));
  }
  start(message: ChannelMessage, signal?: AbortSignal): Promise<string>;
  start(message: ChannelMessage, signal: AbortSignal | undefined, production: { deliver: ChannelDeliver }): Promise<string | undefined>;
  async start(message: ChannelMessage, signal?: AbortSignal, production?: { deliver: ChannelDeliver }): Promise<string | undefined> {
    message = { ...message };
    if (this.closed || signal?.aborted || message.channelId !== "qq-bot" || !["private", "group"].includes(message.conversationType) || !message.conversationId || !message.senderId || !message.messageId || typeof message.content !== "string" || !message.content.trim() || Buffer.byteLength(message.content, "utf8") > 32000) throw new Error("INVALID_QQ_REQUEST");
    if (production && !this.productionAllowed(message)) return undefined;
    const core = await this.core();
    const sourceLease = this.extensions.channelSignal("qq-bot");
    if (this.closed || signal?.aborted || !sourceLease || sourceLease.aborted) throw new Error("CHANNEL_UNAVAILABLE");
    const scope = message.conversationType, permitted = this.allowed[scope];
    const eventRef = this.ref(scope, message.conversationId, message.messageId);
    const senderRef = this.ref(scope, message.conversationId, message.senderId), contentRef = this.ref(message.content);
    for (const [id, prior] of this.entries) if (prior.eventRef === eventRef) {
      if (prior.senderRef !== senderRef || prior.contentRef !== contentRef) throw new Error("QQ_EVENT_CONFLICT");
      return id;
    }
    const allow = (name: string) => !sourceLease.aborted && permitted.has(name) && core.toolAllowed(name) && (name !== "send_message" || !!message.targetRef);
    const snapshot = this.extensions.requestCapabilities({ channel: "qq", allowTool: allow, allowSkill: () => false });
    const tools = new Map(snapshot.visible.filter(item => item.kind === "tool").map(item => [item.name, item]));
    if (production && (!this.productionAllowed(message) || tools.size === 0)) return undefined;
    if (this.entries.size >= 100) throw new Error("RUN_LIMIT");
    if (production) {
      let active = 0;
      for (const [runId, entry] of this.entries) {
        try { if (["working", "waiting", "executing"].includes(this.runs.get(entry.owner, runId).status)) active++; } catch { /* Removed by Core. */ }
      }
      if (active >= this.maxActive) throw new Error("RUN_LIMIT");
    }
    const owner = `qq:${randomUUID()}`;
    const source = { starcoreId: "qq-bot", channelId: "qq-bot", conversationId: this.ref(scope, message.conversationId) };
    const id = this.runs.start(owner, message.content, [{ role: "system", content: core.instructions("qq-bot") }, { role: "user", content: message.content }], {
      searchHistory: () => [], activity: () => {},
      allowTool: name => name !== "search_history" && allow(name) && !!tools.get(name) && snapshot.isEligible(tools.get(name)!.id),
      targetRef: message.targetRef ?? "",
      allowInput: (name, input) => name !== "send_message" || (!!message.targetRef && input.channel === "qq-bot" && input.target === message.targetRef),
    }, source);
    const combined = signal ? AbortSignal.any([sourceLease, signal]) : sourceLease;
    const onAbort = () => {
      this.runs.cancel(owner, id);
      const entry = this.entries.get(id);
      if (entry?.deliver && entry.delivery === "not_attempted") { entry.deliver = undefined; entry.delivery = "unavailable"; entry.deliveryReason = "CHANNEL_CANCELLED"; entry.deliveryAt = new Date().toISOString(); }
    };
    const now = Date.now();
    this.entries.set(id, { owner, scope, conversationRef: source.conversationId, senderRef, eventRef, contentRef, createdAt: new Date(now).toISOString(), providers: new Map([...tools.values()].map(item => [item.name, item.providerId])), signal: combined, onAbort, deadline: now + this.timeoutMs, removeAt: now + this.timeoutMs + this.retentionMs, deliver: production?.deliver, delivery: "not_attempted" });
    combined.addEventListener("abort", onAbort, { once: true });
    if (combined.aborted) onAbort();
    return id;
  }
  get(id: string) {
    const entry = this.entries.get(id); if (!entry) throw new Error("RUN_NOT_FOUND");
    let run = this.runs.get(entry.owner, id);
    if (Date.now() >= entry.deadline && run.status !== "done" && run.status !== "error") {
      this.runs.cancel(entry.owner, id); run = this.runs.get(entry.owner, id);
    }
    if (run.status === "error" && entry.deliver && entry.delivery === "not_attempted") { entry.deliver = undefined; entry.delivery = "unavailable"; entry.deliveryReason = "RUN_CANCELLED"; entry.deliveryAt = new Date().toISOString(); }
    return { ...run, source: { starcoreId: "qq-bot", channelId: "qq-bot", scope: entry.scope, conversationRef: entry.conversationRef, senderRef: entry.senderRef }, createdAt: entry.createdAt,
      calls: run.calls.map(call => ({ ...call, providerId: entry.providers.get(call.name) })),
      generation: run.status === "done" ? "generated" : run.status === "error" ? "failed" : "pending",
      delivery: entry.delivery, ...(entry.deliveryReason ? { deliveryReason: entry.deliveryReason } : {}), ...(entry.deliveryAt ? { deliveryAt: entry.deliveryAt } : {}) };
  }
  list() {
    const result: ReturnType<QQToolRuns["get"]>[] = [];
    for (const [id, entry] of this.entries) {
      try { result.push(this.get(id)); }
      catch { entry.signal.removeEventListener("abort", entry.onAbort); this.entries.delete(id); }
    }
    return result;
  }
  decide(id: string, callId: string, approved: boolean): void {
    const entry = this.entries.get(id); if (!entry) throw new Error("RUN_NOT_FOUND");
    this.get(id); // Enforce the deadline even between timer ticks.
    this.runs.decide(entry.owner, id, callId, approved);
  }
  private sweep(): void {
    const now = Date.now();
    for (const [id, entry] of this.entries) {
      let run: ReturnType<ToolRuns["get"]>;
      try { run = this.runs.get(entry.owner, id); } // Also expires pending approvals and resumes the model.
      catch { entry.signal.removeEventListener("abort", entry.onAbort); this.entries.delete(id); continue; }
      if (now >= entry.deadline && run.status !== "done" && run.status !== "error") { this.runs.cancel(entry.owner, id); run = this.runs.get(entry.owner, id); }
      if (run.status === "error" && entry.deliver && entry.delivery === "not_attempted") { entry.deliver = undefined; entry.delivery = "unavailable"; entry.deliveryReason = "RUN_CANCELLED"; entry.deliveryAt = new Date(now).toISOString(); }
      if (run.status === "done" && entry.deliver && entry.delivery === "not_attempted") {
        const deliver = entry.deliver; entry.deliver = undefined; entry.delivery = "delivering";
        void Promise.resolve().then(() => deliver(run.reply ?? "", entry.signal)).then(result => {
          entry.delivery = result.status; entry.deliveryReason = result.reason; entry.deliveryAt = new Date().toISOString();
        }).catch(() => { entry.delivery = "unknown_outcome"; entry.deliveryReason = "DELIVERY_ERROR"; entry.deliveryAt = new Date().toISOString(); });
      }
      if (now >= entry.removeAt) {
        entry.signal.removeEventListener("abort", entry.onAbort); this.runs.forget(entry.owner, id); this.entries.delete(id);
      }
    }
  }
  shutdown(): void {
    if (this.closed) return;
    this.closed = true; clearInterval(this.timer);
    for (const [id, entry] of this.entries) { entry.signal.removeEventListener("abort", entry.onAbort); this.runs.cancel(entry.owner, id); }
    this.entries.clear();
  }
}
