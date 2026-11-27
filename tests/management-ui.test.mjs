import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initManagement } from '../apps/web/dist/management-ui.js';

test('management UI distinguishes network failures, HTTP failures and invalid status responses', async t=>{
  class Element extends EventTarget {
    textContent=''; disabled=false; value=''; files=[]; children=[];
    append(...items){this.children.push(...items);}
    replaceChildren(...items){this.children=items;}
  }
  const elements=new Map();
  const document={hidden:false,getElementById(id){if(!elements.has(id))elements.set(id,new Element());return elements.get(id);},createElement(){return new Element();}};
  const window=new EventTarget(), location={hash:'#/settings/update'};
  let response=()=>Promise.reject(new TypeError('network'));
  const overrides={document,window,location,confirm:()=>true,sessionStorage:{getItem:()=>JSON.stringify({previous:null,time:Date.now(),operation:'update'}),setItem(){},removeItem(){}},
    fetch:(...args)=>response(...args),setInterval:()=>0};
  const old=Object.fromEntries(Object.keys(overrides).map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  for(const [key,value] of Object.entries(overrides))Object.defineProperty(globalThis,key,{value,configurable:true});
  t.after(()=>{for(const [key,descriptor] of Object.entries(old)){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}});
  const tick=()=>new Promise(resolve=>setImmediate(resolve));
  const poll=async()=>{window.dispatchEvent(new Event('hashchange'));await tick();};
  initManagement(); await tick();
  assert.match(elements.get('update-feedback').textContent,/连接暂时中断/);
  response=()=>Promise.resolve(new Response('',{status:503})); await poll();
  assert.match(elements.get('update-feedback').textContent,/HTTP 503/);
  assert.doesNotMatch(elements.get('backup-feedback').textContent,/HTTP 503|等待服务恢复/);
  for (const status of [502,504]) {
    response=()=>Promise.resolve(new Response('',{status})); await poll();
    assert.match(elements.get('update-feedback').textContent,/等待服务恢复/);
    assert.doesNotMatch(elements.get('backup-feedback').textContent,/等待服务恢复/);
  }
  response=()=>Promise.resolve(new Response('',{status:403})); await poll();
  assert.match(elements.get('update-feedback').textContent,/HTTP 403/);
  response=()=>Promise.resolve(new Response('invalid')); await poll();
  assert.match(elements.get('update-feedback').textContent,/响应无效/);
  response=()=>Promise.resolve(Response.json({enabled:true,pending:false,version:'1',runningSha:'a',current:null,job:null,lastDeployment:null,latest:null,versions:[],backups:[]}));
  await poll();
  assert.match(elements.get('update-feedback').textContent,/确认请求/);
  response=()=>Promise.resolve(Response.json({enabled:true,pending:false,version:'1',runningSha:'a',current:null,job:{id:'job',operation:'update',result:'failed',reason:'NETWORK_RESET',targetSha:null},lastDeployment:null,latest:null,versions:[],backups:[]}));
  await poll();
  assert.match(elements.get('update-feedback').textContent,/被重置/);
  assert.doesNotMatch(elements.get('backup-feedback').textContent,/被重置/);
  response=()=>Promise.resolve(new Response('',{status:502})); await poll();
  assert.match(elements.get('update-feedback').textContent,/HTTP 502/);
  response=()=>Promise.resolve(Response.json({enabled:true,pending:false,version:'1',runningSha:'a',current:null,job:{id:'backup',operation:'backup',phase:'BACKUP',result:'running',targetSha:'a'},lastDeployment:null,latest:null,versions:[],backups:[]}));
  await poll();
  response=()=>Promise.resolve(new Response('',{status:504})); await poll();
  assert.match(elements.get('backup-feedback').textContent,/等待服务恢复/);
  response=()=>Promise.resolve(Response.json({enabled:true,pending:false,version:'1',runningSha:'a',current:null,job:{id:'backup',operation:'backup',result:'success',targetSha:'a'},lastDeployment:null,latest:null,versions:[],backups:[]}));
  await poll();
  assert.match(elements.get('backup-feedback').textContent,/备份已创建/);
  assert.match(elements.get('update-feedback').textContent,/被重置/);
  response=url=>Promise.resolve(new Response('',{status:String(url).endsWith('/request')?502:504}));
  elements.get('backup-create').dispatchEvent(new Event('click'));
  await tick(); await tick();
  assert.match(elements.get('backup-feedback').textContent,/等待服务恢复/);
  response=()=>Promise.resolve(Response.json({enabled:true,pending:false,version:'1',runningSha:'a',current:null,job:{id:'backup2',operation:'backup',result:'failed',reason:'INTERRUPTED',targetSha:'a'},lastDeployment:null,latest:null,versions:[],backups:[]}));
  await poll();
  assert.match(elements.get('backup-feedback').textContent,/操作中断/);
  assert.match(elements.get('update-feedback').textContent,/被重置/);
});
