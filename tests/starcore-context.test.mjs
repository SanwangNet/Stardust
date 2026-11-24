import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { ConversationService } from "../apps/server/dist/conversation.js";
import { ContextService } from "../apps/server/dist/context-service.js";
import { createStardustServer } from "../apps/server/dist/app.js";
import { ExtensionManager } from "../apps/server/dist/extension-manager.js";
import { createQQBotExtension } from "../apps/server/dist/extensions/qq-bot.js";
import { LogService } from "../apps/server/dist/logger.js";
import { qqKeys } from "../apps/server/dist/history-provenance.js";
import { ScopedHistorySearch } from "../apps/server/dist/scoped-history-search.js";

const input=(id,content,kind="c2c",sender="sender-secret",target="private-secret",extra={})=>({kind,rawEventType:kind==='group'?"GROUP_AT_MESSAGE_CREATE":"C2C_MESSAGE_CREATE",senderId:sender,messageId:id,timestamp:new Date().toISOString(),content,...(kind==='group'?{groupOpenid:target}:{}),replyTarget:{scope:kind,targetId:target,msgId:id},...extra});
const channel=(id,content,conversation="group-secret",sender="user-secret",account="bot-secret")=>({channelId:"qq-bot",identityAccountId:account,conversationType:"group",conversationId:conversation,senderId:sender,messageId:id,content,timestamp:new Date().toISOString()});
async function launch(root,path,tool=false){
 const handlers=new Map(),sent=[],calls=[],tools=[];let finish,sendFail=false;
 const bot={on(n,fn){handlers.set(n,fn)},start(){handlers.get("ready")();return new Promise(r=>finish=r)},stop(){finish?.()},async sendText(target,content){if(sendFail)throw Object.assign(new Error("rejected"),{httpStatus:403});sent.push({target,content});return{id:`reply-${sent.length}`}},emit(e){return handlers.get("message")({},e)}};
 const model={async chatContext(messages){calls.push(structuredClone(messages));return `答复:${messages.at(-1).content}`},async chatWithTools(messages,definitions){tools.push(structuredClone({messages,definitions}));return{content:`工具模式回复:${messages.at(-1).content}`,toolCalls:[]}}};
 const managerRoot=join(root,randomUUID());await mkdir(managerRoot);const store=new ConversationService(model,path),manager=new ExtensionManager(managerRoot,model,[createQQBotExtension(async()=>bot)],new LogService(100,()=>{}));
 const server=createStardustServer({setupService:{getInitializationState:()=>({initialized:true})},extensionManager:manager,modelService:model,conversationService:store,qqToolCalling:{enabled:tool,policy:{private:["search_history"],privateSenders:["sender-secret"]}}});
 server.listen(0,"127.0.0.1");await once(server,"listening");await manager.install("qq-bot");await manager.saveConfig("qq-bot",{appId:"bot-secret",appSecret:"mock-secret"});await manager.enable("qq-bot");
 for(let i=0;i<300&&!handlers.has("message");i++)await new Promise(r=>setTimeout(r,10));
 return{bot,model,store,calls,tools,sent,origin:`http://127.0.0.1:${server.address().port}`,setFail(v){sendFail=v},async close(){server.closeAllConnections();await new Promise(r=>server.close(r));await manager.shutdown()}};
}

test("real QQ model-only uses durable history, restores after restart and shares it with tool mode",async t=>{
 const root=await mkdtemp(join(tmpdir(),"starcore-context-")),path=join(root,"db.sqlite");let app;
 t.after(async()=>{if(app)await app.close();await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100})});
 app=await launch(root,path);
 const db=new DatabaseSync(path);db.prepare("INSERT INTO global_context_entries(id,owner,topic,content,created_at,updated_at,version) VALUES(?,?,?,?,?,?,1)").run(randomUUID(),'web:default','显卡','仅 Web 私人显卡记忆','2026','2026');db.close();
 await app.bot.emit(input("first","我买了一张显卡"));await app.bot.emit(input("second","9070 XT"));
 let text=JSON.stringify(app.calls[1]);assert.match(text,/我买了一张显卡/);assert.match(text,/答复:我买了一张显卡/);assert.doesNotMatch(text,/仅 Web 私人显卡记忆/);assert.equal(app.calls[1].filter(m=>m.content==='9070 XT').length,1);assert.equal(app.tools.length,0);
 await app.close();app=undefined;app=await launch(root,path,true);await app.bot.emit(input("third","上面是什么型号"));
 for(let i=0;i<400&&!app.tools.length;i++)await new Promise(r=>setTimeout(r,10));
 text=JSON.stringify(app.tools[0].messages);assert.match(text,/我买了一张显卡/);assert.match(text,/9070 XT/);assert.equal(app.tools[0].messages.filter(m=>m.content==='上面是什么型号').length,1);assert.doesNotMatch(text,/private-secret|sender-secret|bot-secret/);
 for(let i=0;i<400&&!app.sent.length;i++)await new Promise(r=>setTimeout(r,10));assert.equal(app.sent.length,1);
 // Allow deferred delivery to persist its outcome before orderly shutdown.
 for(let i=0;i<200;i++){const all=app.store.messages(qqKeys({channelId:'qq-bot',identityAccountId:'bot-secret',conversationId:'private-secret',senderId:'sender-secret',conversationType:'private',messageId:'third',content:'上面是什么型号',timestamp:new Date().toISOString()}).conversationId);if(all.some(m=>m.role==='assistant'&&m.content.includes('工具模式回复')&&m.status==='complete'))break;await new Promise(r=>setTimeout(r,10));}
 await app.close();app=undefined;app=await launch(root,path);await app.bot.emit(input("fourth","继续"));text=JSON.stringify(app.calls[0]);assert.match(text,/工具模式回复/);assert.match(text,/9070 XT/);
});

