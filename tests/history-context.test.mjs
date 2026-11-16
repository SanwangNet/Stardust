import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { test } from "node:test";
import { ConversationService } from "../apps/server/dist/conversation.js";
import { assembleContext } from "../apps/server/dist/context-assembler.js";
import { createStardustServer } from "../apps/server/dist/app.js";
import { ToolRuns } from "../apps/server/dist/tool-runs.js";
import { activityDisplayText } from "../apps/web/dist/conversation-ui.js";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn) { for (let i=0; i<400; i++) { const value = await fn(); if (value) return value; await delay(10); } throw Error("timed out"); }

test("history search ranks partial Chinese matches, escapes LIKE and respects deletion and scope", async () => {
  const store = new ConversationService({ chatContext: async () => "好的" }, ":memory:");
  try {
    const a = store.create("A"), b = store.create("B"), qq = store.create("QQ", "qq");
    await store.submit(a.id, randomUUID(), "我的小猫小白喜欢睡在窗台上。特殊字符 %_\\");
    await store.submit(b.id, randomUUID(), "喜欢音乐");
    await store.submit(qq.id, randomUUID(), "猫喜欢睡在 QQ 私人内容");
    const matches = store.searchHistory({ keywords: ["猫", "喜欢", "睡"] });
    assert.equal(matches[0].conversationId, a.id); assert.match(matches[0].content, /窗台/);
    assert.ok(matches.some((item) => item.conversationId === b.id));
    assert.ok(matches.every((item) => item.conversationId !== qq.id));
    for (const keyword of ["猫", "小猫", "%_\\"]) assert.equal(store.searchHistory({ keywords: [keyword] })[0].conversationId, a.id);
    assert.deepEqual(store.searchHistory({ keywords: ["不存在的词语"] }), []);
    assert.throws(() => store.searchHistory({ keywords: [""] }));
    assert.throws(() => store.searchHistory({ keywords: ["猫"], limit: 11 }));
    store.delete(a.id); assert.deepEqual(store.searchHistory({ keywords: ["窗台"] }), []);
  } finally { store.close(); }
});

test("assembler selects relevant untrusted summaries, preserves recent messages and stays within budget", () => {
  const history = [{ role: "user", content: "旧问题", sequence: 1 }, { role: "assistant", content: "旧回答", sequence: 2 }];
  const entries = [
    { id: "cat", topic: "宠物", content: "猫叫小白", sources: [{ conversationId: "a", startSequence: 1, endSequence: 2 }] },
    { id: "unrelated", topic: "天气", content: "晴朗", sources: [] },
  ];
  const result = assembleContext(history, "我的猫喜欢睡在哪里？", "b", entries, 1800);
  assert.deepEqual(result.selectedEntryIds, ["cat"]);
  assert.equal(result.messages[0].role, "system");
  assert.equal(result.messages[1].role, "assistant"); assert.match(result.messages[1].content, /不可信/);
  assert.deepEqual(result.messages.slice(-3).map(({role,content}) => [role,content]), [["user","旧问题"],["assistant","旧回答"],["user","我的猫喜欢睡在哪里？"]]);
  assert.ok(result.messages.reduce((n, m) => n + Buffer.byteLength(m.content) + 32, 0) <= 1800);
  assert.deepEqual(assembleContext(history, "猫", "a", entries, 1800).selectedEntryIds, []);
  assert.throws(() => assembleContext([], "超".repeat(1000), "b", entries, 300), /CONTEXT_TOO_LARGE/);
});

