import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cpSync,mkdtempSync,mkdirSync,readFileSync,renameSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {prepareCandidate,runCommand} from '../scripts/updater/prepare.mjs';

function git(cwd,...args){return execFileSync('git',args,{cwd,encoding:'utf8',env:{...process.env,GIT_AUTHOR_NAME:'Test',GIT_AUTHOR_EMAIL:'test@example.invalid',GIT_COMMITTER_NAME:'Test',GIT_COMMITTER_EMAIL:'test@example.invalid'}}).trim();}
function fixture(t){const root=mkdtempSync(join(tmpdir(),'updater-build-')),repo=join(root,'repo'),deploy=join(root,'deploy');mkdirSync(repo);mkdirSync(deploy);git(repo,'init','--quiet');
 const hash=git(repo,'hash-object','-w','--stdin'); // empty blob; build files are generated in staging
 git(repo,'update-index','--add','--cacheinfo',`100644,${hash},tracked.txt`);const tree=git(repo,'write-tree'),sha=git(repo,'commit-tree',tree,'-m','fixture');git(repo,'update-ref','refs/heads/main',sha);
 t.after(()=>rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100}));return{root,repo,deploy,sha};}
const artifacts=['package.json','package-lock.json','apps/server/dist/main.js','apps/server/dist/app.js','apps/server/dist/extensions/index.js','apps/server/dist/extensions/qq-bot.js','apps/server/dist/context-worker.js','apps/server/dist/people-management-worker.js','apps/web/dist/index.html','apps/web/dist/main.js','apps/web/dist/style.css','apps/web/dist/favicon.svg','apps/web/dist/fonts/wght.css','node_modules/@iarna/toml/package.json','node_modules/@tencent-connect/qqbot-nodejs/package.json','tests/example.test.mjs'];
function adapter(f,{fail,wrongHead=false,missing=false}={}){const calls=[];return{uid:1000,remote:()=>({target:f.sha}),calls,async run(command,args,options){calls.push({command,args,options});assert.equal(options.env.STARDUST_MODEL_API_KEY,undefined);assert.notEqual(options.env.STARDUST_STORAGE_ROOT,process.env.STARDUST_STORAGE_ROOT);
 if(fail && ((fail==='dependencies'&&args[0]==='ci')||(fail==='check'&&args[0]==='run'&&args[1]==='check')||(fail==='build'&&args[0]==='run'&&args[1]==='build')||(fail==='test'&&args.includes('--test'))))throw Error('COMMAND_FAILED');
 if(command==='git'){if(args[0]==='rev-parse'&&wrongHead)return 'a'.repeat(40);if(args.includes('fetch')){cpSync(join(f.repo,'.git','objects'),join(options.cwd,'.git','objects'),{recursive:true});writeFileSync(join(options.cwd,'.git','FETCH_HEAD'),f.sha+'\t\tbranch main\n');return '';}return git(options.cwd,...args);}
 if(command==='mv'){renameSync(args.at(-2),args.at(-1));return '';}
 if(args[0]==='run'&&args[1]==='build')for(const path of artifacts){if(missing&&path==='apps/web/dist/index.html')continue;const file=join(options.cwd,path);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,'test');}
 if(args[0]==='run'&&args[1]==='build')writeFileSync(join(options.cwd,'package.json'),JSON.stringify({scripts:{test:'npm run build && node --experimental-sqlite --test tests/*.test.mjs'}}));
 return args[0]==='--version'?'11.0.0':'';}};}

test('real Git checkout pins the selected SHA, publishes only complete artifacts and reuses candidate',async t=>{const f=fixture(t),a=adapter(f);process.env.STARDUST_MODEL_API_KEY='must-not-leak';t.after(()=>delete process.env.STARDUST_MODEL_API_KEY);
 const result=await prepareCandidate({root:f.deploy},a);assert.equal(result.sha,f.sha);assert.equal(result.deployed,false);assert.equal(git(result.path,'rev-parse','HEAD'),f.sha);
 const meta=JSON.parse(readFileSync(join(result.path,'.stardust-candidate.json'),'utf8'));assert.equal(meta.sha,f.sha);assert.equal(meta.status,'prepared');assert.equal(existsSync(join(result.path,'data')),false);
 assert.equal((await prepareCandidate({root:f.deploy},a)).status,'already_prepared');assert.equal(existsSync(join(f.deploy,'current')),false);
});
test('remote advancing after planning cannot change the fetch target',async t=>{const f=fixture(t),a=adapter(f);let calls=0;a.remote=()=>{calls++;return {target:calls===1?f.sha:'b'.repeat(40)};};const result=await prepareCandidate({root:f.deploy,sha:f.sha},a);assert.equal(calls,1);assert.equal(result.sha,f.sha);assert.equal(a.calls.find(x=>x.args.includes('fetch')).args.at(-1),f.sha);});
for(const fail of ['dependencies','check','build','test','missing','sha'])test(`failure ${fail} leaves no candidate and no shared changes`,async t=>{const f=fixture(t),a=adapter(f,{fail,missing:fail==='missing',wrongHead:fail==='sha'});mkdirSync(join(f.deploy,'shared'));writeFileSync(join(f.deploy,'shared','keep'),'unchanged');
 await assert.rejects(prepareCandidate({root:f.deploy},a));assert.equal(existsSync(join(f.deploy,'releases',f.sha)),false);assert.equal(readFileSync(join(f.deploy,'shared','keep'),'utf8'),'unchanged');
});
test('rejects root, invalid paths, invalid SHA and pre-existing unknown directory',async t=>{const f=fixture(t);await assert.rejects(prepareCandidate({root:f.deploy},{uid:0}),/ROOT_BUILD_FORBIDDEN/);await assert.rejects(prepareCandidate({root:'relative'},adapter(f)),/INVALID_ROOT/);await assert.rejects(prepareCandidate({root:f.deploy,sha:'../bad'},adapter(f)),/INVALID_SHA/);mkdirSync(join(f.deploy,'releases',f.sha),{recursive:true});await assert.rejects(prepareCandidate({root:f.deploy},adapter(f)),/CANDIDATE_CONFLICT/);});
test('same SHA reservation prevents concurrent preparation without removing unknown files',async t=>{const f=fixture(t);const lock=join(f.deploy,'releases','.staging',f.sha+'.lock');mkdirSync(lock,{recursive:true});writeFileSync(join(lock,'keep'),'owned elsewhere');await assert.rejects(prepareCandidate({root:f.deploy},adapter(f)),/PREPARE_IN_PROGRESS/);assert.equal(readFileSync(join(lock,'keep'),'utf8'),'owned elsewhere');});
test('command execution respects cancellation and timeout',async()=>{await assert.rejects(runCommand(process.execPath,['-e','setInterval(()=>{},1000)'],{env:process.env,timeout:100,signal:undefined}),/TIMEOUT/);const c=new AbortController();c.abort();await assert.rejects(runCommand(process.execPath,[],{env:process.env,timeout:1000,signal:c.signal}),/CANCELLED/);});
