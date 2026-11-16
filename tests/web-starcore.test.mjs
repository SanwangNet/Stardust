import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { ExtensionManager } from "../apps/server/dist/extension-manager.js";
import { webChatExtension } from "../apps/server/dist/extensions/web-chat.js";
import { ConversationService } from "../apps/server/dist/conversation.js";
import { createStardustServer } from "../apps/server/dist/app.js";
import { ToolRuns } from "../apps/server/dist/tool-runs.js";

const fakeModel={chat:async()=>"回复",chatContext:async()=>"回复"};
test("built-in Web starcore is present, persistent, independently enabled and protected from uninstall", async()=>{
 const root=mkdtempSync(join(tmpdir(),"stardust-builtin-"));let manager=new ExtensionManager(root,fakeModel,[webChatExtension]);
 try {
  let web=manager.list().find(item=>item.id==="web-chat");
  assert.equal(web.builtin,true);assert.equal(web.installed,true);assert.equal(web.enabled,true);
  assert.deepEqual(web.managementPages.filter(page=>["prompt","tools","skills"].includes(page.pageId)).map(page=>[page.pageId,page.title,page.pageKind]),[
    ["prompt","提示词","web-prompt"],["tools","Tool","web-tools"],["skills","Skill","skills"],
  ]);
  assert.ok(!web.managementPages.some(page=>page.pageId==="chat"));
  assert.deepEqual(web.skills,[]);
  await assert.rejects(manager.uninstall("web-chat",true),{code:"BUILTIN_UNINSTALL_FORBIDDEN"});
  await manager.disable("web-chat"); assert.equal(manager.channelEnabled("web-chat"),false); await manager.shutdown();
  manager=new ExtensionManager(root,fakeModel,[webChatExtension]);assert.equal(manager.list()[0].installed,true);assert.equal(manager.channelEnabled("web-chat"),false);
  await manager.enable("web-chat");assert.equal(manager.channelEnabled("web-chat"),true);
  await manager.shutdown();
  manager=new ExtensionManager(root,fakeModel,[{...webChatExtension,manifest:{...webChatExtension.manifest,builtin:false}}]);
  await assert.rejects(manager.uninstall("web-chat",false),{code:"BUILTIN_UNINSTALL_FORBIDDEN"});
 } finally {await manager.shutdown();rmSync(root,{recursive:true,force:true});}
});

