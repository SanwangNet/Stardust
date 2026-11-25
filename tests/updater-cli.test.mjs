import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const prepare=fileURLToPath(new URL('../scripts/updater/prepare.mjs',import.meta.url));
const update=fileURLToPath(new URL('../scripts/updater/update.mjs',import.meta.url));
const env={...process.env};delete env.STARDUST_STORAGE_ROOT;

function run(script,args) {
  const result=spawnSync(process.execPath,[script,...args],{encoding:'utf8',env,timeout:10000});
  assert.equal(result.error,undefined,result.error?.message);
  assert.notEqual(result.status,13,result.stderr);
  assert.doesNotMatch(result.stderr,/unsettled top-level await/i);
  return result;
}

for(const [name,script,args,message] of [
  ['prepare without arguments',prepare,[],'USAGE'],
  ['update without arguments',update,[],'USAGE'],
  ['prepare with excess arguments',prepare,['root','main','a'.repeat(40),'900000','extra'],'USAGE'],
  ['prepare accepts legacy SHA and timeout',prepare,['relative-root','main','a'.repeat(40),'900000'],'INVALID_ROOT'],
  ['update accepts the existing force option',update,['relative-root','main','--force'],'INVALID_ROOT'],
]) test(`${name} loads the real CLI`,()=>{
  const result=run(script,args);assert.equal(result.status,22,result.stderr);assert.equal(result.stderr.trim(),message);
});

test('a real Node process cannot invoke prepareCandidate without supervision',()=>{
  const source=`import {prepareCandidate} from ${JSON.stringify(new URL('../scripts/updater/prepare.mjs',import.meta.url).href)};try{await prepareCandidate();process.exitCode=1}catch(e){console.log(e.message)}`;
  const result=spawnSync(process.execPath,['--input-type=module','-e',source],{encoding:'utf8',env,timeout:10000});
  assert.equal(result.error,undefined,result.error?.message);assert.equal(result.status,0,result.stderr);assert.equal(result.stdout.trim(),'SUPERVISION_UNAVAILABLE');assert.doesNotMatch(result.stderr,/unsettled top-level await/i);
});
