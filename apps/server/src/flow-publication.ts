import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, lstatSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { projectConfigRoot } from "./env.js";
import { builtInWebContextFlow, runWebContextFlow } from "./web-context-flow.js";
import { builtInWebToolFlow, runWebToolFlow } from "./web-tool-flow.js";
import { builtInWebToolExecutionFlow } from "./web-tool-execution-flow.js";

export type FlowConnections = { recent: boolean; global: boolean; search: boolean };
type Version = { id: string; connections: FlowConnections };
type State = { revision: string; draft: FlowConnections; published: Version; previous?: Version };
const defaults = (): FlowConnections => ({ recent: true, global: true, search: true });
function parseConnections(input: unknown): FlowConnections {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).sort().join(",") !== "global,recent,search") throw new Error("INVALID_CONNECTIONS");
  const value = input as FlowConnections;
  if ([value.recent, value.global, value.search].some(item => typeof item !== "boolean")) throw new Error("INVALID_CONNECTIONS");
  return { recent: value.recent, global: value.global, search: value.search };
}
export function resolvePublishedGraphs(connections: FlowConnections) {
  const context = builtInWebContextFlow(), tools = builtInWebToolFlow();
  const child = context.graphs.find(g => g.id === "context")!, tool = tools.graphs.find(g => g.id === "availability")!;
  child.edges = child.edges.filter(e => !(e.to.node === "assembler" && ((e.from.node === "recent" && !connections.recent) || (e.from.node === "global" && !connections.global))));
  tool.edges = tool.edges.filter(e => !(e.from.node === "search" && e.to.node === "filter" && !connections.search));
  return { context, tools, execution: builtInWebToolExecutionFlow() };
}

/** Single-server store. All mutations are synchronous CAS and atomically replace one file. */
export class FlowPublication {
  constructor(private readonly path = join(projectConfigRoot, "data", "flow-publication.json")) {}
  private initial(): State { return { revision: "initial", draft: defaults(), published: { id: "default", connections: defaults() } }; }
  read(): State {
    try {
      if (lstatSync(dirname(this.path)).isSymbolicLink()) throw new Error("INVALID_FLOW_STORE");
      if (lstatSync(this.path).isSymbolicLink()) throw new Error("INVALID_FLOW_STORE");
      const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("INVALID_FLOW_STORE");
      const data = parsed as State;
      const version = (v: Version): Version => { if (!v || typeof v.id !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(v.id)) throw new Error("INVALID_FLOW_STORE"); return { id: v.id, connections: parseConnections(v.connections) }; };
      if (typeof data.revision !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(data.revision)) throw new Error("INVALID_FLOW_STORE");
      return { revision: data.revision, draft: parseConnections(data.draft), published: version(data.published), ...(data.previous ? { previous: version(data.previous) } : {}) };
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return this.initial(); throw error; }
  }
  private write(state: State): void {
    mkdirSync(dirname(this.path), { recursive: true });
    if (lstatSync(dirname(this.path)).isSymbolicLink()) throw new Error("INVALID_FLOW_STORE");
    try { if (lstatSync(this.path).isSymbolicLink()) throw new Error("INVALID_FLOW_STORE"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const temp = `${this.path}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try { fd = openSync(temp, "wx", 0o600); writeFileSync(fd, JSON.stringify(state)); fsyncSync(fd); closeSync(fd); fd = undefined; renameSync(temp, this.path); }
    finally { if (fd !== undefined) closeSync(fd); try { unlinkSync(temp); } catch { /* Temp was moved or could not be removed. */ } }
  }
  save(revision: string, input: unknown): State {
    const current = this.read(); if (current.revision !== revision) throw new Error("FLOW_CONFLICT");
    const next = { ...current, revision: randomUUID(), draft: parseConnections(input) }; this.write(next); return next;
  }
  async validate(input: FlowConnections): Promise<void> {
    const { context, tools } = resolvePublishedGraphs(parseConnections(input));
    await runWebContextFlow(context, { recent: () => [], global: () => [] }, { conversationId: "validation", current: "验证", instructions: "", budgetBytes: 48000, recentLimit: 50, useHistoryTool: true });
    await runWebToolFlow(tools, [], () => true);
  }
  async publish(revision: string): Promise<State> {
    const current = this.read(); if (current.revision !== revision) throw new Error("FLOW_CONFLICT");
    await this.validate(current.draft);
    const latest = this.read(); if (latest.revision !== revision) throw new Error("FLOW_CONFLICT");
    const next = { revision: randomUUID(), draft: current.draft, published: { id: randomUUID(), connections: current.draft }, previous: current.published }; this.write(next); return next;
  }
  reset(revision: string): State { return this.save(revision, defaults()); }
}
