import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {Store} from '../src/core/store.mjs';import {Engine} from '../src/core/engine.mjs';import {taskCheckoutPlan} from '../src/core/checkout.mjs';
import {remainingTaskMs} from '../src/core/task-contract.mjs';
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'boujoy-engine-contract-')),store=new Store(dir);store.data.settings.maxTaskMinutes=20;let clock=Date.now(),starts=0;
 const broker={calls:new Map(),approvals:{cancelTask(){}},phone:{release(){},close(){}},browser:{close(){}}};
 const engine=new Engine({store,broker,secrets:{get:async()=> 'synthetic'},memory:{observe:async()=>{}},clock:()=>clock,runFactory:options=>({async start(){starts++;options.onEvent({type:'assistant/message',data:{content:[{type:'text',text:'我在，随时可以帮你。'}]}});},async stop(){},async dispose(){}})});engine.pump=async()=>{};
 t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});return {store,engine,broker,advance:ms=>clock+=ms,clock:()=>clock,starts:()=>starts};}
async function run(f,task){const active={taskId:task.id,controller:new AbortController(),token:'synthetic-token'};f.engine.active.set(task.id,active);f.engine.tokens.set(active.token,active);await f.engine.run(task.id,active);}
test('ordinary chat finishes from its actual answer without finish_task; actions never qualify',async t=>{
 const f=fixture(t),chat=f.engine.create({prompt:'你在干嘛',cloudConsent:true});await run(f,chat);assert.equal(f.store.task(chat.id).status,'completed');assert.equal(f.store.task(chat.id).completionKind,'conversation');assert.equal(f.store.task(chat.id).result,'我在，随时可以帮你。');
 const withEffect=f.engine.create({prompt:'你好',cloudConsent:true});f.store.transaction(s=>s.actions.push({id:'a',taskId:withEffect.id,status:'completed'}));await run(f,withEffect);assert.equal(f.store.task(withEffect.id).status,'needs_review');
 const work=f.engine.create({prompt:'打开设置查看电池',cloudConsent:true});await run(f,work);assert.equal(f.store.task(work.id).status,'needs_review');
});
test('waiting in the queue longer than the budget again expires the task; an expired task never starts a model run',async t=>{
 const f=fixture(t),task=f.engine.create({prompt:'帮我点牛肉面',cloudConsent:true});f.advance(600001);await Engine.prototype.pump.call(f.engine);assert.equal(f.starts(),0);assert.equal(f.store.task(task.id).status,'expired');
});
test('correction, continuation and consent cannot extend original deadline; new explicit goal retains chain history',async t=>{
 const f=fixture(t),task=f.engine.create({prompt:'帮我点牛肉面',cloudConsent:true});const deadline=task.deadlineAt,start=task.timeline.submittedAt;f.advance(30000);
 await f.engine.continue(task.id,{message:'这次是猪脚饭'});assert.equal(f.store.task(task.id).deadlineAt,deadline);assert.equal(remainingTaskMs(f.store.task(task.id),f.clock()),270000);
 await f.engine.continue(task.id,{cloudConsent:true,maxRunSeconds:600});assert.equal(f.store.task(task.id).deadlineAt,deadline);
 f.advance(270001);await f.engine.continue(task.id,{message:'继续'});assert.equal(f.store.task(task.id).status,'expired');assert.equal(f.store.task(task.id).deadlineAt,deadline);
 await f.engine.continue(task.id,{message:'新任务：帮我点牛肉面'});const updated=f.store.task(task.id);assert.equal(updated.status,'queued');assert.equal(updated.timeline.segments.length,2);assert.equal(updated.timeline.submittedAt,start);assert.equal(remainingTaskMs(updated,f.clock()),300000);
});
test('unknown navigation resolves only with evidence and preserves its original receipt',async t=>{
 const f=fixture(t),task=f.engine.create({prompt:'打开设置查看电池',cloudConsent:true});f.store.transaction(s=>{s.tasks[0].status='unknown_result';s.actions.push({id:'a',taskId:task.id,status:'unknown'});});
 await f.engine.reconcile(task.id,'我觉得已经打开');assert.equal(f.store.task(task.id).status,'unknown_result');
 f.broker.reconcilePhoneNavigation=async()=>{f.store.transaction(s=>s.actions[0].resolution={kind:'goal_observed',evidenceId:'verified-native'});return {resolved:true};};
 await f.engine.reconcile(task.id,'查询证据');assert.equal(f.store.task(task.id).status,'paused');assert.equal(f.store.data.actions[0].status,'unknown');assert.equal(f.store.data.actions[0].resolution.kind,'goal_observed');
});
test('original timeline and contract survive service restart without deadline renewal',t=>{
 const f=fixture(t),task=f.engine.create({prompt:'帮我点牛肉面',cloudConsent:true}),dir=f.store.dir;f.store.close();const reopened=new Store(dir);try{assert.equal(reopened.task(task.id).deadlineAt,task.deadlineAt);assert.deepEqual(reopened.task(task.id).taskContract,task.taskContract);}finally{reopened.close();}
});
test('remote new goal counts transport delay and remote continuation can only tighten deadline',async t=>{
 const f=fixture(t),task=f.engine.create({prompt:'帮我点牛肉面',cloudConsent:true});const original=f.store.task(task.id).deadlineAt;f.advance(20000);
 await f.engine.continue(task.id,{message:'继续',submittedAt:new Date(f.clock()-5000).toISOString(),deadlineAt:new Date(f.clock()+400000).toISOString()});assert.equal(f.store.task(task.id).deadlineAt,original);
 await f.engine.continue(task.id,{message:'新任务：帮我点牛肉面',submittedAt:new Date(f.clock()-10000).toISOString(),deadlineAt:new Date(f.clock()+400000).toISOString()});assert.equal(remainingTaskMs(f.store.task(task.id),f.clock()),290000);
 await f.engine.continue(task.id,{message:'继续',deadlineAt:new Date(f.clock()+5000).toISOString()});assert.equal(remainingTaskMs(f.store.task(task.id),f.clock()),5000);
});
test('remote owner and expiry are stored atomically with the original task and preserved on followup',async t=>{
 const f=fixture(t),remoteDeviceId='11111111-1111-4111-8111-111111111111',remoteExpiresAt=new Date(f.clock()+45000).toISOString();
 const task=f.engine.create({prompt:'帮我点牛肉面',remoteDeviceId,remoteExpiresAt,cloudConsent:true});
 const saved=JSON.parse(fs.readFileSync(f.store.file,'utf8')).tasks.find(t=>t.id===task.id);assert.equal(saved.remoteDeviceId,remoteDeviceId);assert.equal(saved.remoteExpiresAt,remoteExpiresAt);assert.ok(Date.parse(saved.deadlineAt)>Date.parse(remoteExpiresAt),'the message expiry bounds delivery only; the task gets normal working time');
 await f.engine.continue(task.id,{message:'继续'});assert.equal(f.store.task(task.id).remoteDeviceId,remoteDeviceId);
 assert.throws(()=>f.engine.newTask({prompt:'test',remoteDeviceId:'not-a-uuid'}));assert.throws(()=>f.engine.newTask({prompt:'test',remoteDeviceId,remoteExpiresAt:'bad-date'}));
 const input={prompt:'你好',remoteDeviceId,clientRequestId:'22222222-2222-4222-8222-222222222222'};const first=f.engine.create(input);assert.equal(f.engine.create(input).id,first.id);
 assert.throws(()=>f.engine.create({...input,remoteDeviceId:'33333333-3333-4333-8333-333333333333'}),/另一设备/);
});
test('remote attachments are atomically visible with the user message and bound by digest and owner',async t=>{
 const f=fixture(t),messageId='22222222-2222-4222-8222-222222222222',id='33333333-3333-4333-8333-333333333333';
 const artifact={id,name:'note.txt',path:`inputs/${messageId}/${id}`,mime:'text/plain',size:4,sha256:'a'.repeat(64),kind:'input',createdAt:new Date(f.clock()).toISOString(),sourceMessageId:messageId};
 const input={prompt:'总结附件',cloudConsent:true,clientRequestId:messageId,inputDigest:'b'.repeat(64),inputArtifacts:[artifact]};const task=f.engine.create(input),saved=JSON.parse(fs.readFileSync(f.store.file,'utf8'));
 assert.equal(saved.artifacts[0].taskId,task.id);assert.equal(saved.artifacts[0].sourceMessageId,task.messages[0].id);assert.equal(saved.tasks[0].messages[0].inputDigest,input.inputDigest);assert.equal(f.engine.create(input).id,task.id);assert.throws(()=>f.engine.create({...input,inputDigest:'c'.repeat(64)}));
 const remoteDeviceId='44444444-4444-4444-8444-444444444444';await f.engine.message(task.id,{message:'继续',clientRequestId:'55555555-5555-4555-8555-555555555555',remoteDeviceId,inputDigest:'d'.repeat(64)});assert.equal(f.store.task(task.id).remoteDeviceId,remoteDeviceId);
 await assert.rejects(f.engine.continue(task.id,{message:'继续',remoteDeviceId:'66666666-6666-4666-8666-666666666666'}));
 assert.throws(()=>f.engine.create({...input,clientRequestId:'77777777-7777-4777-8777-777777777777',inputArtifacts:[{...artifact,path:'../secret'}]}));
});
test('deleted roles prevent queued execution and continuation while merely hidden roles retain history continuation',async t=>{
 const f=fixture(t),task=f.engine.create({prompt:'你好',cloudConsent:true});f.store.transaction(s=>{const role=s.roles.find(r=>r.id===task.roleId);role.hidden=true;});await f.engine.continue(task.id,{message:'你好'});assert.equal(f.store.task(task.id).status,'queued');
 f.store.transaction(s=>{s.roles.find(r=>r.id===task.roleId).deletedAt=new Date(f.clock()).toISOString();});await Engine.prototype.pump.call(f.engine);assert.equal(f.store.task(task.id).status,'paused');assert.equal(f.starts(),0);await assert.rejects(f.engine.continue(task.id,{message:'继续'}),/删除/);assert.ok(f.store.task(task.id).messages.length>=2);
});
test('remote runtime and continuation remain bound to the current control epoch without extending deadline',async t=>{
 const f=fixture(t),remoteDeviceId='11111111-1111-4111-8111-111111111111',task=f.engine.create({prompt:'你好',cloudConsent:true,remoteDeviceId,remoteControlEpoch:6}),deadline=task.deadlineAt;
 f.store.updateTask(task.id,t=>t.status='running');let control={paused:false,controlEpoch:6};f.engine.remoteControlState=()=>control;const active={taskId:task.id,token:'epoch-test',controller:new AbortController()};assert.equal(f.engine.authorizeRuntime(active),active);
 control={paused:false,controlEpoch:7};assert.throws(()=>f.engine.authorizeRuntime(active));assert.equal(active.controller.signal.aborted,true);
 await f.engine.continue(task.id,{remoteDeviceId,remoteControlEpoch:7});assert.equal(f.store.task(task.id).remoteControlEpoch,7);assert.equal(f.store.task(task.id).deadlineAt,deadline);assert.throws(()=>f.engine.newTask({prompt:'你好',remoteControlEpoch:8}));
});

