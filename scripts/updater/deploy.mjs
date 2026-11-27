import { createOutputTail } from './diagnostics.mjs';
import { runningEndpoints } from './running-port.mjs';
import { constants, createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, stat, statfs, symlink, unlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { inspectStagedArtifacts } from './prepare-core.mjs';
import { REPOSITORY } from './check.mjs';

const execute=promisify(execFile);
const commandEnv={PATH:'/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',LANG:'C',LC_ALL:'C',SYSTEMD_PAGER:'cat'};
const service='stardust.service';
const shaPattern=/^[a-f0-9]{40}$/;
const taskPattern=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const inside=(base,path)=>{const part=relative(base,path);return part!==''&&part!=='..'&&!part.startsWith('..'+sep)&&!isAbsolute(part);};
async function command(file,args,timeout=30000){
  try { return await execute(file,args,{env:commandEnv,timeout,maxBuffer:16384,windowsHide:true}); }
  catch(e) {
    const tail=createOutputTail(4096);tail.push(String(e.stderr??''));
    const safeArgs=args.map(arg=>isAbsolute(arg)?'<path>':String(arg).startsWith('-')?String(arg):'<arg>');
    e.diagnostic={command:[file,...safeArgs].join(' ').slice(0,512),exitCode:Number.isInteger(e.code)?e.code:null,signal:e.signal??null,stderr:tail.snapshot(commandEnv).text.replace(/(?:\/[^\s:]+)+/g,'<path>').slice(-2048)};
    throw e;
  }
}
async function directory(path,{mode=0o755,privateDir=false}={}){
  try{await mkdir(path,{mode});}catch(e){if(e.code!=='EEXIST')throw e;}
  const s=await lstat(path);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==0||(s.mode&(privateDir?0o077:0o022))!==0||(await realpath(path))!==path)throw new Error('UNSAFE_DIRECTORY');
}

