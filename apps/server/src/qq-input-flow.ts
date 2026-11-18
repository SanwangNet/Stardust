import { randomUUID } from "node:crypto";
import { createFlowRegistry, executeFlow, FlowRegistry, validateExecutableFlow, type ExecutableFlow } from "./executable-flow.js";

/** Request-scoped callbacks are supplied by the bundled QQ runtime, never a flow document. */
export type QQInputRequest = {
  eventId: string; messageId?: string; conversationId?: string;
  signal: AbortSignal;
  diagnostic: (signal: AbortSignal) => void | Promise<void>;
  filter: (signal: AbortSignal) => boolean | Promise<boolean>;
};
export type QQInputContext = Readonly<{ channelId: "qq-bot"; starcoreId: "qq-bot"; eventId: string; messageId?: string; conversationId?: string; deadline: number; capabilities: readonly ["qq:inbound"]; signal: AbortSignal }>;

/** Core installs only fixed adapter contracts. The opaque output proves the mandatory filter ran. */
export async function runQQInputFlow(definition: ExecutableFlow, request: QQInputRequest, lifecycle: AbortSignal, timeoutMs = 5000): Promise<"allow" | "skip"> {
  const snapshot = structuredClone(definition);
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = AbortSignal.any([request.signal, lifecycle, timeout]);
  const context: QQInputContext = Object.freeze({ channelId: "qq-bot", starcoreId: "qq-bot", eventId: request.eventId, messageId: request.messageId, conversationId: request.conversationId, deadline: Date.now() + timeoutMs, capabilities: Object.freeze(["qq:inbound"] as const), signal });
  const input = randomUUID(), receipt = randomUUID();
  let called = false, diagnosed = false, allowed = false;
  const guard = () => { if (context.signal.aborted || Date.now() >= context.deadline) throw new Error("QQ_FLOW_CANCELLED"); };
  const bounded = async <T>(action: () => T | Promise<T>): Promise<T> => {
    guard();
    let listener: (() => void) | undefined;
    const cancelled = new Promise<never>((_, reject) => { listener = () => reject(new Error("QQ_FLOW_CANCELLED")); signal.addEventListener("abort", listener, { once: true }); });
    try { return await Promise.race([Promise.resolve().then(() => { guard(); return action(); }), cancelled]); }
    finally { if (listener) signal.removeEventListener("abort", listener); }
  };
  const registry = new FlowRegistry(), core = createFlowRegistry();
  for (const type of ["input", "output", "pass"]) registry.register(type, core.get(type)!);
  const str = { type: "string" as const, required: true }, out = { value: { type: "string" as const } };
  registry.register("qq-bot:diagnostic", { role: "node", inputs: { value: str }, outputs: out, execute: async i => { if (i.value !== input || diagnosed) throw new Error("QQ_FLOW_INVALID_INPUT"); diagnosed = true; await bounded(() => request.diagnostic(signal)); guard(); return { value: input }; } });
  registry.register("qq-bot:accept", { role: "node", inputs: { value: str, diagnostic: { type: "string" } }, outputs: out, execute: async i => {
    if (i.value !== input || called) throw new Error("QQ_FLOW_INVALID_INPUT");
    called = true; allowed = await bounded(() => request.filter(signal)); guard();
    if (typeof allowed !== "boolean") throw new Error("QQ_FLOW_INVALID_RESULT");
    return { value: receipt };
  } });
  try { validateExecutableFlow(snapshot, registry); }
  catch { throw new Error("QQ_FLOW_INVALID"); }
  guard();
  let result;
  try { result = await executeFlow(snapshot, registry, { message: input }, { signal }); }
  catch { throw new Error("QQ_FLOW_INVALID"); }
  guard();
  if (result.status !== "succeeded" || !called || result.outputs.result !== receipt) throw new Error("QQ_FLOW_FAILED");
  return allowed ? "allow" : "skip";
}
