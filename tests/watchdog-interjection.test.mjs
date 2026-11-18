import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {watchdogCheck,WATCHDOG_LIMITS} from '../src/core/watchdog.mjs';
import {Store} from '../src/core/store.mjs';
import {Engine} from '../src/core/engine.mjs';
import {validateTaskContract} from '../src/core/task-contract.mjs';

const T0=Date.parse('2026-10-31T18:00:00.000Z');
const at=n=>new Date(T0+n*1000).toISOString();
function run(events,extra={}){return {id:'t',status:'running',runStartedAt:at(0),events:events.map((e,i)=>({at:at(i+1),...e})),...extra};}
const call=(tool,extra={})=>({type:'tool',tool,...extra});

test('repeated reads with no action are nudged, then stopped',()=>{
 const reads=n=>Array.from({length:n},()=>call('phone_use',{action:'read',sig:'r'}));
 assert.equal(watchdogCheck(run(reads(4)),{now:T0+10000}).level,'ok');
 const nudge=watchdogCheck(run(reads(5)),{now:T0+10000});assert.equal(nudge.level,'nudge');assert.equal(nudge.code,'repeat_read');
 assert.equal(watchdogCheck(run(reads(WATCHDOG_LIMITS.readStop)),{now:T0+20000}).code,'repeat_read');assert.equal(watchdogCheck(run(reads(WATCHDOG_LIMITS.readStop)),{now:T0+20000}).level,'stop');
 assert.equal(watchdogCheck(run([...reads(4),call('phone_use',{action:'tap',sig:'a'}),...reads(2)]),{now:T0+10000}).level,'ok');
});
test('the same non-read call with identical arguments is a loop; varied calls are not',()=>{
 const same=n=>Array.from({length:n},()=>call('phone_use',{action:'tap',sig:'x'}));
 assert.equal(watchdogCheck(run(same(3)),{now:T0+10000}).code,'same_call');assert.equal(watchdogCheck(run(same(5)),{now:T0+10000}).level,'stop');
 assert.equal(watchdogCheck(run([call('phone_use',{action:'tap',sig:'x'}),call('phone_use',{action:'tap',sig:'y'}),call('phone_use',{action:'tap',sig:'x'})]),{now:T0+10000}).level,'ok');
});
test('the same error on consecutive calls is a loop; a success in between resets it',()=>{
 const fail=()=>[call('phone_use',{action:'tap',sig:Math.random().toString()}),{type:'tool_error',tool:'phone_use',code:'phone_target_missing'}];
 const loop=[...fail(),...fail(),...fail()];assert.equal(watchdogCheck(run(loop),{now:T0+10000}).code,'error_loop');
 assert.equal(watchdogCheck(run([...fail(),...fail(),call('phone_use',{action:'tap',sig:'ok'}),...fail()]),{now:T0+10000}).level,'ok');
 assert.equal(watchdogCheck(run([...fail(),...fail(),...fail(),...fail(),...fail()]),{now:T0+10000}).level,'stop');
});
test('a nudge is not repeated on every call, and a silent run is stopped as stalled',()=>{
 const reads=Array.from({length:5},()=>call('phone_use',{action:'read',sig:'r'}));
 const given=run([...reads,{type:'watchdog',code:'repeat_read'},call('phone_use',{action:'read',sig:'r'})]);assert.equal(watchdogCheck(given,{now:T0+10000}).level,'ok');
 assert.equal(watchdogCheck(run([call('web_search',{sig:'s'})]),{now:T0+7*60000}).code,'stalled');
 assert.equal(watchdogCheck({...run([call('web_search',{sig:'s'})]),status:'completed'},{now:T0+7*60000}).level,'ok');
});

function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'boujoy-interject-')),store=new Store(dir);
 const broker={calls:new Map(),approvals:{cancelTask(){}},phone:{release(){},close(){}},browser:{close(){}}};
 const engine=new Engine({store,broker,secrets:{get:async()=>'synthetic'},memory:{observe:async()=>{}},runFactory:()=>({async start(){},async stop(){},async dispose(){}})});engine.pump=async()=>{};
 t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});return {store,engine};}
const uuid=()=>crypto.randomUUID();
async function forward(f,target,message,clientRequestId=uuid()){const caller=await f.engine.message(target.id,{message,clientRequestId,cloudConsent:true});f.store.updateTask(caller.id,t=>{t.status='running';});await f.engine.conversationTaskControl(caller.id,{action:'update',taskId:target.id});return caller;}
function running(f,prompt){const task=f.engine.create({prompt,cloudConsent:true});f.store.updateTask(task.id,row=>{row.status='running';row.runStartedAt=new Date().toISOString();});f.engine.active.set(task.id,{taskId:task.id,controller:new AbortController(),token:'x'});return task;}

