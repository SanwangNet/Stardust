import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { ConversationService } from "../apps/server/dist/conversation.js";
const owner = "web:default";
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { for (let i=0; i<400; i++) { const value=fn(); if (value) return value; await pause(10); } throw new Error("worker timeout"); }

// The mock checks the actual source data and prompt, then returns a deterministic update.
// It does not claim to measure the quality or compliance of a real model.
test("actual retrieved user and assistant messages retain distinct provenance through synthesis and revisions", async () => {
  const seen=[];
  const model={ chatContext:async()=>"好的，我记住了。", async synthesizeGlobalContext(system, input) {
    const data=JSON.parse(input); seen.push({system,data});
    assert.match(system,/role=user/); assert.match(system,/role=assistant/);
    assert.match(system,/不能单独证明用户/); assert.match(system,/重复的助手转述/);
    assert.match(system,/不要记录“助手表示已记住”/); assert.match(system,/原始来源不可用时应保留不确定性/);
    const current=data.turn[0].content;
    if (current === "我有一只叫小白的猫。") return '{"updates":[]}';
    if (current === "检索猫的信息") {
      assert.ok(data.retrievedHistory.some(m=>m.role==="user" && m.content==="我有一只叫小白的猫。"));
      assert.ok(data.retrievedHistory.some(m=>m.role==="assistant" && m.content.includes("记住")));
      return JSON.stringify({updates:[{topic:"关于用户的猫",content:"用户曾明确表示，自己有一只名叫小白的猫。"}]});
    }
    if (current === "助手再次转述") {
      assert.ok(data.existing.some(e=>e.topic==="关于用户的猫"));
      assert.ok(data.priorSources.some(m=>m.role==="user" && m.content==="我有一只叫小白的猫。"));
      assert.equal(data.retrievedHistory.length,0);
      return '{"updates":[]}';
    }
    if (current === "是的，我有一只叫小黑的猫。") {
      assert.equal(data.turn[0].role,"user");
      assert.ok(data.priorSources.some(m=>m.role==="user" && m.content.includes("小白")));
      return JSON.stringify({updates:[{topic:"关于用户的猫",content:"用户更正猫的名字为小黑。"}]});
    }
    return '{"updates":[]}';
  }};
  const store=new ConversationService(model,":memory:"); store.globalContext.start();
  try {
    const a=store.create("A"),b=store.create("B");
    await store.submit(a.id,randomUUID(),"我有一只叫小白的猫。");
    await until(()=>store.globalContext.counts(owner).done===1);
    const search=async(_ctx,_activity,record)=>{ store.searchHistory({keywords:["猫","记住"]},record); return "你之前提到一只叫小白的猫。"; };
    await store.submit(b.id,randomUUID(),"检索猫的信息",false,search);
    await until(()=>store.globalContext.counts(owner).done===2);
    let [entry]=store.globalContext.entries(owner);
    assert.equal(entry.content,"用户曾明确表示，自己有一只名叫小白的猫。");
    assert.ok(entry.sources.some(source=>source.conversationId===a.id && source.startSequence===store.messages(a.id)[0].sequence));
    for(let i=0;i<2;i++) {
      await store.submit(b.id,randomUUID(),"助手再次转述",false,async()=>"你之前说过猫叫小白。");
      await until(()=>store.globalContext.counts(owner).done===3+i);
    }
    assert.equal(store.globalContext.entries(owner)[0].version,1);
    await store.submit(b.id,randomUUID(),"是的，我有一只叫小黑的猫。",false,async()=>"明白了，已记住。");
    await until(()=>store.globalContext.counts(owner).done===5);
    [entry]=store.globalContext.entries(owner);
    assert.equal(entry.content,"用户更正猫的名字为小黑。");
    assert.doesNotMatch(entry.content,/助手表示已记住/);
    assert.ok(entry.sources.some(source=>source.conversationId===a.id));
    assert.equal(entry.version,2);
    assert.ok(seen.length===5);
  } finally { store.close(); }
});