test("ordinary chat calls search, emits live activity and returns tool result to model", async (t) => {
  const calls = [];
  const model = { async chatContext() { return "unused"; }, async chatWithTools(messages, tools) {
    calls.push({ messages: structuredClone(messages), tools: structuredClone(tools) });
    const last = messages.at(-1);
    if (last.role === "tool") { assert.equal(last.tool_call_id, "lookup_1"); assert.match(last.content, /窗台/); return {content:"小白喜欢睡在窗台上。",toolCalls:[]}; }
    if (last.content === "我的猫喜欢睡在哪里？") return { content:"", toolCalls:[{id:"lookup_1",name:"search_history",arguments:JSON.stringify({keywords:["猫","喜欢","睡"]})}] };
    return { content:"我知道了。",toolCalls:[] };
  } };
  const store = new ConversationService(model, ":memory:");
  const extensions = { restore: async()=>{}, shutdown: async()=>{}, availableTools:()=>[], availableTargets:()=>[] };
  const server = createStardustServer({ setupService:{getInitializationState:()=>({initialized:true})}, extensionManager:extensions, modelService:model, conversationService:store });
  server.listen(0,"127.0.0.1"); await once(server,"listening");
  t.after(async()=>{ server.closeAllConnections(); await new Promise((resolve)=>server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = (path, data) => fetch(origin+path,{method:"POST",headers:{origin,"content-type":"application/json"},body:JSON.stringify(data)});
  const a = (await (await post("/api/v1/conversations",{})).json()).conversation;
  assert.equal((await post(`/api/v1/conversations/${a.id}/messages`,{requestId:randomUUID(),content:"我的小猫叫小白，它喜欢睡在窗台上。"})).status,200);
  const b = (await (await post("/api/v1/conversations",{})).json()).conversation;
  const requestId=randomUUID(); const path=`/api/v1/conversations/${b.id}/messages/${requestId}`;
  const pending=post(`/api/v1/conversations/${b.id}/messages`,{requestId,content:"我的猫喜欢睡在哪里？"});
  const observed=await until(async()=>{const data=await (await fetch(origin+path+"/activity")).json(); return data.activity?.displayText === "正在调用 跨会话记忆 Tool" && data.activity;});
  assert.equal(activityDisplayText(observed),"正在调用 跨会话记忆 Tool");
  assert.equal((await (await fetch(origin+path+"/tool")).json()).run.calls.length,0);
  const response=await pending; assert.equal(response.status,200);
  assert.deepEqual((await response.json()).messages.map((m)=>m.content),["我的猫喜欢睡在哪里？","小白喜欢睡在窗台上。"]);
  assert.equal((await (await fetch(origin+path+"/activity")).json()).activity,null);
  assert.ok(calls.every((call)=>call.tools.some((tool)=>tool.function.name==="search_history")));
  assert.equal(store.messages(b.id).length,2);
  assert.equal(store.globalContext.counts("web:default").pending,2);
});

test("read-only calls are bounded and cannot execute unregistered tools", async () => {
  let count=0, searches=0;
  const model={async chatWithTools(){count++; return {content:"",toolCalls:[{id:`call_${count}`,name:"search_history",arguments:'{"keywords":["猫"]}'}]};}};
  const extensions={availableTools:()=>[],availableTargets:()=>[]}; const runs=new ToolRuns(model,extensions);
  const id=runs.start("local","测试",undefined,{searchHistory:()=>{searches++;return [];},activity:()=>{}});
  try { const run=await until(()=>{const r=runs.get("local",id);return r.status==="error" && r;}); assert.equal(run.error,"TOOL_CALL_LIMIT"); assert.equal(searches,3); assert.equal(count,5); } finally { runs.shutdown(); }
});

test("activity text uses safe plain-text fallback",()=>{
  assert.equal(activityDisplayText({requestId:"x",kind:"tool_call",state:"started",displayText:"正在寻找关于小白的习惯"}),"正在寻找关于小白的习惯");
  assert.equal(activityDisplayText({requestId:"x",kind:"tool_call",state:"started",displayText:'<script>{"keywords":[]}'}),"正在调用 Tool");
});

test("saved global summaries reach later conversations but do not enter stored history", async () => {
  const contexts = [];
  const model = { chatContext:async()=>"答复", chatWithTools:async()=>({content:"答复",toolCalls:[]}), synthesizeGlobalContext:async()=>JSON.stringify({updates:[{topic:"宠物",content:"猫叫小白"}]}) };
  const store = new ConversationService(model, ":memory:");
  try {
    store.globalContext.start();
    const a=store.create("A"), b=store.create("B");
    const execute=async (context)=>{contexts.push(context);return "答复";};
    await store.submit(a.id,randomUUID(),"猫叫小白",false,execute);
    await until(()=>store.globalContext.counts("web:default").done===1);
    await store.submit(b.id,randomUUID(),"我的猫叫什么？",false,execute);
    assert.ok(contexts[1].some((message)=>message.role==="assistant" && message.content.includes("猫叫小白")));
    assert.ok(!contexts[1].some((message)=>message.role==="system" && message.content.includes("猫叫小白")));
    assert.deepEqual(store.messages(b.id).map((message)=>message.content),["我的猫叫什么？","答复"]);
  } finally { store.close(); }
});
