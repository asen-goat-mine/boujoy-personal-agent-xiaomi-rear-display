// Real pinned Harness + MCP + spawned child, with a local synthetic model.
// HOME and BOUJOY_DATA must point at the caller's disposable fixture.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {DATA,prepareData} from '../../src/config.mjs';
import {Store} from '../../src/core/store.mjs';
import {Engine} from '../../src/core/engine.mjs';
import {Broker} from '../../src/tools/broker.mjs';
import {HarnessRun} from '../../src/adapters/harness.mjs';

assert.equal(process.env.BOUJOY_F2_FIXTURE,os.homedir(),'do not use the real home');
for(const name of ['Documents','Desktop','Downloads'])fs.mkdirSync(path.join(os.homedir(),name),{recursive:true});
const invoice=path.join(os.homedir(),'Downloads/f2-invoice.txt');fs.writeFileSync(invoice,'F2 synthetic invoice: total 12.34');
prepareData();const store=new Store(DATA),logs=[],calls=[];
const broker=new Broker({store,dataDir:DATA,phone:{release(){},close(){}},browser:{close(){}},memory:{},approvals:{cancelTask(){}}});
const engine=new Engine({store,broker,secrets:{get:async()=>null},memory:{}});engine.pump=async()=>{};
const task=engine.create({prompt:'一边整理下载里的发票，一边把外卖做到付款页就停',cloudConsent:true});store.updateTask(task.id,t=>t.status='running');
const catalog=broker.catalog(store.task(task.id)),parentNames=catalog.map(t=>t.name);
let parentRequests=0,childRequests=0,childTools=[],sawInvoice=false,resolveRead;
const readDone=new Promise(resolve=>{resolveRead=resolve;});
function json(res,value){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(value));}
function reply(res,data,step){
 const tool=Array.isArray(step),content=tool?[{type:'tool_use',id:'f2-'+parentRequests+'-'+childRequests,name:step[0],input:step[1]}]:[{type:'text',text:step}];
 const message={id:'f2-message',type:'message',role:'assistant',model:data.model,content,stop_reason:tool?'tool_use':'end_turn',stop_sequence:null,usage:{input_tokens:12,output_tokens:12}};
 if(!data.stream)return json(res,message);
 res.writeHead(200,{'Content-Type':'text/event-stream'});
 const emit=(type,value)=>res.write(`event: ${type}\ndata: ${JSON.stringify({type,...value})}\n\n`);
 emit('message_start',{message:{...message,content:[],stop_reason:null}});
 for(const [index,c] of content.entries()){
  emit('content_block_start',{index,content_block:tool?{...c,input:{}}:{type:'text',text:''}});
  emit('content_block_delta',{index,delta:tool?{type:'input_json_delta',partial_json:JSON.stringify(c.input)}:{type:'text_delta',text:c.text}});
  emit('content_block_stop',{index});
 }
 emit('message_delta',{delta:{stop_reason:message.stop_reason,stop_sequence:null},usage:{output_tokens:12}});emit('message_stop',{});res.end();
}
const server=http.createServer(async(req,res)=>{try{
 const chunks=[];for await(const chunk of req)chunks.push(chunk);const data=JSON.parse(Buffer.concat(chunks).toString()||'{}');
 if(req.url==='/internal/tools/version')return json(res,{version:0});
 if(req.url==='/internal/tools/list')return json(res,{tools:catalog});
 if(req.url==='/internal/tools/call'){
  calls.push(data.name);const result=await broker.execute(task.id,data.name,data.arguments||{});
  if(data.name==='mac_files'){assert.match(JSON.stringify(result),/F2 synthetic invoice/);sawInvoice=true;resolveRead();}
  return json(res,result);
 }
 const names=(data.tools||[]).map(t=>t.name),parent=!(data.messages||[]).some(m=>m.role==='user'&&(typeof m.content==='string'?m.content:(m.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('\n')).includes('F2 synthetic test:'));
 if(parent){
  parentRequests++;assert.ok(parentRequests<=4,'unexpected parent loop');
  if(parentRequests===1){assert.ok(names.includes('subagent'));return reply(res,data,['subagent',{description:'Read F2 invoice file',prompt:'F2 synthetic test: use mac_files read Downloads/f2-invoice.txt and report its exact contents. Do not use the phone.'}]);}
  await readDone;return reply(res,data,'子智能体已读取测试发票；没有操作手机。');
 }
 childRequests++;childTools=names;assert.ok(childRequests<=3,'unexpected child loop');
 for(const name of ['mac_files','artifact_read'])assert.ok(names.includes('mcp__personal__'+name),'child missing '+name);
 assert.ok(names.includes('mcp__personal__finish_task'),'child completion is isolated by the adapter');
 if(childRequests===1)return reply(res,data,['mcp__personal__mac_files',{action:'read',path:'Downloads/f2-invoice.txt'}]);
 return reply(res,data,'F2 synthetic invoice: total 12.34');
}catch(error){logs.push(error.message);if(!res.headersSent)res.writeHead(500);res.end(JSON.stringify({error:{message:error.message}}));}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const run=new HarnessRun({task:store.task(task.id),toolNames:parentNames,token:'f2-synthetic-local',origin:`http://127.0.0.1:${server.address().port}`,prompt:'Run the F2 file child probe.',onEvent(){},onLog:line=>logs.push(line)});
try{
 await run.start();assert.equal(sawInvoice,true,JSON.stringify(logs.slice(-6)));
 assert.deepEqual(calls,['mac_files']);assert.equal(fs.readFileSync(invoice,'utf8'),'F2 synthetic invoice: total 12.34');
 console.log(JSON.stringify({passed:true,model:'synthetic-local-only',parentRequests,childRequests,childHasMacFiles:childTools.includes('mcp__personal__mac_files'),childHasArtifactRead:childTools.includes('mcp__personal__artifact_read'),calls,sourceUnchanged:true}));
}finally{resolveRead();await run.dispose();engine.groups.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();}
