import { Worker } from "node:worker_threads";
import type { PeopleRepository } from "./people.js";

/** Only channel adapters and Core construct these keys. Never derived from model output. */
export type IdentityInput = { channelId: "qq-bot"; accountId: string; senderId: string; conversationType: "private" | "group"; groupId?: string } | { channelId: "web-chat" };
export type IdentityResult = { kind: "resolved"; identityId: string; personId: string; spaceId?: string; identityType: string; observedName?: string; observedAt: string } | { kind: "unresolved" } | { kind: "unavailable" };

/** Executes against a consistent SQLite read snapshot. It never observes or links identities. */
export function resolveIdentity(repo: PeopleRepository, input: IdentityInput): IdentityResult {
  if (input.channelId !== "qq-bot") return { kind: "unresolved" };
  if (!input.accountId || !input.senderId || (input.conversationType === "group" && !input.groupId)) return { kind: "unresolved" };
  const space = input.conversationType === "group" ? repo.findSpace("qq", input.accountId, "group", input.groupId!) : null;
  if (input.conversationType === "group" && !space) return { kind: "unresolved" };
  const identity = repo.findIdentity({ providerId: "qq", accountId: input.accountId, identityType: space ? "qq_group_member" : "qq_c2c_user", scope: space ? { kind: "space", spaceId: space.id } : { kind: "account" }, externalId: input.senderId });
  if (!identity) return { kind: "unresolved" };
  const person = repo.getPerson(identity.personId);
  if (!person || person.mergedIntoId) return { kind: "unavailable" };
  const member = space ? repo.getMembership(space.id, identity.id) : null;
  return { kind: "resolved", identityId: identity.id, personId: person.id, ...(space ? { spaceId: space.id } : {}), identityType: identity.identityType, ...(member?.displayName ? { observedName: member.displayName } : {}), observedAt: identity.lastSeenAt };
}

/** Bounded worker pool: failure and timeout disclose no identity data. */
export class IdentityResolver {
  private workers = new Set<Worker>();
  private closed = false;
  async resolve(path: string, repo: PeopleRepository, input: IdentityInput): Promise<IdentityResult> {
    if (this.closed || this.workers.size >= 8) return { kind: "unavailable" };
    if (input.channelId === "web-chat") return { kind: "unresolved" };
    if (path === ":memory:") { try { return resolveIdentity(repo, input); } catch { return { kind: "unavailable" }; } }
    return new Promise(resolve => {
      let worker: Worker;
      try { worker = new Worker(new URL("./identity-resolver-worker.js", import.meta.url), { workerData: { path, input } }); } catch { resolve({ kind: "unavailable" }); return; }
      this.workers.add(worker);
      let settled = false;
      const finish = (result: IdentityResult) => { if (settled) return; settled = true; clearTimeout(timer); this.workers.delete(worker); void worker.terminate().catch(() => {}); resolve(result); };
      const timer = setTimeout(() => finish({ kind: "unavailable" }), 1000);
      worker.once("message", (result: IdentityResult) => finish(result));
      worker.once("error", () => finish({ kind: "unavailable" }));
      worker.once("exit", () => finish({ kind: "unavailable" }));
    });
  }
  shutdown(): void { this.closed = true; for (const worker of this.workers) void worker.terminate().catch(() => {}); this.workers.clear(); }
}
