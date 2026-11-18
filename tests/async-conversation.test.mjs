import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/core/store.mjs';
import {Engine} from '../src/core/engine.mjs';
import {Broker} from '../src/tools/broker.mjs';
import {watchdogCheck} from '../src/core/watchdog.mjs';

function fixture(t,{factory,noPump=true}={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'boujoy-async-')),store=new Store(dir);
  // These cases exercise the bounded-time configuration (unlimited is the default).
  store.transaction(s=>{s.settings.maxTaskMinutes=20;});
  const broker={calls:new Map(),approvals:{cancelTask(){}},phone:{release(){},close(){}},browser:{close(){}},allToolNames:()=>['finish_task','conversation_task']};
  const engine=new Engine({store,broker,secrets:{get:async()=>'synthetic'},memory:{observe:async()=>{}},runFactory:factory||(()=>({async start(){},async stop(){},async dispose(){}}))});
  if(noPump)engine.pump=async()=>{};
  t.after(async()=>{await engine.shutdown();store.close();fs.rmSync(dir,{recursive:true,force:true});});
  return {store,engine,dir};
}
const create=(f,prompt='整理一份资料',extra={})=>f.engine.create({prompt,cloudConsent:true,...extra});
function markRunning(f,task){f.store.updateTask(task.id,t=>{t.status='running';t.runStartedAt=new Date().toISOString();});return f.store.task(task.id);}
async function until(check){for(let n=0;n<100;n++){if(check())return;await new Promise(r=>setTimeout(r,5));}assert.fail('expected task transition did not occur');}

test('two waiting background jobs retain separate runs while a new conversational intent completes',async t=>{
  const gates=new Map(),seen=[];let f;
  const factory=options=>{let release;const wait=new Promise(r=>release=r);gates.set(options.task.id,release);
    const run={dead:false,alive:()=>!run.dead,async start(){seen.push({id:options.task.id,prompt:options.task.prompt,token:options.token});if(options.task.prompt.startsWith('长活'))await f.engine.whileWaiting(options.task.id,()=>wait);options.onEvent({type:'assistant/message',data:{content:[{type:'text',text:'这是本轮实际完成的独立答复。'}]}});},async send(){throw Error('parallel turn reused a busy session');},async stop(){run.dead=true;release();},async dispose(){run.dead=true;}};return run;};
  f=fixture(t,{factory,noPump:false});
  const first=create(f,'长活一：研究资料');await until(()=>f.engine.active.has(first.id));
  const second=await f.engine.message(first.id,{message:'长活二：检查另外一份资料',clientRequestId:randomUUID(),cloudConsent:true});await until(()=>f.engine.active.has(second.id));
  const question=await f.engine.message(first.id,{message:'现在几点',clientRequestId:randomUUID(),cloudConsent:true});await until(()=>f.store.task(question.id).status==='completed');
  assert.equal(f.store.task(first.id).status,'running');assert.equal(f.store.task(second.id).status,'running');assert.equal(seen.length,3);assert.equal(new Set(seen.map(row=>row.token)).size,3);
  gates.get(second.id)();await until(()=>f.store.task(second.id).status==='completed');gates.get(first.id)();await until(()=>f.store.task(first.id).status==='completed');
  assert.equal(f.store.data.tasks.length,3);assert.equal(f.engine.warm.size,0,'late background completion cannot overwrite the newer foreground session');
});

test('explicit new work does not cancel old work and control words target the selected task',async t=>{
  const f=fixture(t),first=create(f);markRunning(f,first);
  const next=await f.engine.message(first.id,{message:'新任务：计算两种报价的差值',clientRequestId:randomUUID(),cloudConsent:true});
  assert.notEqual(next.id,first.id);assert.equal(f.store.task(first.id).status,'running');
  await f.engine.message(first.id,{message:'暂停',clientRequestId:randomUUID()});assert.equal(f.store.task(first.id).status,'paused');assert.equal(f.store.task(next.id).status,'queued');
  const oldContract=f.store.task(first.id).taskContract,deadline=f.store.task(first.id).deadlineAt;
  const same=await f.engine.message(first.id,{message:'继续',clientRequestId:randomUUID(),cloudConsent:true});
  assert.equal(same.id,first.id);assert.equal(same.status,'queued');assert.equal(same.taskContract.goal,oldContract.goal);assert.equal(same.deadlineAt,deadline);
});

