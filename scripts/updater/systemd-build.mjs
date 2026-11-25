import { constants } from 'node:fs';
import { access, chown, lstat, mkdir, open, readFile, realpath, rename, statfs, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildUnitName, assessBuildEvidence } from './systemd-evidence.mjs';
import { preflight } from './preflight.mjs';
import { inspectStagedArtifacts } from './prepare-core.mjs';
import { REPOSITORY } from './check.mjs';

const exec=promisify(execFile), pathEnv='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const env={PATH:pathEnv,LANG:'C',LC_ALL:'C',SYSTEMD_PAGER:'cat'};
const command=async(file,args,timeout=10000)=>{const r=await exec(file,args,{env,timeout,maxBuffer:16384});return r.stdout.trim();};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const userPattern=/^[a-z_][a-z0-9_-]{0,31}$/;
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

async function trustedPath(path) {
  if(!isAbsolute(path)||path!==await realpath(path))throw new Error('SUPERVISION_UNAVAILABLE');
  let current=path;for(;;){const s=await lstat(current);if(s.isSymbolicLink()||s.uid!==0||(s.mode&0o022)!==0)throw new Error('SUPERVISION_UNAVAILABLE');const parent=dirname(current);if(parent===current)break;current=parent;}
}
async function executable(name) {
  for(const dir of pathEnv.split(':'))try{const path=await realpath(join(dir,name));await access(path,constants.X_OK);await trustedPath(path);return path;}catch{}
  throw new Error('SUPERVISION_UNAVAILABLE');
}
async function readSmall(path,owner,limit=4096) {
  const f=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const s=await f.stat();if(!s.isFile()||s.uid!==owner||s.nlink!==1||s.size>limit)throw new Error('UNSAFE_FILE');const b=Buffer.alloc(limit+1);const {bytesRead}=await f.read(b,0,b.length,0);if(bytesRead>limit)throw new Error('UNSAFE_FILE');return b.subarray(0,bytesRead).toString('utf8');}finally{await f.close();}
}
async function atomicIntent(dir,intent) {
  const path=join(dir,'intent.json'),tmp=join(dir,`.intent-${intent.taskId}.tmp`);let f;
  try{f=await open(tmp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);await f.writeFile(JSON.stringify(intent)+'\n');await f.sync();await f.close();f=null;await rename(tmp,path);const d=await open(dir,constants.O_RDONLY);try{await d.sync();}finally{await d.close();}}
  finally{await f?.close();try{await unlink(tmp);}catch(e){if(e.code!=='ENOENT')throw e;}}
}
async function account(name){const fields=(await command('getent',['passwd',name])).split(':');if(fields.length!==7||fields[0]!==name||!/^\d+$/.test(fields[2])||!/^\d+$/.test(fields[3]))throw new Error('SUPERVISION_UNAVAILABLE');return {uid:Number(fields[2]),gid:Number(fields[3]),shell:fields[6]};}
async function denyAccess(name,path){try{await command('runuser',['-u',name,'--','/usr/bin/test','-x',path]);return false;}catch(e){if(e.code===1)return true;throw e;}}

