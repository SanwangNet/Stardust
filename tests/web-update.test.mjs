import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStardustServer } from '../apps/server/dist/app.js';
import { createWebUpdateControl, parseUpdateStatus } from '../apps/server/dist/web-update-control.js';
import { publicState, runWebUpdate, compatibleTarget } from '../scripts/updater/web-update.mjs';
import { checkDeploymentContract } from '../scripts/updater/deploy.mjs';

const jobId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', sha='a'.repeat(40);
test('public update state only exposes selected fields and validates them',()=>{
  const published=publicState({status:'PREPARING',phase:'BACKUP',targetSha:sha,lastResult:null,failureStage:null,failureReason:null,secret:'private'},jobId);
  assert.equal(published.running,true);assert.equal(published.phase,'BACKUP');assert.equal(JSON.stringify(published).includes('private'),false);
  assert.equal(parseUpdateStatus(published).jobId,jobId);
  assert.throws(()=>parseUpdateStatus({...published,targetSha:'forged'}),/格式/);
});
test('Web update is opt-in and origin protected, and cannot select commands or paths',async t=>{
  let starts=0;const control={enabled:true,status:async()=>null,start:async()=>{starts++;}};
  const setup={getInitializationState:()=>({initialized:true})},extensions={restore:async()=>{},shutdown:async()=>{},availableTools:()=>[]};
  const server=createStardustServer({setupService:setup,extensionManager:extensions,webUpdateControl:control});server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const origin=`http://127.0.0.1:${server.address().port}`,url=origin+'/api/v1/software-update/install';
  const post=(body,headers={})=>fetch(url,{method:'POST',headers:{origin,'content-type':'application/json',...headers},body:JSON.stringify(body)});
  assert.equal((await post({command:'id'})).status,400);assert.equal((await post({}, {origin:'https://evil.example'})).status,403);assert.equal(starts,0);
  assert.equal((await post({})).status,202);assert.equal(starts,1);
  control.status=async()=>({jobId,running:true,status:'PREPARING',phase:'BUILD',targetSha:sha,result:null,failureStage:null,failureReason:null,updatedAt:Date.now()});
  assert.equal((await post({})).status,409);assert.equal(starts,1);
  const status=await (await fetch(origin+'/api/v1/software-update/status')).json();assert.equal(status.enabled,true);assert.equal(status.job.targetSha,sha);
});
test('unconfigured update control is disabled and cannot launch',async()=>{const control=createWebUpdateControl(false);assert.equal(control.enabled,false);assert.equal(await control.status(),null);await assert.rejects(control.start(),/未启用/);});
test('newer updater contract requires manual migration before switching',async t=>{const root=mkdtempSync(join(tmpdir(),'stardust-contract-'));t.after(()=>rmSync(root,{recursive:true,force:true}));writeFileSync(join(root,'package.json'),JSON.stringify({version:'1'}));await checkDeploymentContract(root);writeFileSync(join(root,'package.json'),JSON.stringify({stardustUpdaterContract:2}));await assert.rejects(checkDeploymentContract(root),/MIGRATION_REQUIRED/);});


test('independent updater publishes progress and final SHA without exposing private state',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'stardust-web-job-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const state={taskId:jobId,startedAt:new Date().toISOString(),status:'PREPARING',phase:'BACKUP',targetSha:sha,lastResult:null,failureReason:null,failureStage:null,privateKey:'secret'};
  let release;const gate=new Promise(resolve=>{release=resolve;});let reads=0;
  const run=runWebUpdate({root:dir,dir,compatibility:async()=>sha,pollMs:10,read:async()=>++reads===1?{taskId:null}:state,runUpdate:async options=>{assert.equal(options.branch,'main');await gate;return {result:'UPDATED',state:{...state,status:'READY',lastResult:'UPDATED'}};}});
  for(let i=0;i<100;i++){await new Promise(resolve=>setTimeout(resolve,10));try{if(JSON.parse(readFileSync(join(dir,'status.json'),'utf8')).phase==='BACKUP')break;}catch{}}
  const progress=JSON.parse(readFileSync(join(dir,'status.json'),'utf8'));assert.equal(progress.phase,'BACKUP');assert.equal(progress.running,true);assert.doesNotMatch(JSON.stringify(progress),/secret/);
  release();const final=await run;assert.equal(final.running,false);assert.equal(final.result,'UPDATED');assert.equal(final.targetSha,sha);
});
test('deployment diagnostics published to WebUI are bounded and redacted',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'stardust-web-error-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const result=await runWebUpdate({root:dir,dir,compatibility:async()=>sha,runUpdate:async()=>({result:'UPDATE_FAILED',state:{status:'FAILED',failureStage:'BACKUP',failureReason:'COMMAND_FAILED'},diagnostic:{stderr:'password=hunter2 /secret/private No process specification given'}})});
  assert.equal(result.failureReason,'COMMAND_FAILED');assert.match(result.detail,/No process specification/);assert.doesNotMatch(result.detail,/hunter2|secret.private/);
});



test('compatibility preflight pins the verified remote SHA and stops for newer contracts',async()=>{
  const remote=()=>({target:sha}),fetcher=async url=>{assert.ok(url.endsWith(sha+'/package.json'));return new Response(JSON.stringify({stardustUpdaterContract:1}));};
  assert.equal(await compatibleTarget(fetcher,remote),sha);
  await assert.rejects(compatibleTarget(async()=>new Response(JSON.stringify({stardustUpdaterContract:2})),remote),/MIGRATION_REQUIRED/);
});