test('unknown receipts prevent continuation but never prevent a separate new task',async t=>{
  const f=fixture(t),old=create(f);f.store.updateTask(old.id,t=>{t.status='unknown_result';});f.store.transaction(s=>s.actions.push({id:'u',taskId:old.id,status:'unknown'}));
  await assert.rejects(f.engine.message(old.id,{message:'继续',clientRequestId:randomUUID(),cloudConsent:true}),/核实/);
  const next=await f.engine.message(old.id,{message:'计算 21 乘 34',clientRequestId:randomUUID(),cloudConsent:true});
  assert.notEqual(next.id,old.id);assert.equal(f.store.task(old.id).status,'unknown_result');assert.equal(f.store.data.actions[0].status,'unknown');
});

test('real Broker forwards the exact new message once and records an atomic completion receipt',async t=>{
  const f=fixture(t),target=create(f,'研究近期编程工具');markRunning(f,target);
  const caller=await f.engine.message(target.id,{message:'重点看本地使用体验',clientRequestId:randomUUID(),cloudConsent:true});markRunning(f,caller);
  const broker=new Broker({store:f.store,dataDir:f.dir,phone:{},browser:{},memory:{},approvals:{cancelTask(){}}});broker.engine=f.engine;
  assert.ok(broker.catalog(f.store.task(caller.id)).some(row=>row.name==='conversation_task'));
  await broker.execute(caller.id,'conversation_task',{action:'update',taskId:target.id});
  const saved=JSON.parse(fs.readFileSync(f.store.file,'utf8')),forwarded=saved.tasks.find(t=>t.id===target.id).messages.filter(m=>m.sourceTaskId===caller.id);
  assert.equal(forwarded.length,1);assert.equal(forwarded[0].content,caller.prompt);assert.equal(f.store.task(caller.id).status,'completed');assert.equal(f.store.task(target.id).status,'running');
  const replay=await f.engine.conversationTaskControl(caller.id,{action:'update',taskId:target.id});assert.equal(replay.replayed,true);
  assert.equal(f.engine.takeInterjections(target.id).length,1);assert.equal(f.engine.takeInterjections(target.id).length,0);
});

test('conversation controls cannot cross roles, replay an acted intent, expand authority or resume unknown effects',async t=>{
  const f=fixture(t),target=create(f,'打开设置查看电池'),caller=create(f,'修改提醒时间',{conversationId:target.id});markRunning(f,target);markRunning(f,caller);
  await assert.rejects(f.engine.conversationTaskControl(caller.id,{action:'update',taskId:target.id}),/超出/);
  const cross=create(f,'继续做',{conversationId:target.id,roleId:'work'});markRunning(f,cross);await assert.rejects(f.engine.conversationTaskControl(cross.id,{action:'pause',taskId:target.id}),/同一对话/);
  const read=create(f,'查看屏幕信息',{conversationId:target.id});markRunning(f,read);f.store.transaction(s=>s.actions.push({id:'done',taskId:read.id,status:'completed'}));
  await assert.rejects(f.engine.conversationTaskControl(read.id,{action:'update',taskId:target.id}),/已有操作/);
  f.store.updateTask(target.id,t=>{t.status='unknown_result';});await assert.rejects(f.engine.conversationTaskControl(read.id,{action:'resume',taskId:target.id}),/未知结果/);
});

test('watchdog detects an empty hung run and does not mistake user chatter for progress',()=>{
  const start=Date.now()-7*60000,task={id:'t',status:'running',runStartedAt:new Date(start).toISOString(),events:[],messages:[]};
  assert.equal(watchdogCheck(task).code,'stalled');
  task.events.push({type:'interjection',at:new Date().toISOString()});task.messages.push({role:'user',content:'到哪了',at:new Date().toISOString()});assert.equal(watchdogCheck(task).code,'stalled');
  task.events.push({type:'model_timing',at:new Date().toISOString()});assert.equal(watchdogCheck(task).level,'ok');
});