/** No unit is launched unless the root-owned configuration and runtime checks pass. */
export async function checkBuildEnvironment(root,dir) {
  try {
    if(process.platform!=='linux'||process.getuid?.()!==0||!/^\/[a-zA-Z0-9_./-]+$/.test(root))throw Error();
    const configPath=join(dir,'config.json'),s=await lstat(configPath);if(!s.isFile()||s.isSymbolicLink()||s.uid!==0||(s.mode&0o077)!==0)throw Error();
    const config=JSON.parse(await readSmall(configPath,0));if(!config||Object.keys(config).sort().join(',')!=='buildUser,coreUser'||!userPattern.test(config.buildUser??'')||!userPattern.test(config.coreUser??''))throw Error();
    const builder=await account(config.buildUser),core=await account(config.coreUser);if(!builder.uid||!core.uid||builder.uid===core.uid||!/(?:\/nologin|\/false)$/.test(builder.shell))throw Error();
    const codeDir=dirname(fileURLToPath(import.meta.url));if(!/^\/[a-zA-Z0-9_./-]+$/.test(codeDir)||!/^\/[a-zA-Z0-9_./-]+$/.test(await realpath(process.execPath)))throw Error();await trustedPath(codeDir);await trustedPath(await realpath(process.execPath));
    for(const name of ['build-worker.mjs','prepare.mjs','prepare-core.mjs','check.mjs','update.mjs','state.mjs','lock.mjs','preflight.mjs','systemd-build.mjs','systemd-evidence.mjs'])await trustedPath(join(codeDir,name));
    const tools={};for(const name of ['git','npm','systemctl','systemd-run','flock','runuser','node'])tools[name]=await executable(name);
    if(tools.node!==(await realpath(process.execPath)))throw Error();
    for(const name of ['node','git','npm'])await command('runuser',['-u',config.buildUser,'--','/usr/bin/test','-x',tools[name]]);
    for(const path of [root,codeDir])await command('runuser',['-u',config.buildUser,'--','/usr/bin/test','-x',path]);
    for(const path of [join(codeDir,'build-worker.mjs'),join(codeDir,'prepare-core.mjs'),join(codeDir,'check.mjs')])await command('runuser',['-u',config.buildUser,'--','/usr/bin/test','-r',path]);
    const base=join(root,'build-work');try{await mkdir(base,{mode:0o711});}catch(e){if(e.code!=='EEXIST')throw e;}const baseStat=await lstat(base);if(!baseStat.isDirectory()||baseStat.isSymbolicLink()||baseStat.uid!==0||(baseStat.mode&0o022)!==0||(await realpath(base))!==base)throw Error();
    await command('runuser',['-u',config.buildUser,'--','/usr/bin/test','-x',base]);
    const releases=join(root,'releases');try{const st=await lstat(releases);if(!st.isDirectory()||st.isSymbolicLink()||st.uid!==0||(st.mode&0o022)!==0||(await realpath(releases))!==releases)throw Error();}catch(e){if(e.code!=='ENOENT')throw e;}
    // The dedicated account may not already have independent processes.
    try{const p=await command('ps',['-u',String(builder.uid),'-o','pid=']);if(p.trim())throw Error();}catch(e){if(e.code!==1)throw e;}
    const protectedPaths=[join(root,'shared')];if(process.env.STARDUST_STORAGE_ROOT){if(!isAbsolute(process.env.STARDUST_STORAGE_ROOT))throw Error();protectedPaths.push(resolve(process.env.STARDUST_STORAGE_ROOT));}
    for(const path of new Set(protectedPaths)){if(!/^\/[a-zA-Z0-9_./-]+$/.test(path))throw Error();try{const st=await lstat(path);if(!st.isDirectory()||st.isSymbolicLink()||(await realpath(path))!==path||!await denyAccess(config.buildUser,path))throw Error();}catch(e){if(e.code!=='ENOENT')throw e;}}
    const probe=await preflight({root,buildUser:config.buildUser,runUser:config.coreUser,active:true});if(probe.active.result!=='passed')throw Error();
    return {config,builder,codeDir,protectedPaths};
  } catch {throw new Error('SUPERVISION_UNAVAILABLE');}
}

async function properties(unit){const out=await command('systemctl',['show',unit,'--property=LoadState,ActiveState,SubState,InvocationID,Result,ExecMainCode,ExecMainStatus,Type,ExitType,KillMode,SendSIGKILL,Delegate,Restart,NoNewPrivileges,ProtectControlGroups,RemainAfterExit,User']);return Object.fromEntries(out.split(/\r?\n/).filter(x=>x.includes('=')).map(x=>{const i=x.indexOf('=');return [x.slice(0,i),x.slice(i+1)];}));}
async function cgroupState(unit){try{if((await statfs('/sys/fs/cgroup')).type!==0x63677270)return 'unknown';const slice=await lstat('/sys/fs/cgroup/system.slice');if(!slice.isDirectory()||slice.isSymbolicLink())return 'unknown';const group=`/sys/fs/cgroup/system.slice/${unit}`;try{const st=await lstat(group);if(!st.isDirectory()||st.isSymbolicLink())return 'unknown';}catch(e){return e.code==='ENOENT'?'destroyed':'unknown';}const value=await readFile(`${group}/cgroup.events`,'utf8');if(/^populated 1$/m.test(value))return 'populated';if(/^populated 0$/m.test(value))return 'empty';return 'unknown';}catch{return 'unknown';}}

