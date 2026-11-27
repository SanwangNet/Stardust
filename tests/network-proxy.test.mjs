import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStardustServer } from '../apps/server/dist/app.js';
import { createConfigStore } from '../apps/server/dist/config.js';
import { SetupService } from '../apps/server/dist/setup.js';
import { ExtensionManager } from '../apps/server/dist/extension-manager.js';
import { ConversationService } from '../apps/server/dist/conversation.js';
import { FlowPublication } from '../apps/server/dist/flow-publication.js';

const ip=process.env.STARDUST_TEST_NETWORK_IP;
const openSSL=process.env.STARDUST_TEST_OPENSSL??(process.platform==='win32'?'C:\\Program Files\\Git\\usr\\bin\\openssl.exe':'openssl');
function call({secure=false,port,path,method='GET',headers={},body}) {
  return new Promise((resolve,reject)=>{const req=(secure?httpsRequest:httpRequest)({hostname:ip,localAddress:ip,port,path,method,headers,rejectUnauthorized:false,servername:secure?'bot.lan.test':undefined},res=>{let text='';res.setEncoding('utf8');res.on('data',x=>text+=x);res.on('end',()=>resolve({status:res.statusCode,body:text?JSON.parse(text):null}));});req.on('error',reject);if(body!==undefined)req.write(JSON.stringify(body));req.end();});
}
test('non-loopback direct access and a separate HTTPS proxy retain origin and approval boundaries',{skip:!ip?'set STARDUST_TEST_NETWORK_IP to a real local non-loopback IPv4 address':false},async t=>{
  assert.ok(!ip.startsWith('127.'),'must use a non-loopback address');
  const root=mkdtempSync(join(tmpdir(),'stardust-network-test-')),key=join(root,'key.pem'),cert=join(root,'cert.pem');
  const generated=spawnSync(openSSL,['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=bot.lan.test'],{encoding:'utf8',windowsHide:true});
  assert.equal(generated.status,0,generated.stderr);
  const old=process.env.STARDUST_TRUSTED_PROXIES;process.env.STARDUST_TRUSTED_PROXIES=ip;
  const setup=new SetupService(createConfigStore(root)),model={chatContext:async()=> 'ok',getConfig:()=>({baseUrl:'',modelId:''})};
  const extensions=new ExtensionManager(root,model,[]),store=new ConversationService(model,join(root,'conversation.sqlite'));
  const server=createStardustServer({setupService:setup,extensionManager:extensions,conversationService:store,modelService:model,flowPublication:new FlowPublication(join(root,'flow.json'))});
  let actualPeer;server.on('connection',socket=>{actualPeer=socket.remoteAddress});
  server.listen(0,ip);await once(server,'listening');const port=server.address().port;
  const proxy=spawn(process.execPath,[fileURLToPath(new URL('./fixtures/https-proxy.mjs',import.meta.url)),ip,String(port),key,cert],{stdio:['ignore','pipe','pipe'],windowsHide:true});
  let proxyPort;try {const [chunk]=await once(proxy.stdout,'data');proxyPort=Number(String(chunk).trim());assert.ok(proxyPort>0);
    const directOrigin=`http://${ip}:${port}`,directHeaders={origin:directOrigin,'content-type':'application/json'};
    assert.equal((await call({port,path:'/api/v1/setup/state'})).status,200);
    assert.equal((await call({port,path:'/api/v1/setup/complete',method:'POST',headers:{...directHeaders,origin:'https://evil.example'},body:{}})).status,403);
    const publicHost=`bot.lan.test:${proxyPort}`,origin=`https://${publicHost}`,headers={host:publicHost,origin,'content-type':'application/json'};
    assert.equal((await call({secure:true,port:proxyPort,path:'/api/v1/setup/complete',method:'POST',headers,body:{web:{title:'Proxy'}}})).status,200);
    assert.equal(actualPeer.replace(/^::ffff:/,''),ip);
    for(const path of ['/api/v1/setup/state','/api/v1/model/config','/api/v1/conversations','/api/v1/agent/settings','/api/v1/global-context','/api/v1/extensions','/api/v1/flow-overview','/api/v1/flow-publication','/api/v1/capabilities','/api/v1/starcore-flows','/api/v1/logs','/api/v1/server/settings','/api/v1/control-session']) assert.equal((await call({secure:true,port:proxyPort,path,headers})).status,200,path);
    const control=await call({secure:true,port:proxyPort,path:'/api/v1/control-session',headers});
    for(const path of ['/api/v1/people','/api/v1/approvals']) assert.notEqual((await call({secure:true,port:proxyPort,path,headers:{...headers,'x-stardust-control-token':control.body.token}})).status,403,path);
    const created=await call({secure:true,port:proxyPort,path:'/api/v1/conversations',method:'POST',headers,body:{}});assert.equal(created.status,201);
    assert.equal((await call({secure:true,port:proxyPort,path:'/api/v1/server/settings',method:'POST',headers,body:{port:8080}})).status,200);
    assert.equal((await call({secure:true,port:proxyPort,path:'/api/v1/flow-publication/save',method:'POST',headers:{...headers,origin:'https://evil.example'},body:{}})).status,403);
    assert.equal((await call({port,path:'/api/v1/conversations'})).status,200);
    assert.equal((await call({port,path:'/api/v1/server/settings',method:'POST',headers:{'content-type':'application/json'},body:{port:1234}})).status,403);
  } finally {proxy.kill();if(proxy.exitCode===null)await once(proxy,'exit');server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await extensions.shutdown();if(old===undefined)delete process.env.STARDUST_TRUSTED_PROXIES;else process.env.STARDUST_TRUSTED_PROXIES=old;rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});


test('non-loopback direct access rejects forged forwarding and cross-origin writes',{skip:!ip?'set STARDUST_TEST_NETWORK_IP to a real local non-loopback IPv4 address':false},async t=>{
  const root=mkdtempSync(join(tmpdir(),'stardust-direct-test-')),old=process.env.STARDUST_TRUSTED_PROXIES;process.env.STARDUST_TRUSTED_PROXIES='';
  const setup=new SetupService(createConfigStore(root)),extensions=new ExtensionManager(root,undefined,[]),server=createStardustServer({setupService:setup,extensionManager:extensions});
  server.listen(0,ip);await once(server,'listening');const port=server.address().port,origin=`http://${ip}:${port}`;
  try {
    const headers={origin,'content-type':'application/json'};
    assert.equal((await call({port,path:'/api/v1/setup/complete',method:'POST',headers:{...headers,host:'bot.lan.test',origin:'https://bot.lan.test','x-forwarded-proto':'https'},body:{}})).status,403);
    assert.equal((await call({port,path:'/api/v1/setup/complete',method:'POST',headers:{...headers,'x-forwarded-for':'127.0.0.1'},body:{}})).status,403);
    assert.equal((await call({port,path:'/api/v1/setup/complete',method:'POST',headers:{...headers,origin:'http://attacker.example'},body:{}})).status,403);
    assert.equal((await call({port,path:'/api/v1/setup/complete',method:'POST',headers,body:{}})).status,200);
    assert.equal((await call({port,path:'/api/v1/setup/state'})).body.initialized,true);
  } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await extensions.shutdown();if(old===undefined)delete process.env.STARDUST_TRUSTED_PROXIES;else process.env.STARDUST_TRUSTED_PROXIES=old;rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});
