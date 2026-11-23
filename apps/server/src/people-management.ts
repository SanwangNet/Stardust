import { Worker } from "node:worker_threads";
import type { ChannelMessage } from "./channel.js";
import type { PeopleRepository } from "./people.js";

export type ManagementQuery = "people" | "person" | "identities" | "personSpaces" | "spaces" | "space" | "members" | "identity" | "audit";
export type ManagementMutation = "edit" | "reassign" | "detach" | "undo" | "mergePreview" | "merge" | "splitPreview" | "split" | "undoMerge";
export type ManagementArgs = [string, number, number, ("active" | "merged")?];
export function queryPeople(repo: PeopleRepository, query: ManagementQuery, [value, limit, offset, state]: ManagementArgs): unknown {
  switch (query) {
    case "people": return repo.managementPeople(value, limit, offset, state);
    case "person": return repo.managementPerson(value);
    case "identities": return repo.managementPersonIdentities(value, limit, offset);
    case "personSpaces": return repo.managementPersonSpaces(value, limit, offset);
    case "spaces": return repo.managementSpaces(value, limit, offset);
    case "space": return repo.managementSpace(value);
    case "members": return repo.managementSpaceMembers(value, limit, offset);
    case "identity": return repo.managementIdentity(value);
    case "audit": return repo.managementAudit(value,limit,offset);
  }
}
export function mutatePeople(repo: PeopleRepository, action: ManagementMutation, args: unknown[]): unknown {
  switch (action) {
    case "edit": return repo.editPerson(args[0] as string,args[1] as number,args[2],args[3]);
    case "reassign": return repo.reassignIdentity(args[0] as string,args[1] as string,args[2] as number,args[3]);
    case "detach": return repo.detachIdentity(args[0] as string,args[1] as number,args[2]);
    case "undo": return repo.undoIdentity(args[0] as string,args[1]);
    case "mergePreview": return repo.previewMerge(args[0] as string,args[1] as string,args[2]);
    case "merge": return repo.mergePeople(args[0] as string,args[1] as string,args[2],args[3],args[4]);
    case "splitPreview": return repo.previewSplit(args[0] as string,args[1] as string | null,args[2]);
    case "split": return repo.splitPeople(args[0] as string,args[1] as string | null,args[2],args[3],args[4]);
    case "undoMerge": return repo.undoMerge(args[0] as string,args[1]);
  }
}

/** File-backed management reads run off the channel event loop and have bounded concurrency. */
export class PeopleManagementReader {
  private readonly workers = new Set<Worker>();
  private closed = false;
  async query(path: string, repo: PeopleRepository, query: ManagementQuery, args: ManagementArgs): Promise<unknown> {
    return this.perform(path, repo, query, args, false);
  }
  async mutate(path: string, repo: PeopleRepository, action: ManagementMutation, args: unknown[]): Promise<unknown> {
    return this.perform(path, repo, action, args, true);
  }
  private async perform(path: string, repo: PeopleRepository, query: ManagementQuery | ManagementMutation, args: unknown[], mutation: boolean): Promise<unknown> {
    if (this.closed || this.workers.size >= 8) throw new Error("PEOPLE_UNAVAILABLE");
    // SQLite's private in-memory databases cannot be opened by another connection.
    if (path === ":memory:") return mutation ? mutatePeople(repo, query as ManagementMutation, args) : queryPeople(repo, query as ManagementQuery, args as ManagementArgs);
    return new Promise((resolve, reject) => {
      let worker: Worker;
      try { worker = new Worker(new URL("./people-management-worker.js", import.meta.url), { workerData: { path, query, args, mutation } }); }
      catch { reject(new Error("PEOPLE_UNAVAILABLE")); return; }
      this.workers.add(worker);
      let settled = false;
      const finish = (value: unknown, failed = false) => {
        if (settled) return; settled = true; clearTimeout(timer); this.workers.delete(worker); void worker.terminate().catch(() => {});
        if (failed) reject(new Error(["NOT_FOUND", "INVALID_INPUT", "CONFLICT", "BATCH_LIMIT"].includes(String(value)) ? String(value) : "PEOPLE_UNAVAILABLE")); else resolve(value);
      };
      const timer = setTimeout(() => finish("PEOPLE_UNAVAILABLE", true), 5000);
      worker.once("message", (message: { ok: boolean; value?: unknown; error?: string }) => finish(message.ok ? message.value : message.error, !message.ok));
      worker.once("error", () => finish("PEOPLE_UNAVAILABLE", true));
      worker.once("exit", () => finish("PEOPLE_UNAVAILABLE", true));
    });
  }
  /** Shares the management worker limit and lifecycle for bounded QQ history writes. */
  async recordQQ(path: string, message: ChannelMessage, reply?: string): Promise<void> {
    if (this.closed || this.workers.size >= 8) throw new Error("PEOPLE_UNAVAILABLE");
    return new Promise((resolve, reject) => {
      let worker: Worker;
      try { worker = new Worker(new URL("./people-management-worker.js", import.meta.url), { workerData: { path, history: { message, reply } } }); }
      catch { reject(new Error("HISTORY_UNAVAILABLE")); return; }
      this.workers.add(worker); let settled = false;
      const finish = (ok: boolean) => { if (settled) return; settled = true; clearTimeout(timer); this.workers.delete(worker); void worker.terminate().catch(() => {}); if (ok) resolve(); else reject(new Error("HISTORY_UNAVAILABLE")); };
      const timer = setTimeout(() => finish(false), 1500);
      worker.once("message", (result: { ok: boolean }) => finish(result.ok));
      worker.once("error", () => finish(false)); worker.once("exit", () => finish(false));
    });
  }
  shutdown(): void { this.closed = true; for (const worker of this.workers) void worker.terminate().catch(() => {}); this.workers.clear(); }
}