// Reject links outside the release and hard links before root takes ownership.
async function inspectTree(root,owner){
  let count=0;const stack=[root];
  while(stack.length){const path=stack.pop();if(++count>300000)throw new Error('RELEASE_TOO_LARGE');const s=await lstat(path);
    if(s.uid!==owner)throw new Error('UNSAFE_RELEASE');
    if(s.isSymbolicLink()){const target=await readlink(path);if(isAbsolute(target))throw new Error('UNSAFE_RELEASE');const resolved=await realpath(path);if(!inside(root,resolved))throw new Error('UNSAFE_RELEASE');continue;}
    if(owner===0&&(s.mode&0o022)!==0)throw new Error('UNSAFE_RELEASE');
    if(s.isDirectory()){for(const name of await readdir(path))stack.push(join(path,name));continue;}
    if(!s.isFile()||s.nlink!==1)throw new Error('UNSAFE_RELEASE');
  }
}
async function noBuilderProcesses(uid){try{const r=await command('ps',['-u',String(uid),'-o','pid=']);if(r.stdout.trim())throw new Error('BUILD_STILL_RUNNING');}catch(e){if(e.code!==1)throw e;}}
async function stagedMetadata(source,sha,branch,status){
  const path=join(source,'.stardust-candidate.json'),f=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const s=await f.stat();if(!s.isFile()||s.nlink!==1||s.size>65536)throw new Error('INVALID_CANDIDATE');const text=await f.readFile('utf8');const data=JSON.parse(text);if(data.format!==1||data.status!==status||data.sha!==sha||data.branch!==branch||data.repository!==REPOSITORY)throw new Error('INVALID_CANDIDATE');return data;}finally{await f.close();}
}
export async function checkDeploymentContract(release){
  const file=join(release,'package.json'),entry=await lstat(file);
  if(!entry.isFile()||entry.isSymbolicLink()||entry.size>65536)throw new Error('INVALID_CANDIDATE');
  const pkg=JSON.parse(await readFile(file,'utf8')),required=pkg.stardustUpdaterContract??1;
  if(!Number.isSafeInteger(required)||required<1)throw new Error('INVALID_CANDIDATE');
  if(required>1)throw new Error('MIGRATION_REQUIRED');
}
async function publish(root,taskId,sha,branch,builder){
  const base=join(root,'releases'),source=join(root,'build-work',taskId,'source'),destination=join(base,sha);
  await directory(base);
  let existing;try{existing=await lstat(destination);}catch(e){if(e.code!=='ENOENT')throw e;}
  if(existing){try{if(!existing.isDirectory()||existing.isSymbolicLink()||existing.uid!==0||(await realpath(destination))!==destination)throw Error();await inspectTree(destination,0);await stagedMetadata(destination,sha,branch,'prepared');await inspectStagedArtifacts(destination);const head=join(destination,'.git','HEAD'),hs=await lstat(head);if(!hs.isFile()||hs.isSymbolicLink()||hs.size>128||(await readFile(head,'utf8')).trim()!==sha)throw Error();await checkDeploymentContract(destination);return destination;}catch(e){if(e.message==='MIGRATION_REQUIRED')throw e;throw new Error('CANDIDATE_CONFLICT');}}
  const src=await lstat(source);if(!src.isDirectory()||src.isSymbolicLink()||src.uid!==builder.uid||(await realpath(source))!==source)throw new Error('INVALID_CANDIDATE');
  await noBuilderProcesses(builder.uid);await stagedMetadata(source,sha,branch,'staged');await inspectStagedArtifacts(source);await inspectTree(source,builder.uid);
  if((await stat(source)).dev!==(await stat(base)).dev)throw new Error('RELEASE_FILESYSTEM_MISMATCH');
  await noBuilderProcesses(builder.uid);
  // GNU chown/chmod do not follow recursively encountered symlinks.
  await command('chown',['-hR','0:0','--',source],300000);await command('chmod',['-R','u+rwX,go+rX,go-w','--',source],300000);
  await inspectTree(source,0);await inspectStagedArtifacts(source);
  const meta=await stagedMetadata(source,sha,branch,'staged');meta.status='prepared';
  await writeFile(join(source,'.stardust-candidate.json'),JSON.stringify(meta,null,2)+'\n',{mode:0o644});
  await command('mv',['--no-clobber','--no-target-directory','--',source,destination],300000);
  try{await lstat(source);throw new Error('CANDIDATE_CONFLICT');}catch(e){if(e.code!=='ENOENT')throw e;}
  await inspectStagedArtifacts(destination);await checkDeploymentContract(destination);return destination;
}
async function currentRelease(root){
  const current=join(root,'current'),s=await lstat(current);if(!s.isSymbolicLink())throw new Error('CURRENT_INVALID');
  const target=resolve(root,await readlink(current)),sha=target.slice(join(root,'releases').length+1);
  if(!shaPattern.test(sha)||target!==join(root,'releases',sha))throw new Error('CURRENT_INVALID');
  const item=await lstat(target);if(!item.isDirectory()||item.isSymbolicLink()||(await realpath(target))!==target)throw new Error('CURRENT_INVALID');return sha;
}
async function serviceProperties(){const {stdout}=await command('systemctl',['show',service,'--property=LoadState,ActiveState,SubState,User,WorkingDirectory,Environment,EnvironmentFiles,ExecStart,ControlGroup,KillMode,Delegate']);return Object.fromEntries(stdout.trim().split(/\r?\n/).filter(x=>x.includes('=')).map(x=>{const i=x.indexOf('=');return [x.slice(0,i),x.slice(i+1)];}));}
async function assertService(root,coreUser){
  const p=await serviceProperties(),node=await realpath(process.execPath);
  if(p.LoadState!=='loaded'||p.ActiveState!=='active'||p.SubState!=='running'||p.User!==coreUser||p.WorkingDirectory!==join(root,'current')||p.ControlGroup!==`/system.slice/${service}`||p.KillMode!=='control-group'||p.Delegate!=='no'||p.EnvironmentFiles||!p.Environment?.split(' ').includes(`STARDUST_STORAGE_ROOT=${join(root,'shared')}`)||!p.ExecStart?.includes(`argv[]=${node} --experimental-sqlite apps/server/dist/main.js ;`))throw new Error('SERVICE_CONFIGURATION_INVALID');
}
async function stopped(){
  const p=await serviceProperties();if(p.ActiveState!=='inactive'&&p.ActiveState!=='failed')throw new Error('SERVICE_STILL_RUNNING');
  if((await statfs('/sys/fs/cgroup')).type!==0x63677270)throw new Error('SERVICE_STOP_UNCONFIRMED');
  const slice='/sys/fs/cgroup/system.slice',st=await lstat(slice);if(!st.isDirectory()||st.isSymbolicLink())throw new Error('SERVICE_STOP_UNCONFIRMED');
  const dir=join(slice,service);try{const group=await lstat(dir);if(!group.isDirectory()||group.isSymbolicLink()||!/^populated 0$/m.test(await readFile(join(dir,'cgroup.events'),'utf8')))throw new Error('SERVICE_STILL_RUNNING');}catch(e){if(e.code!=='ENOENT')throw e;}
}
async function noDatabaseUsers(root){
  const data=join(root,'shared','data');try{const s=await lstat(data);if(!s.isDirectory()||s.isSymbolicLink()||(await realpath(data))!==data)throw new Error('DATABASE_UNSAFE');}catch(e){if(e.code==='ENOENT')return;throw e;}
  for(const name of ['conversations.sqlite','conversations.sqlite-wal','conversations.sqlite-shm']){
    const path=join(data,name);try{const s=await lstat(path);if(!s.isFile()||s.isSymbolicLink()||(await realpath(path))!==path)throw new Error('DATABASE_UNSAFE');}catch(e){if(e.code==='ENOENT')continue;throw e;}
    try{await command('fuser',[path]);throw new Error('DATABASE_IN_USE');}catch(e){if(e.code!==1||String(e.stderr??'').trim())throw e;}
  }
}
async function inspectShared(root){let count=0;const stack=[root];while(stack.length){const path=stack.pop();if(++count>300000)throw new Error('SHARED_INVALID');const s=await lstat(path);if(s.isSymbolicLink())throw new Error('SHARED_INVALID');if(s.isDirectory()){for(const name of await readdir(path))stack.push(join(path,name));}else if(!s.isFile()||s.nlink!==1)throw new Error('SHARED_INVALID');}}
async function checkFuser(dir,taskId){const path=join(dir,`.fuser-${taskId}`);let f,created=false;try{f=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);created=true;const result=await command('fuser',[path]);if(!result.stdout.trim().split(/\s+/).includes(String(process.pid)))throw new Error('FUSER_UNAVAILABLE');}finally{await f?.close();if(created)try{await unlink(path);}catch(e){if(e.code!=='ENOENT')throw e;}}}
async function digest(path){const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);return hash.digest('hex');}
async function backup(root,taskId,oldSha){
  const shared=join(root,'shared'),s=await lstat(shared);if(!s.isDirectory()||s.isSymbolicLink()||(await realpath(shared))!==shared)throw new Error('SHARED_INVALID');
  const dir=join(root,'backups');await directory(dir,{mode:0o700,privateDir:true});await inspectShared(shared);await checkFuser(dir,taskId);await noDatabaseUsers(root);
  const tmp=join(dir,`.${taskId}.tar.gz`),archive=join(dir,`${taskId}.tar.gz`),manifest=join(dir,`${taskId}.json`);
  const file=await open(tmp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);await file.close();
  await command('tar',['-czf',tmp,'-C',root,'--','shared'],3600000);await chmod(tmp,0o600);const saved=await open(tmp,constants.O_RDONLY|constants.O_NOFOLLOW);try{await saved.sync();}finally{await saved.close();}
  const info=await lstat(tmp);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size===0)throw new Error('BACKUP_INVALID');
  const checksum=await digest(tmp);const data={format:1,createdAt:new Date().toISOString(),version:oldSha,sqliteSchema:null,sha256:checksum,size:info.size};
  const record=await open(manifest,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{await record.writeFile(JSON.stringify(data,null,2)+'\n');await record.sync();}finally{await record.close();}
  await rename(tmp,archive);const d=await open(dir,constants.O_RDONLY);try{await d.sync();}finally{await d.close();}return archive;
}
async function switchCurrent(root,sha,taskId){const temporary=join(root,`.current-${taskId}`);await symlink(join('releases',sha),temporary);try{await rename(temporary,join(root,'current'));const d=await open(root,constants.O_RDONLY);try{await d.sync();}finally{await d.close();}}finally{try{await unlink(temporary);}catch(e){if(e.code!=='ENOENT')throw e;}}}
async function health(port,expectedSha){let diagnostic;const deadline=Date.now()+30000;while(Date.now()<deadline){try{const p=await serviceProperties();if(p.ActiveState!=='active')throw Error();for(const endpoint of port == null ? await runningEndpoints() : [{host:"127.0.0.1",port}]) {try{const response=await fetch(`http://${endpoint.host}:${endpoint.port}/api/health`,{signal:AbortSignal.timeout(2000),redirect:'error'});if(response.ok){let size=0;const chunks=[];for await(const chunk of response.body){size+=chunk.length;if(size>65536)throw Error();chunks.push(chunk);}const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(body?.status==='ok'&&body?.service==='Stardust'&&(!expectedSha||body.runningSha===expectedSha))return;}}catch{}}}catch(e){if(e?.diagnostic)diagnostic=e.diagnostic;}await new Promise(r=>setTimeout(r,1000));}const error=new Error('HEALTH_CHECK_FAILED');if(diagnostic)error.diagnostic=diagnostic;throw error;}

