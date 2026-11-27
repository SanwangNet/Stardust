import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root=await realpath(process.argv[2]);
const expected=JSON.parse(await readFile(join(root,'version.json'),'utf8'));
assert.deepEqual((await readdir(root)).sort(),['apps','lifecycle','node_modules','package.json','version.json']);
assert.deepEqual((await readdir(join(root,'lifecycle'))).sort(),['archive.py','files.mjs','manage.mjs','running-port.mjs']);
for(const name of ['node_modules/typescript','node_modules/vite','apps/server/src','apps/web/src','.env','data','shared'])await assert.rejects(access(join(root,name)),{code:'ENOENT'});
const storage=await mkdtemp(join(tmpdir(),'stardust-release-smoke-'));
const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');
const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
const child=spawn(process.execPath,['--experimental-sqlite',join(root,'apps/server/dist/main.js')],{
  cwd:storage,env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,STARDUST_HOST:'127.0.0.1',STARDUST_PORT:String(port),STARDUST_STORAGE_ROOT:storage},stdio:['ignore','pipe','pipe'],
});
let errorLog='';
child.stderr.on('data',chunk=>{errorLog=(errorLog+chunk).slice(-3000);});
child.stdout.resume();
try{
  const base=`http://127.0.0.1:${port}`;
  let health;
  for(let i=0;i<100&&child.exitCode===null;i++){
    try{health=await (await fetch(base+'/api/health',{signal:AbortSignal.timeout(700)})).json();break;}catch{await new Promise(resolve=>setTimeout(resolve,100));}
  }
  assert.equal(health?.runningSha,expected.sha,errorLog);
  assert.equal(health.status,'ok');
  assert.match(await (await fetch(base)).text(),/Stardust/);
  assert.equal((await fetch(base+'/management-ui.js')).status,200);
  const setup=await fetch(base+'/api/v1/setup/complete',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:'{}'});
  assert.equal(setup.status,200,await setup.text());
  assert.equal((await (await fetch(base+'/api/v1/setup/state')).json()).initialized,true);
  assert.ok((await readdir(storage)).includes('config.toml'));
  console.log('Standalone Stardust package started, served WebUI, and initialized isolated storage.');
}finally{
  if(child.exitCode===null&&child.signalCode===null){child.kill();await once(child,'exit');}
  await rm(storage,{recursive:true,force:true,maxRetries:8,retryDelay:100});
}