test('a routine receipt and its delivered flag commit together, with retry after a write failure',t=>{
  const f=fixture(t),origin=create(f),routine={id:randomUUID(),name:'只读检查',roleId:origin.roleId,conversationId:origin.conversationId};
  const result=f.engine.newTask({prompt:'检查结果',source:'routine',routineId:routine.id,cloudConsent:false});Object.assign(result,{status:'completed',result:'发现一项变化'});
  f.store.transaction(s=>{s.routines.push(routine);s.tasks.push(result);});
  const persist=f.store.persist.bind(f.store);let fail=true;f.store.persist=()=>{if(fail){fail=false;throw Error('disk unavailable');}persist();};
  assert.throws(()=>f.engine.deliverRoutineResult(result.id),/disk unavailable/);assert.equal(f.store.task(result.id).routineDelivered,undefined);assert.equal(f.store.data.tasks.filter(t=>t.routineTaskId===result.id).length,0);
  f.engine.recoverDeliveries();f.engine.recoverDeliveries();assert.equal(f.store.task(result.id).routineDelivered,true);assert.equal(f.store.data.tasks.filter(t=>t.routineTaskId===result.id).length,1);
});

test('restart recovery wakes a waiting parent to report an interrupted child without restarting that child',t=>{
  const f=fixture(t),parent=create(f),child=create(f,'研究子主题');
  f.store.updateTask(child.id,t=>{t.parentId=parent.id;t.status='running';});f.store.updateTask(parent.id,t=>{t.children=[child.id];t.status='waiting_children';});
  f.store.close();const reloaded=new Store(f.dir);t.after(()=>reloaded.close());
  const engine=new Engine({store:reloaded,broker:f.engine.broker,secrets:{get:async()=>null}});engine.pump=async()=>{};engine.recoverDeliveries();
  assert.equal(reloaded.task(parent.id).status,'queued');assert.equal(reloaded.task(child.id).status,'interrupted');assert.equal(reloaded.data.tasks.length,2);
});

test('an undelivered correction retains its receipt when follow-up creation fails',t=>{
  const f=fixture(t),task=create(f);f.engine.interject(task.id,{message:'再补充来源日期'});f.store.updateTask(task.id,t=>{t.status='completed';});
  const createTask=f.engine.create.bind(f.engine);f.engine.create=()=>{throw Error('persist failed');};f.engine.followInterjections(task.id);
  assert.equal(f.store.task(task.id).messages.find(m=>m.interjection).followedAt,undefined);
  f.engine.create=createTask;f.engine.followInterjections(task.id);f.engine.followInterjections(task.id);assert.equal(f.store.data.tasks.length,2);
});

test('a resume after an intervening completed answer selects one unfinished goal and asks the model when ambiguous',async t=>{
 const f=fixture(t),first=create(f,'研究资料');f.store.updateTask(first.id,t=>{t.status='paused';});
 const question=create(f,'现在几点',{conversationId:first.id});f.store.updateTask(question.id,t=>{t.status='completed';});
 const continued=await f.engine.message(question.id,{message:'继续',clientRequestId:randomUUID(),cloudConsent:true});assert.equal(continued.id,first.id);assert.equal(continued.status,'queued');
 const other=create(f,'研究另一个主题',{conversationId:first.id});f.store.updateTask(other.id,t=>{t.status='paused';});
 const clarification=await f.engine.message(question.id,{message:'继续',clientRequestId:randomUUID(),cloudConsent:true});assert.notEqual(clarification.id,first.id);assert.notEqual(clarification.id,other.id);assert.equal(f.store.task(other.id).status,'paused');
});

