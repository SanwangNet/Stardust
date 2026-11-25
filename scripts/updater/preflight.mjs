#!/usr/bin/env node
// Read-only by default. --active creates one uniquely named, time-limited test unit.
import { constants } from 'node:fs';
import { access, chmod, chown, lstat, mkdtemp, mkdir, open, readFile, realpath, rmdir, statfs, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { delimiter, isAbsolute, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateRoot } from './state.mjs';

const exec=promisify(execFile);
const username=/^[a-z_][a-z0-9_-]{0,31}$/;
const env={PATH:'/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',LANG:'C',LC_ALL:'C',SYSTEMD_PAGER:'cat'};
const command=async(file,args,timeout=5000)=>{const {stdout}=await exec(file,args,{env,timeout,maxBuffer:16384,windowsHide:true});return stdout.trim();};
async function executable(name) {
  for(const part of env.PATH.split(delimiter)){if(!isAbsolute(part))continue;const candidate=join(part,name);try{await access(candidate,constants.X_OK);const s=await lstat(candidate);if(s.isFile()||s.isSymbolicLink())return await realpath(candidate);}catch{}}
  return null;
}
async function account(name) {
  if(!username.test(name??''))return null;
  try{const out=await command('getent',['passwd',name]);const parts=out.split(':');if(parts.length!==7||parts[0]!==name||!/^\d+$/.test(parts[2])||!/^\d+$/.test(parts[3]))return null;return {name,uid:Number(parts[2]),gid:Number(parts[3])};}catch{return null;}
}
async function unitProperties(unit) {
  const out=await command('systemctl',['show',unit,'--property=LoadState,ActiveState,MainPID,InvocationID,ControlGroup,ExitType,Result,Type,KillMode,SendSIGKILL,Delegate,Restart,NoNewPrivileges,ProtectControlGroups,User']);
  return Object.fromEntries(out.split(/\r?\n/).filter(x=>x.includes('=')).map(x=>{const p=x.indexOf('=');return [x.slice(0,p),x.slice(p+1)];}));
}
const sleep=ms=>new Promise(resolvePromise=>setTimeout(resolvePromise,ms));
async function readProbeFile(path,uid,limit) {
  const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const st=await handle.stat();if(!st.isFile()||st.uid!==uid||st.nlink!==1||st.size>limit)throw new Error('PROBE_FILE_UNSAFE');const buffer=Buffer.alloc(limit+1);const {bytesRead}=await handle.read(buffer,0,buffer.length,0);if(bytesRead>limit)throw new Error('PROBE_FILE_UNSAFE');return buffer.subarray(0,bytesRead);}finally{await handle.close();}
}
async function cleanupProbe(dir,output) {
  for(const name of ['ready','writes'])try{await unlink(join(output,name));}catch(e){if(e.code!=='ENOENT')throw e;}
  try{await rmdir(output);}catch(e){if(e.code!=='ENOENT')throw e;}
  await rmdir(dir);
}

