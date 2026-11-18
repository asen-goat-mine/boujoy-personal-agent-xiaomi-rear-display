import test from 'node:test';
import assert from 'node:assert/strict';
import {DraftStream,LiveDrafts} from '../src/core/live-draft.mjs';

const sse=events=>events.map(value=>`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`).join('');
test('only text deltas from the streamed model response become the draft, split across arbitrary chunk boundaries',()=>{
 const seen=[];const stream=new DraftStream(text=>seen.push(text));
 const body=sse([{type:'message_start',message:{id:'m'}},{type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'明天'}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'晴，🌤️'}},{type:'content_block_start',index:1,content_block:{type:'tool_use',name:'web_search'}},{type:'content_block_delta',index:1,delta:{type:'input_json_delta',partial_json:'{"query":"x"}'}},{type:'message_stop'}]);
 const bytes=Buffer.from(body);for(let i=0;i<bytes.length;i+=7)stream.push(bytes.subarray(i,i+7));
 assert.equal(seen.at(-1),'明天晴，🌤️');assert.ok(seen.every(text=>!text.includes('query')));
});
test('a new model request in the same run resets the draft',()=>{
 const seen=[];const stream=new DraftStream(text=>seen.push(text));
 stream.push(sse([{type:'message_start'},{type:'content_block_start',index:0,content_block:{type:'text'}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'我先查一下'}}]));
 stream.push(sse([{type:'message_start'}]));assert.equal(seen.at(-1),'');
 stream.push('data: not json\n\n');assert.equal(seen.at(-1),'');
});
test('drafts are throttled per task and clearing publishes an empty draft once',async()=>{
 const published=[];const drafts=new LiveDrafts({publish:value=>published.push(value),intervalMs:20});
 drafts.update('a','一');drafts.update('a','一二');drafts.update('a','一二三');assert.equal(published.length,0);
 await new Promise(resolve=>setTimeout(resolve,40));assert.deepEqual(published,[{type:'draft',taskId:'a',text:'一二三',thinking:''}]);assert.equal(drafts.get('a').text,'一二三');
 drafts.clear('a');drafts.clear('a');assert.deepEqual(published.at(-1),{type:'draft',taskId:'a',text:'',thinking:''});assert.equal(published.length,2);assert.equal(drafts.get('a'),null);drafts.close();
});
test('finish_task\'s summary streams into the draft as it is written, after any earlier text; other tool arguments never do',()=>{
 const seen=[];const stream=new DraftStream(text=>seen.push(text));
 const parts=['{"outcome":"comp','leted","sum','mary":"明天洛杉','矶不下雨，\\n','出门不用带伞\\u3002','","evidence":["obs-1"]}'];
 const body=sse([{type:'message_start',message:{id:'m'}},{type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'查好了。'}},
  {type:'content_block_start',index:1,content_block:{type:'tool_use',name:'mcp__boujoy__finish_task'}},...parts.map(partial_json=>({type:'content_block_delta',index:1,delta:{type:'input_json_delta',partial_json}})),{type:'message_stop'}]);
 const bytes=Buffer.from(body);for(let i=0;i<bytes.length;i+=5)stream.push(bytes.subarray(i,i+5));
 assert.equal(seen.at(-1),'查好了。\n\n明天洛杉矶不下雨，\n出门不用带伞。');
 assert.ok(seen.some(text=>text==='查好了。\n\n明天洛杉'),'shown while still being written');assert.ok(seen.every(text=>!text.includes('obs-1')&&!text.includes('outcome')));
});

test('thinking blocks stream into the thinking chain and accumulate across the run\'s model steps',async()=>{
 const published=[];const drafts=new LiveDrafts({publish:value=>published.push(value),intervalMs:10});const stream=drafts.stream('t');
 stream.push(sse([{type:'message_start'},{type:'content_block_start',index:0,content_block:{type:'thinking',thinking:''}},{type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:'先看看'}},{type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:'天气。'}},{type:'content_block_start',index:1,content_block:{type:'text',text:''}},{type:'content_block_delta',index:1,delta:{type:'text_delta',text:'好的'}}]));
 assert.equal(drafts.get('t').thinking,'先看看天气。');assert.equal(drafts.get('t').text,'好的','thinking never leaks into the answer');
 const next=drafts.stream('t');next.push(sse([{type:'message_start'},{type:'content_block_start',index:0,content_block:{type:'thinking',thinking:''}},{type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:'上海 18 度。'}}]));
 assert.equal(drafts.get('t').thinking,'先看看天气。\n\n上海 18 度。');
 await new Promise(resolve=>setTimeout(resolve,25));assert.equal(published.at(-1).thinking,'先看看天气。\n\n上海 18 度。');
 drafts.clear('t');assert.deepEqual(published.at(-1),{type:'draft',taskId:'t',text:'',thinking:''});drafts.close();
});
