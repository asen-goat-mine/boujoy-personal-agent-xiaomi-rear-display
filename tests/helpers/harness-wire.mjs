import {syntheticTurnEnd} from '../../src/core/synthetic-turn-end.mjs';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {prepareData,DATA} from '../../src/config.mjs';
import {Store} from '../../src/core/store.mjs';
import {Engine} from '../../src/core/engine.mjs';
import {CORE_SYSTEM} from '../../src/adapters/harness.mjs';
import {Approvals} from '../../src/core/approvals.mjs';
import {Broker,TOOL_DEFINITIONS} from '../../src/tools/broker.mjs';
prepareData();const store=new Store(DATA);const approvals=new Approvals(store);const events=[];const logs=[];
const memory={context:async()=>({context:'Synthetic memory: verify the final result.',sources:[{path:'test-only.md'}]}),observe:async()=>{}};
const broker=new Broker({store,approvals,memory,phone:{release(){},close(){}},browser:{close(){}}});
let engine,count=0,systemPromptChecks=0,toolNames=[],wirePaths=[],brokerCalls=[];
function modelSystemText(data){
 const text=content=>typeof content==='string'?content:Array.isArray(content)?content.filter(block=>block?.type==='text').map(block=>block.text||'').join('\n'):'';
 return [text(data.system),...(data.messages||[]).filter(message=>message.role==='system').map(message=>text(message.content))].join('\n');
}
function json(res,x){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(x));}
const server=http.createServer(async(req,res)=>{try{
  const chunks=[];for await(const c of req)chunks.push(c);const data=JSON.parse(Buffer.concat(chunks).toString()||'{}');
  if(req.url==='/internal/tools/version')return json(res,{version:0});
  if(req.url==='/internal/tools/list')return json(res,{tools:TOOL_DEFINITIONS});
  if(req.url==='/internal/tools/call'){brokerCalls.push(data.name);const active=engine.tokens.get(req.headers.authorization.slice(7));return json(res,await broker.execute(active.taskId,data.name,data.arguments||{},active.controller.signal));}
  const modelToken=req.url.match(/^\/internal\/model\/([^/]+)\//)?.[1];
  if(engine.tokens.get(modelToken)?.softFinished)return syntheticTurnEnd(res,data.stream!==false);
  wirePaths.push(req.url.replace(/[a-f0-9]{64}/g,'TOKEN'));
  // Every system prompt variant (the user's own task, a delegated or scheduled one) opens with the same identity policy.
  assert.ok(modelSystemText(data).includes(CORE_SYSTEM.split('\n')[0]),'The actual model system channel must include the shared Chinese Personal Agent identity policy');systemPromptChecks++;
  count++;toolNames=(data.tools||[]).map(t=>t.name);if(count>3)throw Error('Unexpected model request after finish_task');
  const step=[['memory_context',{query:'synthetic verification'}],['artifact_write',{name:'synthetic-proof.txt',content:'Synthetic wire test, no personal data.'}],['finish_task',{outcome:'completed',summary:'Synthetic end-to-end run completed.',evidence:store.data.artifacts.map(a=>a.id)}]][count-1];
  const content=step?[{type:'tool_use',id:'call-'+count,name:toolNames.find(n=>n.endsWith(step[0])),input:step[1]}]:[{type:'text',text:'Synthetic end-to-end run completed.'}];
  if(step&&!content[0].name)throw Error('Missing synthetic tool '+step[0]+' in '+toolNames.join(','));
  const message={id:'synthetic-'+count,type:'message',role:'assistant',model:data.model,content,stop_reason:step?'tool_use':'end_turn',stop_sequence:null,usage:{input_tokens:12,output_tokens:12}};
  if(!data.stream)return json(res,message);
  res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'});
  const emit=(type,value)=>res.write(`event: ${type}\ndata: ${JSON.stringify({type,...value})}\n\n`);
  emit('message_start',{message:{...message,content:[],stop_reason:null}});
  for(const [index,c] of content.entries()){
    emit('content_block_start',{index,content_block:c.type==='tool_use'?{...c,input:{}}:{type:'text',text:''}});
    emit('content_block_delta',{index,delta:c.type==='tool_use'?{type:'input_json_delta',partial_json:JSON.stringify(c.input)}:{type:'text_delta',text:c.text}});
    emit('content_block_stop',{index});
  }
  emit('message_delta',{delta:{stop_reason:message.stop_reason,stop_sequence:null},usage:{output_tokens:12}});emit('message_stop',{});res.end();
}catch(e){logs.push(e.message);res.writeHead(500);res.end(JSON.stringify({error:{message:e.message}}));}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
engine=new Engine({store,broker,memory,secrets:{get:async()=> 'synthetic-not-a-key'},origin:`http://127.0.0.1:${server.address().port}`,log:(...x)=>logs.push(x.join(':'))});
const original=engine.onEvent.bind(engine);engine.onEvent=(id,event)=>{events.push(event.type);original(id,event);};
let task;
try{
  task=engine.create({prompt:'Synthetic test only: read synthetic memory, write a synthetic proof file, then finish.',cloudConsent:true,memoryConsent:true});
  for(let i=0;i<900;i++){await new Promise(r=>setTimeout(r,50));task=store.task(task.id);if(!['queued','running','waiting_approval'].includes(task.status)&&!engine.active.size)break;}
  assert.equal(task.status,'completed',JSON.stringify({status:task.status,reason:task.blockedReason,count,wirePaths,events,logs:logs.slice(-8)}));
  assert.equal(count,3,'finish_task must freeze the run without a fourth model request');assert.deepEqual(brokerCalls,['memory_context','artifact_write','finish_task']);assert.equal(store.data.artifacts.length,1);assert.match(fs.readFileSync(path.join(DATA,'artifacts',store.data.artifacts[0].path),'utf8'),/Synthetic wire test/);
  assert.ok(task.messages.some(m=>m.role==='assistant'));
  const frozenMessages=task.messages.length,frozenResult=task.result;
  engine.onEvent(task.id,{type:'assistant/message',data:{message:{content:[{type:'text',text:'Unexpected post-finish message'}]}}});
  assert.equal(task.messages.length,frozenMessages);assert.equal(task.result,frozenResult);
  await assert.rejects(broker.execute(task.id,'artifact_write',{name:'after-finish.txt',content:'This must not be written.'}),e=>e.code==='invalid_input');
  assert.equal(store.data.artifacts.length,1);assert.equal(task.status,'completed');

  // The full Harness keeps its own native tools; Boujoy's tools reach the model through the broker under one prefix.
  const personal=toolNames.filter(n=>n.startsWith('mcp__personal__'));
  assert.ok(personal.length>0&&personal.every(n=>TOOL_DEFINITIONS.some(t=>n==='mcp__personal__'+t.name)),`Unknown brokered tools: ${personal.join(',')}`);
  console.log(JSON.stringify({passed:true,model:'synthetic-local-only',requests:count,tools:toolNames.length,events:[...new Set(events)],artifacts:store.data.artifacts.length,postFinishFrozen:true,brokerCalls,systemPromptVerified:true,systemPromptChecks}));
}finally{await engine.shutdown();await new Promise(r=>server.close(r));store.close();}