test("group observations are saved without a reply and same-name senders retain distinct scoped aliases",async t=>{
 const root=await mkdtemp(join(tmpdir(),"group-context-")),app=await launch(root,join(root,"db.sqlite"));t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100})});
 const ordinary=(id,sender,content)=>input(id,content,"group",sender,"group-secret",{rawEventType:"GROUP_MESSAGE_CREATE",senderName:"同名"});
 await app.bot.emit(ordinary("one","sender-a","键盘型号"));await app.bot.emit(ordinary("two","sender-b","这个很好"));
 assert.equal(app.calls.length,0);assert.equal(app.sent.length,0);
 await app.bot.emit(input("three","你怎么看","group","sender-a","group-secret",{senderName:"同名"}));
 const model=app.calls[0],history=model.filter(m=>m.content.includes('[历史消息'));assert.equal(history.length,2);const aliases=history.map(m=>JSON.parse(m.content.slice(m.content.indexOf('{'))).author.member);assert.notEqual(aliases[0],aliases[1]);
 assert.match(JSON.stringify(model),/键盘型号/);assert.match(JSON.stringify(model),/这个很好/);assert.doesNotMatch(JSON.stringify(model),/sender-a|sender-b|group-secret|bot-secret/);
});

test("scoped handles keep event boundaries, delivery failures and identities isolated",async t=>{
 const root=await mkdtemp(join(tmpdir(),"context-boundary-")),store=new ConversationService({chatContext:async()=>""},join(root,"db.sqlite")),service=new ContextService(store);t.after(async()=>{service.shutdown();store.close();await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100})});
 const a=channel("one","先前消息"), h=service.forQQ(a);await h.prepare();await h.saveReply("未送达", "failed");
 await service.forQQ(channel("other","其他群秘密","another-group")).prepare();await service.forQQ(channel("bot","其他机器人秘密","group-secret","user-secret","another-bot")).prepare();
 const second=service.forQQ(channel("two","当前消息")),snapshot=await second.prepare();await service.forQQ(channel("three","后来的消息")).prepare();
 const text=JSON.stringify(snapshot.messages);assert.match(text,/先前消息/);assert.doesNotMatch(text,/未送达|其他群秘密|其他机器人秘密|后来的消息/);assert.equal(snapshot.messages.filter(m=>m.content==='当前消息').length,1);
 assert.ok(snapshot.persisted && snapshot.boundary>0);const id=qqKeys(a).conversationId;assert.equal(store.messages(id).length,4);
 const web=store.create();assert.equal(service.forWeb(web.id).shortTerm("新消息").at(-1).content,"新消息");assert.throws(()=>service.forWeb(id),/NOT_FOUND/);
});

test("a failed QQ delivery stays in full history but is not presented as a seen reply",async t=>{
 const root=await mkdtemp(join(tmpdir(),"context-delivery-")),app=await launch(root,join(root,"db.sqlite"));t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100})});
 app.setFail(true);await app.bot.emit(input("failed","失败回复之前的提问"));app.setFail(false);await app.bot.emit(input("next","后续问题"));
 const text=JSON.stringify(app.calls[1]);assert.match(text,/失败回复之前的提问/);assert.doesNotMatch(text,/答复:失败回复之前的提问/);
 const key=qqKeys({channelId:'qq-bot',identityAccountId:'bot-secret',conversationId:'private-secret',senderId:'sender-secret',conversationType:'private',messageId:'failed',content:'失败回复之前的提问',timestamp:new Date().toISOString()}).conversationId;
 assert.equal(app.store.messages(key).find(m=>m.content==='答复:失败回复之前的提问').status,'failed');
});

