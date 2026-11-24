import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, cpSync, existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

test('two application versions share the durable storage root across processes', t=>{
 const root=mkdtempSync(join(process.cwd(),'.storage-root-test-')),storage=join(root,'shared');mkdirSync(storage);
 t.after(()=>rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
 const versions=['v1','v2'].map(name=>{const dir=join(root,name);mkdirSync(join(dir,'apps','server'),{recursive:true});cpSync('apps/server/dist',join(dir,'apps','server','dist'),{recursive:true});mkdirSync(join(dir,'apps','web'),{recursive:true});cpSync('apps/web/dist',join(dir,'apps','web','dist'),{recursive:true});appendFileSync(join(dir,'apps','web','dist','index.html'), '<!-- static-'+name+' -->');return dir;});
 const driver=join(root,'run.mjs');writeFileSync(driver,`
import assert from 'node:assert/strict'; import {join} from 'node:path'; import {pathToFileURL} from 'node:url'; import {randomUUID} from 'node:crypto'; import {DatabaseSync} from 'node:sqlite';
const [app,mode,storage]=process.argv.slice(2);const load=async name=>import(pathToFileURL(join(app,'apps/server/dist',name+'.js')).href);
const env=await load('env'); const {SetupService}=await load('setup');const {createSecretStore}=await load('model-secret');const {ConversationService}=await load('conversation');const {FlowPublication}=await load('flow-publication');const {ExtensionManager}=await load('extension-manager');const {createQQBotExtension}=await load('extensions/qq-bot');const {PeopleManagementReader}=await load('people-management');
assert.equal(env.runtimePaths.storageRoot,storage);assert.equal(env.runtimePaths.applicationRoot.replace(/[\\\\/]$/,''),app);process.chdir(storage);assert.equal(env.projectConfigRoot,storage);
const setup=new SetupService(),secret=createSecretStore(),model={chatContext:async()=> '答复'},store=new ConversationService(model),manager=new ExtensionManager(undefined,model,[createQQBotExtension(async()=>{throw Error('not started')})]);
if(mode==='write') {assert.equal(setup.getInitializationState().initialized,false);const {createStardustServer}=await load('app');const {once}=await import('node:events');const mock={restore:async()=>{},shutdown:async()=>{},availableTools:()=>[],availableTargets:()=>[]};const web=createStardustServer({setupService:setup,extensionManager:mock,modelService:model});web.listen(0,'127.0.0.1');await once(web,'listening');const origin='http://127.0.0.1:'+web.address().port;const result=await fetch(origin+'/api/v1/setup/complete',{method:'POST',headers:{origin,'content-type':'application/json'},body:'{}'});assert.equal(result.status,200);web.closeAllConnections();await new Promise(r=>web.close(r));secret.saveKey('test-secret');await manager.install('qq-bot');await manager.saveConfig('qq-bot',{appId:'123',appSecret:'qq-secret'});const c=store.create('持久会话');await store.submit(c.id,randomUUID(),'历史正文');store.people.observeIdentity({providerId:'qq',accountId:'bot',identityType:'qq_c2c_user',scope:{kind:'account'},externalId:'person',observedAt:'2025-01-01T00:00:00.000Z',source:'test'});const db=new DatabaseSync(store.databasePath);db.prepare("INSERT INTO global_context_entries(id,owner,topic,content,created_at,updated_at,version) VALUES('memory','web:default','主题','持久记忆','2025','2025',1)").run();db.close();const flow=new FlowPublication();flow.save(flow.read().revision,{recent:true,global:false,search:true});}
else {assert.equal(setup.getInitializationState().initialized,true);assert.equal(secret.getKey().fileKey,'test-secret');assert.equal(manager.list().find(x=>x.id==='qq-bot').installed,true);assert.equal(env.createEnvLoader().loadExtensionEnv('qq-bot').configured,true);assert.equal(store.list()[0].title,'持久会话');assert.equal(store.messages(store.list()[0].id)[0].content,'历史正文');assert.equal(store.globalContext.entries('web:default')[0].content,'持久记忆');assert.equal(new FlowPublication().read().draft.global,false);const reader=new PeopleManagementReader();assert.equal((await reader.query(store.databasePath,store.people,'people',['',10,0])).length,1);reader.shutdown();}
assert.equal(store.databasePath,env.runtimePaths.conversationDatabasePath);
const {createStardustServer}=await load('app');const {once}=await import('node:events');const server=createStardustServer({setupService:setup,extensionManager:manager,modelService:model,conversationService:store});server.listen(0,'127.0.0.1');await once(server,'listening');const response=await fetch('http://127.0.0.1:'+server.address().port+'/');assert.match(await response.text(),new RegExp('static-'+(mode==='write'?'v1':'v2')));server.closeAllConnections();await new Promise(r=>server.close(r));await manager.shutdown();
`);
 const env={...process.env,STARDUST_STORAGE_ROOT:storage};for(const [index,version] of versions.entries())execFileSync(process.execPath,['--experimental-sqlite',driver,version,index?'read':'write',storage],{env,stdio:'pipe',timeout:30000});
 for(const file of ['config.toml','.env','env/qq-bot/.env','data/conversations.sqlite','data/extensions.json','data/flow-publication.json'])assert.ok(existsSync(join(storage,file)),file);
 for(const version of versions)for(const name of ['config.toml','.env','env','data'])assert.equal(existsSync(join(version,name)),false,name);
});

test('configured storage retains extension traversal and symlink protection',t=>{
 const root=mkdtempSync(join(process.cwd(),'.storage-security-')),storage=join(root,'shared'),outside=join(root,'outside');mkdirSync(storage);mkdirSync(outside);
 t.after(()=>rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
 try {symlinkSync(outside,join(storage,'env'),'junction');} catch(error) {t.skip('环境不允许创建符号链接: '+error.code);return;}
 const code=`import(${JSON.stringify(new URL('file:///'+join(process.cwd(),'apps/server/dist/env.js').replaceAll('\\','/')).href)}).then(({createEnvLoader})=>{const loader=createEnvLoader();for(const id of ['../outside','qq-bot']){try{loader.loadExtensionEnv(id);process.exitCode=1}catch{}}})`;
 const result=spawnSync(process.execPath,['-e',code],{env:{...process.env,STARDUST_STORAGE_ROOT:storage},encoding:'utf8'});assert.equal(result.status,0,result.stderr);
});

test('storage root validation fails closed and default remains application root',()=>{
 const entry=join(process.cwd(),'apps/server/dist/env.js');const code=`import(${JSON.stringify(new URL('file:///'+entry.replaceAll('\\','/')).href)}).then(x=>console.log(JSON.stringify(x.runtimePaths)))`;
 const base={...process.env};delete base.STARDUST_STORAGE_ROOT;
 const run=value=>spawnSync(process.execPath,['-e',code],{env:value===undefined?base:{...base,STARDUST_STORAGE_ROOT:value},encoding:'utf8'});
 const good=run();assert.equal(good.status,0);const paths=JSON.parse(good.stdout);assert.equal(paths.storageRoot,paths.applicationRoot);
 for(const value of ['relative-path','',join(process.cwd(),'missing-storage-root-83')]){const failed=run(value);assert.notEqual(failed.status,0);assert.match(failed.stderr,/STARDUST_STORAGE_ROOT/);}
});

test('extension traversal remains rejected under an explicit storage root',t=>{
 const root=mkdtempSync(join(process.cwd(),'.storage-traversal-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const code=`import(${JSON.stringify(new URL('file:///'+join(process.cwd(),'apps/server/dist/env.js').replaceAll('\\','/')).href)}).then(({createEnvLoader})=>{try{createEnvLoader().loadExtensionEnv('../outside');process.exitCode=1}catch{}})`;
 const result=spawnSync(process.execPath,['-e',code],{env:{...process.env,STARDUST_STORAGE_ROOT:root},encoding:'utf8'});assert.equal(result.status,0,result.stderr);
});