/** Caller holds the deployment lock and has already persisted PREPARING. */
export async function runSystemdBuild({root,dir,state,branch,timeout,signal,onPhase,environment}) {
  const {taskId,targetSha}=state;if(!uuid.test(taskId??'')||!/^[a-f0-9]{40}$/.test(targetSha??''))throw new Error('MANUAL_INTERVENTION');
  const unit=buildUnitName(root,taskId),bootId=(await readFile('/proc/sys/kernel/random/boot_id','utf8')).trim();if(!uuid.test(bootId))throw new Error('MANUAL_INTERVENTION');
  const base=join(root,'build-work');try{await mkdir(base,{mode:0o711});}catch(e){if(e.code!=='EEXIST')throw e;}const baseStat=await lstat(base);if(!baseStat.isDirectory()||baseStat.isSymbolicLink()||baseStat.uid!==0||(baseStat.mode&0o022)!==0||(await realpath(base))!==base)throw new Error('MANUAL_INTERVENTION');
  const taskDir=join(base,taskId);await mkdir(taskDir,{mode:0o700});await chown(taskDir,environment.builder.uid,environment.builder.gid);
  let intent={format:1,taskId,sha:targetSha,branch,unit,bootId,staging:`build-work/${taskId}`,invocationId:null};await atomicIntent(dir,intent);
  const worker=join(environment.codeDir,'build-worker.mjs');const denied=['-/run/dbus/system_bus_socket','-/run/systemd/private','-/run/user',...environment.protectedPaths.map(p=>`-${p}`)].join(' ');
  const unitProperties=['Type=exec','ExitType=cgroup','KillMode=control-group','RuntimeMaxSec=5400','TimeoutStopSec=10','SendSIGKILL=yes','Delegate=no','Restart=no','NoNewPrivileges=yes','ProtectControlGroups=yes','ProtectHome=yes','PrivateTmp=yes','CapabilityBoundingSet=',`User=${environment.config.buildUser}`,`InaccessiblePaths=${denied}`,`ReadOnlyPaths=-${join(root,'releases')}`];
  const workerPath=pathEnv;
  // The marker is durable before any call that can create the unit. Failure after
  // this point leaves PREPARING and requires manual intervention.
  await command('systemd-run',[`--unit=${unit}`,'--slice=system.slice','--expand-environment=no','--remain-after-exit',...unitProperties.map(p=>`--property=${p}`),'--setenv=PATH='+workerPath,'--',await realpath(process.execPath),worker,root,taskId,targetSha,branch,unit,String(timeout)],20000);
  let p=await propertiesForStart(unit,environment.config.buildUser);intent={...intent,invocationId:p.InvocationID};await atomicIntent(dir,intent);
  const expected={root,taskId,bootId,invocationId:p.InvocationID};let lastPhase='';const deadline=performance.now()+5500000;
  for(;;){
    if(signal?.aborted||performance.now()>deadline)throw new Error('MANUAL_INTERVENTION');
    p=await propertiesForStart(unit,environment.config.buildUser);const currentBoot=(await readFile('/proc/sys/kernel/random/boot_id','utf8')).trim();
    let phase;try{phase=(await readSmall(join(taskDir,'progress'),environment.builder.uid,128)).trim();}catch(e){if(e.code!=='ENOENT')throw e;}
    if(phase&&/^[A-Z_]{1,80}$/.test(phase)&&phase!==lastPhase){lastPhase=phase;await onPhase(phase);}
    const observation={unit,bootId:currentBoot,invocationId:p.InvocationID,cgroupPath:`/system.slice/${unit}`,activeState:p.ActiveState,subState:p.SubState,cgroupState:await cgroupState(unit),result:p.Result,mainCode:p.ExecMainCode==='exited'?1:/^\d+$/.test(p.ExecMainCode??'')?Number(p.ExecMainCode):null,mainStatus:/^\d+$/.test(p.ExecMainStatus??'')?Number(p.ExecMainStatus):null};
    const verdict=assessBuildEvidence(expected,observation);if(verdict.status==='running'){await sleep(1000);continue;}if(verdict.status==='uncertain')throw new Error('MANUAL_INTERVENTION');if(verdict.status==='failed')return {status:'failed',phase:lastPhase||'BUILD',reason:'UNIT_FAILED'};
    const result=JSON.parse(await readSmall(join(taskDir,'result.json'),environment.builder.uid));
    if(result.format!==1||result.taskId!==taskId||result.sha!==targetSha||result.status!=='staged'||result.invocationId!==intent.invocationId)throw new Error('MANUAL_INTERVENTION');
    const source=join(taskDir,'source'),sourceStat=await lstat(source);if(!sourceStat.isDirectory()||sourceStat.isSymbolicLink()||sourceStat.uid!==environment.builder.uid||(await realpath(source))!==source)throw new Error('MANUAL_INTERVENTION');
    const metadata=JSON.parse(await readSmall(join(source,'.stardust-candidate.json'),environment.builder.uid,65536));if(metadata.format!==1||metadata.status!=='staged'||metadata.sha!==targetSha||metadata.branch!==branch||metadata.repository!==REPOSITORY)throw new Error('MANUAL_INTERVENTION');
    await inspectStagedArtifacts(source);
    return {status:'staged',phase:lastPhase||'ARTIFACTS',unit};
  }
}
async function propertiesForStart(unit,user){const p=await properties(unit);if(p.LoadState!=='loaded'||!/^[a-f0-9]{32}$/.test(p.InvocationID??'')||p.Type!=='exec'||p.ExitType!=='cgroup'||p.KillMode!=='control-group'||p.SendSIGKILL!=='yes'||p.Delegate!=='no'||p.Restart!=='no'||p.NoNewPrivileges!=='yes'||p.ProtectControlGroups!=='yes'||p.RemainAfterExit!=='yes'||p.User!==user)throw new Error('MANUAL_INTERVENTION');return p;}
