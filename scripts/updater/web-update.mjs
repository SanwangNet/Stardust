import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { executeUpdate } from './update.mjs';
import { readState } from './state.mjs';
import { createOutputTail } from './diagnostics.mjs';
import { checkRemote } from './check.mjs';

const sha=v=>typeof v==='string'&&/^[a-f0-9]{40}$/.test(v)?v:null;
const code=v=>typeof v==='string'&&/^[A-Z0-9_:.-]{1,160}$/.test(v)?v:null;
export function publicState(state, job, running=true) {
  return {format:1,jobId:job,running,status:code(state?.status),phase:code(state?.phase),targetSha:sha(state?.targetSha),result:code(state?.lastResult),failureStage:code(state?.failureStage),failureReason:code(state?.failureReason),detail:null,updatedAt:Date.now()};
}
async function save(dir,jobId,state){
  const tmp=join(dir,`.${jobId}.tmp`),path=join(dir,'status.json');let f;
  try{f=await open(tmp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o640);await f.writeFile(JSON.stringify(state));await f.sync();await f.close();f=null;await rename(tmp,path);}finally{await f?.close();try{await unlink(tmp);}catch(e){if(e.code!=='ENOENT')throw e;}}
}
export async function compatibleTarget(fetcher=fetch,remote=checkRemote){
  const target=remote('main').target;
  if(!sha(target))throw new Error('INVALID_REMOTE_RESPONSE');
  let response;try{response=await fetcher(`https://raw.githubusercontent.com/SanwangNet/Stardust/${target}/package.json`,{redirect:'error',signal:AbortSignal.timeout(10000)});}catch{throw new Error('MIGRATION_CHECK_FAILED');}
  if(!response.ok||!response.body)throw new Error('MIGRATION_CHECK_FAILED');
  let size=0;const chunks=[];
  for await(const chunk of response.body){size+=chunk.length;if(size>65536)throw new Error('MIGRATION_CHECK_FAILED');chunks.push(chunk);}
  let pkg;try{pkg=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new Error('MIGRATION_CHECK_FAILED');}
  if(!pkg||typeof pkg!=='object'||Array.isArray(pkg))throw new Error('MIGRATION_CHECK_FAILED');
  const required=pkg.stardustUpdaterContract??1;
  if(!Number.isSafeInteger(required)||required<1)throw new Error('MIGRATION_CHECK_FAILED');
  if(required>1)throw new Error('MIGRATION_REQUIRED');
  return target;
}

/** Injected arguments are for in-process tests; the service always uses these fixed defaults. */
export async function runWebUpdate({root='/opt/stardust',dir='/run/stardust-web-update',runUpdate=executeUpdate,read=readState,pollMs=500,compatibility=compatibleTarget}={}){
  const jobId=randomUUID();await save(dir,jobId,publicState({status:'CHECKING',phase:'REMOTE_CHECK'},jobId));
  let updating=false,baselineTask,baselineReadable=false;
  try{baselineTask=(await read(join(root,'updater'))).taskId;baselineReadable=true;}catch{}
  const poll=async()=>{if(updating)return;updating=true;try{const state=await read(join(root,'updater'));if(baselineReadable && state.taskId && state.taskId!==baselineTask)await save(dir,jobId,publicState(state,jobId));}catch{}finally{updating=false;}};
  const timer=setInterval(()=>void poll(),pollMs);timer.unref();
  try{
    const target=await compatibility();
    const result=await runUpdate({root,branch:'main',sha:target});clearInterval(timer);while(updating)await new Promise(r=>setTimeout(r,20));
    const state=result.state??{},out={...publicState(state,jobId,false),result:code(result.result)??'UPDATE_FAILED',failureReason:result.result==='BACKOFF'?'BACKOFF':code(state.failureReason)??code(result.reason)};
    if(typeof result.diagnostic?.stderr==='string'){const tail=createOutputTail(2048);tail.push(result.diagnostic.stderr);out.detail=tail.snapshot({}).text.replace(/(?:\/[^\s:]+)+/g,'<path>').slice(-500)||null;}
    await save(dir,jobId,out);return out;
  } catch(e){
    clearInterval(timer);while(updating)await new Promise(r=>setTimeout(r,20));const reason=['LOCK_BUSY','LOCK_LOST','STATE_INVALID','STATE_UNSAFE','MIGRATION_REQUIRED','MIGRATION_CHECK_FAILED','REMOTE_CHECK_FAILED','INVALID_REMOTE_RESPONSE'].includes(e?.message)?e.message:'UPDATER_UNAVAILABLE';
    const out={...publicState({},jobId,false),result:'UPDATE_FAILED',failureReason:reason};await save(dir,jobId,out);return out;
  }
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){const result=await runWebUpdate();if(!['UPDATED','UP_TO_DATE'].includes(result.result))process.exitCode=1;}