test('the background roster retains old live work after many intervening completed turns',t=>{
 const f=fixture(t),long=create(f,'长期研究');markRunning(f,long);
 for(let i=0;i<30;i++){const row=create(f,'短问答 '+i,{conversationId:long.id});f.store.updateTask(row.id,t=>{t.status='completed';});}
 const current=create(f,'现在到哪了',{conversationId:long.id});assert.equal(f.engine.conversationTasks(current.id)[0].taskId,long.id);
});

test('recovery never upgrades local-only reminder results to cloud dispatch and rechecks a revoked source grant',async t=>{
 const {createRoutine,routineTaskInput}=await import('../src/core/scheduler.mjs');
 const f=fixture(t),local=createRoutine({name:'本机提醒',prompt:'提醒检查资料',kind:'daily',time:'09:00',taskKind:'reminder',cloudConsent:false});
 const result=f.engine.newTask(routineTaskInput(local,{at:Date.now(),slot:new Date().toISOString()}));Object.assign(result,{status:'completed',result:'提醒检查资料'});f.store.transaction(s=>{s.routines.push(local);s.tasks.push(result);});
 f.engine.recoverDeliveries();assert.equal(f.store.data.tasks.filter(row=>row.source==='router').length,0);assert.equal(f.store.task(result.id).cloudConsent,false);
 const approved=createRoutine({name:'云端检查',prompt:'查阅最新公开文档',kind:'daily',time:'09:00',cloudConsent:true});
 const source=f.engine.newTask(routineTaskInput(approved,{at:Date.now(),slot:new Date().toISOString()}));Object.assign(source,{status:'completed',result:'本轮公开检查已完成'});f.store.transaction(s=>{s.routines.push(approved);s.tasks.push(source);});
 const routed=f.engine.deliverRoutineResult(source.id);assert.equal(routed.source,'router');markRunning(f,routed);
 const active={taskId:routed.id,token:'dispatch-test',controller:new AbortController()};assert.equal(f.engine.authorizeRuntime(active),active);
 f.store.transaction(s=>{s.routines.find(row=>row.id===approved.id).authorization.revokedAt=new Date().toISOString();});assert.throws(()=>f.engine.authorizeRuntime(active),/失效/);assert.equal(active.controller.signal.aborted,true);
});

test('group execution brings the bot\'s notes and jobs like a private chat, but not the content of other private chats',async t=>{
 const f=fixture(t);let prompt='';
 f.store.transaction(s=>{const role=s.roles.find(row=>row.id==='concierge');role.notes=[{id:randomUUID(),text:'private-note-canary'}];s.watches.push({id:randomUUID(),roleId:role.id,status:'active',goal:'private-watch-canary'});});
 const privateTask=create(f,'private-chat-canary');f.store.updateTask(privateTask.id,t=>{t.status='completed';});
 f.engine.runFactory=options=>({async start(){prompt=options.prompt;f.store.updateTask(options.task.id,t=>{t.report={outcome:'completed',summary:'群内公开资料已整理。',evidence:[],remaining:''};});f.engine.finishReport(options.task.id);},async stop(){},async dispose(){}});
 const group=f.engine.groups.create({name:'公开资料群',memberRoleIds:['concierge','work'],coordinatorRoleId:'concierge'});
 const receipt=f.engine.groups.send(group.id,{content:'整理公开资料',recipientRoleIds:['concierge'],clientRequestId:randomUUID(),cloudConsent:true,memoryConsent:false});
 await Engine.prototype.pump.call(f.engine);await Promise.all([...f.engine.active.values()].map(row=>row.completion));
 assert.match(prompt,/公开资料群/);for(const marker of ['private-note-canary','private-watch-canary'])assert.ok(prompt.includes(marker),marker);assert.ok(!prompt.includes('private-chat-canary'),'another conversation is not pasted in');
 assert.deepEqual(f.engine.conversationTasks(receipt.taskIds[0]),[]);
 await assert.rejects(f.engine.message(receipt.taskIds[0],{message:'新要求',clientRequestId:randomUUID()}),/群消息入口/);
 assert.equal(f.store.data.outbox.filter(row=>row.conversationId===receipt.taskIds[0]).length,0);
});

