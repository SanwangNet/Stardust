import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

test('configuration tests remain isolated under the updater storage environment',t=>{
  // A short workspace-local temporary path also avoids nested Windows MAX_PATH
  // failures when the outer updater environment already has a deep TMPDIR.
  const root=mkdtempSync(join(process.cwd(),'.updater-test-environment-')),home=join(root,'home'),temp=join(root,'tmp'),storage=join(root,'storage');
  const resolved=realpathSync(root),within=relative(realpathSync(process.cwd()),resolved);
  assert.ok(within && within!=='..' && !within.startsWith('..'+sep) && !isAbsolute(within));
  for(const dir of [home,temp,storage])mkdirSync(dir);
  t.after(()=>rmSync(resolved,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
  const dotEnv='STARDUST_PORT=9\nINHERITED_SENTINEL=fixture-storage-only\n',toml='[server]\nport = 9\n';
  writeFileSync(join(storage,'.env'),dotEnv);writeFileSync(join(storage,'config.toml'),toml);
  const sourceNames=['config.toml','.env','env','data'],before=sourceNames.map(name=>existsSync(join(process.cwd(),name)));
  const env={PATH:process.env.PATH??'',HOME:home,USERPROFILE:home,TMPDIR:temp,TMP:temp,TEMP:temp,LANG:'C.UTF-8',CI:'true',STARDUST_STORAGE_ROOT:storage,
    ...(process.platform==='win32'?{SystemRoot:process.env.SystemRoot,ComSpec:process.env.ComSpec,PATHEXT:process.env.PATHEXT}:{})};
  const result=spawnSync(process.execPath,['--experimental-sqlite','--test','--test-concurrency=2','tests/config.test.mjs','tests/env.test.mjs','tests/storage-root.test.mjs','tests/setup-flow.test.mjs','tests/extensions.test.mjs'],{cwd:process.cwd(),env,encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024});
  assert.equal(result.error,undefined,result.error?.message);assert.equal(result.status,0,`${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout,/从其他工作目录启动时读取项目根 TOML/);assert.match(result.stdout,/从其他工作目录启动时使用项目根 .env/);assert.match(result.stdout,/模块启动时分别解析默认和显式 Storage Root/);
  assert.match(result.stdout,/HTTP 初始化校验、来源检查、上限和持久化/);assert.match(result.stdout,/capability API accepts only two validated PNG parts/);
  assert.equal(readFileSync(join(storage,'.env'),'utf8'),dotEnv);assert.equal(readFileSync(join(storage,'config.toml'),'utf8'),toml);assert.deepEqual(readdirSync(storage).sort(),['.env','config.toml']);
  assert.deepEqual(sourceNames.map(name=>existsSync(join(process.cwd(),name))),before);
});
