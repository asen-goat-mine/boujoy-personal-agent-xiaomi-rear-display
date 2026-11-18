import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {memoryClassifier,BokPersonalMemory} from '../src/adapters/bok-personal.mjs';import {Store} from '../src/core/store.mjs';import {reserveMemoryUsage,commitMemoryUsage} from '../src/core/model-usage.mjs';
const deferred=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve};};
async function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'boujoy-memory-http-')),store=new Store(dir);let calls=0,handler=(req,res)=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({type:'message',content:[{type:'text',text:'{"signals":[]}'}],usage:{input_tokens:12,output_tokens:7}}));};
 const server=http.createServer(async(req,res)=>{for await(const chunk of req){}calls++;handler(req,res);});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${server.address().port}/v1/messages`;
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();fs.rmSync(dir,{recursive:true,force:true});});
 const fetcher=async(target,init)=>{assert.equal(target,'https://api.deepseek.com/anthropic/v1/messages');return fetch(url,init);};
 return {store,calls:()=>calls,setHandler(value){handler=value;},classify(options={}){return memoryClassifier({secrets:{get:async()=> 'isolated-placeholder'},fetcher,onRequest:()=>reserveMemoryUsage(store),onUsage:(usage,id)=>commitMemoryUsage(store,id,usage),...options});}};
}
test('memory classification rechecks authorization after delayed credential read without dispatching or counting',async t=>{
 const f=await fixture(t),entered=deferred(),key=deferred();let allowed=true;const classify=f.classify({secrets:{async get(){entered.resolve();return key.promise;}}});
 const pending=classify({content:'test local preference',existing:[],isAuthorized:()=>allowed}),rejected=assert.rejects(pending,{code:'memory_authorization_revoked'});await entered.promise;allowed=false;key.resolve('isolated-placeholder');await rejected;assert.equal(f.calls(),0);assert.equal(f.store.data.usage.requests,0);assert.equal(f.store.data.memoryUsageReceipts,undefined);
});
test('actual local HTTP memory replies add only reported tokens, including invalid-signal replies, once per receipt',async t=>{
 const f=await fixture(t),classify=f.classify();assert.deepEqual(await classify({content:'local preference',existing:[],isAuthorized:()=>true}),[]);
 f.setHandler((req,res)=>res.end(JSON.stringify({type:'message',content:[{type:'text',text:'{"signals":[]}'}]})));await classify({content:'second preference',existing:[]});
 f.setHandler((req,res)=>res.end(JSON.stringify({type:'message',content:[{type:'text',text:'not valid signals'}],usage:{input_tokens:5,output_tokens:3}})));await assert.rejects(classify({content:'third preference',existing:[]}),{code:'memory_interpretation_invalid'});
 const usage=f.store.data.usage;assert.equal(usage.requests,3);assert.equal(usage.memoryRequests,3);assert.equal(usage.inputTokens,17);assert.equal(usage.outputTokens,10);assert.equal(usage.measuredRequests,2);assert.equal(usage.unavailableUsageRequests,1);assert.deepEqual(usage.memory,{inputTokens:17,outputTokens:10,measuredRequests:2,partialUsageRequests:0,unavailableUsageRequests:1});
 const receipts=f.store.data.memoryUsageReceipts;assert.equal(receipts[1].usage.inputTokens,undefined);commitMemoryUsage(f.store,receipts[0].id,{status:'reported',inputTokens:999,outputTokens:999});assert.equal(f.store.data.usage.inputTokens,17);assert.ok(!fs.readFileSync(f.store.file,'utf8').includes('local preference'));
});
test('an available task abort cancels an in-flight memory HTTP request and records unavailable usage',async t=>{
 const f=await fixture(t),received=deferred();f.setHandler(()=>received.resolve());const controller=new AbortController(),pending=f.classify()({content:'local preference',existing:[],isAuthorized:()=>true,signal:controller.signal}),rejected=assert.rejects(pending,error=>error.name==='AbortError');await received.promise;controller.abort();await rejected;
 assert.equal(f.calls(),1);assert.equal(f.store.data.usage.requests,1);assert.equal(f.store.data.memoryUsageReceipts[0].status,'unavailable');assert.equal(f.store.data.memoryUsageReceipts[0].usage.inputTokens,undefined);
});
test('Bok observe forwards its live authorization predicate through the keychain wait',async t=>{
 const f=await fixture(t),entered=deferred(),key=deferred();let allowed=true,learningCalls=0;const personal=new BokPersonalMemory({vault:'unused-local-fixture',classify:f.classify({secrets:{async get(){entered.resolve();return key.promise;}}})});personal.call=async op=>{if(op==='context')return {claims:[]};learningCalls++;return {};};
 const pending=personal.observe({authorized:true,memoryMode:'default',content:'我习惯先写提纲',isAuthorized:()=>allowed}),rejected=assert.rejects(pending,{code:'memory_authorization_revoked'});await entered.promise;allowed=false;key.resolve('isolated-placeholder');await rejected;assert.equal(learningCalls,0);assert.equal(f.calls(),0);
});
