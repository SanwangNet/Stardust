#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkRemote } from './check.mjs';
import { prepareCandidate } from './prepare-core.mjs';
import { acquireLock } from './lock.mjs';
import { updaterDirectory, readState, writeState } from './state.mjs';
import { checkBuildEnvironment, runSystemdBuild, checkDependencies } from './systemd-build.mjs';
import { deployStaged, publishStaged, inspectInstalled, publishedCandidate } from './deploy.mjs';

const delays=[60,120,300,600,1800];
const active=new Set(['CHECKING','PREPARING','VERIFYING']);
const nowIso=ms=>new Date(ms).toISOString();
const boundedDelay=n=>delays[Math.min(n-1,delays.length-1)]*1000;
const errorCode=e=>{const found=String(e?.message??'').match(/(?:^|:)(TIMEOUT|CANCELLED|CANDIDATE_CONFLICT|PREPARE_IN_PROGRESS|SHA_MISMATCH|ARTIFACT_INVALID|ROOT_BUILD_FORBIDDEN|STORAGE_OVERLAP|INVALID_ROOT|INVALID_BRANCH|TARGET_NOT_BRANCH_HEAD|REMOTE_CHECK_FAILED|INVALID_REMOTE_RESPONSE)(?=:|$)/);return found?.[1]??'FAILED';};
const stageCode=value=>String(value).toUpperCase().replace(/[^A-Z0-9_]/g,'_').slice(0,80);

