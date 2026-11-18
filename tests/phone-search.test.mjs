import test from 'node:test';
import assert from 'node:assert/strict';
import {searchPhone} from '../src/adapters/phone-search.mjs';
import {searchCommercePhone} from '../src/adapters/commerce-search.mjs';
const grant={platform:'taobao',query:'牛肉面'};
const frame={content:[{type:'text',text:JSON.stringify({observationId:'fresh',textTargets:[{id:'branch-a',text:'入口甲'},{id:'branch-b',text:'入口乙'}]})},{type:'image',mimeType:'image/png',data:'fixture'}]};
test('legacy search returns one fresh observation and leaves every branch to the model',async()=>{
 let reads=0,actions=0;const phone={observeQuery:async(id,scope)=>{reads++;assert.equal(id,'t');assert.deepEqual(scope,grant);return frame;}};
 const result=await searchPhone(phone,{taskId:'t',grant,act:async()=>actions++});
 assert.equal(reads,1);assert.equal(actions,0);assert.equal(result.search.needsModel,true);assert.equal(result.search.actions,0);assert.equal(result.search.reason,'model_driven_search');assert.deepEqual(result.content.slice(1),frame.content);
});
test('commerce compatibility uses the same model-led observation for any supported platform',async()=>{
 for(const platform of ['taobao','meituan','jd','pinduoduo']){
  let actions=0;const result=await searchCommercePhone({observeQuery:async()=>frame},{taskId:'t',grant:{...grant,platform},act:async()=>actions++});
  assert.equal(actions,0);assert.equal(result.search.needsModel,true);
 }
});
test('search never retries or suppresses an unavailable observation as success',async()=>{
 let reads=0;const error=Object.assign(Error('offline'),{code:'device_offline'});
 await assert.rejects(searchPhone({observeQuery:async()=>{reads++;throw error;}},{taskId:'t',grant}),error);assert.equal(reads,1);
});
test('missing scope and cancellation cannot dispatch or read',async()=>{
 let reads=0;const phone={observeQuery:async()=>{reads++;return frame;}};
 for(const scope of [null,{platform:'invented',query:'x'}])await assert.rejects(searchPhone(phone,{taskId:'t',grant:scope}),{code:'invalid_input'});
 const stop=new AbortController();stop.abort();await assert.rejects(searchPhone(phone,{taskId:'t',grant,signal:stop.signal}),{code:'cancelled'});assert.equal(reads,0);
});
test('a cancelled in-flight observation does not become a usable search result',async()=>{
 const stop=new AbortController();await assert.rejects(searchPhone({observeQuery:async()=>{stop.abort();return frame;}},{taskId:'t',grant,signal:stop.signal}),{code:'cancelled'});
});
