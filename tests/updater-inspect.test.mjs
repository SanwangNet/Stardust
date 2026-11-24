import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from '../scripts/updater/inspect.mjs';
import { checkRemote, REPOSITORY } from '../scripts/updater/check.mjs';

test('deployment inventory checks types without reading secrets or invoking a shell', t=>{
 const root=mkdtempSync(join(tmpdir(),'stardust-inventory-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 mkdirSync(join(root,'data'));writeFileSync(join(root,'.env'),'SECRET_VALUE');let call;
 const result=inspect(root,'stardust.service',(...args)=>{call=args;return 'Id=stardust.service\nUser=stardust\nActiveState=active\n';});
 assert.equal(result.paths.data,'directory');assert.equal(result.paths['.env'],'file');assert.equal(result.paths['config.toml'],'missing');
 assert.equal(result.systemd.User,'stardust');assert.equal(call[0],'systemctl');assert.ok(call[1].includes('--'));assert.ok(!JSON.stringify(result).includes('SECRET_VALUE'));
});
test('remote check validates and fixes one SHA without accepting a repository URL',()=>{
 const sha='a'.repeat(40);let args;
 const fake=(...a)=>{args=a;return `${sha}\trefs/heads/main\n`;};
 assert.equal(checkRemote('main',sha,fake).status,'no_update');
 assert.equal(checkRemote('main','b'.repeat(40),fake).target,sha);
 assert.equal(args[0],'git');assert.ok(args[1].includes(REPOSITORY));assert.equal(args[2].env.GIT_TERMINAL_PROMPT,'0');
 assert.throws(()=>checkRemote('../main',null,fake),/INVALID_BRANCH/);
 assert.throws(()=>checkRemote('main','bad',fake),/INVALID_CURRENT_SHA/);
 assert.throws(()=>checkRemote('main',null,()=>{throw Error('secret');}),/REMOTE_CHECK_FAILED/);
 assert.throws(()=>checkRemote('main',null,()=>`${sha}\trefs/heads/other\n`),/INVALID_REMOTE_RESPONSE/);
});
test('inventory rejects relative paths and injected service names',()=>{
 assert.throws(()=>inspect('relative','stardust.service'),/INVALID_ROOT/);
 assert.throws(()=>inspect(process.cwd(),'x.service;touch pwned'),/INVALID_SERVICE/);
});