test('a correction during a run is delivered to the model without stopping it or changing its authority',async t=>{
 const f=fixture(t),task=running(f,'在淘宝闪购点一份牛肉面，到结算页');const before=JSON.stringify(f.store.task(task.id).taskContract);
 await forward(f,task,'不要辣');const same=f.store.task(task.id);
 assert.equal(same.id,task.id);assert.equal(same.status,'running');assert.equal(JSON.stringify(same.taskContract),before);assert.equal(validateTaskContract(same).valid,true);
 const delivered=f.engine.takeInterjections(task.id);assert.equal(delivered.length,1);assert.equal(delivered[0].text,'不要辣');assert.match(delivered[0].handling,/补充或修正/);
 assert.deepEqual(f.engine.takeInterjections(task.id),[]);
});
test('a new request starts independently while the earlier run keeps its original authority',async t=>{
 const f=fixture(t),task=running(f,'打开设置查看电池'),contract=JSON.stringify(f.store.task(task.id).taskContract);
 const follow=await f.engine.message(task.id,{message:'顺便给张三发消息说“我晚点到”',clientRequestId:uuid(),cloudConsent:true});
 assert.equal(f.store.task(task.id).status,'running');assert.equal(JSON.stringify(f.store.task(task.id).taskContract),contract);
 assert.notEqual(follow.id,task.id);assert.equal(follow.conversationId,task.id);assert.ok(follow.taskContract.effects.includes('send'));
 assert.deepEqual(f.engine.takeInterjections(task.id),[]);assert.equal(f.store.data.tasks.length,2);
});
test('an undelivered correction is not lost if the run ends first; a stopped task does not auto-continue',async t=>{
 const f=fixture(t),task=running(f,'帮我查一下明天洛杉矶天气');
 await forward(f,task,'还有后天的');
 f.engine.active.delete(task.id);f.store.updateTask(task.id,row=>{row.status='completed';});f.engine.followInterjections(task.id);
 assert.equal(f.store.data.tasks.length,3);
 const g=fixture(t),other=running(g,'帮我查一下明天洛杉矶天气');await forward(g,other,'还有后天的');
 g.engine.active.delete(other.id);g.store.updateTask(other.id,row=>{row.status='cancelled';});g.engine.followInterjections(other.id);assert.equal(g.store.data.tasks.length,2);
});
test('stop words still stop, and the same submission is not interjected twice',async t=>{
 const f=fixture(t),task=running(f,'打开设置查看电池'),id=uuid();
 await forward(f,task,'不要辣',id);await f.engine.message(task.id,{message:'不要辣',clientRequestId:id});
 assert.equal(f.store.task(task.id).messages.filter(m=>m.interjection).length,1);
 const active=f.engine.active.get(task.id);active.completion=Promise.resolve();
 await f.engine.message(task.id,{message:'停止',clientRequestId:uuid()});assert.equal(f.store.task(task.id).status,'cancelled');
});
test('the Broker delivers interjections and watchdog nudges inside the next real tool result',async t=>{
 const {Broker}=await import('../src/tools/broker.mjs');
 const f=fixture(t),task=running(f,'帮我查一下明天洛杉矶天气');
 const broker=new Broker({store:f.store,phone:{},approvals:{cancelTask(){}},dataDir:fs.mkdtempSync(path.join(os.tmpdir(),'boujoy-guidance-'))});broker.engine=f.engine;f.engine.broker=broker;
 await forward(f,task,'还有后天的');
 const runtime=result=>JSON.parse(result.content.at(-1).text);
 const first=runtime(await broker.execute(task.id,'task_context',{}));assert.equal(first.userInterjections[0].text,'还有后天的');assert.ok(first.taskRuntime);
 const second=runtime(await broker.execute(task.id,'task_context',{}));assert.equal(second.userInterjections,undefined);
 const later=[];for(let i=0;i<4;i++)later.push(runtime(await broker.execute(task.id,'task_context',{})));
 assert.deepEqual(later.map(r=>!!r.watchdog),[false,false,true,false]);assert.match(later[2].watchdog,/读取/);
});
test('twice the stop count of one identical loop is marked hard, so full mode stops it even with model supervision',()=>{
 const fail=()=>[call('finish_task_like',{sig:Math.random().toString()}),{type:'tool_error',tool:'finish_task_like',code:'effect_not_verified'}];
 const loop=n=>Array.from({length:n},fail).flat();
 const soft=watchdogCheck(run(loop(WATCHDOG_LIMITS.errorStop)),{now:T0+10000});assert.equal(soft.level,'stop');assert.equal(soft.hard,undefined);
 const hard=watchdogCheck(run(loop(WATCHDOG_LIMITS.errorStop*2)),{now:T0+10000});assert.equal(hard.code,'error_loop');assert.equal(hard.hard,true);
});
