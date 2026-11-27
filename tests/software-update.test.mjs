import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkSoftwareUpdate } from '../apps/server/dist/software-update.js';

const sha='a'.repeat(40), previous='b'.repeat(40);
function api(response) { return new Response(JSON.stringify(response),{status:200,headers:{'content-type':'application/json'}}); }
test('update check reads the fixed branch, pins metadata to its SHA and never builds',async()=>{
  const calls=[];
  const fetcher=async(url,options)=>{calls.push({url,options});return calls.length===1?api({sha,commit:{message:'修复初始化\n更多信息'}}):api({encoding:'base64',content:Buffer.from(JSON.stringify({version:'0.2.0'})).toString('base64')});};
  const value=await checkSoftwareUpdate('0.1.0',fetcher,previous);
  assert.equal(value.current.sha,previous);assert.equal(value.latest.sha,sha);assert.equal(value.latest.version,'0.2.0');assert.equal(value.updateAvailable,true);assert.match(value.latest.message,/修复初始化/);
  assert.match(calls[0].url,/^https:\/\/api\.github\.com\/repos\/SanwangNet\/Stardust\/commits\/main$/);assert.ok(calls[1].url.endsWith(`ref=${sha}`));assert.equal(calls[0].options.redirect,'error');
});
test('matching SHA, missing version metadata and malformed remote responses are handled',async()=>{
  let calls=0;const same=await checkSoftwareUpdate('0.1.0',async()=>++calls===1?api({sha,commit:{message:'same'}}):new Response('',{status:404}),sha);assert.equal(same.updateAvailable,false);assert.equal(same.latest.version,null);
  await assert.rejects(checkSoftwareUpdate('0.1.0',async()=>api({sha:'invalid',commit:{message:'x'}}),sha),/格式错误/);
  await assert.rejects(checkSoftwareUpdate('0.1.0',async()=>new Response('',{status:503}),sha),/HTTP 503/);
});
