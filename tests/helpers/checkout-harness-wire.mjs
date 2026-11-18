import {syntheticTurnEnd} from '../../src/core/synthetic-turn-end.mjs';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import {prepareData,DATA} from '../../src/config.mjs';
import {Store} from '../../src/core/store.mjs';
import {Engine} from '../../src/core/engine.mjs';
import {Approvals} from '../../src/core/approvals.mjs';
import {Broker,TOOL_DEFINITIONS} from '../../src/tools/broker.mjs';

// All model traffic terminates at this ephemeral loopback server. No phone,
// keychain, external model, production DATA or application server is used.
assert.ok(process.env.BOUJOY_DATA,'The test must provide an isolated DATA directory');
prepareData();
const store=new Store(DATA);
// This isolated fixture explicitly enables its synthetic phone. Production
// defaults remain disabled; the Broker still enforces the real permission gate.
store.transaction(state=>{state.settings.phoneEnabled=true;});
const approvals=new Approvals(store);
const events=[],logs=[],toolCalls=[],modelPayloads=[];
const initialImage=fs.readFileSync(new URL('../fixtures/screenshot.png',import.meta.url)).toString('base64');
const finalImage='synthetic-local-final-checkout-image';
let stableReads=0,phoneActions=0,released=0,engine,requests=0,finishReply;
const line=(text,y)=>({id:text,text,bounds:[40,y,500,y+40],center:{x:270,y:y+20}});
const checkoutOcr=()=>({width:1000,height:2000,lines:[
  line('确认订单',100),line('经典牛肉面',500),line('x2',560),
  line('实付 ¥38.00',1830),line('立即支付 ¥38.00',1900)
]});
const nativeTree=()=>({content:[{type:'text',text:JSON.stringify({ok:true,result:{
  display:'main',foreground:'com.taobao.taobao/com.taobao.tao.TBMainActivity',
  windowPkg:'com.taobao.taobao',tree:'window pkg=com.taobao.taobao'
}})}]});
const phone={
  observation:null,
  async observeStable(taskId){
    stableReads++;
    const id='synthetic-checkout-'+stableReads;
    this.observation={id,taskId,at:Date.now(),stability:'stable',stabilityScope:'full',tree:nativeTree(),ocr:checkoutOcr()};
    return {content:[
      {type:'text',text:JSON.stringify({observationId:id,stability:'stable',stabilityScope:'full',textTargets:this.observation.ocr.lines})},
      {type:'image',mimeType:'image/png',data:stableReads===1?initialImage:finalImage}
    ]};
  },
  async act(){phoneActions++;throw Error('No phone action is expected at checkout');},
  async openApp(){phoneActions++;throw Error('No app launch is expected at checkout');},
  release(){released++;},
  close(){}
};
const memory={observe:async()=>{throw Error('Memory must not run in this session-only test');}};
const broker=new Broker({store,approvals,memory,phone,browser:{close(){}}});
function json(res,value,status=200){
  if(res.destroyed)return;
  res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));
}
function streamMessage(res,data,content){
  const message={id:'synthetic-checkout-'+requests,type:'message',role:'assistant',model:data.model,
    content,stop_reason:'tool_use',stop_sequence:null,usage:{input_tokens:12,output_tokens:12}};
  if(!data.stream)return json(res,message);
  res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'});
  const emit=(type,value)=>res.write(`event: ${type}\ndata: ${JSON.stringify({type,...value})}\n\n`);
  emit('message_start',{message:{...message,content:[],stop_reason:null}});
  for(const [index,block] of content.entries()){
    emit('content_block_start',{index,content_block:{...block,input:{}}});
    emit('content_block_delta',{index,delta:{type:'input_json_delta',partial_json:JSON.stringify(block.input)}});
    emit('content_block_stop',{index});
  }
  emit('message_delta',{delta:{stop_reason:'tool_use',stop_sequence:null},usage:{output_tokens:12}});
  emit('message_stop',{});res.end();
}
const server=http.createServer(async(req,res)=>{
  try{
    if(req.url.endsWith('/files'))return json(res,{},404);
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const data=JSON.parse(Buffer.concat(chunks).toString()||'{}');
    if(req.url==='/internal/tools/version')return json(res,{version:0});
  if(req.url==='/internal/tools/list')return json(res,{tools:TOOL_DEFINITIONS});
    if(req.url==='/internal/tools/call'){
      const token=String(req.headers.authorization||'').replace(/^Bearer /,'');
      const active=engine.tokens.get(token);assert.ok(active,'Only the active test Harness may invoke tools');
      toolCalls.push(data.name);
      const result=await broker.execute(active.taskId,data.name,data.arguments||{},active.controller.signal);
      if(data.name==='finish_task')finishReply=result;
      return json(res,result);
    }
    const modelToken=req.url.match(/^\/internal\/model\/([^/]+)\//)?.[1];
  if(engine.tokens.get(modelToken)?.softFinished)return syntheticTurnEnd(res,data.stream!==false);
  assert.match(req.url,/^\/internal\/model\/[a-f0-9]{64}\//,'Unexpected network path');
    requests++;modelPayloads.push(JSON.stringify(data.messages));
    assert.ok(requests<=2,'The model continued after ready_for_user; checkout must freeze the Harness');
    const names=(data.tools||[]).map(t=>t.name);
    const step=requests===1?['phone_observe',{}]:['finish_task',{
      outcome:'ready_for_user',summary:'An unverified model summary must not become the handoff.',
      evidence:[phone.observation.id],checkoutItem:'经典牛肉面',checkoutQuantity:2,checkoutTotalFen:3800
    }];
    const name=names.find(n=>n==='mcp__personal__'+step[0]);assert.ok(name,'Missing brokered tool '+step[0]);
    return streamMessage(res,data,[{type:'tool_use',id:'checkout-call-'+requests,name,input:step[1]}]);
  }catch(error){logs.push(error.message);json(res,{error:{message:error.message}},500);}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
engine=new Engine({store,broker,memory,secrets:{get:async()=> 'synthetic-not-a-key'},
  origin:`http://127.0.0.1:${server.address().port}`,log:(...parts)=>logs.push(parts.join(':'))});
const onEvent=engine.onEvent.bind(engine);
engine.onEvent=(id,event)=>{events.push(event.type);onEvent(id,event);};
let task;
process.on('uncaughtExceptionMonitor',error=>{
  console.error(JSON.stringify({test:'checkout-harness',error:error.code||error.message,status:task&&store.task(task.id).status,requests,stableReads,toolCalls,logs:logs.slice(-4)}));
});
try{
  task=engine.create({prompt:'在淘宝闪购点两份牛肉面，预算40元，到结算页，我自己付款。',kind:'food',
    cloudConsent:true,memoryConsent:false,memoryMode:'session_only',phoneQuery:{platform:'taobao',query:'牛肉面'}});
  for(let i=0;i<900;i++){
    await new Promise(resolve=>setTimeout(resolve,50));task=store.task(task.id);
    if(!['queued','running','waiting_approval'].includes(task.status)&&!engine.active.size)break;
  }
  const diagnostic=JSON.stringify({status:task.status,reason:task.blockedReason,requests,stableReads,toolCalls,events,logs:logs.slice(-8)});
  assert.equal(task.status,'ready_for_user',diagnostic);
  assert.equal(engine.active.size,0,diagnostic);
  assert.ok([...engine.tokens.values()].some(active=>active.parked));
  assert.deepEqual(toolCalls,['phone_observe','finish_task']);
  assert.equal(requests,2);assert.equal(stableReads,1);assert.equal(released,1);
  assert.equal(task.report.outcome,'ready_for_user');
  assert.equal(task.checkout.item,'经典牛肉面');assert.equal(task.checkout.quantity,2);
  assert.equal(task.checkout.totalFen,3800);assert.equal(task.checkout.paymentStatus,'not_submitted');
  assert.equal(task.checkout.evidenceId,'synthetic-checkout-1');
  assert.deepEqual(task.report.evidence,['synthetic-checkout-1']);
  assert.equal(task.quotes.length,0,'Single-platform checkout does not need comparison quotes');
  assert.match(task.result,/自行提交和付款/);
  assert.doesNotMatch(task.result,/unverified model summary/);
  assert.ok(task.completedAt);assert.equal(task.blockedReason,'');
  assert.equal(task.messages.filter(m=>m.role==='assistant'&&m.content===task.result).length,1);
  assert.ok(modelPayloads[1].includes(initialImage),'Initial screenshot must pass through the real Harness MCP wire');
  assert.ok(finishReply,'The broker must produce a verified handoff reply');
  assert.ok(!JSON.stringify(finishReply).includes(finalImage),'Local final recheck screenshot must not leave the broker');
  assert.ok(modelPayloads.every(payload=>!payload.includes(finalImage)));
  assert.equal(store.data.actions.length,0);assert.equal(phoneActions,0);
  assert.equal(store.data.approvals.filter(a=>a.status==='pending').length,0);
  const terminal=JSON.stringify({status:task.status,report:task.report,result:task.result,checkout:task.checkout,completedAt:task.completedAt});
  // An already queued tool reaching the broker after the abort cannot perform an action.
  await assert.rejects(broker.execute(task.id,'phone_action',{
    observationId:task.checkout.evidenceId,action:'back',reason:'Synthetic late action after verified handoff'
  }),/任务当前不能执行工具/);
  await engine.stop(task.id,{pause:true});
  await engine.shutdown();task=store.task(task.id);
  assert.equal(JSON.stringify({status:task.status,report:task.report,result:task.result,checkout:task.checkout,completedAt:task.completedAt}),terminal,
    'Harness teardown, a late tool and a stop must preserve the verified terminal outcome');
  assert.equal(phoneActions,0);assert.equal(store.data.actions.length,0);assert.equal(requests,2);
  console.log(JSON.stringify({passed:true,status:task.status,requests,stableReads,phoneActions,
    pendingApprovals:0,latestObservationReused:true,lateActionRefused:true,model:'synthetic-local-only'}));
}finally{
  await engine.shutdown();await new Promise(resolve=>server.close(resolve));store.close();
}