test('content-free consent and remote resume preserve the source-bound meal scope and original deadline',async t=>{
 const f=fixture(t),remoteDeviceId='11111111-1111-4111-8111-111111111111',task=f.engine.create({prompt:'淘宝闪购点一杯冰美式，到结算页',cloudConsent:false}),query=task.phoneQuery,deadline=task.deadlineAt;f.advance(5000);
 await f.engine.continue(task.id,{cloudConsent:true,memoryConsent:false,remoteDeviceId,remoteControlEpoch:2});const resumed=f.store.task(task.id);assert.equal(resumed.status,'queued');assert.deepEqual(resumed.phoneQuery,query);assert.equal(taskCheckoutPlan(resumed)?.query,'冰美式');assert.equal(resumed.deadlineAt,deadline);assert.equal(resumed.messages.length,1);
 f.store.updateTask(task.id,t=>t.taskContract.source.contentSha256='forged');await f.engine.continue(task.id,{});assert.equal(f.store.task(task.id).phoneQuery,null,'invalid provenance cannot preserve a query');
});


test('natural small talk ends as conversation while underspecified input asks for input without a false failure',async t=>{
 const f=fixture(t);
 for(const prompt of ['你干嘛呢','你现在忙什么呀','在吗？']){
  const task=f.engine.create({prompt,cloudConsent:true});await run(f,task);assert.equal(f.store.task(task.id).status,'completed',prompt);assert.equal(f.store.task(task.id).completionKind,'conversation');
 }
 for(const prompt of ['1','那个东西','那件事']){
  const task=f.engine.create({prompt,cloudConsent:true});await run(f,task);assert.equal(f.store.task(task.id).status,'needs_input',prompt);assert.equal(f.store.task(task.id).completionKind,'clarification');assert.equal(f.store.task(task.id).blockedReason,'');assert.equal(f.store.task(task.id).cloudConsent,true);
 }
 const command=f.engine.create({prompt:'你干嘛呢，打开设置查看电池',cloudConsent:true});await run(f,command);assert.equal(f.store.task(command.id).status,'needs_review');assert.equal(f.store.task(command.id).taskContract.intent,'task');
});