test("the bounded short window is reconstructed deterministically without deleting full history",async t=>{
 const root=await mkdtemp(join(tmpdir(),"context-budget-")),path=join(root,"db.sqlite");let store=new ConversationService({chatContext:async()=>""},path),service=new ContextService(store);
 t.after(async()=>{service.shutdown();store.close();await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100})});
 for(let i=0;i<60;i++)store.recordQQ(channel(`msg-${i}`,`记录${i} ${'长'.repeat(1500)}`));
 const current=channel("current","新消息"),before=await service.forQQ(current).prepare();assert.ok(before.messages.length<=51);assert.ok(Buffer.byteLength(JSON.stringify(before.messages))<37_000);
 const count=store.messages(qqKeys(current).conversationId).length;assert.equal(count,61);
 service.shutdown();store.close();store=new ConversationService({chatContext:async()=>""},path);service=new ContextService(store);
 const after=await service.forQQ(current).prepare();assert.deepEqual(after.messages,before.messages);assert.equal(store.messages(qqKeys(current).conversationId).length,count);
});

test("bound full-history search excludes supplied recent messages and anything beyond the run boundary",async t=>{
 const root=await mkdtemp(join(tmpdir(),"context-search-")),store=new ConversationService({chatContext:async()=>""},join(root,"db.sqlite")),history=new ScopedHistorySearch(),service=new ContextService(store,history);t.after(async()=>{service.shutdown();history.shutdown();store.close();await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100})});
 store.recordQQ(channel("old","路由器 很久以前"));for(let i=0;i<49;i++)store.recordQQ(channel(`filler-${i}`,`近期记录 ${i}`));store.recordQQ(channel("recent","路由器 最近"));
 const handle=service.forQQ(channel("current","查找"));const snapshot=await handle.prepare();assert.match(JSON.stringify(snapshot.messages),/路由器 最近/);
 store.recordQQ(channel("future","路由器 将来的消息"));const result=await handle.search({keywords:["路由器"]});assert.equal(result.results.length,1);assert.match(result.results[0].content,/很久以前/);assert.doesNotMatch(JSON.stringify(result),/最近|将来的消息/);
});

test("Web and QQ production requests share Core context service without sharing their histories",async t=>{
 const root=await mkdtemp(join(tmpdir(),"context-web-qq-")),app=await launch(root,join(root,"db.sqlite"));t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100})});
 const service=app.store.context,counts={web:0,webPrepare:0,qq:0};
 const originalWeb=service.forWeb.bind(service),originalQQ=service.forQQ.bind(service);
 const originalRecent=app.store.readRecentContext.bind(app.store);
 service.forWeb=(...args)=>{counts.web++;return originalWeb(...args)};
 app.store.readRecentContext=(...args)=>{counts.webPrepare++;return originalRecent(...args)};
 service.forQQ=(...args)=>{counts.qq++;return originalQQ(...args)};
 const post=(path,body)=>fetch(app.origin+path,{method:"POST",headers:{origin:app.origin,"content-type":"application/json"},body:JSON.stringify(body)});
 const a=(await (await post("/api/v1/conversations",{title:"A"})).json()).conversation.id,b=(await (await post("/api/v1/conversations",{title:"B"})).json()).conversation.id;
 const send=async(id,content)=>{const response=await post(`/api/v1/conversations/${id}/messages`,{requestId:randomUUID(),content});assert.equal(response.status,200)};
 await Promise.all([send(a,"Web A 秘密"),app.bot.emit(input("one","QQ 私有内容"))]);
 await Promise.all([send(b,"Web B 秘密"),send(a,"Web A 第二轮"),app.bot.emit(input("two","QQ 第二轮"))]);
 const webA=app.tools.find(call=>call.messages.at(-1).content==='Web A 第二轮').messages;
 assert.match(JSON.stringify(webA),/Web A 秘密/);assert.doesNotMatch(JSON.stringify(webA),/Web B 秘密|QQ 私有内容/);assert.equal(webA.filter(m=>m.content==='Web A 第二轮').length,1);
 const qq=app.calls.find(messages=>messages.at(-1).content==='QQ 第二轮');assert.match(JSON.stringify(qq),/QQ 私有内容/);assert.doesNotMatch(JSON.stringify(qq),/Web A 秘密|Web B 秘密/);
 assert.ok(counts.web>=3 && counts.webPrepare>=3 && counts.qq>=2);assert.equal(app.store.context,service);
 const aRows=app.store.messages(a);assert.deepEqual(aRows.map(row=>row.role),['user','assistant','user','assistant']);
 await assert.rejects(app.store.submit(a,randomUUID(),"伪造",false,undefined,{contextHandle:originalWeb(b)}),/HISTORY_ACCESS_DENIED/);
 assert.equal(app.store.messages(a).length,aRows.length);
});

