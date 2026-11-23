import { Worker } from "node:worker_threads";
import type { ChannelObservation } from "./channel.js";
import type { LogService } from "./logger.js";

type Pending = { observation: ChannelObservation; signal: AbortSignal };

/** Bounded, best-effort in-memory dispatch; SQLite work never runs in the QQ event loop. */
export class PeopleObserver {
  private readonly pending: Pending[] = [];
  private worker?: Worker;
  private active?: { signal: AbortSignal; flag: Int32Array; onAbort: () => void };
  private starting = false;
  private closed = false;
  constructor(private readonly path: () => Promise<string>, private readonly logs: LogService, private readonly limit = 64) {}
  submit(observation: ChannelObservation, signal: AbortSignal): void {
    if (this.closed || signal.aborted) return;
    if (this.pending.length + (this.active || this.starting ? 1 : 0) >= this.limit) { this.warn("OBSERVATION_QUEUE_FULL"); return; }
    this.pending.push({ observation: structuredClone(observation), signal });
    void this.dispatch();
  }
  private warn(code: string): void { this.logs.write("WARN", "people", "人物观察未完成。", { code }); }
  private async dispatch(): Promise<void> {
    if (this.closed || this.starting || this.active) return;
    let next: Pending | undefined;
    while ((next = this.pending.shift()) && next.signal.aborted) { /* Drop revoked work. */ }
    if (!next) return;
    this.starting = true;
    try {
      const dbPath = await this.path();
      if (this.closed || next.signal.aborted) return;
      if (dbPath === ":memory:") { this.warn("OBSERVATION_MEMORY_DB_UNSUPPORTED"); return; }
      if (!this.worker) {
        const worker = new Worker(new URL("./people-observer-worker.js", import.meta.url), { workerData: { path: dbPath } });
        this.worker = worker;
        worker.on("message", (result: { ok?: boolean }) => { if (this.worker !== worker) return; if (!result?.ok) this.warn("OBSERVATION_FAILED"); this.finish(); });
        worker.on("error", () => this.failed(worker));
        worker.on("exit", () => this.failed(worker));
      }
      const flag = new Int32Array(new SharedArrayBuffer(4)), signal = next.signal;
      const onAbort = () => { Atomics.store(flag, 0, 1); };
      this.active = { flag, signal, onAbort }; signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
      this.worker.postMessage({ observation: next.observation, cancellation: flag.buffer });
    } catch { this.warn("OBSERVATION_FAILED"); this.finish(); }
    finally { this.starting = false; if (!this.active && !this.closed) void this.dispatch(); }
  }
  private finish(): void {
    if (this.active) this.active.signal.removeEventListener("abort", this.active.onAbort);
    this.active = undefined;
    if (!this.starting && !this.closed) void this.dispatch();
  }
  private failed(worker: Worker): void {
    if (this.worker !== worker) return;
    this.worker = undefined; if (!this.closed) this.warn("OBSERVATION_WORKER_FAILED"); this.finish();
  }
  shutdown(): void {
    this.closed = true; this.pending.length = 0;
    if (this.active) { this.active.onAbort(); this.active.signal.removeEventListener("abort", this.active.onAbort); this.active = undefined; }
    const worker = this.worker; this.worker = undefined;
    if (worker) void worker.terminate().catch(() => {});
  }
}