test('a complete coffee request gets a fresh segment rather than the 9.5 seconds left by the prior request',async t=>{
 const f=fixture(t),task=f.engine.create({prompt:'打开设置查看电池',cloudConsent:true,maxRunSeconds:120});
 f.store.updateTask(task.id,t=>t.status='completed');
 await f.engine.continue(task.id,{message:'打开淘宝点杯咖啡，冰美式'});f.advance(50500);
 assert.equal(remainingTaskMs(f.store.task(task.id),f.clock()),1149500);
 await f.engine.continue(task.id,{message:'打开淘宝点杯冰美式咖啡'});
 const current=f.store.task(task.id);assert.equal(remainingTaskMs(current,f.clock()),1149500);assert.equal(current.messages.at(-1).content,'打开淘宝点杯冰美式咖啡');assert.equal(current.taskContract.intent,'task');assert.equal(current.memoryConsent,false);
});
test('a repeated purchase never renews a budget after a possible cart effect or an unknown result',async t=>{
 const f=fixture(t),task=f.engine.create({prompt:'淘宝点一杯冰美式',cloudConsent:true}),deadline=task.deadlineAt;
 f.store.transaction(s=>s.actions.push({id:'cart-original',taskId:task.id,status:'completed',tool:'phone_action',authorization:'preparation_scope'}));f.advance(30000);
 await f.engine.continue(task.id,{message:'淘宝点一杯冰美式'});assert.equal(f.store.task(task.id).deadlineAt,deadline);
 f.store.updateTask(task.id,t=>t.status='unknown_result');await assert.rejects(f.engine.continue(task.id,{message:'淘宝点一杯冰美式'}));assert.equal(f.store.data.actions[0].id,'cart-original');
});

