import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { createStardustServer } from '../apps/server/dist/app.js';
import { createConfigStore } from '../apps/server/dist/config.js';
import { SetupService } from '../apps/server/dist/setup.js';
import { ExtensionManager } from '../apps/server/dist/extension-manager.js';

const root=mkdtempSync(join(tmpdir(),'stardust-setup-browser-')),profile=join(root,'chrome');
const setup=new SetupService(createConfigStore(root)),extensions=new ExtensionManager(root,undefined,[]);
const server=createStardustServer({setupService:setup,extensionManager:extensions});
let chrome,socket;
async function until(fn){for(let i=0;i<200;i++){if(await fn())return;await wait(50);}throw Error('等待浏览器状态超时');}
try {
  server.listen(0,'127.0.0.1');await once(server,'listening');const origin=`http://127.0.0.1:${server.address().port}`;
  chrome=spawn(process.env.STARDUST_TEST_CHROME??'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',['--headless=new','--disable-gpu','--no-first-run','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{windowsHide:true,stdio:'ignore'});
  let launchError;chrome.on('error',e=>{launchError=e});let port;await until(()=>{if(launchError)throw launchError;try{port=readFileSync(join(profile,'DevToolsActivePort'),'utf8').split('\n')[0];return true}catch{return false}});
  const targets=await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();socket=new WebSocket(targets.find(x=>x.type==='page').webSocketDebuggerUrl);await once(socket,'open');
  let id=0;const pending=new Map();socket.addEventListener('message',event=>{const m=JSON.parse(event.data),p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}});
  const send=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});socket.send(JSON.stringify({id:n,method,params}));});
  const evalJS=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.text);return r.result.value;};
  await send('Page.navigate',{url:origin});await until(()=>evalJS('document.querySelector("#setup-dialog")?.open'));
  assert.equal(await evalJS('!!document.querySelector("#setup-host, #setup-port, #summary-host, #summary-port")'),false);
  await evalJS('document.querySelector("#setup-next").click()');await evalJS('document.querySelector("#setup-title").value="浏览器测试"');await evalJS('document.querySelector("#setup-next").click()');
  assert.equal(await evalJS('document.querySelector("#setup-submit").hidden'),false);
  await evalJS('document.querySelector("#setup-submit").click()');await until(async()=>await evalJS('!document.querySelector("#setup-dialog").open'));
  assert.equal(setup.getInitializationState().initialized,true);
  await send('Page.reload');await until(()=>evalJS('document.title.includes("浏览器测试")'));assert.equal(await evalJS('document.querySelector("#setup-dialog").open'),false);
  await evalJS('location.hash="/settings/server"');await until(()=>evalJS('!!document.querySelector("#server-settings-port").value'));
  await evalJS('document.querySelector("#server-settings-port").value="8080";document.querySelector("#server-settings-form").requestSubmit()');await until(()=>evalJS('document.querySelector("#server-settings-feedback").textContent.includes("已保存")'));
  assert.equal(setup.getSetupConfig().server.port,8080);assert.equal(await evalJS('document.querySelector("#server-running-port").textContent'),String(server.address().port));
  console.log('浏览器初始化、刷新及端口设置通过');
} finally {socket?.close();chrome?.kill();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await extensions.shutdown();try{rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100})}catch{}}
