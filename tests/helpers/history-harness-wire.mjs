import {syntheticTurnEnd} from '../../src/core/synthetic-turn-end.mjs';
import assert from 'node:assert/strict';
import http from 'node:http';import fs from 'node:fs';import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {prepareData,DATA} from '../../src/config.mjs';
import {Store} from '../../src/core/store.mjs';import {Engine} from '../../src/core/engine.mjs';
import {Broker} from '../../src/tools/broker.mjs';import {Approvals} from '../../src/core/approvals.mjs';
import {CORE_SYSTEM} from '../../src/adapters/harness.mjs';import {createTaskContract} from '../../src/core/task-contract.mjs';
prepareData();const store=new Store(DATA),memory={observe:async()=>{}},broker=new Broker({store,memory,approvals:new Approvals(store),phone:{release(){},close(){}},browser:{close(){}}});
const marker='独立标记-蓝桉：核验值42',calls=[],logs=[];let engine,task,requests=0,listed,read,systemChars;
const json=(res,value)=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
function textOf(value){return typeof value==='string'?value:Array.isArray(value)?value.filter(row=>row.type==='text').map(row=>row.text).join('\n'):'';}
const server=http.createServer(async(req,res)=>{try{
 const chunks=[];for await(const chunk of req)chunks.push(chunk);const data=JSON.parse(Buffer.concat(chunks).toString()||'{}');
 const active=engine.tokens.get((req.headers.authorization||'').replace(/^Bearer /,''));
 if(req.url==='/internal/tools/version')return json(res,{version:0});
  if(req.url==='/internal/tools/list'){assert.ok(active);return json(res,{tools:broker.catalog(store.task(active.taskId))});}
 if(req.url==='/internal/tools/call'){
  assert.ok(active);calls.push(data.name);const result=await broker.execute(active.taskId,data.name,data.arguments||{},active.controller.signal);
  if(data.name==='task_history'){const value=JSON.parse(result.content[0].text);if(data.arguments.action==='list')listed=value;else read=value;}return json(res,result);
 }
 const modelToken=req.url.match(/^\/internal\/model\/([^/]+)\//)?.[1];
  if(engine.tokens.get(modelToken)?.softFinished)return syntheticTurnEnd(res,data.stream!==false);
  assert.match(req.url,/^\/internal\/model\/[a-f0-9]{64}\//);requests++;assert.ok(requests<=4);
 const system=[textOf(data.system),...(data.messages||[]).filter(m=>m.role==='system').map(m=>textOf(m.content))].join('\n');systemChars=system.length;
 assert.ok(system.includes(CORE_SYSTEM.split('\n')[0]));assert.equal(system.includes('手机 query 观察'),false);
 const payload=JSON.stringify(data.messages);assert.ok(payload.includes('只生成文件，不对外发送'));
 if(requests===1)assert.equal(payload.includes(marker),false,'Marker is outside the initial exact excerpts; history retrieval must really recover it');
 if(requests===3){assert.ok(read?.content.includes(marker));assert.ok(payload.includes(marker),'Actual MCP read result must reach the model');}
 const match=listed?.messages.find(row=>row.role==='assistant');
 const steps=[['task_history',{action:'list',query:'独立标记-蓝桉'}],['task_history',{action:'read',messageRef:match?.ref,offset:match?.previewOffset,maxChars:1000}],['artifact_write',{name:'history-proof.txt',content:read?.content||''}],['finish_task',{outcome:'completed',summary:'已按原始要求生成文件。',evidence:store.data.artifacts.map(row=>row.id)}]],step=steps[requests-1],name=data.tools.find(tool=>tool.name==='mcp__personal__'+step[0])?.name;assert.ok(name);
 const message={id:'local-history-'+requests,type:'message',role:'assistant',model:data.model,content:[{type:'tool_use',id:'call-'+requests,name,input:step[1]}],stop_reason:'tool_use',stop_sequence:null,usage:{input_tokens:10,output_tokens:10}};
 if(!data.stream)return json(res,message);res.writeHead(200,{'Content-Type':'text/event-stream'});
 const emit=(type,body)=>res.write(`event: ${type}\ndata: ${JSON.stringify({type,...body})}\n\n`);
 emit('message_start',{message:{...message,content:[],stop_reason:null}});emit('content_block_start',{index:0,content_block:{...message.content[0],input:{}}});emit('content_block_delta',{index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify(step[1])}});emit('content_block_stop',{index:0});emit('message_delta',{delta:{stop_reason:'tool_use',stop_sequence:null},usage:{output_tokens:10}});emit('message_stop',{});res.end();
}catch(error){logs.push(error.message);res.writeHead(500);res.end(JSON.stringify({error:{message:error.message}}));}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
engine=new Engine({store,broker,memory,secrets:{get:async()=> 'synthetic-local-only'},origin:`http://127.0.0.1:${server.address().port}`,log:(...parts)=>logs.push(parts.join(':'))});
try{
 task=engine.create({prompt:'生成一份核验报告，只生成文件，不对外发送。',cloudConsent:true,memoryConsent:false,memoryMode:'session_only'});
 store.updateTask(task.id,t=>{
  const at=t.messages[0].at;t.messages.push({id:randomUUID(),role:'assistant',content:'旧资料'.repeat(6000)+marker+'旧资料'.repeat(6000),at});
  for(let i=0;i<30;i++)t.messages.push({id:randomUUID(),role:i%2?'user':'assistant',content:i%2?'沿用原要求，补充第'+i+'项。':'历史回答'.repeat(1800),at});
  t.messages.push({id:randomUUID(),role:'user',content:'继续，找回旧资料里的独立标记-蓝桉并生成核验文本。',at});
  t.taskContract=createTaskContract(t,{previous:t.taskContract});
 });
 // The latest user names the search key, not the value. Verify that the value
 // is absent initially and recovered solely from the archived assistant body.
 for(let i=0;i<900;i++){await new Promise(resolve=>setTimeout(resolve,25));task=store.task(task.id);if(!engine.active.size&&!['queued','running','waiting_approval'].includes(task.status))break;}
 assert.equal(task.status,'completed',JSON.stringify({status:task.status,reason:task.blockedReason,logs:logs.slice(-6),requests,calls}));assert.equal(requests,4);assert.deepEqual(calls,['task_history','task_history','artifact_write','finish_task'],JSON.stringify({logs,listed,read}));assert.ok(fs.readFileSync(path.join(DATA,'artifacts',store.data.artifacts[0].path),'utf8').includes(marker));
 console.log(JSON.stringify({passed:true,requests,calls,historyRecovered:true,focusedPolicyVerified:true,systemChars,contextStats:task.contextStats,model:'synthetic-local-only'}));
}finally{await engine.shutdown();await new Promise(resolve=>server.close(resolve));store.close();}
