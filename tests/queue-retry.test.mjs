import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/core/store.mjs';
import {Engine} from '../src/core/engine.mjs';
import {initializeTimeline,advanceTimeline,queuedExpired,beginSegment,taskDeadline,QUEUE_GRACE_MS} from '../src/core/task-contract.mjs';

const MIN=60000;
function fixture(t,behave){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'boujoy-queue-')),store=new Store(dir);const runs=[];
  const approvals={cancelTask(){}};
  const runFactory=options=>{const run={options,sent:[],alive:()=>true,async start(){await behave(options.task.id,run,'start');},async send(text){run.sent.push(text);await behave(options.task.id,run,'send');},async stop(){},async dispose(){}};runs.push(run);return run;};
  const engine=new Engine({store,broker:{calls:new Map(),approvals,phone:{release(){},close(){}},browser:{close(){}},allToolNames:()=>['finish_task']},secrets:{get:async()=>'x'},memory:{observe:async()=>{}},runFactory});
  t.after(async()=>{await engine.shutdown();store.close();fs.rmSync(dir,{recursive:true,force:true});});
  return {store,engine,runs};
}
const finish=(f,id,summary='好了。')=>{f.store.updateTask(id,row=>{row.report={outcome:'completed',summary,evidence:[],remaining:''};});f.engine.finishReport(id);};
async function settle(f){for(let i=0;i<6;i++){await f.engine.pump();await Promise.all([...f.engine.active.values()].map(a=>a.completion));await new Promise(r=>setTimeout(r,5));}}

test('time waiting in the queue does not use up the task budget; fixed bounds still apply',()=>{
  const t0=Date.parse('2026-11-02T10:00:00Z'),task={id:randomUUID(),messages:[{id:'m',role:'user',content:'x'}]};
  initializeTimeline(task,{at:t0,budgetMs:20*MIN});
  assert.equal(queuedExpired(task,t0+25*MIN),false,'other tasks held the slots for 25 minutes');
  assert.equal(beginSegment(task,{at:t0+25*MIN}),true);
  assert.equal(taskDeadline(task),t0+45*MIN,'the 20 minutes start when it first runs');
  assert.equal(beginSegment(task,{at:t0+30*MIN}),false,'a later resume does not extend it again');
  advanceTimeline(task,{at:t0+30*MIN,newGoal:false,budgetMs:20*MIN});
  assert.equal(taskDeadline(task),t0+45*MIN,'a correction measures from the real start, not the queue time');
  const never={id:randomUUID(),messages:[]};initializeTimeline(never,{at:t0,budgetMs:20*MIN});
  assert.equal(queuedExpired(never,t0+40*MIN-1),false);assert.equal(queuedExpired(never,t0+40*MIN+1),true,'a task that never gets a slot gives up after waiting as long as its budget');
  const long={id:randomUUID(),messages:[]};initializeTimeline(long,{at:t0,budgetMs:120*MIN});assert.equal(queuedExpired(long,t0+120*MIN+QUEUE_GRACE_MS+1),true,'at most half an hour of extra waiting');
  const bound={id:randomUUID(),messages:[]};initializeTimeline(bound,{at:t0,budgetMs:20*MIN,deadlineAt:new Date(t0+5*MIN).toISOString()});
  assert.equal(queuedExpired(bound,t0+6*MIN),true,'a routine window or phone grant expiry is not stretched');
  beginSegment(bound,{at:t0+2*MIN});assert.equal(taskDeadline(bound),t0+5*MIN);
});

test('a run waiting for approval or a background agent does not hold a concurrent slot',async t=>{
  let release;const gate=new Promise(r=>{release=r;});
  const f=fixture(t,async(id,run,phase)=>{
    if(f.store.task(id).prompt==='等确认'){f.store.updateTask(id,row=>{row.status='waiting_approval';});f.store.data.tasks;queueMicrotask(()=>f.engine.pump());await gate;f.store.updateTask(id,row=>{row.status='running';});}
    if(f.store.task(id).prompt==='等代理'){await f.engine.whileWaiting(id,()=>gate);}
    finish(f,id);
  });
  f.store.transaction(s=>{s.settings.maxConcurrent=1;});
  const a=f.engine.create({prompt:'等确认',cloudConsent:true});
  const b=f.engine.create({prompt:'等代理',cloudConsent:true});
  const c=f.engine.create({prompt:'普通任务',cloudConsent:true});
  for(let i=0;i<20&&f.store.task(c.id).status!=='completed';i++){await f.engine.pump();await new Promise(r=>setTimeout(r,10));}
  assert.equal(f.store.task(c.id).status,'completed','the third task ran while the other two waited');
  assert.equal(f.store.task(a.id).status,'waiting_approval');
  release();await settle(f);
  assert.equal(f.store.task(a.id).status,'completed');assert.equal(f.store.task(b.id).status,'completed');
});

test('a malformed model response is retried once from the same point',async t=>{
  const f=fixture(t,async(id,run,phase)=>{
    if(phase==='start'){f.store.event(id,'turn','本轮推理结束',{reason:'error',errorCode:'MALFORMED_RESPONSE'});return;}
    finish(f,id,'查好了。');
  });
  const task=f.engine.create({prompt:'帮我查一下明天的天气',cloudConsent:true});await settle(f);
  const row=f.store.task(task.id);
  assert.equal(row.status,'completed');assert.equal(f.runs[0].sent.length,1);assert.match(f.runs[0].sent[0],/MALFORMED_RESPONSE/);
  assert.ok(row.events.some(e=>e.type==='model_retry'));
});

test('a second failure in a row is reported, not retried forever',async t=>{
  const f=fixture(t,async id=>{f.store.event(id,'turn','本轮推理结束',{reason:'error',errorCode:'MALFORMED_RESPONSE'});});
  const task=f.engine.create({prompt:'帮我查一下明天的天气',cloudConsent:true});await settle(f);
  assert.equal(f.runs[0].sent.length,1);assert.equal(f.store.task(task.id).status,'needs_review');
  assert.match(f.store.task(task.id).blockedReason,/MALFORMED_RESPONSE/);
});

test('quota errors are not retried',async t=>{
  const f=fixture(t,async id=>{f.store.event(id,'turn','本轮推理结束',{reason:'error',errorCode:'QUOTA'});});
  const task=f.engine.create({prompt:'帮我查一下明天的天气',cloudConsent:true});await settle(f);
  assert.equal(f.runs[0].sent.length,0);assert.equal(f.store.task(task.id).status,'needs_review');
});

test('a plain explanation of why it will not do something finishes the turn',async t=>{
  const f=fixture(t,async id=>{f.store.updateTask(id,row=>{row.messages.push({id:randomUUID(),role:'assistant',content:'抱歉，这个我不能帮你做：帮别人刷单违反平台规则，可能导致封号。如果你想提高店铺曝光，我可以帮你整理正规的推广办法。',at:new Date().toISOString()});});});
  const task=f.engine.create({prompt:'帮我去淘宝给我店铺刷100个好评',cloudConsent:true});await settle(f);
  assert.equal(f.store.task(task.id).status,'completed');
});