test("assistant-only search evidence is never relabelled as a user statement", async () => {
  let last;
  const model={chatContext:async()=>"仅助手转述：用户有一只叫小白的猫。",async synthesizeGlobalContext(system,input){
    const data=JSON.parse(input); last=data;
    assert.match(system,/role=assistant 只能证明助手曾说过/);
    if(data.turn[0].content==="查询助手记录") {
      assert.ok(data.retrievedHistory.length);
      assert.ok(data.retrievedHistory.every(m=>m.role==="assistant"));
      return JSON.stringify({updates:[{topic:"待核实的猫",content:"助手曾提及一只叫小白的猫，用户来源未确认。"}]});
    }
    return '{"updates":[]}';
  }};
  const store=new ConversationService(model,":memory:"); store.globalContext.start();
  try {
    const a=store.create(),b=store.create(); await store.submit(a.id,randomUUID(),"请随便说一句"); await until(()=>store.globalContext.counts(owner).done===1);
    await store.submit(b.id,randomUUID(),"查询助手记录",false,async(_ctx,_activity,record)=>{store.searchHistory({keywords:["仅助手转述"]},record);return "此前助手提及小白。";});
    await until(()=>store.globalContext.counts(owner).done===2);
    assert.ok(last.retrievedHistory.every(m=>m.role==="assistant"));
    assert.match(store.globalContext.entries(owner)[0].content,/未确认/);
  } finally {store.close();}
});

test("deleted sources and clear during a running chat cannot reintroduce retained evidence", async () => {
  let release; const inputs=[];
  const model={chatContext:async()=>"答复",async synthesizeGlobalContext(_s,input){inputs.push(JSON.parse(input));return '{"updates":[]}';}};
  const store=new ConversationService(model,":memory:"); store.globalContext.start();
  try {
    const a=store.create(),b=store.create(); await store.submit(a.id,randomUUID(),"猫在窗台");await until(()=>store.globalContext.counts(owner).done===1);
    const pending=store.submit(b.id,randomUUID(),"查看猫",false,async(_ctx,_activity,record)=>{store.searchHistory({keywords:["猫"]},record);await new Promise(resolve=>{release=resolve});return "窗台";});
    await until(()=>release);store.globalContext.clear(owner);release();await pending;
    await until(()=>store.globalContext.counts(owner).done===1);
    assert.deepEqual(inputs.at(-1).retrievedHistory,[]);
    let resume; const other=store.submit(b.id,randomUUID(),"再次查看",false,async(_ctx,_activity,record)=>{store.searchHistory({keywords:["猫"]},record);await new Promise(resolve=>{resume=resolve});return "窗台";});
    await until(()=>resume);store.delete(a.id);resume();await other;
    await until(()=>store.globalContext.counts(owner).done===2);
    assert.ok(inputs.at(-1).retrievedHistory.every(message=>message.conversationId!==a.id));
  } finally {store.close();}
});