test("real Web Tool Calling searches through its bound context and retains Web-only evidence",async t=>{
 const root=await mkdtemp(join(tmpdir(),"context-web-search-")),app=await launch(root,join(root,"db.sqlite"));t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100})});
 const service=app.store.context,original=service.forWeb.bind(service);let searches=0,toolResult;
 const web=app.store.create("来源"),destination=app.store.create("查询");await app.store.submit(web.id,randomUUID(),"网络故障在 Web 排查");
 app.store.recordQQ(channel("qq-secret","网络故障 QQ 私密内容"));
 service.forWeb=(...args)=>{const h=original(...args);return {...h,search:(...values)=>{searches++;return h.search(...values)}}};
 app.model.chatWithTools=async messages=>{const last=messages.at(-1);if(last.role==='tool'){toolResult=JSON.parse(last.content);return {content:"完成",toolCalls:[]}}return {content:"",toolCalls:[{id:"lookup",name:"search_history",arguments:JSON.stringify({keywords:["网络故障"]})}]}};
 const response=await fetch(`${app.origin}/api/v1/conversations/${destination.id}/messages`,{method:"POST",headers:{origin:app.origin,"content-type":"application/json"},body:JSON.stringify({requestId:randomUUID(),content:"查询网络故障"})});
 assert.equal(response.status,200);assert.equal(searches,1);assert.match(JSON.stringify(toolResult),/Web 排查/);assert.doesNotMatch(JSON.stringify(toolResult),/QQ 私密内容/);
 assert.throws(()=>original(qqKeys(channel("qq-secret","网络故障 QQ 私密内容")).conversationId),/NOT_FOUND/);
});

test("Web failure retry keeps its original user message and scoped history boundary",async t=>{
 const root=await mkdtemp(join(tmpdir(),"context-web-retry-")),app=await launch(root,join(root,"db.sqlite"));t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100})});
 const calls=[];let fail=true;app.model.chatWithTools=async messages=>{calls.push(structuredClone(messages));if(messages.at(-1).content==='问题 B' && fail){fail=false;throw Error('model failed')}return {content:`回复:${messages.at(-1).content}`,toolCalls:[]}};
 const post=(path,body)=>fetch(app.origin+path,{method:"POST",headers:{origin:app.origin,"content-type":"application/json"},body:JSON.stringify(body)});
 const id=(await (await post("/api/v1/conversations",{})).json()).conversation.id,path=`/api/v1/conversations/${id}/messages`;
 assert.equal((await post(path,{requestId:randomUUID(),content:"问题 A"})).status,200);
 const idB=randomUUID();assert.equal((await post(path,{requestId:idB,content:"问题 B"})).status,500);
 assert.equal((await post(path,{requestId:idB,content:"问题 B",retry:true})).status,200);
 const context=calls.at(-1);assert.deepEqual(context.slice(-3).map(m=>m.content),["问题 A","回复:问题 A","问题 B"]);assert.equal(context.filter(m=>m.content==='问题 B').length,1);
 assert.deepEqual(app.store.messages(id).map(m=>[m.role,m.content,m.status]),[["user","问题 A","complete"],["assistant","回复:问题 A","complete"],["user","问题 B","complete"],["assistant","回复:问题 B","complete"]]);
});

test("Web production context recovers from the same database after restart and deleted handles expire",async t=>{
 const root=await mkdtemp(join(tmpdir(),"context-web-restart-")),path=join(root,"db.sqlite");let app;
 t.after(async()=>{if(app)await app.close();await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100})});
 app=await launch(root,path);
 const post=(url,body)=>fetch(app.origin+url,{method:"POST",headers:{origin:app.origin,"content-type":"application/json"},body:JSON.stringify(body)});
 const id=(await (await post("/api/v1/conversations",{title:"恢复测试"})).json()).conversation.id;
 assert.equal((await post(`/api/v1/conversations/${id}/messages`,{requestId:randomUUID(),content:"重启前 Web 内容"})).status,200);
 const originalIds=app.store.messages(id).map(m=>m.id);await app.close();app=undefined;
 app=await launch(root,path);assert.equal((await post(`/api/v1/conversations/${id}/messages`,{requestId:randomUUID(),content:"重启后 Web 内容"})).status,200);
 const messages=app.tools.at(-1).messages;assert.match(JSON.stringify(messages),/重启前 Web 内容/);assert.equal(messages.filter(m=>m.content==='重启后 Web 内容').length,1);assert.deepEqual(app.store.messages(id).slice(0,2).map(m=>m.id),originalIds);
 const deleted=app.store.create("待删除"),handle=app.store.context.forWeb(deleted.id);app.store.delete(deleted.id);assert.throws(()=>handle.shortTerm("查询"),/NOT_FOUND/);assert.throws(()=>handle.search({keywords:["重启"]}),/NOT_FOUND/);
});
