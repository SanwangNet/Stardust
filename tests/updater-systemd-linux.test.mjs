import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { updaterDirectory } from '../scripts/updater/state.mjs';
import { observeLock } from '../scripts/updater/lock.mjs';
import { preflight } from '../scripts/updater/preflight.mjs';

const linux=process.platform==='linux';
const lockUrl=new URL('../scripts/updater/lock.mjs',import.meta.url).href;
const preparePath=fileURLToPath(new URL('../scripts/updater/prepare.mjs',import.meta.url));
const preflightPath=fileURLToPath(new URL('../scripts/updater/preflight.mjs',import.meta.url));
const script=`import {acquireLock} from ${JSON.stringify(lockUrl)};try{const lock=await acquireLock(process.argv[1]);console.log('ACQUIRED');process.stdin.resume();process.stdin.on('end',async()=>{await lock.release()});}catch(e){console.error(e.message);process.exitCode=e.message==='LOCK_BUSY'?11:1}`;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function root(t){const path=realpathSync(mkdtempSync(join(tmpdir(),'stardust-lock-test-')));t.after(()=>rmSync(path,{recursive:true,force:true,maxRetries:5}));return path;}
async function holder(dir){const child=spawn(process.execPath,['--input-type=module','-e',script,dir],{stdio:['pipe','pipe','pipe']});await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('LOCK_HOLDER_TIMEOUT'));},5000);child.stdout.once('data',data=>{clearTimeout(timer);try{assert.match(String(data),/ACQUIRED/);resolve();}catch(e){reject(e);}});child.once('error',e=>{clearTimeout(timer);reject(e);});child.once('exit',code=>{clearTimeout(timer);reject(Error(`LOCK_HOLDER_EXIT_${code}`));});});return child;}

test('preflight on Windows never creates a unit or modifies the supplied directory',{skip:linux?'Windows-specific behavior':false},async t=>{const path=root(t);const result=await preflight({root:path,buildUser:'builder',runUser:'core',active:true});assert.equal(result.checks.platform,'unsupported');assert.equal(result.productionBuild,'coordinator_checks_required');assert.equal(result.active.result,'not_requested');});
test('default preflight CLI is read-only and reports the coordinator gate',t=>{const path=root(t),before=readdirSync(path);const run=spawnSync(process.execPath,[preflightPath,path,'builder','core'],{encoding:'utf8',timeout:15000});assert.equal(run.status,24,run.stderr);const output=JSON.parse(run.stdout);assert.equal(output.active.result,'not_requested');assert.equal(output.productionBuild,'coordinator_checks_required');assert.deepEqual(readdirSync(path),before);});

test('real flock excludes another process, permits a different root, and survives direct CLI attempts',{skip:!linux?'需要 Linux flock':false},async t=>{
  const first=root(t),second=root(t),dir1=await updaterDirectory(first,true),dir2=await updaterDirectory(second,true),one=await holder(dir1);t.after(()=>one.kill('SIGKILL'));
  const conflict=spawnSync(process.execPath,['--input-type=module','-e',script,dir1],{encoding:'utf8',timeout:5000});assert.equal(conflict.status,11,conflict.stderr);
  const two=await holder(dir2);t.after(()=>two.kill('SIGKILL'));
  const cleanEnv={...process.env};delete cleanEnv.STARDUST_STORAGE_ROOT;
  const direct=spawnSync(process.execPath,[preparePath,first,'main'],{env:cleanEnv,encoding:'utf8',timeout:5000});assert.equal(direct.status,11,direct.stderr);assert.match(direct.stderr,/LOCK_BUSY/);
  one.stdin.end();await once(one,'exit');two.stdin.end();await once(two,'exit');assert.equal(await observeLock(dir1),'not_held');assert.equal(await observeLock(dir2),'not_held');
});

test('SIGKILL of a lock owner eventually releases the kernel lock',{skip:!linux?'需要 Linux flock':false},async t=>{
  const path=root(t),dir=await updaterDirectory(path,true),child=await holder(dir);t.after(()=>child.kill('SIGKILL'));child.kill('SIGKILL');await once(child,'exit');
  let state='held';for(let i=0;i<50&&state!=='not_held';i++){await pause(100);state=await observeLock(dir);}assert.equal(state,'not_held');
});

const active=linux&&process.env.RUN_STARDUST_SYSTEMD_TESTS==='1';
test('real systemd service contains a detached writer until its cgroup is stopped',{skip:!active?'需 Linux systemd 和显式启用主动测试':false},async t=>{
  const buildUser=process.env.STARDUST_TEST_BUILD_USER,runUser=process.env.STARDUST_TEST_CORE_USER;
  assert.ok(buildUser&&runUser,'请提供两个独立的非 root 测试用户');assert.equal(process.getuid(),0,'主动测试需管理测试 unit 的权限');
  const result=await preflight({root:root(t),buildUser,runUser,active:true});assert.equal(result.active.result,'passed',JSON.stringify(result));assert.equal(result.active.cgroupEmpty,true);assert.equal(result.active.detachedChildObserved,true);assert.equal(result.productionBuild,'coordinator_checks_required');
});
