#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkRemote, REPOSITORY } from './check.mjs';

const shaPattern=/^[0-9a-f]{40}$/;
const artifacts=['package.json','package-lock.json','apps/server/dist/main.js','apps/server/dist/app.js','apps/server/dist/extensions/index.js','apps/server/dist/extensions/qq-bot.js','apps/server/dist/context-worker.js','apps/server/dist/people-management-worker.js','apps/web/dist/index.html','apps/web/dist/main.js','apps/web/dist/style.css','apps/web/dist/favicon.svg','apps/web/dist/fonts/wght.css','node_modules/@iarna/toml/package.json','node_modules/@tencent-connect/qqbot-nodejs/package.json'];
const validBranch=branch=>/^[a-zA-Z0-9][a-zA-Z0-9/_-]{0,127}$/.test(branch) && !branch.includes('//') && !branch.endsWith('/');
const samePath=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
function cleanEnv(home,storage) {
  return {PATH:process.env.PATH ?? '/usr/bin:/bin',HOME:home,USERPROFILE:home,TMPDIR:home,TMP:home,TEMP:home,
    ...(process.platform==='win32'?{SystemRoot:process.env.SystemRoot ?? 'C:\\Windows',ComSpec:process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe'}:{}),
    LANG:'C.UTF-8',CI:'true',GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null',
    npm_config_cache:join(home,'npm-cache'),npm_config_audit:'false',npm_config_fund:'false',npm_config_jobs:'2',STARDUST_STORAGE_ROOT:storage};
}
/** No shell, bounded output, timeout and cancellation; command output is never logged. */
export function runCommand(command,args,{cwd,env,timeout,signal}={}) {
  return new Promise((resolvePromise,reject)=>{
    if(signal?.aborted){reject(new Error('CANCELLED'));return;}
    const child=spawn(command,args,{cwd,env,stdio:['ignore','pipe','pipe'],windowsHide:true,detached:process.platform!=='win32'});
    let output='',size=0,reason,killTimer;const limit=65536;
    const consume=chunk=>{size+=chunk.length;if(size<=limit)output+=chunk.toString();};child.stdout.on('data',consume);child.stderr.on('data',consume);
    const stop=why=>{if(reason)return;reason=why;try{if(process.platform!=='win32' && child.pid)process.kill(-child.pid,'SIGTERM');else child.kill('SIGTERM');}catch{};killTimer=setTimeout(()=>{try{if(process.platform!=='win32' && child.pid)process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL');}catch{}},2000);killTimer.unref();};
    const timer=setTimeout(()=>stop('TIMEOUT'),timeout);const abort=()=>stop('CANCELLED');signal?.addEventListener('abort',abort,{once:true});
    child.once('error',()=>{clearTimeout(timer);clearTimeout(killTimer);signal?.removeEventListener('abort',abort);reject(new Error(reason ?? 'COMMAND_FAILED'));});
    child.once('close',code=>{clearTimeout(timer);clearTimeout(killTimer);if(reason && process.platform!=='win32' && child.pid)try{process.kill(-child.pid,'SIGKILL');}catch{}signal?.removeEventListener('abort',abort);if(reason||code!==0)reject(new Error(reason ?? 'COMMAND_FAILED'));else resolvePromise(output.trim());});
  });
}
async function verifyArtifacts(path) {for(const item of artifacts){const file=join(path,item),stat=await lstat(file),rel=relative(path,await realpath(file));if(!stat.isFile() || stat.isSymbolicLink() || stat.size===0 || rel==='..' || rel.startsWith('..'+sep) || isAbsolute(rel))throw new Error('ARTIFACT_INVALID');}}
async function verifyNoRuntimeData(path) {for(const name of ['config.toml','.env','env','data']){try{await lstat(join(path,name));throw new Error('RUNTIME_DATA_IN_CANDIDATE');}catch(e){if(e.code!=='ENOENT')throw e;}}}
// Observation only: this does not seal a builder-owned directory or authorize publication.
export async function inspectStagedArtifacts(path) {await verifyArtifacts(path);await verifyNoRuntimeData(path);}
async function validExisting(path,target,branch,run,timeout,signal) {
  try {const stat=await lstat(path);if(!stat.isDirectory()||stat.isSymbolicLink())return false;const marker=join(path,'.stardust-candidate.json'),markerStat=await lstat(marker);if(!markerStat.isFile()||markerStat.isSymbolicLink()||markerStat.size>65536)return false;const meta=JSON.parse(await readFile(marker,'utf8'));if(meta.format!==1||meta.sha!==target||meta.repository!==REPOSITORY||meta.branch!==branch||meta.status!=='prepared')return false;await verifyArtifacts(path);await verifyNoRuntimeData(path);const options={cwd:path,env:cleanEnv(path,path),timeout,signal};return await run('git',['rev-parse','HEAD'],options)===target && !(await run('git',['status','--porcelain','--untracked-files=no'],options));}catch{return false;}
}

// Shared by the legacy fixture and the systemd worker; never publishes a release.
async function buildInStaging({tmp,target,branch,timeout,signal,metadataStatus='prepared'},adapter={}) {
  const source=join(tmp,'source'),home=join(tmp,'home'),storage=join(tmp,'storage');
  const run=adapter.run??runCommand,log=adapter.log??(()=>{}),env=cleanEnv(home,storage),phases=[];let stage='fetch';
  const step=async(name,command,args,cwd=source)=>{stage=name;const start=Date.now();await log({stage:name,event:'start'});try{const result=await run(command,args,{cwd,env,timeout,signal});const durationMs=Date.now()-start;phases.push({stage:name,durationMs});await log({stage:name,event:'ok',durationMs});return result;}catch(e){const code=['TIMEOUT','CANCELLED'].includes(e.message)?e.message:'FAILED';await log({stage:name,event:'failed',code,durationMs:Date.now()-start});throw new Error(`${name}:${code}`);}};
  try {
    await mkdir(source);await mkdir(home);await mkdir(storage);
    await step('git_init','git',['init','--quiet']);
    await step('fetch','git',['-c','credential.helper=','fetch','--no-tags','--depth=1',REPOSITORY,target]);
    await step('checkout','git',['checkout','--quiet','--detach','FETCH_HEAD']);
    if(await step('verify_sha','git',['rev-parse','HEAD'])!==target)throw new Error('SHA_MISMATCH');
    await verifyNoRuntimeData(source);
    const npm=process.platform==='win32'?'npm.cmd':'npm';
    await step('dependencies',npm,['ci']);await step('check',npm,['run','check']);await step('build',npm,['run','build']);
    const manifest=JSON.parse(await readFile(join(source,'package.json'),'utf8'));
    if(manifest?.scripts?.test!=='npm run build && node --experimental-sqlite --test tests/*.test.mjs')throw new Error('UNSUPPORTED_TEST_SCRIPT');
    const tests=(await readdir(join(source,'tests'))).filter(name=>name.endsWith('.test.mjs')).sort().map(name=>join('tests',name));if(!tests.length)throw new Error('TESTS_MISSING');
    await step('test',process.execPath,['--experimental-sqlite','--test','--test-concurrency=2',...tests]);
    stage='artifacts';await log({stage,event:'start'});await verifyArtifacts(source);await verifyNoRuntimeData(source);
    if(await step('verify_final_sha','git',['rev-parse','HEAD'])!==target)throw new Error('SHA_MISMATCH');
    if(await step('verify_sources','git',['status','--porcelain','--untracked-files=no']))throw new Error('SOURCE_MODIFIED');
    const npmVersion=await step('npm_version',npm,['--version']);
    if(!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(npmVersion))throw new Error('INVALID_NPM_VERSION');
    const metadata={format:1,status:metadataStatus,sha:target,repository:REPOSITORY,branch,builtAt:new Date().toISOString(),node:process.version,npm:npmVersion,phases,artifacts};
    await writeFile(join(source,'.stardust-candidate.json'),JSON.stringify(metadata,null,2)+'\n',{flag:'wx',mode:0o600});
    return {source,metadata,phases};
  } catch(e){throw new Error(`${stage}:${e.message}`);}
}

// Direct invocation is limited to the real systemd cgroup, not an environment flag.
export async function buildSystemdWorker({root,taskId,sha,branch,unit,timeout}) {
  if(process.platform!=='linux'||process.getuid?.()===0||!isAbsolute(root??'')||root!==resolve(root)||!shaPattern.test(sha??'')||!validBranch(branch??'')||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(taskId??'')||!Number.isSafeInteger(timeout)||timeout<1000||timeout>3600000)throw new Error('WORKER_FORBIDDEN');
  const expected=`stardust-build-${createHash('sha256').update(root).digest('hex').slice(0,16)}-${taskId}.service`;if(unit!==expected)throw new Error('WORKER_FORBIDDEN');
  const cg=await readFile('/proc/self/cgroup','utf8');if(!cg.split(/\r?\n/).includes(`0::/system.slice/${unit}`)||!/^[a-f0-9]{32}$/.test(process.env.INVOCATION_ID??''))throw new Error('WORKER_FORBIDDEN');
  const tmp=join(root,'build-work',taskId),st=await lstat(tmp);if(!st.isDirectory()||st.isSymbolicLink()||st.uid!==process.getuid()||(st.mode&0o077)!==0||(await realpath(tmp))!==tmp)throw new Error('WORKER_DIRECTORY_INVALID');
  const log=async e=>{if(e.event==='start')await writeFile(join(tmp,'progress'),String(e.stage).toUpperCase().replace(/[^A-Z0-9_]/g,'_').slice(0,80)+'\n',{mode:0o600});};
  const result=await buildInStaging({tmp,target:sha,branch,timeout,metadataStatus:'staged'},{log});
  await writeFile(join(tmp,'result.json'),JSON.stringify({format:1,taskId,sha,status:'staged',invocationId:process.env.INVOCATION_ID})+'\n',{flag:'wx',mode:0o600});
  return result;
}

// Kept private until construction and publication are separated behind a verified supervisor.
async function prepareCandidateCore({root,branch='main',sha,timeout=900000,signal},adapter={}) {
  if(!isAbsolute(root)||root!==resolve(root)||/[\x00-\x1f]/.test(root))throw new Error('INVALID_ROOT');
  if(!validBranch(branch))throw new Error('INVALID_BRANCH');
  if(sha!==undefined&&!shaPattern.test(sha))throw new Error('INVALID_SHA');
  if(!Number.isSafeInteger(timeout)||timeout<1000||timeout>3600000)throw new Error('INVALID_TIMEOUT');
  if((adapter.uid ?? process.getuid?.())===0)throw new Error('ROOT_BUILD_FORBIDDEN');
  const rootStat=await lstat(root);if(!rootStat.isDirectory()||rootStat.isSymbolicLink()||!samePath(await realpath(root),root))throw new Error('INVALID_ROOT');
  const remote=(adapter.remote ?? checkRemote)(branch);const target=sha ?? remote.target;
  if(!shaPattern.test(target)||target!==remote.target)throw new Error('TARGET_NOT_BRANCH_HEAD');
  const run=adapter.run ?? runCommand, log=adapter.log ?? (()=>{}), releases=join(root,'releases'), staging=join(releases,'.staging');
  await log({stage:'remote_check',event:'ok',sha:target});
  const production=process.env.STARDUST_STORAGE_ROOT;
  if(production && isAbsolute(production)) {const shared=resolve(production),a=relative(shared,releases),b=relative(releases,shared);if(!a || !b || (!a.startsWith('..'+sep)&&a!=='..'&&!isAbsolute(a)) || (!b.startsWith('..'+sep)&&b!=='..'&&!isAbsolute(b)))throw new Error('STORAGE_OVERLAP');}
  for(const dir of [releases,staging]){try{await mkdir(dir);}catch(e){if(e.code!=='EEXIST')throw e;}const s=await lstat(dir);if(!s.isDirectory()||s.isSymbolicLink()||!samePath(await realpath(dir),dir))throw new Error('INVALID_RELEASES');}
  if((await stat(releases)).dev!==(await stat(staging)).dev)throw new Error('STAGING_FILESYSTEM_MISMATCH');
  const reservation=join(staging,`${target}.lock`);
  try {await mkdir(reservation);}catch(e){if(e.code==='EEXIST')throw new Error('PREPARE_IN_PROGRESS');throw e;}
  try {
  const destination=join(releases,target);
  try {await lstat(destination);if(await validExisting(destination,target,branch,run,timeout,signal))return {sha:target,path:destination,status:'already_prepared',deployed:false};throw new Error('CANDIDATE_CONFLICT');} catch(e){if(e.code!=='ENOENT')throw e;}
  const tmp=await mkdtemp(join(staging,'build-'));
  try {
    const {source,phases}=await buildInStaging({tmp,target,branch,timeout,signal},{run,log});
    try{await lstat(destination);throw new Error('CANDIDATE_CONFLICT');}catch(e){if(e.code!=='ENOENT')throw e;}
    if(process.platform==='linux') {
      await run('mv',['--no-clobber','--no-target-directory','--',source,destination],{cwd:source,env:cleanEnv(join(tmp,'home'),join(tmp,'storage')),timeout,signal});
      try{await lstat(source);throw new Error('CANDIDATE_CONFLICT');}catch(e){if(e.code!=='ENOENT')throw e;}
    } else await rename(source,destination);
    await log({stage:'publish',event:'ok'});return {sha:target,path:destination,status:'prepared',deployed:false,phases};
  } finally {await rm(tmp,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
  } finally {await rmdir(reservation);}
}

/** Direct invocation cannot bypass the coordinator's supervision gate. */
export async function prepareCandidate() { throw new Error('SUPERVISION_UNAVAILABLE'); }

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
 const {main}=await import('./update.mjs');
 await main(process.argv.slice(2),{legacyPrepare:true});
}