test("retrieval evidence survives restart and is removed when its source is deleted", async () => {
  const { mkdtempSync, rmSync }=await import("node:fs"), { tmpdir }=await import("node:os"), { join }=await import("node:path");
  const root=mkdtempSync(join(tmpdir(),"stardust-provenance-")), path=join(root,"messages.sqlite");
  const seen=[]; const model={chatContext:async()=>"答复",async synthesizeGlobalContext(_s,input){seen.push(JSON.parse(input));return '{"updates":[]}';}};
  let store=new ConversationService(model,path);
  try {
    const a=store.create(),b=store.create();
    await store.submit(a.id,randomUUID(),"历史用户说猫叫小白");
    await store.submit(b.id,randomUUID(),"查找",false,async(_ctx,_activity,record)=>{store.searchHistory({keywords:["小白"]},record);return "小白";});
    store.close();store=new ConversationService(model,path);store.globalContext.start();
    await until(()=>store.globalContext.counts(owner).done===2);
    assert.ok(seen[1].retrievedHistory.some(message=>message.role==="user" && message.content.includes("猫叫小白")));
    store.delete(a.id);
    const {DatabaseSync}=await import("node:sqlite");const db=new DatabaseSync(path);
    try { assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM synthesis_job_evidence").get().n),0); }
    finally {db.close();}
  } finally {store.close();rmSync(root,{recursive:true,force:true});}
});

test("HTTP Tool Calling passes only actual search results as role-labelled synthesis evidence", async (t) => {
  const {once}=await import("node:events"), {createStardustServer}=await import("../apps/server/dist/app.js");
  const inputs=[];
  const model={chatContext:async()=>"unused",async chatWithTools(messages){
    const last=messages.at(-1);
    if(last.role==="tool") return {content:"猫叫小白。",toolCalls:[]};
    if(last.content==="之前的猫叫什么？") return {content:"",toolCalls:[{id:"lookup",name:"search_history",arguments:JSON.stringify({keywords:["小白"]})}]};
    return {content:"好的。",toolCalls:[]};
  },async synthesizeGlobalContext(_s,input){inputs.push(JSON.parse(input));return '{"updates":[]}';}};
  const store=new ConversationService(model,":memory:");
  const app=createStardustServer({setupService:{getInitializationState:()=>({initialized:true})},extensionManager:{restore:async()=>{},shutdown:async()=>{},availableTools:()=>[],availableTargets:()=>[]},modelService:model,conversationService:store});
  app.listen(0,"127.0.0.1"); await once(app,"listening");
  t.after(async()=>{app.closeAllConnections();await new Promise(resolve=>app.close(resolve));});
  const origin=`http://127.0.0.1:${app.address().port}`;
  const post=(path,data)=>fetch(origin+path,{method:"POST",headers:{origin,"content-type":"application/json"},body:JSON.stringify(data)});
  const a=(await(await post("/api/v1/conversations",{})).json()).conversation;
  const b=(await(await post("/api/v1/conversations",{})).json()).conversation;
  assert.equal((await post(`/api/v1/conversations/${a.id}/messages`,{requestId:randomUUID(),content:"我有一只叫小白的猫。"})).status,200);
  assert.equal((await post(`/api/v1/conversations/${b.id}/messages`,{requestId:randomUUID(),content:"之前的猫叫什么？"})).status,200);
  await until(()=>store.globalContext.counts(owner).done===2);
  assert.ok(inputs[1].retrievedHistory.some(item=>item.role==="user" && item.content==="我有一只叫小白的猫。"));
  assert.equal(inputs[1].turn[0].content,"之前的猫叫什么？");
});

test("a source deleted while synthesis is running cannot be restored by its stale result", async () => {
  let release, runs=0;
  const model={chatContext:async()=>"答复",async synthesizeGlobalContext(_s,input){
    const data=JSON.parse(input);
    if(data.turn[0].content!=="检索猫") return '{"updates":[]}';
    runs++;
    if(runs===1){assert.ok(data.retrievedHistory.some(m=>m.content.includes("小白")));await new Promise(resolve=>{release=resolve});return JSON.stringify({updates:[{topic:"猫",content:"不应恢复小白"}]});}
    assert.ok(data.retrievedHistory.every(m=>!m.content.includes("小白")));
    return '{"updates":[]}';
  }};
  const store=new ConversationService(model,":memory:");store.globalContext.start();
  try{
    const a=store.create(),b=store.create();await store.submit(a.id,randomUUID(),"猫叫小白");await until(()=>store.globalContext.counts(owner).done===1);
    await store.submit(b.id,randomUUID(),"检索猫",false,async(_ctx,_activity,record)=>{store.searchHistory({keywords:["小白"]},record);return "小白";});
    await until(()=>release);store.delete(a.id);release();
    await until(()=>store.globalContext.counts(owner).done===1 && runs===2);
    assert.deepEqual(store.globalContext.entries(owner),[]);
  }finally{store.close();}
});