test("revoking a Web Tool while confirmation is pending prevents the external action",async()=>{
 const root=mkdtempSync(join(tmpdir(),"stardust-web-policy-"));let sends=0,allowed=true,turn=0;
 const tool={name:"send_test",description:"test",parameters:{type:"object"},validate:()=>({}),prepare:()=>({approval:{operation:"发送",targetDescription:"测试",risk:"外部操作"}}),execute:async()=>{sends++;return {status:"sent"};}};
 const channel={manifest:{id:"test-channel",name:"Test",version:"1",description:"",type:"channel",fields:[]},tools:[tool],create(_config,host){return {start(){host.status("connected")},stop(){}}}};
 const extensions=new ExtensionManager(root,fakeModel,[channel]);await extensions.install("test-channel");await extensions.enable("test-channel");await extensions.setToolEnabled("test-channel","send_test",true);
 const model={chatWithTools:async()=>++turn===1?{content:"",toolCalls:[{id:"one",name:"send_test",arguments:"{}"}]}:{content:"完成",toolCalls:[]}};
 const runs=new ToolRuns(model,extensions);const id=runs.start("local","hello",undefined,{searchHistory:()=>[],activity:()=>{},allowTool:()=>allowed});
 try{
  for(let i=0;i<100&&runs.get("local",id).status!=="waiting";i++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(runs.get("local",id).status,"waiting");allowed=false;
  assert.throws(()=>runs.decide("local",id,"one",true),/APPROVAL_UNAVAILABLE/);
  for(let i=0;i<100&&runs.get("local",id).status!=="done";i++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(sends,0);assert.equal(runs.get("local",id).status,"done");
 }finally{runs.shutdown();await extensions.shutdown();rmSync(root,{recursive:true,force:true});}
});

test("channel host routes a non-Web message through the same main Agent prompt",async(t)=>{
 const root=mkdtempSync(join(tmpdir(),"stardust-channel-core-"));let host;const calls=[];
 const channel={manifest:{id:"sample-channel",name:"Channel",version:"1",description:"",type:"channel",fields:[]},create(_config,value){host=value;return {start(){value.status("connected")},stop(){}}}};
 const extensions=new ExtensionManager(root,fakeModel,[webChatExtension,channel]);
 await extensions.install("sample-channel");await extensions.enable("sample-channel");
 const model={chatContext:async(messages,_signal,context)=>{calls.push(structuredClone({messages,context}));return "统一回复";},chat:async()=>{throw Error("unexpected legacy path");}};
 const store=new ConversationService(model,join(root,"chat.sqlite"));store.agent.update({agentPrompt:"跨渠道共同主体",webPrompt:"只用于 Web"},[]);
 const app=createStardustServer({setupService:{getInitializationState:()=>({initialized:true})},extensionManager:extensions,conversationService:store,modelService:model});
 app.listen(0,"127.0.0.1");await once(app,"listening");
 t.after(async()=>{app.closeAllConnections();await new Promise(resolve=>app.close(resolve));await extensions.shutdown();rmSync(root,{recursive:true,force:true});});
 assert.equal(await host.message({channelId:"sample-channel",messageId:"1",senderId:"p",conversationId:"c",conversationType:"private",content:"你好",eventId:"event-1",timestamp:new Date().toISOString()},new AbortController().signal),"统一回复");
 assert.match(calls[0].messages[0].content,/跨渠道共同主体/);assert.doesNotMatch(calls[0].messages[0].content,/只用于 Web/);
 assert.deepEqual(calls[0].messages.at(-1),{role:"user",content:"你好"});assert.equal(calls[0].context.eventId,"event-1");assert.equal(store.list().length,0);
});

test("agent prompt, Web prompt, tool settings and channel scope persist across restart",async()=>{
 const root=mkdtempSync(join(tmpdir(),"stardust-agent-")),path=join(root,"conversation.sqlite");let store=new ConversationService(fakeModel,path);
 try {
  store.agent.update({agentPrompt:"共同的星尘身份",webPrompt:"Web 特定说明",tool:{name:"search_history",enabled:false}},["search_history"]);
  assert.equal(store.agent.toolAllowed("search_history"),false);
  assert.throws(()=>store.agent.update({tool:{name:"unavailable",enabled:true}},["search_history"]),/INVALID_INPUT/);
  const requests=[];const agentModel={chatContext:async(messages)=>{requests.push(messages);return "回复";}};
  await store.agent.chatChannel(agentModel,"qq-bot","你好",new AbortController().signal);
  assert.match(requests[0][0].content,/共同的星尘身份/);assert.doesNotMatch(requests[0][0].content,/Web 特定说明/);
  const a=store.create("Web"); await store.submit(a.id,randomUUID(),"我有一只猫");
  assert.equal(a.starcoreId,"web-chat");assert.equal(a.channelId,"web");assert.equal(a.scopeId,"web:default");
  const other=store.create("QQ","qq"); await store.submit(other.id,randomUUID(),"另一人的秘密猫");
  assert.notEqual(other.scopeId,"web:default");assert.ok(store.searchHistory({keywords:["猫"]}).every(item=>item.conversationId===a.id));
  const privateWeb=store.create("Private");
  const db=new DatabaseSync(path);db.prepare("UPDATE conversations SET scope_id = ? WHERE id = ?").run("private:other",privateWeb.id);db.close();
  await store.submit(privateWeb.id,randomUUID(),"私人猫秘密");
  assert.throws(()=>store.getWeb(privateWeb.id),/NOT_FOUND/);
  assert.ok(!store.searchHistory({keywords:["秘密"]}).some(item=>item.conversationId===privateWeb.id));
  assert.equal(store.globalContext.jobs("web:default").length,1);
  store.close();store=new ConversationService(fakeModel,path);
  assert.equal(store.agent.settings().agentPrompt,"共同的星尘身份");assert.equal(store.agent.settings().webPrompt,"Web 特定说明");assert.equal(store.agent.toolAllowed("search_history"),false);
  store.agent.update({agentPrompt:null,webPrompt:null,tool:{name:"search_history",enabled:true}},["search_history"]);
  assert.notEqual(store.agent.settings().agentPrompt,"共同的星尘身份");assert.equal(store.agent.toolAllowed("search_history"),true);
 }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

test("Web API applies configured prompts and Tool policy while protecting built-in starcore",async(t)=>{
 const root=mkdtempSync(join(tmpdir(),"stardust-web-channel-")); const calls=[];
 const model={chatContext:async()=>"答复",async chatWithTools(messages,tools){
   calls.push(structuredClone({messages,tools}));const last=messages.at(-1);
   if(last.role==="tool")return {content:"已处理",toolCalls:[]};
   if(last.content==="试用检索")return {content:"",toolCalls:[{id:"history_1",name:"search_history",arguments:'{"keywords":["猫"]}'}]};
   return {content:"答复",toolCalls:[]};
 }};
 const extensions=new ExtensionManager(root,fakeModel,[webChatExtension]); const store=new ConversationService(model,join(root,"c.sqlite"));
 const app=createStardustServer({setupService:{getInitializationState:()=>({initialized:true})},extensionManager:extensions,conversationService:store,modelService:model});
 app.listen(0,"127.0.0.1");await once(app,"listening");
 t.after(async()=>{app.closeAllConnections();await new Promise(resolve=>app.close(resolve));await extensions.shutdown();rmSync(root,{recursive:true,force:true});});
 const origin=`http://127.0.0.1:${app.address().port}`;
 const request=(path,method="GET",body)=>fetch(origin+path,{method,headers:{origin,"content-type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)})});
 let web=(await(await request("/api/v1/extensions")).json()).extensions.find(item=>item.id==="web-chat");assert.equal(web.builtin,true);assert.equal(web.installed,true);
 assert.equal((await request("/api/v1/extensions/web-chat/uninstall","POST",{deleteConfig:true})).status,403);
 assert.equal((await request("/api/v1/agent/settings","PATCH",{agentPrompt:"共同主身份",webPrompt:"浏览器渠道提示"})).status,200);
 const conversation=(await(await request("/api/v1/conversations","POST",{})).json()).conversation;
 assert.equal((await request(`/api/v1/conversations/${conversation.id}/messages`,"POST",{requestId:randomUUID(),content:"猫的信息"})).status,200);
 assert.ok(calls[0].messages.some(m=>m.role==="system" && m.content.includes("共同主身份") && m.content.includes("浏览器渠道提示")));
 assert.ok(calls[0].tools.some(tool=>tool.function.name==="search_history"));
 assert.equal((await request("/api/v1/agent/settings","PATCH",{tool:{name:"search_history",enabled:false}})).status,200);
 assert.equal((await request(`/api/v1/conversations/${conversation.id}/messages`,"POST",{requestId:randomUUID(),content:"试用检索"})).status,200);
 assert.ok(!calls[1].tools.some(tool=>tool.function.name==="search_history"));
 assert.equal(JSON.parse(calls[2].messages.at(-1).content).error,"TOOL_UNAVAILABLE");
 assert.equal((await request("/api/v1/agent/settings","PATCH",{tool:{name:"search_history",enabled:true}})).status,200);
 assert.equal((await request(`/api/v1/conversations/${conversation.id}/messages`,"POST",{requestId:randomUUID(),content:"继续讨论"})).status,200);
 assert.ok(calls[3].tools.some(tool=>tool.function.name==="search_history"));
 assert.equal((await request("/api/v1/extensions/web-chat/disable","POST",{})).status,200);
 assert.equal((await request(`/api/v1/conversations/${conversation.id}/messages`,"POST",{requestId:randomUUID(),content:"继续"})).status,403);
});