function occupiedHarness(){
 const gates=new Map(),started=[],stopped=[];let peak=0,owner;
 const factory=options=>{let release;const gate=new Promise(resolve=>release=resolve);gates.set(options.task.id,release);const run={dead:false,alive:()=>!run.dead,
  async start(){started.push(options.task.id);peak=Math.max(peak,owner().engine.active.size);if(options.task.prompt.startsWith('持续执行'))await gate;options.onEvent({type:'assistant/message',data:{content:[{type:'text',text:'这一条新意图已独立回答，其他工作仍保留。'}]}});},
  async send(){throw Error('a parallel user turn reused another run');},async stop(){stopped.push(options.task.id);run.dead=true;release();},async dispose(){run.dead=true;}};return run;};
 return {factory,gates,started,stopped,bind:read=>owner=read,peak:()=>peak};
}

test('one foreground reserve answers a new user turn while two nonwaiting long runs occupy every ordinary slot',async t=>{
 const harness=occupiedHarness(),f=fixture(t,{factory:harness.factory,noPump:false});harness.bind(()=>f);
 const first=create(f,'持续执行：整理研究资料');await until(()=>harness.started.includes(first.id));
 const second=await f.engine.message(first.id,{message:'持续执行：核对另一份资料',clientRequestId:randomUUID(),cloudConsent:true});await until(()=>harness.started.includes(second.id));
 assert.equal(f.engine.busySlots(),2);assert.ok([...f.engine.active.values()].every(row=>!row.waiting&&!row.foreground));
 const question=await f.engine.message(first.id,{message:'请说明当前有哪些工作仍在进行',clientRequestId:randomUUID(),cloudConsent:true});await until(()=>f.store.task(question.id).status==='completed');
 assert.equal(f.store.task(question.id).executionLane,'foreground');assert.equal(f.store.task(first.id).status,'running');assert.equal(f.store.task(second.id).status,'running');assert.deepEqual(harness.stopped,[]);
 assert.equal(harness.peak(),3);assert.equal(f.store.task(question.id).conversationId,first.id);assert.equal(f.engine.warm.size,0);
});

test('the reserve is capped at one and queued delegated work cannot take it or block a later user turn',async t=>{
 const {deriveDelegation}=await import('../src/core/delegation.mjs');
 const harness=occupiedHarness(),f=fixture(t,{factory:harness.factory,noPump:false});harness.bind(()=>f);
 const first=create(f,'持续执行：整理研究资料');await until(()=>harness.started.includes(first.id));
 const second=await f.engine.message(first.id,{message:'持续执行：核对另一份资料',clientRequestId:randomUUID(),cloudConsent:true});await until(()=>harness.started.includes(second.id));
 const child=f.engine.create(deriveDelegation(f.store.task(first.id),{roleId:'work',prompt:'查询研究资料来源'},f.store));await f.engine.pump();assert.equal(f.store.task(child.id).status,'queued');
 const foreground=await f.engine.message(first.id,{message:'持续执行：这是用户另一条独立要求',clientRequestId:randomUUID(),cloudConsent:true});await until(()=>harness.started.includes(foreground.id));
 assert.equal(f.store.task(foreground.id).executionLane,'foreground');assert.equal(f.store.task(child.id).status,'queued');
 const next=await f.engine.message(first.id,{message:'我现在有哪些任务',clientRequestId:randomUUID(),cloudConsent:true});await f.engine.pump();assert.equal(f.store.task(next.id).status,'queued');assert.equal(harness.peak(),3);
 harness.gates.get(foreground.id)();await until(()=>f.store.task(next.id).status==='completed');
 assert.equal(f.store.task(next.id).executionLane,'foreground');assert.equal(f.store.task(child.id).status,'queued');assert.equal(f.store.task(first.id).status,'running');assert.equal(f.store.task(second.id).status,'running');assert.deepEqual(harness.stopped,[]);assert.equal(harness.peak(),3);
});

