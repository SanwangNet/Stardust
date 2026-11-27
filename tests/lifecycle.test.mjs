import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readlink, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canRollback, lifecycle, parseSystemdProperties, retainedVersions, validateRequest } from '../scripts/lifecycle/manage.mjs';
import { releases } from '../scripts/lifecycle/files.mjs';
import { createManagement } from '../apps/server/dist/management.js';
import { createStardustServer } from '../apps/server/dist/app.js';

const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', a='a'.repeat(40), b='b'.repeat(40), c='c'.repeat(40);
const release=(sha,sequence,dataFormat=1)=>({format:1,sha,sequence,version:'0.1.0',dataFormat,platform:'linux-x64',node:24,manager:1});
const archiveHelper=fileURLToPath(new URL('../scripts/lifecycle/archive.py',import.meta.url));
const python=process.env.STARDUST_TEST_PYTHON ?? (process.platform==='linux'?'/usr/bin/python3':null);
test('systemd properties retain equals signs in environment values',()=>{
  assert.deepEqual(parseSystemdProperties('User=stardust\r\nEnvironment=STARDUST_STORAGE_ROOT=/opt/stardust/shared OTHER=a=b\r\nEnvironmentFiles=\r\n'),{
    User:'stardust',Environment:'STARDUST_STORAGE_ROOT=/opt/stardust/shared OTHER=a=b',EnvironmentFiles:''
  });
});
async function temp(t){
  const root=await realpath(await mkdtemp(join(tmpdir(),'stardust-lifecycle-')));
  t.after(()=>rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  return root;
}

test('atomic JSON preserves explicit modes under umask 0077, including replacements', {skip:process.platform!=='linux'}, async t=>{
  const root=await temp(t), moduleUrl=new URL('../scripts/lifecycle/files.mjs',import.meta.url).href;
  await chmod(root,0o750);
  const script=`import {atomicJson} from ${JSON.stringify(moduleUrl)};
    process.umask(0o077);
    const gid=process.getuid()===0?process.getgid():undefined;
    await atomicJson(process.argv[1],{format:1,revision:1},0o640,gid);
    await atomicJson(process.argv[1],{format:1,revision:2},0o640,gid);
    await atomicJson(process.argv[2],{private:true},0o600);`;
  const status=join(root,'status.json'), config=join(root,'config.json');
  execFileSync(process.execPath,['--input-type=module','-e',script,status,config]);
  assert.equal((await stat(status)).mode&0o777,0o640);
  assert.equal((await stat(config)).mode&0o777,0o600);
  assert.equal(JSON.parse(await readFile(status,'utf8')).revision,2);
  if(process.getuid()===0){
    const bytes=execFileSync(process.execPath,['-e','process.stdout.write(require("fs").readFileSync(process.argv[1],"utf8"))',status],{uid:65534,gid:process.getgid()});
    assert.equal(JSON.parse(bytes.toString()).revision,2);
  }
});

test('management accepts only fixed operations with typed immutable identifiers',()=>{
  assert.deepEqual(validateRequest({id,operation:'rollback',target:a}),{id,operation:'rollback',target:a});
  for(const value of [
    {id,operation:'update',target:'https://example.com/anything'},
    {id,operation:'backup',path:'/opt/stardust/shared'},
    {id,operation:'delete',backup:'../shared'},
    {id,operation:'shell'}, {id:[id],operation:'check'}, {id,operation:'update',target:[a]},
  ])assert.throws(()=>validateRequest(value),/INVALID_REQUEST/);
  assert.equal(canRollback(null,release(a,1)),false);
  assert.equal(canRollback(release(a,1,2),release(b,2)),false);
  assert.equal(canRollback(release(a,1),release(b,2)),true);
  assert.deepEqual(retainedVersions([release(a,1),release(b,2),release(c,3)],a,2).map(v=>v.sha),[b]);
});

test('release checks use published assets and keep tokens off redirected downloads',async()=>{
  const manifest={...release(a,2),archive:'stardust-linux-x64.tar.gz',size:4,sha256:b.padEnd(64,'b'),message:'published'};
  const assets=[{name:manifest.archive,state:'uploaded',id:2,size:4},{name:'stardust-release.json',state:'uploaded',id:3}];
  const record={draft:false,prerelease:false,published_at:'2026-01-01',assets,tag_name:'main-2-'+a};
  let download=false;
  const remote=releases('private-test-token',async(url,options)=>{
    const href=String(url);
    if(href.includes('release-assets.githubusercontent.com')){
      assert.equal(options.headers,undefined);
      download=true;return Response.json(manifest);
    }
    assert.equal(options.headers.Authorization,'Bearer private-test-token');
    if(href.endsWith('per_page=30'))return Response.json([{...record,draft:true,tag_name:'main-3-'+b},record,{...record,assets:[],tag_name:'main-4-'+c}]);
    assert.ok(href.endsWith('/assets/3'));
    return new Response('',{status:302,headers:{Location:'https://release-assets.githubusercontent.com/asset'}});
  });
  assert.equal((await remote.latest()).sha,a);
  assert.equal(download,true);
});

test('Core queues fixed requests through the filesystem, rejects cross-origin writes and gates downloads',async t=>{
  const root=await temp(t);
  await mkdir(join(root,'management','inbox'),{recursive:true});
  await mkdir(join(root,'backups'));
  await writeFile(join(root,'management','status.json'),JSON.stringify({format:1,job:null,versions:[],backups:[],latest:null}),{mode:0o600});
  await writeFile(join(root,'backups',id+'.tar.gz'),'private',{mode:0o600});
  const owner=process.getuid?.() ?? 0;
  const management=createManagement(true,root,owner);
  const setup={getInitializationState:()=>({initialized:true}),getSetupConfig:()=>({web:{title:'Stardust'}})};
  const extensions={restore:async()=>{},shutdown:async()=>{},availableTools:()=>[]};
  const app=createStardustServer({management,setupService:setup,extensionManager:extensions});
  app.listen(0,'127.0.0.1');await once(app,'listening');
  t.after(()=>{app.closeAllConnections();return new Promise(resolve=>app.close(resolve));});
  const origin='http://127.0.0.1:'+app.address().port;
  const post=(body,source=origin)=>fetch(origin+'/api/v1/management/request',{method:'POST',headers:{Origin:source,'Content-Type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await post({operation:'check',url:'https://example.com'})).status,400);
  assert.equal((await post({operation:'backup'},'http://example.com')).status,403);
  const queued=await post({operation:'backup'});
  assert.equal(queued.status,202);
  assert.deepEqual(JSON.parse(await readFile(join(root,'management','inbox','request.json'),'utf8')),{operation:'backup',id:(await queued.json()).id});
  assert.equal((await post({operation:'backup'})).status,409);
  await import('node:fs/promises').then(fs=>fs.unlink(join(root,'management','inbox','request.json')));
  const uploaded=await fetch(origin+'/api/v1/management/upload',{method:'POST',headers:{Origin:origin,'Content-Type':'application/gzip'},body:'fixture'});
  assert.equal(uploaded.status,202);
  const uploadId=(await uploaded.json()).id;
  assert.equal(await readFile(join(root,'management','inbox',uploadId+'.tar.gz'),'utf8'),'fixture');
  assert.equal(await (await fetch(origin+'/api/v1/management/backups/'+id)).text(),'private');
  await assert.rejects(createManagement(false,root,owner).download(id),/MANAGEMENT_DISABLED/);
});

test('archive helper preserves ordinary backups and rejects escaping paths and links',{skip:!python},async t=>{
  const root=await temp(t),shared=join(root,'shared'),archive=join(root,'safe.tar.gz'),output=join(root,'out');
  await mkdir(shared);await mkdir(output);await writeFile(join(shared,'.env'),'SECRET=fixture');
  await writeFile(join(root,'backup.json'),JSON.stringify({format:2,version:a,dataFormat:1,createdAt:'2026-01-01'}));
  execFileSync(python,['-I',archiveHelper,'backup',archive,shared,join(root,'backup.json')]);
  execFileSync(python,['-I',archiveHelper,'extract',archive,output,'backup']);
  assert.equal(await readFile(join(output,'shared','.env'),'utf8'),'SECRET=fixture');
  const bad=join(root,'unsafe.tar.gz');
  const create="import tarfile,sys; f=tarfile.open(sys.argv[1],'w:gz'); i=tarfile.TarInfo(sys.argv[2]); i.type=tarfile.SYMTYPE if sys.argv[3]=='link' else tarfile.REGTYPE; i.linkname='../../outside'; f.addfile(i); f.close()";
  for(const [path,mode] of [['shared/../../outside','file'],['shared/link','link'],['/shared/file','file']]){
    execFileSync(python,['-I','-c',create,bad,path,mode]);
    const result=await import('node:child_process').then(({spawnSync})=>spawnSync(python,['-I',archiveHelper,'extract',bad,output,'backup'],{encoding:'utf8'}));
    assert.equal(result.status,1);
    assert.match(result.stderr,/UNSAFE_ARCHIVE/);
  }
});

test('real Linux files: update backs up shared, switches versions, and restores matching data',{skip:process.platform!=='linux'||process.getuid()!==0},async t=>{
  const root=await temp(t);
  for(const path of ['releases','backups','shared','management','management/private','management/inbox'])await mkdir(join(root,path),{mode:0o700});
  const shared=join(root,'shared','.env');
  await writeFile(shared,'original');
  await mkdir(join(root,'releases',a),{mode:0o755});
  await writeFile(join(root,'releases',a,'version.json'),JSON.stringify(release(a,1)));
  await symlink('releases/'+a,join(root,'current'));
  const operations=[],archive=(...args)=>execFileSync(python,['-I',archiveHelper,...args]);
  let active=true, newest=release(b,2,2);
  const remote={latest:async()=>newest,download:async(target,path)=>{
    const staging=join(root,'payload-'+target.sequence);await mkdir(staging);
    for(const item of ['apps/server/dist/main.js','apps/web/dist/index.html','node_modules/@iarna/toml/package.json','node_modules/@tencent-connect/qqbot-nodejs/package.json']){
      await mkdir(join(staging,item,'..'),{recursive:true});
      await writeFile(join(staging,item),'fixture');
    }
    await writeFile(join(staging,'version.json'),JSON.stringify(target));
    await writeFile(join(staging,'package.json'),JSON.stringify({version:target.version}));
    execFileSync('tar',['-czf',path,'-C',staging,'apps','node_modules','version.json','package.json']);
  }};
  const control=async(command)=>{
    if(command==='stop'){active=false;operations.push('stop');return {stdout:''};}
    if(command==='start'){active=true;operations.push('start');return {stdout:''};}
    return {stdout:[`WorkingDirectory=${root}/current`,`Environment=STARDUST_STORAGE_ROOT=${root}/shared`,'User=stardust','Group=stardust','KillMode=control-group','Delegate=no','ActiveState=inactive','MainPID=0'].join('\n')};
  };
  const manager=await lifecycle({root,config:{uid:0,gid:0,enabled:true,retainVersions:3,retainAutomaticBackups:3},remote,control,
    extract:(...args)=>{if(args[0]==='backup')assert.equal(active,false);return archive(...args);},verifyHealth:async sha=>assert.equal(await readlink(join(root,'current')),'releases/'+sha)});
  assert.equal((await manager.run({id,operation:'update',target:b})).result,'success');
  assert.equal(await readFile(shared,'utf8'),'original');
  assert.deepEqual(operations,['stop','start']);
  assert.equal((await manager.run({id,operation:'rollback',target:a})).reason,'INCOMPATIBLE_ROLLBACK');
  const status=JSON.parse(await readFile(join(root,'management','status.json'),'utf8'));
  assert.equal(status.backups[0].kind,'automatic');
  await writeFile(shared,'later');
  assert.equal((await manager.run({id,operation:'restore',backup:status.backups[0].id})).result,'success');
  assert.equal(await readFile(shared,'utf8'),'original');
  assert.equal(await readlink(join(root,'current')),'releases/'+a);
  const after=JSON.parse(await readFile(join(root,'management','status.json'),'utf8'));
  assert.equal(after.backups.some(x=>x.kind==='safety'),true);
});
