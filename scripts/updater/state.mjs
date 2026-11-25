import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';

const sha = value => value === null || typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const stamp = value => value === null || typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const count = value => Number.isSafeInteger(value) && value >= 0 && value <= 1000;
const short = value => value === null || typeof value === 'string' && /^[A-Z0-9_:.-]{1,160}$/.test(value);
const phases = new Set(['IDLE','CHECKING','PREPARING','VERIFYING','READY','FAILED','INTERRUPTED']);
const keys = ['format','status','phase','taskId','trigger','startedAt','updatedAt','checkedAt','remoteSha','targetSha','preparedSha','preparedAt','lastResult','failureStage','failureReason','checkFailures','checkNextAt','buildFailures','buildFailureSha','buildNextAt','interruptedPhase'];

export function initialState() {
  return {format:1,status:'IDLE',phase:null,taskId:null,trigger:null,startedAt:null,updatedAt:null,checkedAt:null,remoteSha:null,targetSha:null,preparedSha:null,preparedAt:null,lastResult:null,failureStage:null,failureReason:null,checkFailures:0,checkNextAt:null,buildFailures:0,buildFailureSha:null,buildNextAt:null,interruptedPhase:null};
}
export function validateState(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s) || s.format !== 1) throw new Error(s?.format !== undefined && s.format !== 1 ? 'STATE_VERSION_UNSUPPORTED' : 'STATE_INVALID');
  if (Object.keys(s).length !== keys.length || keys.some(k=>!Object.hasOwn(s,k)) || !phases.has(s.status) || ![s.phase,s.trigger,s.lastResult,s.failureStage,s.failureReason,s.interruptedPhase].every(short) || ![s.startedAt,s.updatedAt,s.checkedAt,s.preparedAt,s.checkNextAt,s.buildNextAt].every(stamp) || ![s.remoteSha,s.targetSha,s.preparedSha,s.buildFailureSha].every(sha) || !count(s.checkFailures) || !count(s.buildFailures) || !(s.taskId === null || typeof s.taskId === 'string' && /^[a-f0-9-]{36}$/.test(s.taskId))) throw new Error('STATE_INVALID');
  if (['CHECKING','PREPARING','VERIFYING'].includes(s.status) && (!s.taskId || !s.startedAt) || s.status === 'READY' && (!s.preparedSha || !s.preparedAt) || s.buildFailures > 0 && !s.buildFailureSha) throw new Error('STATE_INVALID');
  return s;
}
export async function validateRoot(root) {
  if (typeof root !== 'string' || !isAbsolute(root) || root !== resolve(root) || /[\x00-\x1f]/.test(root)) throw new Error('INVALID_ROOT');
  const st=await lstat(root); const actual=await realpath(root);
  if (!st.isDirectory() || st.isSymbolicLink() || (process.platform==='win32' ? actual.toLowerCase()!==root.toLowerCase() : actual!==root || (st.mode&0o022)!==0 || ![0,process.getuid()].includes(st.uid))) throw new Error('INVALID_ROOT');
}
export async function updaterDirectory(root, create=false) {
  await validateRoot(root); const dir=join(root,'updater');
  if(create) try {await mkdir(dir,{mode:0o700});} catch(e) {if(e.code!=='EEXIST')throw e;}
  const st=await lstat(dir);
  const actual=await realpath(dir);
  if(!st.isDirectory() || st.isSymbolicLink() || (process.platform!=='win32' && (st.uid!==process.getuid() || (st.mode & 0o077)!==0)) || (process.platform==='win32'?actual.toLowerCase()!==dir.toLowerCase():actual!==dir)) throw new Error('UPDATER_DIRECTORY_UNSAFE');
  return dir;
}
export async function readState(dir) {
  const path=join(dir,'state.json'); let handle;
  try {
    const entry=await lstat(path);if(!entry.isFile() || entry.isSymbolicLink() || entry.nlink!==1)throw new Error('STATE_UNSAFE');
    handle=await open(path,constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const st=await handle.stat(); if(!st.isFile() || st.size>32768 || st.nlink!==1 || (process.platform!=='win32' && (st.uid!==process.getuid() || (st.mode&0o077)!==0))) throw new Error('STATE_UNSAFE');
    let s; try {s=JSON.parse(await handle.readFile('utf8'));} catch {throw new Error('STATE_INVALID');}
    return validateState(s);
  } catch(e) {if(e.code==='ENOENT')return initialState();throw e;} finally {await handle?.close();}
}
export async function writeState(dir,state) {
  validateState(state); const path=join(dir,'state.json'),tmp=join(dir,`.state-${randomUUID()}.tmp`); let file;
  // Refuse links even though rename itself does not follow the final component.
  try {const st=await lstat(path);if(!st.isFile() || st.isSymbolicLink() || st.nlink!==1)throw new Error('STATE_UNSAFE');}catch(e){if(e.code!=='ENOENT')throw e;}
  try {file=await open(tmp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW??0),0o600);await file.writeFile(JSON.stringify(state,null,2)+'\n');await file.sync();await file.close();file=null;await rename(tmp,path);if(process.platform!=='win32'){const d=await open(dir,constants.O_RDONLY);try{await d.sync();}finally{await d.close();}}}
  finally {await file?.close();try{await unlink(tmp);}catch(e){if(e.code!=='ENOENT')throw e;}}
}