test('restart recovery preserves old interjections without renewing deadlines or dispatching them',t=>{
 const f=fixture(t),task=create(f,'查看公开资料');f.engine.interject(task.id,{message:'再检查原文日期'});f.store.updateTask(task.id,row=>{row.status='completed';});
 const before=structuredClone(f.store.task(task.id)),tasksBefore=f.store.data.tasks.length;
 f.store.close();const reloaded=new Store(f.dir);t.after(()=>reloaded.close());
 const resumed=new Engine({store:reloaded,broker:f.engine.broker,secrets:{get:async()=>{throw Error('no model request allowed');}}});resumed.pump=async()=>{};
 resumed.recoverDeliveries();resumed.followInterjections(task.id);
 assert.equal(reloaded.data.tasks.length,tasksBefore);assert.equal(reloaded.task(task.id).deadlineAt,before.deadlineAt);assert.deepEqual(reloaded.task(task.id).messages,before.messages);
 assert.equal(reloaded.task(task.id).messages.find(row=>row.interjection).followedAt,undefined);
});

test('old, paused, cancelled and unknown sources never spawn a fresh follow-up while a valid fresh correction retains its old bound',t=>{
 for(const status of ['paused','cancelled','unknown_result','expired','interrupted','failed','needs_review']){
  const f=fixture(t),task=create(f);f.engine.interject(task.id,{message:'补充来源日期'});f.store.updateTask(task.id,row=>{row.status=status;});f.engine.followInterjections(task.id);assert.equal(f.store.data.tasks.length,1,status);assert.equal(f.store.task(task.id).messages.find(row=>row.interjection).followedAt,undefined,status);
 }
 const stale=fixture(t),old=create(stale);stale.engine.interject(old.id,{message:'查看另一份资料'});stale.store.updateTask(old.id,row=>{row.status='completed';});stale.engine.clock=()=>Date.parse(old.deadlineAt)+1;stale.engine.followInterjections(old.id);assert.equal(stale.store.data.tasks.length,1);
 const fresh=fixture(t),current=create(fresh);fresh.engine.interject(current.id,{message:'补充来源日期'});fresh.store.updateTask(current.id,row=>{row.status='completed';});fresh.engine.followInterjections(current.id);const follow=fresh.store.data.tasks.find(row=>row.id!==current.id);assert.ok(follow);assert.ok(Date.parse(follow.deadlineAt)<=Date.parse(current.deadlineAt));
});

test('what the user adds mid-run goes straight into the running Harness session; if that fails it rides on the next tool result',async t=>{
  const f=fixture(t),task=markRunning(f,create(f));const steered=[];
  const run={waiting:true,async steer(text){steered.push(text);return true;},async stop(){},async dispose(){}};
  f.engine.active.set(task.id,{taskId:task.id,controller:new AbortController(),run});
  f.engine.interject(task.id,{message:'再补充来源日期'});
  await until(()=>steered.length===1);
  assert.match(steered[0],/再补充来源日期/);assert.match(steered[0],/补充或修正/);
  assert.ok(f.store.task(task.id).messages.at(-1).deliveredAt);
  assert.deepEqual(f.engine.takeInterjections(task.id),[],'not delivered a second time through a tool result');
  assert.ok(f.store.task(task.id).events.some(e=>e.type==='interjection'&&e.native===true));
  // The session refuses (no turn is being waited on, or the process is gone): the note stays pending.
  run.steer=async()=>false;f.engine.interject(task.id,{message:'还要加上作者'});
  await until(()=>!f.store.task(task.id).messages.at(-1).deliveredAt&&f.store.task(task.id).messages.at(-1).content==='还要加上作者');
  await new Promise(resolve=>setTimeout(resolve,10));
  const later=f.engine.takeInterjections(task.id);assert.equal(later.length,1);assert.equal(later[0].text,'还要加上作者');
  run.waiting=false;f.engine.interject(task.id,{message:'第三条'});await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(steered.length,1);assert.equal(f.engine.takeInterjections(task.id).length,1);
  f.engine.active.delete(task.id);
});