/** Test one independently managed unit, never a production build unit. */
async function activeProbe(builder,node) {
  if(process.getuid?.()!==0)throw new Error('ACTIVE_PROBE_REQUIRES_ROOT');
  const unit=`stardust-probe-${randomUUID()}.service`,dir=await mkdtemp('/run/stardust-supervision-probe-');
  const output=join(dir,'output');let invocation=null,cgroup=null,created=false,launchAttempted=false,stopped=false;
  try {
    if(/[%\x00-\x1f]/.test(node)||/[%\x00-\x1f]/.test(output))throw new Error('PROBE_PATH_INVALID');
    await chmod(dir,0o711);await mkdir(output,{mode:0o700});await chown(output,builder.uid,builder.gid);
    const before=await unitProperties(unit);if(before.LoadState!=='not-found')throw new Error('PROBE_UNIT_COLLISION');
    const childCode="const fs=require('node:fs');const p=process.argv[1];const s=fs.readFileSync('/proc/self/stat','utf8');const f=s.slice(s.lastIndexOf(')')+2).split(' ');fs.writeFileSync(p+'/ready',JSON.stringify({uid:process.getuid(),pid:process.pid,group:Number(f[2]),session:Number(f[3])}));setInterval(()=>fs.appendFileSync(p+'/writes','x'),100);";
    const parentCode="const cp=require('node:child_process');const c=cp.spawn(process.execPath,['-e',process.argv[2],process.argv[1]],{detached:true,stdio:'ignore'});c.unref();";
    const props=['Type=exec','ExitType=cgroup','KillMode=control-group','RuntimeMaxSec=25','TimeoutStopSec=3','SendSIGKILL=yes','Delegate=no','Restart=no','NoNewPrivileges=yes','ProtectControlGroups=yes','ProtectHome=yes','PrivateTmp=yes','ReadOnlyPaths=-/usr','InaccessiblePaths=-/run/dbus/system_bus_socket -/run/systemd/private -/run/user','CapabilityBoundingSet=',`User=${builder.name}`];
    launchAttempted=true;
    await command('systemd-run',[`--unit=${unit}`,'--slice=system.slice','--expand-environment=no',...props.map(x=>`--property=${x}`),'--',node,'-e',parentCode,output,childCode],8000);created=true;
    let p;
    for(let i=0;i<40;i++){p=await unitProperties(unit);try{await access(join(output,'ready'));if(p.ActiveState==='active'&&p.MainPID==='0')break;}catch{}await sleep(100);}
    if(p?.ActiveState!=='active'||p.MainPID!=='0'||p.ExitType!=='cgroup'||!/^[a-f0-9]{32}$/.test(p.InvocationID??''))throw new Error('PROBE_CGROUP_LIFECYCLE_UNCONFIRMED');
    if(p.Type!=='exec'||p.KillMode!=='control-group'||p.SendSIGKILL!=='yes'||p.Delegate!=='no'||p.Restart!=='no'||p.NoNewPrivileges!=='yes'||p.ProtectControlGroups!=='yes'||p.User!==builder.name)throw new Error('PROBE_PROPERTIES_UNCONFIRMED');
    const worker=JSON.parse((await readProbeFile(join(output,'ready'),builder.uid,512)).toString('utf8'));
    if(worker.uid!==builder.uid)throw new Error('PROBE_WRONG_USER');
    if(!Number.isSafeInteger(worker.pid)||worker.pid!==worker.group||worker.pid!==worker.session)throw new Error('PROBE_SETSID_UNCONFIRMED');
    invocation=p.InvocationID;
    if(p.ControlGroup!==`/system.slice/${unit}`)throw new Error('PROBE_CGROUP_PATH_INVALID');
    cgroup=resolve('/sys/fs/cgroup','.'+p.ControlGroup);
    if(!cgroup.startsWith('/sys/fs/cgroup'+sep))throw new Error('PROBE_CGROUP_PATH_INVALID');
    const events=await readFile(join(cgroup,'cgroup.events'),'utf8');if(!/^populated 1$/m.test(events))throw new Error('PROBE_CGROUP_NOT_POPULATED');
    await sleep(300);if(!(await readProbeFile(join(output,'writes'),builder.uid,4096)).length)throw new Error('PROBE_WRITES_UNCONFIRMED');
    const current=await unitProperties(unit);if(current.InvocationID!==invocation)throw new Error('PROBE_UNIT_IDENTITY_CHANGED');
    await command('systemctl',['stop',unit],10000);
    let empty=false;
    for(let i=0;i<30;i++){try{const eventsAfter=await readFile(join(cgroup,'cgroup.events'),'utf8');if(/^populated 0$/m.test(eventsAfter)){empty=true;break;}}catch(e){if(e.code==='ENOENT'){empty=true;break;}throw e;}await sleep(100);}
    if(!empty)throw new Error('PROBE_CGROUP_NOT_EMPTY');
    const bytes=(await readProbeFile(join(output,'writes'),builder.uid,4096)).length;await sleep(300);
    if((await readProbeFile(join(output,'writes'),builder.uid,4096)).length!==bytes)throw new Error('PROBE_WRITER_SURVIVED');stopped=true;
    let retainedDirectory;try{await cleanupProbe(dir,output);}catch{retainedDirectory=dir;}
    return {result:'passed',unit,invocation,detachedChildObserved:true,cgroupEmpty:true,workerUid:builder.uid,...(retainedDirectory?{retainedDirectory}:{})};
  } catch(e) {
    // Never stop a unit unless both its unique name and observed invocation match.
    if(created && invocation && !stopped)try{const p=await unitProperties(unit);if(p.InvocationID===invocation)await command('systemctl',['stop',unit],10000);}catch{}
    return {result:'failed',reason:/^[A-Z_]+$/.test(e.message)?e.message:'ACTIVE_PROBE_FAILED',unit,...(launchAttempted?{retainedDirectory:dir}:{})};
  } finally {if(!stopped&&!launchAttempted)try{await cleanupProbe(dir,output);}catch{}}
}

