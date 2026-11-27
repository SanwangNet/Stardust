import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, chown, lstat, mkdir, mkdtemp, readdir, readlink, realpath, rename, rm, rmdir, symlink, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { networkInterfaces } from 'node:os';
import { promisify } from 'node:util';
import { archiveLimit, atomicJson, capture, digest, digestPattern, idPattern, missing, openFile, readJson, releases, shaPattern, syncDirectory, version } from './files.mjs';
import { runningEndpoints } from './running-port.mjs';

const systemRoot='/opt/stardust', command=promisify(execFile), service='stardust.service';
const helper=fileURLToPath(new URL('./archive.py',import.meta.url));
const python=(...args)=>command('/usr/bin/python3',['-I',helper,...args],{timeout:3600000});
const systemctl=(...args)=>command('/usr/bin/systemctl',[...args,service],{timeout:90000,env:{PATH:'/usr/bin:/bin',LANG:'C'}});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const absent=error=>{if(!missing(error))throw error;return null;};
export function parseSystemdProperties(stdout){
  return Object.fromEntries(stdout.trim().split(/\r?\n/).map(line=>{const i=line.indexOf('=');return [line.slice(0,i),line.slice(i+1)];}));
}
export function validateRequest(value){
  if(!value||typeof value.id!=='string'||!idPattern.test(value.id)||!['check','update','backup','restore','rollback','upload','delete'].includes(value.operation))throw Error('INVALID_REQUEST');
  const key={update:'target',rollback:'target',restore:'backup',delete:'backup'}[value.operation];
  if(Object.keys(value).sort().join(',')!==['id','operation',...(key?[key]:[])].sort().join(',') ||
    (key==='target'&&(typeof value[key]!=='string'||!shaPattern.test(value[key]))) || (key==='backup'&&(typeof value[key]!=='string'||!idPattern.test(value[key]))))throw Error('INVALID_REQUEST');
  return {id:value.id,operation:value.operation,...(key?{[key]:value[key]}:{})};
}
export function canRollback(current,target){return !!current?.dataFormat&&current.dataFormat===target?.dataFormat;}
function backupMetadata(value,id){
  if(!value||![1,2].includes(value.format)||!shaPattern.test(value.version)||!Number.isFinite(Date.parse(value.createdAt)))throw Error('INVALID_BACKUP_METADATA');
  if(value.format===2&&(!Number.isSafeInteger(value.dataFormat)||value.dataFormat<1))throw Error('INVALID_BACKUP_METADATA');
  return {id,version:value.version,createdAt:new Date(value.createdAt).toISOString(),dataFormat:value.format===2?value.dataFormat:null,sequence:Number.isSafeInteger(value.sequence)&&value.sequence>0?value.sequence:null};
}
export async function directory(path,owner=0,groupWritable=false){
  const stat=await lstat(path);
  if(!stat.isDirectory()||stat.uid!==owner||(stat.mode&(groupWritable?0o002:0o022))||await realpath(path)!==path)throw Error('UNSAFE_DIRECTORY');
  return stat;
}
export function retainedVersions(versions,current,retain){
  return versions.filter(v=>v.sha!==current).sort((a,b)=>b.sequence-a.sequence).slice(retain-1);
}
export async function lifecycle({root=systemRoot,config,remote=releases(config.token),control=systemctl,extract=python,verifyHealth}){
  const releasesDir=join(root,'releases'), backupsDir=join(root,'backups'), shared=join(root,'shared');
  const management=join(root,'management'),inbox=join(management,'inbox'),privateDir=join(management,'private');
  const statusPath=join(management,'status.json');
  const gid=config.gid, uid=config.uid;
  const bootId=await openFile('/proc/sys/kernel/random/boot_id',128).then(async file=>{try{return (await file.readFile('utf8')).trim();}finally{await file.close();}}).catch(()=>null);
  let status={format:1,job:null,lastDeployment:null,latest:null,versions:[],backups:[]};
  const previous=await readJson(statusPath,512*1024,0).catch(absent);
  if(previous?.format===1)status=previous;
  const persist=()=>atomicJson(statusPath,status,0o640,gid);
  async function installed(sha){
    if(!shaPattern.test(sha))throw Error('INVALID_VERSION');
    const path=join(releasesDir,sha);
    await directory(path);
    const meta=await readJson(join(path,'version.json'),4096,0).catch(absent);
    if(meta){const release=version(meta);if(release.sha!==sha)throw Error('INVALID_VERSION');return release;}
    const legacy=await readJson(join(path,'.stardust-candidate.json'),65536,0);
    if(legacy.sha!==sha||legacy.status!=='prepared')throw Error('INVALID_VERSION');
    return {sha,version:'旧版',dataFormat:null,sequence:0};
  }
  async function current(){
    const pointer=await readlink(join(root,'current')).catch(absent);
    if(pointer===null)return null;
    const match=/^releases\/([a-f0-9]{40})$/.exec(pointer);
    if(!match)throw Error('INVALID_CURRENT');
    return installed(match[1]);
  }
  async function inventory(active){
    const entries=await readdir(releasesDir);
    const versions=[];
    for(const sha of entries.filter(x=>shaPattern.test(x))){
      try{const value=await installed(sha);versions.push({...value,rollback:canRollback(active,value)});}catch{/* Unrecognized local directories stay untouched. */}
    }
    const backups=[];
    for(const name of (await readdir(backupsDir)).filter(x=>x.endsWith('.tar.gz'))){
      const id=name.slice(0,-7);if(!idPattern.test(id))continue;
      try{
        const f=await openFile(join(backupsDir,name),archiveLimit,0);const info=await f.stat();await f.close();
        const meta=await readJson(join(backupsDir,id+'.json'),32768,0).catch(absent);
        let entry={id,size:info.size,kind:'legacy',createdAt:info.mtime.toISOString(),version:null,restorable:false};
        try{const valid=backupMetadata(meta,id);entry={...entry,...valid,kind:meta.format===1?'legacy':meta.kind,restorable:(versions.some(v=>v.sha===valid.version&&v.dataFormat===valid.dataFormat)||!!valid.sequence)&&digestPattern.test(meta.sha256)&&info.size===meta.size};}catch{}
        backups.push(entry);
      }catch{/* Keep unsupported files on disk. */}
    }
    status.current=active;
    status.versions=versions.sort((a,b)=>b.sequence-a.sequence);
    status.backups=backups.sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
    await persist();
  }
  async function stage(phase){status.job={...status.job,phase};await persist();}
  async function stop(){
    const {stdout}=await control('show','--property=User,Group,WorkingDirectory,KillMode,Delegate,Environment,EnvironmentFiles');
    const properties=parseSystemdProperties(stdout);
    if(properties.User!=='stardust'||!['','stardust'].includes(properties.Group)||properties.WorkingDirectory!==join(root,'current')||properties.KillMode!=='control-group'||properties.Delegate!=='no'||properties.EnvironmentFiles||!properties.Environment?.split(' ').includes('STARDUST_STORAGE_ROOT='+shared))throw Error('SERVICE_CONFIGURATION_INVALID');
    // systemctl stop waits for the control group. shared is reserved for this service.
    await control('stop');
    const result=await control('show','--property=ActiveState,MainPID');
    if(!/^ActiveState=(inactive|failed)$/m.test(result.stdout)||!/^MainPID=0$/m.test(result.stdout))throw Error('SERVICE_NOT_STOPPED');
  }
  async function start(sha){
    await control('start');
    if(verifyHealth){await verifyHealth(sha);return;}
    const deadline=Date.now()+30000;
    while(Date.now()<deadline){
      try{
        const {stdout}=await control('show','--property=MainPID','--value');
        const listener=await readJson('/run/stardust-core/endpoint.json',2048,uid).catch(()=>null);
        const addresses=Object.values(networkInterfaces()).flat().map(entry=>entry.address);
        const address=listener?.address;
        let endpoints;
        if(listener && listener.pid===Number(stdout.trim()) && listener.pid>0 &&
          Number.isInteger(listener.port)&&listener.port>0&&listener.port<=65535 &&
          (['0.0.0.0','::','127.0.0.1','::1'].includes(address)||addresses.includes(address))){
          const host=address==='0.0.0.0'?'127.0.0.1':address==='::'?'[::1]':address.includes(':')?'['+address+']':address;
          endpoints=[{host,port:listener.port}];
        } else endpoints=await runningEndpoints();
        for(const {host,port} of endpoints){
          try{
            const response=await fetch(`http://${host}:${port}/api/health`,{redirect:'error',signal:AbortSignal.timeout(1500)});
            if(response.ok){const health=await response.json();if(health.service==='Stardust'&&health.status==='ok'&&health.runningSha===sha)return;}
          }catch{}
        }
      }catch{}
      await pause(750);
    }
    throw Error('HEALTH_CHECK_FAILED');
  }
  async function switchTo(sha,onSwitch=()=>{}){
    const temp=join(root,'.current-'+randomUUID());
    await symlink('releases/'+sha,temp);
    try{await rename(temp,join(root,'current'));onSwitch();await syncDirectory(root);}finally{await unlink(temp).catch(absent);}
  }
  async function saveBackup(work,active,kind){
    const id=randomUUID(),meta={format:2,kind,version:active.sha,dataFormat:active.dataFormat??1,sequence:active.sequence,createdAt:new Date().toISOString()};
    if(active.dataFormat===null){meta.format=1;delete meta.dataFormat;}
    const archive=join(work,id+'.tar.gz'),metadata=join(work,id+'.json');
    await directory(shared,uid);
    await atomicJson(metadata,meta,0o600);
    await extract('backup',archive,shared,metadata);
    const f=await openFile(archive,archiveLimit,0);
    try{meta.size=(await f.stat()).size;meta.sha256=await digest(archive);await f.chown(0,gid);await f.chmod(0o640);await f.sync();}finally{await f.close();}
    await rename(archive,join(backupsDir,id+'.tar.gz'));
    await atomicJson(join(backupsDir,id+'.json'),meta,0o640,gid);
    return id;
  }
  async function prepareRelease(work,target){
    if(target.manager>1)throw Error('MANAGER_UPGRADE_REQUIRED');
    const found=await installed(target.sha).catch(absent);
    if(found?.dataFormat!==null&&found){
      if(JSON.stringify(version(found))!==JSON.stringify(version(target)))throw Error('VERSION_CONFLICT');
      return found;
    }
    const archive=join(work,'package.tar.gz'),out=join(work,'release');
    await stage('DOWNLOAD');await remote.download(target,archive);
    await stage('EXTRACT');await mkdir(out);
    await extract('extract',archive,out,'package');
    const meta=version(await readJson(join(out,'version.json'),4096,0));
    const pkg=await readJson(join(out,'package.json'),65536,0);
    if(JSON.stringify(meta)!==JSON.stringify(version(target))||pkg.version!==meta.version)throw Error('INVALID_RELEASE');
    for(const item of ['apps/server/dist/main.js','apps/web/dist/index.html','node_modules/@iarna/toml/package.json','node_modules/@tencent-connect/qqbot-nodejs/package.json']){
      const file=await openFile(join(out,item),32*1024**2,0);await file.close();
    }
    if(found)throw Error('VERSION_CONFLICT');
    await rename(out,join(releasesDir,target.sha));
    await syncDirectory(releasesDir);
    return meta;
  }
  async function deleteBackup(id){
    await unlink(join(backupsDir,id+'.tar.gz'));
    await unlink(join(backupsDir,id+'.json')).catch(absent);
  }
  async function prepareRestore(work,id){
    const meta=await readJson(join(backupsDir,id+'.json'),32768,0),info=backupMetadata(meta,id);
    const archive=join(backupsDir,id+'.tar.gz'),f=await openFile(archive,archiveLimit,0);
    try{if((await f.stat()).size!==meta.size||await digest(archive)!==meta.sha256)throw Error('BACKUP_CHECKSUM_MISMATCH');}finally{await f.close();}
    let target=await installed(info.version).catch(absent);
    if(!target){
      if(!info.sequence)throw Error('VERSION_NOT_AVAILABLE');
      const published=await remote.find(info.version,info.sequence);
      if(published.dataFormat!==info.dataFormat)throw Error('INCOMPATIBLE_BACKUP');
      target=await prepareRelease(work,published);
    }
    if(target.dataFormat!==info.dataFormat)throw Error('INCOMPATIBLE_BACKUP');
    if(target.manager>1)throw Error('MANAGER_UPGRADE_REQUIRED');
    const out=join(work,'restore');await mkdir(out,{mode:0o700});await extract('extract',archive,out,'backup');
    async function own(path){
      const stat=await lstat(path);
      if(stat.isDirectory())for(const name of await readdir(path))await own(join(path,name));
      await chown(path,uid,gid);await chmod(path,stat.isDirectory()?0o700:0o600);
    }
    const restored=join(out,'shared');await own(restored);
    return {target,restored};
  }
  async function withStopped(operation){
    await stage('STOP');await stop();
    let changed=false;
    try{const target=await operation(()=>{changed=true;});await stage('START');await start(target.sha);return target;}
    catch(error){if(!changed)await control('start').catch(()=>{});throw error;}
  }
  async function run(request){
    const {id,operation}=request;
    status.job={id,operation,phase:'CHECK',result:'running',reason:null,targetSha:null,bootId};
    await persist();
    let work,keepWork=false;
    try{
      const active=await current();
      if(operation==='check'){status.latest=await remote.latest();delete status.latest.assetId;delete status.latest.sha256;delete status.latest.size;}
      else if(operation==='delete')await deleteBackup(request.backup);
      else{
        work=await mkdtemp(join(privateDir,'job-'));
        if(operation==='upload'){
          await stage('VALIDATE');
          const file=await openFile(join(inbox,id+'.tar.gz'),archiveLimit,uid);
          const path=join(work,'upload.tar.gz');
          const checksum=await capture(file.createReadStream(),path);
          const out=join(work,'archive');await mkdir(out,{mode:0o700});await extract('extract',path,out,'backup');
          const supplied=await readJson(join(out,'backup.json'),32768,0).catch(absent);
          const meta=supplied?{format:supplied.format,...backupMetadata(supplied,id),kind:'uploaded',...checksum}:null;
          await chown(path,0,gid);await chmod(path,0o640);
          await rename(path,join(backupsDir,id+'.tar.gz'));
          if(meta)await atomicJson(join(backupsDir,id+'.json'),meta,0o640,gid);
        } else if(operation==='install'||operation==='update'){
          const latest=await remote.latest();
          if(operation==='update'&&request.target!==latest.sha)throw Error('RELEASE_CHANGED');
          status.job.targetSha=latest.sha;
          if(active?.sha===latest.sha){
            if(operation==='install'){await stage('START');await start(active.sha);}
            status.job.result='unchanged';
          }
          else{
            if(active&&(latest.sequence<=active.sequence||latest.dataFormat<(active.dataFormat??1)))throw Error('INCOMPATIBLE_RELEASE');
            const target=await prepareRelease(work,latest);
            if(!active){await switchTo(target.sha);await stage('START');await start(target.sha);}
            else await withStopped(async changed=>{
              await stage('BACKUP');await saveBackup(work,active,'automatic');
              await stage('SWITCH');await switchTo(target.sha,changed);return target;
            });
          }
        } else if(!active)throw Error('NO_CURRENT_VERSION');
        else if(operation==='backup'){
          status.job.targetSha=active.sha;
          await withStopped(async()=>{await stage('BACKUP');await saveBackup(work,active,'manual');return active;});
        } else if(operation==='rollback'){
          const target=await installed(request.target);status.job.targetSha=target.sha;
          if(!canRollback(active,target))throw Error('INCOMPATIBLE_ROLLBACK');
          if(target.manager>1)throw Error('MANAGER_UPGRADE_REQUIRED');
          if(target.sha===active.sha)status.job.result='unchanged';
          else await withStopped(async changed=>{await stage('BACKUP');await saveBackup(work,active,'automatic');await stage('SWITCH');await switchTo(target.sha,changed);return target;});
        } else if(operation==='restore'){
          await stage('VALIDATE');
          const {target,restored}=await prepareRestore(work,request.backup);status.job.targetSha=target.sha;
          await withStopped(async changed=>{
            await stage('BACKUP');await saveBackup(work,active,'safety');
            await stage('RESTORE');
            const displaced=join(work,'displaced');
            await rename(shared,displaced);
            try{await rename(restored,shared);}catch(error){
              try{await rename(displaced,shared);}catch{keepWork=true;changed();throw Error('SHARED_RESTORE_INCOMPLETE');}
              throw error;
            }
            changed();keepWork=true;
            await switchTo(target.sha);
            return target;
          });
        }
      }
      const now=await current();
      await inventory(now);
      if(['install','update','restore'].includes(operation)){
        const candidates=status.versions.filter(v=>operation!=='install'||v.sequence>0 || v.sha===now?.sha);
        for(const entry of retainedVersions(candidates,now.sha,config.retainVersions))await rm(join(releasesDir,entry.sha),{recursive:true});
        const automatic=status.backups.filter(b=>b.kind==='automatic');
        for(const entry of automatic.slice(config.retainAutomaticBackups))await deleteBackup(entry.id);
        await inventory(now);
      }
      if(status.job.result==='running')status.job.result='success';
      keepWork=false;
    }catch(error){
      console.error(operation,status.job.phase,error.message,String(error.stderr??'').slice(-1000));
      status.job.result='failed';
      const archiveError=error.stderr?.match(/(?:^|\s)(UNSAFE_ARCHIVE|ARCHIVE_LIMIT|INVALID_BACKUP|UNSAFE_STORAGE)(?:$|\s)/m)?.[1];
      status.job.reason=archiveError??(/^[A-Z][A-Z0-9_]{1,80}$/.test(error.message)?error.message:error.code==='ENOENT'?'FILE_MISSING':'OPERATION_FAILED');
      await inventory(await current().catch(()=>null)).catch(()=>{});
    }finally{
      if(work&&!keepWork)await rm(work,{recursive:true,force:true}).catch(()=>{});
      if(operation==='upload')await unlink(join(inbox,id+'.tar.gz')).catch(()=>{});
      if(['update','install','restore','rollback'].includes(operation)) status.lastDeployment=status.job;
      await persist();
    }
    return status.job;
  }
  async function consume(){
    await directory(inbox,0,true);await directory(privateDir);
    const path=join(inbox,'request.json'),claimed=join(privateDir,'request-'+randomUUID());
    // Remove the trigger before inspecting its content. A malformed request is consumed once.
    try{await rename(path,claimed);}catch(error){if(missing(error))return;throw error;}
    try{
      if(!config.enabled)return;
      const request=validateRequest(await readJson(claimed,2048,uid));
      await run(request);
    }catch(error){console.error('Management request rejected:',error.message);}
    finally{
      const entry=await lstat(claimed).catch(absent);
      if(entry?.isDirectory())await rmdir(claimed).catch(error=>{if(error.code!=='ENOTEMPTY')throw error;console.error('Nonempty invalid request left in quarantine.');});
      else await unlink(claimed).catch(absent);
    }
  }
  async function interrupted(){
    if(status.job?.result!=='running')return;
    status.job={...status.job,result:'failed',reason:'INTERRUPTED'};
    if(['update','install','restore','rollback'].includes(status.job.operation))status.lastDeployment=status.job;
    await inventory(await current().catch(()=>null));
  }
  return {run,consume,inventory,current,interrupted};
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
  if(process.platform!=='linux'||process.getuid()!==0||process.argv.length!==3)throw Error('LOCAL_ROOT_REQUIRED');
  const config=await readJson(join(systemRoot,'management','config.json'),4096,0);
  {
    delete config.token;
    const file=await openFile('/etc/stardust/github-token',512,0).catch(absent);
    if(file){try{if(((await file.stat()).mode&0o077)!==0)throw Error('UNSAFE_GITHUB_TOKEN');config.token=(await file.readFile('utf8')).trim();}finally{await file.close();}}
  }
  if(!Number.isSafeInteger(config.uid)||config.uid<1||!Number.isSafeInteger(config.gid)||config.gid<1||typeof config.enabled!=='boolean'||
    !Number.isSafeInteger(config.retainVersions)||config.retainVersions<1||config.retainVersions>50||
    !Number.isSafeInteger(config.retainAutomaticBackups)||config.retainAutomaticBackups<1||config.retainAutomaticBackups>50 ||
    (config.token!==undefined&&!/^[A-Za-z0-9_]{20,256}$/.test(config.token)))throw Error('INVALID_LOCAL_CONFIGURATION');
  for(const path of [systemRoot,join(systemRoot,'releases'),join(systemRoot,'backups'),join(systemRoot,'management'),join(systemRoot,'management','private')])await directory(path);
  const manager=await lifecycle({config});
  const operation=process.argv[2];
  if(operation==='consume')await manager.consume();
  else if(operation==='interrupted')await manager.interrupted();
  else if(operation==='enable'){const local=await readJson(join(systemRoot,'management','config.json'),4096,0);await atomicJson(join(systemRoot,'management','config.json'),{...local,enabled:true},0o600);}
  else if(operation==='inventory')await manager.inventory(await manager.current());
  else if(operation==='install'){
    const result=await manager.run({id:randomUUID(),operation});
    if(result.result==='failed')process.exitCode=1;
  }else throw Error('INVALID_OPERATION');
}
