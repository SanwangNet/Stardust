import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const statusPath = "/run/stardust-web-update/status.json";
const service = "stardust-web-update.service";
export interface UpdateStatus { jobId: string; running: boolean; status: string | null; phase: string | null; targetSha: string | null; result: string | null; failureStage: string | null; failureReason: string | null; detail: string | null; updatedAt: number }
const code = (v: unknown): v is string | null => v === null || typeof v === "string" && /^[A-Z0-9_:.-]{1,160}$/.test(v);
export function parseUpdateStatus(value: unknown): UpdateStatus {
  if (!value || typeof value !== "object") throw new Error("更新状态格式错误");
  const v = value as Record<string, unknown>;
  if (v.format !== 1 || typeof v.jobId !== "string" || !/^[a-f0-9-]{36}$/.test(v.jobId) || typeof v.running !== "boolean" || ![v.status,v.phase,v.result,v.failureStage,v.failureReason].every(code) || !(v.targetSha === null || typeof v.targetSha === "string" && /^[a-f0-9]{40}$/.test(v.targetSha)) || !(v.detail === null || typeof v.detail === "string" && v.detail.length <= 500) || typeof v.updatedAt !== "number" || !Number.isSafeInteger(v.updatedAt)) throw new Error("更新状态格式错误");
  return {jobId:v.jobId,running:v.running,status:v.status as string|null,phase:v.phase as string|null,targetSha:v.targetSha as string|null,result:v.result as string|null,failureStage:v.failureStage as string|null,failureReason:v.failureReason as string|null,detail:v.detail as string|null,updatedAt:v.updatedAt};
}
export function createWebUpdateControl(enabled: boolean) {
  return {
    enabled,
    async status(): Promise<UpdateStatus | null> {
      if (!enabled) return null;
      let text: string; try { text=await readFile(statusPath,"utf8"); } catch(e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw new Error("无法读取更新状态"); }
      if (text.length>8192) throw new Error("更新状态格式错误");
      const state=parseUpdateStatus(JSON.parse(text));
      if(state.running && Date.now()-state.updatedAt>10000) {
        try { const result=await exec("/usr/bin/systemctl",["is-active",service],{timeout:3000,env:{PATH:"/usr/bin:/bin",LANG:"C"}}); if (!["active","activating","reloading"].includes(result.stdout.trim())) throw new Error(); }
        catch(e) { if (typeof (e as NodeJS.ErrnoException).code === "number") return {...state,running:false,result:"UPDATE_FAILED",failureReason:"UPDATER_INTERRUPTED"}; }
      }
      return state;
    },
    async start(): Promise<void> {
      if (!enabled) throw new Error("WebUI 更新未启用");
      try { await exec("/usr/bin/sudo",["-n","/usr/bin/systemctl","start","--no-block",service],{timeout:10000,env:{PATH:"/usr/bin:/bin",LANG:"C"}}); }
      catch { throw new Error("无法启动更新服务，请检查部署授权和服务状态"); }
    },
  };
}
