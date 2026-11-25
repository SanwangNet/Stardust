import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { runCommand } from '../scripts/updater/prepare.mjs';
import { recordWorkerEvent, writeFailureDiagnostic } from '../scripts/updater/diagnostics.mjs';

function fixture(t){const root=realpathSync(mkdtempSync(join(tmpdir(),'updater-diagnostic-'))),within=relative(realpathSync(tmpdir()),root);assert.ok(within&&within!=='..'&&!within.startsWith('..'+sep)&&!isAbsolute(within));t.after(()=>rmSync(root,{recursive:true,force:true,maxRetries:5}));return root;}

test('failed command retains bounded, redacted stream tails and its exit status',async t=>{
  const dir=fixture(t),secret='not-for-diagnostic-7b921',env={...process.env,STARDUST_API_KEY:secret};
  const code=`const fs=require('node:fs');fs.writeSync(1,'✖ fixture test failed\\n'+'x'.repeat(100000)+'\\n# fail 1\\napi_key=${secret}\\n');fs.writeSync(2,'password=other-secret\\nAuthorization: Bearer secret-bearer-value\\nUNCLASSIFIED_ENV=should-not-be-recorded\\n'+JSON.stringify({apiKey:'json-secret-123'})+'\\n');process.exit(7)`;
  let failure;try{await runCommand(process.execPath,['-e',code],{env,timeout:10000});assert.fail('command succeeded');}catch(e){failure=e;}
  assert.equal(failure.message,'COMMAND_FAILED');assert.equal(failure.diagnostic.exitCode,7);assert.equal(failure.diagnostic.signal,null);assert.equal(failure.diagnostic.truncated.stdout,true);
  assert.match(failure.diagnostic.failureHints.text,/fixture test failed/);assert.match(failure.diagnostic.failureHints.text,/# fail 1/);assert.match(failure.diagnostic.stdout,/# fail 1/);
  assert.doesNotMatch(JSON.stringify(failure.diagnostic),/not-for-diagnostic-7b921|other-secret|secret-bearer-value|should-not-be-recorded|json-secret-123/);
  await recordWorkerEvent(dir,{event:'failed',stage:'test',diagnostic:failure.diagnostic});
  const path=join(dir,'failure.json'),record=JSON.parse(readFileSync(path,'utf8'));
  assert.equal(record.stage,'TEST');assert.equal(record.reason,'COMMAND_FAILED');assert.equal(record.exitCode,7);assert.equal(record.truncated.stdout,true);assert.ok(statSync(path).size<=65536);
  assert.doesNotMatch(readFileSync(path,'utf8'),/not-for-diagnostic-7b921|other-secret|secret-bearer-value/);
});

test('timeout and cancellation carry structured reasons without exposing command output in errors',async()=>{
  let timed;try{await runCommand(process.execPath,['-e','setInterval(()=>{},1000)'],{env:process.env,timeout:100});}catch(e){timed=e;}
  assert.equal(timed?.message,'TIMEOUT');assert.equal(timed.diagnostic.reason,'TIMEOUT');assert.equal(timed.diagnostic.exitCode,null);
  const controller=new AbortController();controller.abort();await assert.rejects(runCommand(process.execPath,[],{env:process.env,timeout:1000,signal:controller.signal}),e=>e.message==='CANCELLED'&&e.diagnostic.reason==='CANCELLED');
  await assert.rejects(runCommand(process.execPath+'.missing',[],{env:process.env,timeout:1000}),e=>e.message==='SPAWN_ERROR'&&e.diagnostic.exitCode===null);
});

test('a pre-existing log or symlink is never overwritten',async t=>{
  const dir=fixture(t),outside=join(dir,'outside'),path=join(dir,'failure.json');writeFileSync(outside,'unchanged');
  try{symlinkSync(outside,path,'file');}catch(e){if(['EPERM','EACCES'].includes(e.code)){t.skip('环境不允许创建符号链接');return;}throw e;}
  await assert.rejects(writeFailureDiagnostic(dir,'test',{reason:'COMMAND_FAILED'}));assert.equal(readFileSync(outside,'utf8'),'unchanged');assert.equal(existsSync(path),true);
});