export async function preflight({root,buildUser,runUser,active=false}) {
  const result={platform:process.platform,checks:{},active:{result:'not_requested'},productionBuild:'coordinator_checks_required',supervisionAvailable:false};
  if(process.platform!=='linux'){result.checks.platform='unsupported';return result;}
  result.checks.platform='linux';
  try{await validateRoot(root);result.checks.deploymentRoot='valid';}catch{result.checks.deploymentRoot='invalid_or_inaccessible';}
  const [builder,runner]=await Promise.all([account(buildUser),account(runUser)]);
  result.checks.buildUser=builder&&builder.uid!==0?{name:builder.name,uid:builder.uid}:'missing_or_root';
  result.checks.runUser=runner&&runner.uid!==0?{name:runner.name,uid:runner.uid}:'missing_or_root';
  result.checks.userSeparation=builder&&runner&&builder.uid!==0&&runner.uid!==0&&builder.uid!==runner.uid?'distinct':'invalid';
  result.checks.executables=Object.fromEntries(await Promise.all(['systemctl','systemd-run','flock','git','npm'].map(async name=>[name,await executable(name)])));result.checks.executables.node=process.execPath;
  try{result.checks.cgroupV2=(await statfs('/sys/fs/cgroup')).type===0x63677270?'present':'unavailable';}catch{result.checks.cgroupV2='unavailable';}
  try{await command('systemctl',['show','--property=Version','--value']);result.checks.systemManager='available';}catch{result.checks.systemManager='unavailable';}
  for(const name of ['updater','releases','shared'])try{const st=await lstat(join(root,name));result.checks[name]={type:st.isSymbolicLink()?'symlink':st.isDirectory()?'directory':'other',uid:st.uid,mode:(st.mode&0o777).toString(8)};}catch(e){result.checks[name]=e.code==='ENOENT'?'missing':'inaccessible';}
  result.checks.builderAccessToSecrets='unknown';result.checks.permissionBoundary='not_verified';
  if(active){if(result.checks.userSeparation!=='distinct'||result.checks.cgroupV2!=='present'||result.checks.systemManager!=='available'||!result.checks.executables['systemd-run'])result.active={result:'not_run',reason:'PREREQUISITES_UNAVAILABLE'};else try{result.active=await activeProbe(builder,process.execPath);}catch(e){result.active={result:'not_run',reason:e.message==='ACTIVE_PROBE_REQUIRES_ROOT'?e.message:'ACTIVE_PROBE_FAILED'};}}
  return result;
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
  const [root,buildUser,runUser,...args]=process.argv.slice(2);
  if(!root||!buildUser||!runUser||args.length>1||args.length===1&&args[0]!=='--active'){console.error('USAGE: node preflight.mjs ABSOLUTE_ROOT BUILD_USER CORE_USER [--active]');process.exitCode=22;}
  else {try{console.log(JSON.stringify(await preflight({root,buildUser,runUser,active:args[0]==='--active'}),null,2));process.exitCode=24;}catch{console.error('PREFLIGHT_FAILED');process.exitCode=24;}}
}
