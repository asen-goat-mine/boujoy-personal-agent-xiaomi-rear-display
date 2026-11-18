import assert from 'node:assert/strict';import http from 'node:http';
import {prepareData,DATA} from '../../src/config.mjs';import {Store} from '../../src/core/store.mjs';import {Engine} from '../../src/core/engine.mjs';import {Broker} from '../../src/tools/broker.mjs';import {Approvals} from '../../src/core/approvals.mjs';import {syntheticTurnEnd} from '../../src/core/synthetic-turn-end.mjs';
prepareData();const store=new Store(DATA),memory={observe:async()=>{}},broker=new Broker({store,dataDir:DATA,memory,approvals:new Approvals(store),phone:{release(){},close(){}},browser:{close(){}}});
if(process.env.BOUJOY_TEST_FULL==='1')store.data.settings.harnessFull=true;
let engine,task,parentRequests=0,childRequests=0;const logs=[],calls=[];
const json=(res,x,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(x));};
const server=http.createServer(async(req,res)=>{try{
 const chunks=[];for await(const c of req)chunks.push(c);const data=JSON.parse(Buffer.concat(chunks).toString()||'{}'),active=engine.tokens.get((req.headers.authorization||'').replace(/^Bearer /,''));
 if(req.url==='/internal/harness/guidance')return json(res,broker.runtimeGuidance(active.taskId));
 if(req.url==='/internal/harness/native-authorize')return json(res,{allowed:true});
 if(req.url==='/internal/harness/approval')return json(res,{outcome:'rejected'});
 if(req.url==='/internal/tools/version')return json(res,{version:0});
 if(req.url==='/internal/tools/list')return json(res,{tools:broker.catalog(store.task(active.taskId))});
 if(req.url==='/internal/tools/call'){calls.push(data.name);try{return json(res,await broker.execute(active.taskId,data.name,data.arguments||{},active.controller.signal));}catch(e){logs.push(e.message);return json(res,{error:{code:e.code,message:e.message}},400);}}
 const token=req.url.match(/^\/internal\/model\/([^/]+)\//)?.[1];if(engine.tokens.get(token)?.softFinished)return syntheticTurnEnd(res,data.stream!==false);
 const child=(data.messages||[]).some(m=>m.role==='user'&&(typeof m.content==='string'?m.content:(m.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('\n')).includes('Only reply with the isolated'));let content;
 if(child){
  childRequests++;assert.equal(childRequests<=2,true);assert.ok(data.tools.some(t=>t.name==='mcp__personal__finish_task'));assert.ok(data.tools.some(t=>t.name==='mcp__personal__agent_run'));
  await new Promise(r=>setTimeout(r,400));content=[{type:'text',text:'CHILD-ONLY-ANSWER-'+childRequests}];
 }else{
  parentRequests++;assert.ok(parentRequests<=3,JSON.stringify({parentRequests,logs,calls}));
  if(parentRequests===1)content=['alpha','beta'].map((label,i)=>({type:'tool_use',id:'spawn-'+i,name:'subagent',input:{description:label,prompt:'Only reply with the isolated '+label+' result. Do not use tools.'}}));
  if(parentRequests===2)content=[{type:'tool_use',id:'wait',name:'mcp__personal__delegation_status',input:{wait:true}}];
  if(parentRequests===3){const rows=store.task(task.id).harnessChildren;assert.equal(rows.length,2);assert.ok(rows.every(r=>r.status==='completed'));content=[{type:'tool_use',id:'finish',name:'mcp__personal__finish_task',input:{outcome:'completed',summary:'PARENT-VERIFIED-BOTH',evidence:rows.map(r=>r.id)}}];}
 }
 const message={id:'synthetic-'+parentRequests+'-'+childRequests,type:'message',role:'assistant',model:data.model,content,stop_reason:content.some(c=>c.type==='tool_use')?'tool_use':'end_turn',stop_sequence:null,usage:{input_tokens:10,output_tokens:10}};
 if(!data.stream)return json(res,message);res.writeHead(200,{'Content-Type':'text/event-stream'});const emit=(type,x)=>res.write(`event: ${type}\ndata: ${JSON.stringify({type,...x})}\n\n`);
 emit('message_start',{message:{...message,content:[],stop_reason:null}});for(const [index,c] of content.entries()){emit('content_block_start',{index,content_block:c.type==='tool_use'?{...c,input:{}}:{type:'text',text:''}});emit('content_block_delta',{index,delta:c.type==='tool_use'?{type:'input_json_delta',partial_json:JSON.stringify(c.input)}:{type:'text_delta',text:c.text}});emit('content_block_stop',{index});}emit('message_delta',{delta:{stop_reason:message.stop_reason,stop_sequence:null},usage:{output_tokens:10}});emit('message_stop',{});res.end();
 }catch(e){logs.push(e.stack);json(res,{error:{message:e.message}},500);}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));engine=new Engine({store,broker,memory,secrets:{get:async()=>'synthetic-only'},origin:`http://127.0.0.1:${server.address().port}`,log:(...x)=>logs.push(x.join(':'))});
try{
 task=engine.create({prompt:'Run two independent internal workers and combine their answers.',cloudConsent:true,memoryConsent:false});
 for(let i=0;i<1000;i++){await new Promise(r=>setTimeout(r,25));task=store.task(task.id);if(!engine.active.size&&!['queued','running'].includes(task.status))break;}
 assert.equal(task.status,'completed',JSON.stringify({status:task.status,logs:logs.slice(-8),calls,parentRequests,childRequests}));assert.equal(childRequests,2);assert.equal(parentRequests,3);assert.equal(task.harnessChildren.length,2);assert.equal(task.messages.filter(m=>m.role==='assistant').length,1);assert.equal(task.result,'PARENT-VERIFIED-BOTH');assert.equal(task.events.filter(e=>e.type==='turn').length,1,'child endings cannot masquerade as parent turns');
 console.log(JSON.stringify({passed:true,childRequests,parentRequests,chatReplies:1,childReceipts:task.harnessChildren.length,calls}));
}finally{await engine.shutdown();await new Promise(r=>server.close(r));store.close();}