export async function inspectInstalled(root,target,branch,config){
  const sha=await currentRelease(root);if(sha!==target)return false;
  const release=join(root,'releases',sha);await inspectTree(release,0);await stagedMetadata(release,sha,branch,'prepared');await inspectStagedArtifacts(release);
  const head=join(release,'.git','HEAD'),s=await lstat(head);if(!s.isFile()||s.isSymbolicLink()||s.size>128||(await readFile(head,'utf8')).trim()!==sha)throw new Error('INVALID_CANDIDATE');
  await assertService(root,config.coreUser);await health(null,sha);return true;
}

export async function publishedCandidate(root,sha,branch) {
  if(!shaPattern.test(sha))throw new Error('INVALID_CANDIDATE');
  const release=join(root,'releases',sha);let entry;
  try{entry=await lstat(release);}catch(e){if(e.code==='ENOENT')return false;throw e;}
  if(!entry.isDirectory()||entry.isSymbolicLink()||entry.uid!==0||(await realpath(release))!==release)throw new Error('CANDIDATE_CONFLICT');
  await inspectTree(release,0);await stagedMetadata(release,sha,branch,'prepared');await inspectStagedArtifacts(release);
  const head=join(release,'.git','HEAD'),hs=await lstat(head);if(!hs.isFile()||hs.isSymbolicLink()||hs.size>128||(await readFile(head,'utf8')).trim()!==sha)throw new Error('CANDIDATE_CONFLICT');
  return true;
}