/** Adapters are trusted in-process test seams, not CLI configuration. */
export async function executeUpdate({root,branch='main',sha,timeout=900000,force=false,prepareOnly=false,signal},adapter={}) {
  const storage=process.env.STARDUST_STORAGE_ROOT;
  if(storage!==undefined){if(!isAbsolute(storage))throw new Error('STORAGE_OVERLAP');const production=resolve(storage);for(const path of [join(root,'updater'),join(root,'releases')]){const a=relative(production,path),b=relative(path,production);const within=x=>x==='' || x!=='..' && !x.startsWith('..'+sep) && !isAbsolute(x);if(within(a)||within(b))throw new Error('STORAGE_OVERLAP');}}
  if(process.platform==='linux'&&!adapter.acquireLock){try{await checkDependencies();}catch(e){if(e.message!=='MISSING_DEPENDENCIES')throw e;return {result:'SUPERVISION_UNAVAILABLE',reason:'MISSING_DEPENDENCIES',missing:e.missing,installCommand:'sudo apt update && sudo apt install -y git nodejs npm systemd util-linux tar gzip psmisc coreutils procps passwd libc-bin'};}}
  const dir=await updaterDirectory(root,true), lock=await (adapter.acquireLock??acquireLock)(dir);
  const controller=new AbortController(); const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});lock.signal?.addEventListener('abort',abort,{once:true});
  let state,phase='CHECKING',persistenceFailed=false;
  const clock=adapter.now??Date.now;
  const save=async()=>{if(!lock.alive)throw new Error('LOCK_LOST');state.updatedAt=nowIso(clock());try{await (adapter.writeState??writeState)(dir,state);}catch(e){persistenceFailed=true;throw e;}};
  try {
    state=await readState(dir);
    if(active.has(state.status)) {state.interruptedPhase=state.phase??state.status;state.status='INTERRUPTED';state.lastResult='INTERRUPTED';await save();return {result:'MANUAL_INTERVENTION',state};}
    if(state.status==='INTERRUPTED')return {result:'MANUAL_INTERVENTION',state};
    // Bound dates after a backwards wall-clock adjustment; do not permit indefinite backoff.
    let clamped=false;for(const key of ['checkNextAt','buildNextAt'])if(state[key] && Date.parse(state[key])>clock()+1800000){state[key]=nowIso(clock()+1800000);clamped=true;}
    if(state.checkedAt && Date.parse(state.checkedAt)>clock()){state.checkedAt=nowIso(clock());clamped=true;}
    if(clamped)await save();
    if(!force && state.checkNextAt && Date.parse(state.checkNextAt)>clock())return {result:'BACKOFF',state};
    if(!force && state.buildNextAt && Date.parse(state.buildNextAt)>clock() && state.checkedAt && Date.parse(state.checkedAt)>clock()-60000 && Date.parse(state.checkedAt)<=clock())return {result:'BACKOFF',state};
    state.status='CHECKING';state.phase='REMOTE_CHECK';state.taskId=randomUUID();state.trigger=force?'MANUAL_FORCE':'MANUAL';state.startedAt=nowIso(clock());state.targetSha=null;state.interruptedPhase=null;await save();
    let remote;
    try {remote=await (adapter.checkRemote??checkRemote)(branch);if(!/^[a-f0-9]{40}$/.test(remote?.target))throw new Error('INVALID_REMOTE_RESPONSE');if(sha!==undefined && sha!==remote.target)throw new Error('TARGET_NOT_BRANCH_HEAD');}
    catch(e){state.status='FAILED';state.failureStage='REMOTE_CHECK';state.failureReason=errorCode(e);state.checkFailures=Math.min(1000,state.checkFailures+1);state.checkNextAt=nowIso(clock()+boundedDelay(state.checkFailures));state.lastResult='CHECK_FAILED';await save();return {result:'CHECK_FAILED',state};}
    state.checkedAt=nowIso(clock());state.remoteSha=remote.target;state.targetSha=remote.target;state.checkFailures=0;state.checkNextAt=null;
    if(state.buildFailureSha && state.buildFailureSha!==remote.target){state.buildFailures=0;state.buildFailureSha=null;state.buildNextAt=null;}
    if(!force && state.buildNextAt && Date.parse(state.buildNextAt)>clock()){state.status='IDLE';state.phase=null;state.lastResult='BACKOFF';await save();return {result:'BACKOFF',state};}
    if(!adapter.processTreeSupervised){
      let environment;try{environment=await (adapter.checkBuildEnvironment??checkBuildEnvironment)(root,dir);}catch(e){state.status='FAILED';state.phase=null;state.failureStage='PROCESS_SUPERVISION';state.failureReason=e.message==='MISSING_DEPENDENCIES'?'MISSING_DEPENDENCIES':'SUPERVISION_UNAVAILABLE';state.lastResult='SUPERVISION_UNAVAILABLE';await save();return {result:'SUPERVISION_UNAVAILABLE',state,...(e.message==='MISSING_DEPENDENCIES'?{missing:e.missing,installCommand:'sudo apt update && sudo apt install -y git nodejs npm systemd util-linux tar gzip psmisc coreutils procps passwd libc-bin'}:{})};}
      if(!prepareOnly){try{if(await (adapter.inspectInstalled??inspectInstalled)(root,remote.target,branch,environment.config)){state.status='IDLE';state.phase=null;state.failureStage=null;state.failureReason=null;state.lastResult='UP_TO_DATE';await save();return {result:'UP_TO_DATE',state};}}catch{state.status='FAILED';state.phase=null;state.failureStage='INSTALLATION_CHECK';state.failureReason='INSTALLATION_UNHEALTHY';state.lastResult='INSTALLATION_UNHEALTHY';await save();return {result:'INSTALLATION_UNHEALTHY',state};}}
      if(controller.signal.aborted){state.status='INTERRUPTED';state.interruptedPhase=state.phase;state.lastResult='INTERRUPTED';await save();return {result:'MANUAL_INTERVENTION',state};}
      state.status='PREPARING';state.phase='SYSTEMD_START';await save();
      try {
        const reused=await (adapter.publishedCandidate??publishedCandidate)(root,remote.target,branch);
        const result=reused ? {status:'staged'} : await (adapter.runSystemdBuild??runSystemdBuild)({root,dir,state,branch,timeout,signal:controller.signal,environment,onPhase:async value=>{phase=value;state.phase=value;await save();}});
        if(!lock.alive||controller.signal.aborted)throw new Error('MANUAL_INTERVENTION');
        if(result.status==='failed'){state.status='FAILED';state.failureStage=result.phase;state.failureReason=result.reason;state.buildFailures=Math.min(1000,state.buildFailures+1);state.buildFailureSha=remote.target;state.buildNextAt=nowIso(clock()+boundedDelay(state.buildFailures));state.lastResult='PREPARE_FAILED';await save();return {result:'PREPARE_FAILED',state};}
        state.buildFailures=0;state.buildFailureSha=null;state.buildNextAt=null;
        const deployInput={root,state,branch,environment,signal:controller.signal,onPhase:async value=>{phase=value;state.phase=value;await save();}};
        const deployed=await (prepareOnly?(adapter.publishStaged??publishStaged)(deployInput):(adapter.deployStaged??deployStaged)(deployInput));
        if(persistenceFailed||!lock.alive)throw new Error('LOCK_LOST');
        if(deployed.status!=='updated'&&deployed.status!=='prepared'){state.status='FAILED';state.failureStage=deployed.phase;state.failureReason=deployed.reason;state.lastResult=deployed.switched?'UPDATE_FAILED_SWITCHED':deployed.restored?'UPDATE_FAILED_RESTORED':'UPDATE_FAILED';await save();let diagnosticPath,diagnosticWriteError;if(deployed.diagnostic){try{diagnosticPath=join(dir,`failure-${state.taskId}.json`);const f=await open(diagnosticPath,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW??0),0o600);try{await f.writeFile(JSON.stringify({phase:deployed.phase,...deployed.diagnostic},null,2)+'\n');await f.sync();}finally{await f.close();}}catch{diagnosticPath=undefined;diagnosticWriteError='DIAGNOSTIC_WRITE_FAILED';}}return {result:'UPDATE_FAILED',state,restored:deployed.restored,switched:deployed.switched,...(deployed.diagnostic?{diagnostic:deployed.diagnostic,...(diagnosticPath?{diagnosticPath}:{}),...(diagnosticWriteError?{diagnosticWriteError}:{})}:{})};}
        state.status='READY';state.phase=null;state.preparedSha=remote.target;state.preparedAt=nowIso(clock());state.failureStage=null;state.failureReason=null;state.lastResult=prepareOnly?'PREPARED':'UPDATED';await save();return {result:state.lastResult,state};
      }catch(e){if(persistenceFailed||!lock.alive)throw e;state.interruptedPhase=state.phase;state.status='INTERRUPTED';state.failureStage=state.phase;state.failureReason='MANUAL_INTERVENTION';state.lastResult='INTERRUPTED';await save();return {result:'MANUAL_INTERVENTION',state};}
    }
    state.status='PREPARING';state.phase='SOURCE_FETCH';await save();
    const log=async event=>{if(event.event!=='start')return;phase=stageCode(event.stage);state.phase=phase;state.status=['ARTIFACTS','VERIFY_FINAL_SHA','VERIFY_SOURCES','NPM_VERSION','PUBLISH'].includes(phase)?'VERIFYING':'PREPARING';await save();};
    try {
      const result=await (adapter.prepareCandidate??prepareCandidate)({root,branch,sha:remote.target,timeout,signal:controller.signal},{...adapter.prepareAdapter,remote:()=>({target:remote.target}),log});
      if(!lock.alive || controller.signal.aborted)throw new Error('CANCELLED');
      state.status='READY';state.phase=null;state.preparedSha=result.sha;state.preparedAt=nowIso(clock());state.buildFailures=0;state.buildFailureSha=null;state.buildNextAt=null;state.failureStage=null;state.failureReason=null;state.lastResult=result.status==='already_prepared'?'ALREADY_PREPARED':'PREPARED';await save();return {result:state.lastResult,state};
    } catch(e) {
      if(persistenceFailed || !lock.alive)throw e;
      state.status='FAILED';state.failureStage=phase;state.failureReason=errorCode(e);state.buildFailures=Math.min(1000,state.buildFailures+1);state.buildFailureSha=remote.target;state.buildNextAt=nowIso(clock()+boundedDelay(state.buildFailures));state.lastResult='PREPARE_FAILED';await save();return {result:'PREPARE_FAILED',state};
    }
  } finally {signal?.removeEventListener('abort',abort);lock.signal?.removeEventListener('abort',abort);await lock.release();}
}