test('terminal model errors retain safe cause codes and never misreport an earlier recovered tap error',async t=>{
 const f=fixture(t),task=f.engine.create({prompt:'淘宝买一瓶无糖可乐，到结算页',cloudConsent:true});
 f.engine.runFactory=options=>({async start(){f.store.event(task.id,'tool_error','旧定位错误',{code:'phone_target_missing'});options.onEvent({type:'turn/end',data:{reason:{kind:'error',error:{code:'CONTEXT_LENGTH_EXCEEDED',status:400,message:'sensitive provider body',requestId:'private-id'}}}});},async dispose(){}});
 await run(f,task);const current=f.store.task(task.id),end=current.events.find(e=>e.type==='turn');assert.equal(end.errorCode,'CONTEXT_LENGTH_EXCEEDED');assert.equal(end.httpStatus,400);assert.ok(!JSON.stringify(end).includes('sensitive'));assert.ok(!JSON.stringify(end).includes('private-id'));
 assert.match(current.blockedReason,/CONTEXT_LENGTH_EXCEEDED/);assert.ok(!current.blockedReason.includes('旧定位错误'));
});

test('zero duration creates an unlimited task and runs without an overflow timer',async t=>{const f=fixture(t);f.store.data.settings.maxTaskMinutes=0;const task=f.engine.create({prompt:'整理工作',cloudConsent:true});assert.equal(task.deadlineAt,null);assert.equal(task.taskContract.expiresAt,null);f.advance(365*86400000);await run(f,task);assert.equal(f.starts(),1);assert.notEqual(f.store.task(task.id).status,'expired');});