/** Only called by the coordinator after the supervised build has fully stopped. */
export async function publishStaged({root,state,branch,environment,onPhase,signal},adapter={}) {
  if(!shaPattern.test(state.targetSha??'')||!taskPattern.test(state.taskId??''))throw new Error('INVALID_TASK');
  try{if(signal?.aborted)throw new Error('CANCELLED');await onPhase('PUBLISH');await (adapter.publish??publish)(root,state.taskId,state.targetSha,branch,environment.builder);return {status:'prepared'};}
  catch(e){const allowed=['INVALID_CANDIDATE','CANDIDATE_CONFLICT','UNSAFE_DIRECTORY','UNSAFE_RELEASE','RELEASE_TOO_LARGE','RELEASE_FILESYSTEM_MISMATCH','BUILD_STILL_RUNNING','MIGRATION_REQUIRED','CANCELLED'];return {status:'failed',phase:'PUBLISH',reason:allowed.includes(e?.message)?e.message:e?.diagnostic?'COMMAND_FAILED':'UPDATE_FAILED',...(e?.diagnostic?{diagnostic:e.diagnostic}:{}),restored:false,switched:false};}
}

export async function deployStaged({root,state,branch,environment,onPhase,signal},adapter={}){
  if(!shaPattern.test(state.targetSha??'')||!taskPattern.test(state.taskId??''))throw new Error('INVALID_TASK');
  const ops={publish,currentRelease,assertService,stop:async()=>{await command('systemctl',['stop',service],60000);await stopped();},backup,switchCurrent,start:async()=>{await command('systemctl',['start',service],60000);},health,...adapter};
  let phase='PUBLISH',serviceStopped=false,switched=false;
  const step=async(name,fn)=>{phase=name;if(signal?.aborted)throw new Error('CANCELLED');await onPhase(name);return fn();};
  try {
    await step('PUBLISH',()=>ops.publish(root,state.taskId,state.targetSha,branch,environment.builder));
    const oldSha=await step('SERVICE_CHECK',async()=>{const value=await ops.currentRelease(root);await ops.assertService(root,environment.config.coreUser);return value;});
    await step('STOP',()=>ops.stop());serviceStopped=true;
    await step('BACKUP',()=>ops.backup(root,state.taskId,oldSha));
    await step('SWITCH',()=>{switched=true;return ops.switchCurrent(root,state.targetSha,state.taskId);});
    await step('START',()=>ops.start());await step('HEALTH',()=>ops.health(adapter.health ? (environment.config.healthPort??80) : null,state.targetSha));
    return {status:'updated',phase:'HEALTH'};
  } catch(e){
    let restored=false;if(serviceStopped&&!switched&&!signal?.aborted&&e?.message!=='LOCK_LOST'){try{await ops.start();await ops.health(adapter.health ? (environment.config.healthPort??80) : null);restored=true;}catch{}}
    const allowed=['INVALID_TASK','INVALID_CANDIDATE','CANDIDATE_CONFLICT','UNSAFE_DIRECTORY','UNSAFE_RELEASE','RELEASE_TOO_LARGE','RELEASE_FILESYSTEM_MISMATCH','BUILD_STILL_RUNNING','CURRENT_INVALID','SERVICE_CONFIGURATION_INVALID','SERVICE_STILL_RUNNING','SERVICE_STOP_UNCONFIRMED','DATABASE_IN_USE','DATABASE_UNSAFE','FUSER_UNAVAILABLE','SHARED_INVALID','BACKUP_INVALID','HEALTH_CHECK_FAILED','MIGRATION_REQUIRED','CANCELLED'];
    return {status:'failed',phase,reason:allowed.includes(e?.message)?e.message:e?.diagnostic?'COMMAND_FAILED':'UPDATE_FAILED',...(e?.diagnostic?{diagnostic:e.diagnostic}:{}),restored,switched};
  }
}
