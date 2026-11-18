import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {AnthropicUsageMeter,commitModelUsage} from '../src/core/model-usage.mjs';import {Store} from '../src/core/store.mjs';
const event=(type,body)=>`event: ${type}\r\ndata: ${JSON.stringify({type,...body})}\r\n\r\n`;
test('Anthropic JSON usage records only actual numeric provider counters including zero',()=>{
 const meter=new AnthropicUsageMeter();for(const byte of Buffer.from(JSON.stringify({type:'message',content:[{text:'中文'}],usage:{input_tokens:12,output_tokens:0,cache_read_input_tokens:7,cache_creation_input_tokens:3}})))meter.push(Buffer.from([byte]));const usage=meter.finish({transportComplete:true});assert.equal(usage.status,'reported');assert.equal(usage.inputTokens,12);assert.equal(usage.outputTokens,0);assert.equal(usage.cacheReadInputTokens,7);assert.equal(usage.cacheCreationInputTokens,3);
 const missing=new AnthropicUsageMeter();missing.push(Buffer.from('{"type":"message","content":[{"text":"long enough to be billed?"}]}'));assert.equal(missing.finish({transportComplete:true}).status,'unavailable');assert.equal(missing.finish({transportComplete:true}).inputTokens,undefined);
});
test('Anthropic SSE aggregates cumulative frames once across byte/chunk boundaries',()=>{
 const stream=event('message_start',{message:{id:'msg1',usage:{input_tokens:25,output_tokens:1}}})+event('content_block_delta',{delta:{text:'中文'}})+event('message_delta',{usage:{output_tokens:9}})+event('message_delta',{usage:{output_tokens:9}})+event('message_delta',{usage:{output_tokens:15}})+event('message_stop',{});
 const meter=new AnthropicUsageMeter({contentType:'text/event-stream; charset=utf-8'});for(const byte of Buffer.from(stream))meter.push(Buffer.from([byte]));const usage=meter.finish({transportComplete:true});assert.equal(usage.status,'reported');assert.equal(usage.inputTokens,25);assert.equal(usage.outputTokens,15);assert.deepEqual(meter.finish({transportComplete:true}),usage);
});
test('truncation, invalid counters, oversized or absent usage never become invented totals',()=>{
 const partial=new AnthropicUsageMeter({contentType:'text/event-stream'});partial.push(Buffer.from(event('message_start',{message:{usage:{input_tokens:5,output_tokens:1}}})+event('message_delta',{usage:{output_tokens:4}})));assert.deepEqual(Object.entries(partial.finish()).filter(([key])=>['inputTokens','outputTokens','status'].includes(key)),[['inputTokens',5],['outputTokens',4],['status','partial']]);
 const invalid=new AnthropicUsageMeter();invalid.push(Buffer.from(JSON.stringify({type:'message',usage:{input_tokens:'100',output_tokens:-1}})));assert.equal(invalid.finish({transportComplete:true}).status,'unavailable');
 const oversized=new AnthropicUsageMeter({maxBytes:20});oversized.push(Buffer.from('x'.repeat(30)));assert.equal(oversized.finish().reason,'usage_frame_too_large');
 const content=new AnthropicUsageMeter();content.push(Buffer.from(JSON.stringify({type:'message',content:[{text:JSON.stringify({usage:{input_tokens:999}})}]})));assert.equal(content.finish({transportComplete:true}).inputTokens,undefined);
});
test('usage receipts commit once and retain partial versus unknown requests',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'boujoy-usage-')),store=new Store(dir);t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});store.transaction(s=>s.tasks.push({id:'t',modelUsageReceipts:[{id:'a',status:'pending'},{id:'b',status:'pending'},{id:'c',status:'pending'}]}));
 commitModelUsage(store,'t','a',{status:'reported',inputTokens:12,outputTokens:9});commitModelUsage(store,'t','a',{status:'reported',inputTokens:999,outputTokens:999});commitModelUsage(store,'t','b',{status:'partial',inputTokens:5});commitModelUsage(store,'t','c',{status:'unavailable'});
 assert.equal(store.data.usage.inputTokens,17);assert.equal(store.data.usage.outputTokens,9);assert.equal(store.data.usage.measuredRequests,1);assert.equal(store.data.usage.partialUsageRequests,1);assert.equal(store.data.usage.unavailableUsageRequests,1);assert.equal(store.task('t').modelUsageReceipts[1].usage.outputTokens,undefined);
});
