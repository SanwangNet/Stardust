import { randomUUID } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import { access, lstat, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform, type Readable } from "node:stream";

const limit = 2 * 1024 ** 3;
const bootId = process.platform === "linux" ? readFile("/proc/sys/kernel/random/boot_id", "utf8").then(value => value.trim(), () => null) : Promise.resolve(null);
export const releaseSha = /^[a-f0-9]{40}$/;
export const backupId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export const managementOperations = ["check", "update", "backup", "restore", "rollback", "upload", "delete"] as const;
type Operation = (typeof managementOperations)[number];
export interface ManagementRequest { operation: Operation; target?: string; backup?: string }
export function managementRequest(input: unknown): ManagementRequest {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("INVALID_REQUEST");
  const value = input as Record<string, unknown>;
  const operation = value.operation as Operation;
  if (!managementOperations.includes(operation) || operation === "upload") throw new Error("INVALID_REQUEST");
  const key = operation === "restore" || operation === "delete" ? "backup" : operation === "update" || operation === "rollback" ? "target" : undefined;
  if (Object.keys(value).sort().join(",") !== (key ? ["operation", key].sort().join(",") : "operation")) throw new Error("INVALID_REQUEST");
  if (!key) return { operation };
  const argument = value[key];
  if (typeof argument !== "string" || !(key === "backup" ? backupId : releaseSha).test(argument)) throw new Error("INVALID_REQUEST");
  return { operation, [key]: argument };
}
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === "ENOENT"; }

export function createManagement(enabled: boolean, root = "/opt/stardust", owner = 0) {
  const dir = join(root, "management"), inbox = join(dir, "inbox"), requestPath = join(inbox, "request.json");
  let submitting = false;

  async function status() {
    if (!enabled) return { enabled, pending: false, job: null, lastDeployment: null, versions: [], backups: [], latest: null, current: null };
    const file = await open(join(dir, "status.json"), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    let value;
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== owner || (process.platform !== "win32" && (stat.mode & 0o022) !== 0) || stat.size > 512 * 1024) throw new Error("MANAGEMENT_UNAVAILABLE");
      value = JSON.parse(await file.readFile("utf8"));
      if (value?.format !== 1) throw new Error("MANAGEMENT_UNAVAILABLE");
    } finally { await file.close(); }
    const pending = await lstat(requestPath).then(() => true, error => { if (!missing(error)) throw error; return false; });
    const boot = await bootId;
    const job = value.job?.result === "running" && boot && value.job.bootId && value.job.bootId !== boot
      ? { ...value.job, result: "failed", reason: "INTERRUPTED" }
      : value.job;
    const publicJob = (item: Record<string,unknown> | null) => item ? {
      id:item.id, operation:item.operation, phase:item.phase, targetSha:item.targetSha, result:item.result, reason:item.reason,
    } : null;
    return { enabled, pending, job:publicJob(job), lastDeployment:publicJob(value.lastDeployment ?? null),
      versions:value.versions, backups:value.backups, latest:value.latest, current:value.current ?? null };

  }

  async function submit(request: ManagementRequest, upload?: Readable): Promise<string> {
    if (!enabled) throw new Error("MANAGEMENT_DISABLED");
    if (submitting) throw new Error("MANAGEMENT_BUSY");
    submitting = true;
    const id = randomUUID(), temp = join(inbox, id + ".tmp"), archive = join(inbox, id + ".tar.gz");
    let queued = false;
    try {
      const state = await status();
      if (state.pending || state.job?.result === "running") throw new Error("MANAGEMENT_BUSY");
      await access(inbox, constants.W_OK);
      if (upload) {
        let size = 0;
        await pipeline(upload, new Transform({ transform(chunk: Buffer, _encoding, done) {
          size += chunk.length;
          if (size > limit) done(new Error("UPLOAD_TOO_LARGE"));
          else done(null, chunk);
        } }), createWriteStream(archive, {flags:"wx",mode:0o600}));
        if (!size) throw new Error("INVALID_REQUEST");

      }
      const file = await open(temp, "wx", 0o600);
      try { await file.writeFile(JSON.stringify({ ...request, id })); await file.sync(); } finally { await file.close(); }
      await rename(temp, requestPath);
      queued = true;
      return id;
    } finally {
      submitting = false;
      await unlink(temp).catch(() => {});
      if (upload && !queued) await unlink(archive).catch(() => {});
    }
  }

  async function download(id: string) {
    if (!enabled || !backupId.test(id)) throw new Error("MANAGEMENT_DISABLED");
    const file = await open(join(root, "backups", id + ".tar.gz"), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.uid !== owner || stat.nlink !== 1 || (process.platform !== "win32" && (stat.mode & 0o022) !== 0) || stat.size > limit) throw new Error("INVALID_BACKUP");
      return { stream: file.createReadStream(), size: stat.size };
    } catch (error) { await file.close(); throw error; }
  }

  return { enabled, status, submit, download };
}