export async function main(args,{legacyPrepare=false}={}) {
  const controller=new AbortController();const abort=()=>controller.abort();process.once('SIGINT',abort);process.once('SIGTERM',abort);
  try {
    const [root,branch='main',...rest]=args;let force=false,sha,timeout=900000;
    if(legacyPrepare){if(rest.length>2)throw new Error('USAGE');[sha]=rest;if(rest[1]!==undefined)timeout=Number(rest[1]);}
    else {if(rest.length>1 || rest.length===1 && rest[0]!=='--force')throw new Error('USAGE');force=rest[0]==='--force';}
    if(!root)throw new Error('USAGE');
    const output=await executeUpdate({root,branch,sha,timeout,force,prepareOnly:legacyPrepare,signal:controller.signal});console.log(JSON.stringify(output,null,2));
    process.exitCode=({PREPARED:0,ALREADY_PREPARED:0,UPDATED:0,UP_TO_DATE:0,BACKOFF:10,MANUAL_INTERVENTION:23,CHECK_FAILED:20,PREPARE_FAILED:21,UPDATE_FAILED:21,INSTALLATION_UNHEALTHY:21,SUPERVISION_UNAVAILABLE:24})[output.result]??22;
  } catch(e){const known=['LOCK_BUSY','USAGE','STATE_INVALID','STATE_UNSAFE','STATE_VERSION_UNSUPPORTED','UPDATER_DIRECTORY_UNSAFE','LOCK_FILE_UNSAFE','LOCK_LOST','LOCK_HELPER_FAILED','LOCK_HELPER_TIMEOUT','LINUX_FLOCK_REQUIRED','INVALID_ROOT','STORAGE_OVERLAP'];const message=['EACCES','EPERM'].includes(e?.code)?'PERMISSION_DENIED':known.includes(e?.message)?e.message:'UPDATER_ERROR';console.error(message);process.exitCode=message==='LOCK_BUSY'?11:22;}
  finally{process.removeListener('SIGINT',abort);process.removeListener('SIGTERM',abort);}
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href)await main(process.argv.slice(2));
