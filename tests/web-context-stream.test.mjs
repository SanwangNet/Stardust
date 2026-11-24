import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createStardustServer } from "../apps/server/dist/app.js";
import { ConversationService } from "../apps/server/dist/conversation.js";
import { ModelService } from "../apps/server/dist/model.js";
import { LogService } from "../apps/server/dist/logger.js";

test("Web context survives streamed model output without storing partial replies", async t => {
  const root=await mkdtemp(join(tmpdir(),"web-context-stream-")), requests=[];
  let incomplete=false;
  const config={loadConfig:()=>({model:{baseUrl:"http://127.0.0.1:9999/v1",modelId:"mock",timeoutMs:3000,stream:true}})};
  const secrets={getKey:()=>({key:"",fileKey:""})};
  const request=async(_url,options)=>{
    const body=JSON.parse(options.body);
    if(body.max_tokens===2000) {
      const frame=JSON.stringify({choices:[{index:0,delta:{content:'{"updates":[]}'}}]});
      return new Response(`data: ${frame}\n\ndata: [DONE]\n\n`,{headers:{"content-type":"text/event-stream"}});
    }
    requests.push(body);
    const frames=incomplete
      ? 'data: {"choices":[{"index":0,"delta":{"content":"不完整片段"}}]}\n\n'
      : 'data: {"choices":[{"index":0,"delta":{"content":"你好"}}]}\n\ndata: {"choices":[{"index":0,"delta":{"content":"，世界"}}]}\n\ndata: [DONE]\n\n';
    return new Response(frames,{headers:{"content-type":"text/event-stream"}});
  };
  const model=new ModelService(config,secrets,request,new LogService(100,()=>{}));
  const store=new ConversationService(model,join(root,"db.sqlite"));
  const extensions={restore:async()=>{},shutdown:async()=>{},availableTools:()=>[],availableTargets:()=>[]};
  const server=createStardustServer({setupService:{getInitializationState:()=>({initialized:true})},modelService:model,conversationService:store,extensionManager:extensions});
  server.listen(0,"127.0.0.1");await once(server,"listening");
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100})});
  const origin=`http://127.0.0.1:${server.address().port}`;
  const post=(path,body)=>fetch(origin+path,{method:"POST",headers:{origin,"content-type":"application/json"},body:JSON.stringify(body)});
  const id=(await (await post("/api/v1/conversations",{})).json()).conversation.id,path=`/api/v1/conversations/${id}/messages`;
  assert.equal((await post(path,{requestId:randomUUID(),content:"第一轮"})).status,200);
  assert.deepEqual(store.messages(id).map(m=>[m.role,m.content,m.status]),[["user","第一轮","complete"],["assistant","你好，世界","complete"]]);
  incomplete=true;
  assert.equal((await post(path,{requestId:randomUUID(),content:"第二轮"})).status,500);
  assert.equal(requests.length,2);assert.ok(requests.every(r=>r.stream===true));
  assert.deepEqual(requests[1].messages.slice(-3).map(m=>m.content),["第一轮","你好，世界","第二轮"]);
  assert.deepEqual(store.messages(id).map(m=>[m.role,m.content,m.status]),[["user","第一轮","complete"],["assistant","你好，世界","complete"],["user","第二轮","unknown"]]);
});
