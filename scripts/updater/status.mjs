#!/usr/bin/env node
import { runningEndpoints } from './running-port.mjs';
import { constants } from 'node:fs';
import { lstat, open, readlink } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { initialState, readState, updaterDirectory, validateRoot } from './state.mjs';
import { observeLock } from './lock.mjs';
import { buildUnitName } from './systemd-evidence.mjs';

export async function observeCurrent(root) {
  const path=join(root,'current');
  try {
    const st=await lstat(path);if(!st.isSymbolicLink())return {status:'unexpected_type',sha:null};
    const target=await readlink(path);const absolute=isAbsolute(target)?resolve(target):resolve(root,target);
    const match=/^[a-f0-9]{40}$/.exec(absolute.slice(join(root,'releases').length+1));
    if(!match || absolute!==join(root,'releases',match[0]))return {status:'unexpected_target',sha:null};
    try {const targetStat=await lstat(absolute);return {status:targetStat.isDirectory()&&!targetStat.isSymbolicLink()?'points_to_release':'invalid_release',sha:match[0]};}catch(e){if(e.code==='ENOENT')return {status:'missing_release',sha:match[0]};throw e;}
  } catch(e){if(e.code==='ENOENT')return {status:'missing',sha:null};throw e;}
}
async function observeRunning(dir){
  let file;try{
    file=await open(join(dir,'config.json'),constants.O_RDONLY|(constants.O_NOFOLLOW??0));const s=await file.stat();
    if(!s.isFile()||s.nlink!==1||s.size>4096||(process.platform!=='win32'&&(s.uid!==process.getuid()||(s.mode&0o077)!==0)))return 'unknown';
    const config=JSON.parse(await file.readFile('utf8'));let ports;try{ports=await runningEndpoints();}catch{ports=Number.isInteger(config.healthPort)&&config.healthPort>0&&config.healthPort<=65535?[{host:"127.0.0.1",port:config.healthPort}]:[];}
    for(const endpoint of ports){try{const response=await fetch(`http://${endpoint.host}:${endpoint.port}/api/health`,{signal:AbortSignal.timeout(1500),redirect:'error'});if(!response.ok)continue;
    let size=0;const chunks=[];for await(const chunk of response.body){size+=chunk.length;if(size>65536)return 'unknown';chunks.push(chunk);}
    const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(body?.status==='ok'&&body?.service==='Stardust'&&/^[a-f0-9]{40}$/.test(body.runningSha??''))return body.runningSha;}catch{}}return 'unknown';
  }catch{return 'unknown';}finally{await file?.close();}
}
export async function getStatus(root) {
  await validateRoot(root);let state,lock,intent=null,runningSha='unknown';
  try {const dir=await updaterDirectory(root);state=await readState(dir);lock=await observeLock(dir);
    let f;try{const path=join(dir,'intent.json'),entry=await lstat(path);if(!entry.isFile()||entry.isSymbolicLink())throw new Error('INTENT_INVALID');f=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));const st=await f.stat();if(!st.isFile()||st.size>4096||st.nlink!==1||(process.platform!=='win32'&&(st.uid!==process.getuid()||(st.mode&0o077)!==0)))throw new Error('INTENT_INVALID');const v=JSON.parse(await f.readFile('utf8'));if(v.format!==1||v.taskId!==state.taskId||v.unit!==buildUnitName(root,v.taskId)||v.staging!==`build-work/${v.taskId}`||v.sha!==state.targetSha||!/^([a-f0-9-]{36})$/.test(v.bootId??'')||!(v.invocationId===null||/^[a-f0-9]{32}$/.test(v.invocationId)))throw new Error('INTENT_INVALID');intent={unit:v.unit,staging:v.staging,bootId:v.bootId,invocationId:v.invocationId};}catch(e){if(e.code!=='ENOENT')intent={error:'INTENT_UNAVAILABLE_OR_INVALID'};}finally{await f?.close();}
    runningSha=await observeRunning(dir);
  }catch(e){if(e.code!=='ENOENT')throw e;state=initialState();lock='not_held';}
  return {state,observation:{lock,intent,current:await observeCurrent(root),runningSha,possibleInterruption:state.status==='INTERRUPTED'||(['CHECKING','PREPARING','VERIFYING'].includes(state.status)&&lock!=='held')}};
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){try{if(process.argv.length!==3)throw new Error('USAGE');console.log(JSON.stringify(await getStatus(process.argv[2]),null,2));}catch(e){console.error(e?.message==='USAGE'?'USAGE':'STATUS_ERROR');process.exitCode=22;}}
