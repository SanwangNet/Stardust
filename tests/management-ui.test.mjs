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
  const overrides={document,window,location,sessionStorage:{getItem:()=>JSON.stringify({previous:null,time:Date.now()}),setItem(){},removeItem(){}},
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
  assert.doesNotMatch(elements.get('backup-feedback').textContent,/等待服务恢复/);
  response=()=>Promise.resolve(new Response('',{status:403})); await poll();
  assert.match(elements.get('update-feedback').textContent,/HTTP 403/);
  response=()=>Promise.resolve(new Response('invalid')); await poll();
  assert.match(elements.get('update-feedback').textContent,/响应无效/);
  response=()=>Promise.resolve(Response.json({enabled:true,pending:false,version:'1',runningSha:'a',current:null,job:null,lastDeployment:null,latest:null,versions:[],backups:[]}));
  await poll();
  assert.match(elements.get('update-feedback').textContent,/确认请求/);
});
