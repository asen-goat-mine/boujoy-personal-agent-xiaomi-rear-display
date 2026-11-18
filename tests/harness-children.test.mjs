import test from 'node:test';
import {NEEDS_HARNESS} from './helpers/requirements.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {randomUUID} from 'node:crypto';
import {HarnessRun} from '../src/adapters/harness.mjs';import {Store} from '../src/core/store.mjs';import {Engine} from '../src/core/engine.mjs';import {Broker} from '../src/tools/broker.mjs';import {watchdogCheck} from '../src/core/watchdog.mjs';
function setup(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'harness-children-')),store=new Store(dir);
 const broker=new Broker({store,dataDir:dir,memory:{},approvals:{cancelTask(){}},phone:{release(){},close(){}},browser:{close(){}}});
 const engine=new Engine({store,broker,secrets:{get:async()=>null},memory:{}});engine.pump=async()=>{};
 const task=engine.create({prompt:'独立核算，汇总结果',cloudConsent:true});store.updateTask(task.id,r=>{r.status='running';r.runStartedAt=new Date().toISOString();});
 const run=new HarnessRun({task,onEvent:event=>engine.onEvent(task.id,event)});
 const emit=(sessionId,type,data)=>run.receiveNotification({method:'session.event',params:{sessionId,event:{type,data}}});
 t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});return {store,broker,engine,task,run,emit};
}
const answer=text=>({content:[{type:'text',text}]});
test('SDK child answers and errors never become parent chat or parent turn errors; warm session identity stays stable',t=>{
 const f=setup(t),child=randomUUID();f.emit(child,'turn/start',{});f.emit(child,'assistant/message',answer('child-only-result'));f.emit(child,'turn/end',{reason:{kind:'error',error:{code:'QUOTA'}}});
 assert.equal(f.store.task(f.task.id).messages.some(m=>m.content.includes('child-only-result')),false);
 assert.equal(f.store.task(f.task.id).events.some(e=>e.type==='turn'),false);
 assert.equal(f.store.task(f.task.id).harnessChildren[0].status,'failed');assert.equal(f.broker.completedTaskEvidence(f.store.task(f.task.id),child),false);
 f.emit(f.task.id,'assistant/message',answer('parent-answer'));assert.equal(f.store.task(f.task.id).messages.at(-1).content,'parent-answer');
 const next=f.engine.create({prompt:'继续核算',conversationId:f.task.id,cloudConsent:true});f.store.updateTask(next.id,t=>t.status='running');f.run.onEvent=e=>f.engine.onEvent(next.id,e);
 f.emit(f.task.id,'assistant/message',answer('next-parent-answer'));assert.equal(f.store.task(next.id).messages.at(-1).content,'next-parent-answer');assert.equal(f.store.task(next.id).harnessChildren,undefined);
});
test('native children block premature finish, release the waiting slot, and supply scoped completion evidence',async t=>{
 const f=setup(t),child=randomUUID();f.emit(child,'turn/start',{});
 await assert.rejects(f.broker.executeTool(f.task.id,'finish_task',{outcome:'completed',summary:'premature',evidence:[]}),{code:'harness_children_pending'});
 const active={waiting:0};f.engine.active.set(f.task.id,active);
 const pending=f.broker.executeTool(f.task.id,'delegation_status',{wait:true});await new Promise(r=>setTimeout(r,10));assert.equal(active.waiting,1);assert.equal(f.engine.busySlots(),0);
 f.emit(child,'assistant/message',answer('verified 42'));f.emit(child,'turn/end',{reason:{kind:'completed'}});
 const result=JSON.parse((await pending).content[0].text);assert.equal(active.waiting,0);assert.equal(result[0].finishEvidenceRef,child);assert.equal(result[0].result,'verified 42');
 assert.equal(f.broker.completedTaskEvidence(f.store.task(f.task.id),child),true);
 const other=f.engine.create({prompt:'other',cloudConsent:true});assert.equal(f.broker.completedTaskEvidence(other,child),false);
 f.engine.active.delete(f.task.id);await f.broker.executeTool(f.task.id,'finish_task',{outcome:'completed',summary:'verified 42',evidence:[child]});assert.equal(f.store.task(f.task.id).status,'completed');
 const saved=JSON.stringify(f.store.task(f.task.id));f.emit(child,'assistant/message',answer('late answer'));assert.equal(JSON.stringify(f.store.task(f.task.id)),saved);
});
test('watchdog recognizes real child activity, still stops silence, and ignores user chatter',()=>{
 const now=Date.now(),old=new Date(now-7*60000).toISOString(),task={status:'running',runStartedAt:old,events:[],messages:[],harnessChildren:[{id:'c',updatedAt:new Date(now-1000).toISOString()}]};
 assert.equal(watchdogCheck(task,{now}).level,'ok');task.harnessChildren[0].updatedAt=old;task.messages.push({role:'user',at:new Date(now).toISOString(),content:'进度？'});assert.equal(watchdogCheck(task,{now}).code,'stalled');
});
test('native wait aborts without pretending a queued child has completed',async t=>{
 const f=setup(t),child=randomUUID(),controller=new AbortController();f.emit(child,'turn/start',{});const active={waiting:0};f.engine.active.set(f.task.id,active);
 const pending=f.broker.executeTool(f.task.id,'delegation_status',{wait:true},controller.signal);controller.abort();await assert.rejects(pending,{code:'cancelled'});assert.equal(active.waiting,0);assert.equal(f.store.task(f.task.id).harnessChildren[0].status,'running');assert.equal(f.broker.completedTaskEvidence(f.store.task(f.task.id),child),false);f.engine.active.delete(f.task.id);
});

test('real Harness routes two child sessions, waits, accepts their evidence and emits one parent reply',{skip:NEEDS_HARNESS,timeout:40000},async t=>{
 const {execFile}=await import('node:child_process'),{promisify}=await import('node:util');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'native-child-wire-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const {stdout}=await promisify(execFile)(process.execPath,['tests/helpers/harness-children-wire.mjs'],{cwd:path.resolve(import.meta.dirname,'..'),env:{...process.env,BOUJOY_DATA:dir},timeout:35000,maxBuffer:200000});
 const result=JSON.parse(stdout);assert.equal(result.passed,true);assert.equal(result.childReceipts,2);assert.equal(result.chatReplies,1);
});

test('legacy rule watchdog stops a read loop when model supervision is explicitly disabled',async t=>{
 const f=setup(t);f.store.data.settings.modelWatchdogEnabled=false;const old=new Date(Date.now()-7*60000).toISOString();f.store.updateTask(f.task.id,t=>t.runStartedAt=old);
 const active={taskId:f.task.id,waiting:1,controller:new AbortController(),run:{stop(){}}};f.engine.active.set(f.task.id,active);
 f.engine.watchdogSweep();assert.equal(f.store.task(f.task.id).status,'running');active.waiting=0;f.engine.watchdogSweep();assert.equal(f.store.task(f.task.id).status,'blocked');f.engine.active.delete(f.task.id);
 const loop=f.engine.create({prompt:'查阅任务信息',cloudConsent:true});f.store.updateTask(loop.id,t=>{t.status='running';t.runStartedAt=new Date().toISOString();});
 for(let i=0;i<9;i++)await f.broker.execute(loop.id,'task_context',{});
 assert.equal(f.store.task(loop.id).status,'blocked');assert.ok(f.store.task(loop.id).events.some(e=>e.type==='watchdog'&&e.code==='repeat_read'));await assert.rejects(f.broker.execute(loop.id,'task_context',{}));
});

test('a resumed task does not wait on children from a dead Harness process',async t=>{
 const f=setup(t);f.store.updateTask(f.task.id,t=>{t.status='queued';t.harnessChildren=[{id:randomUUID(),status:'running'}];});f.engine.secrets={get:async()=>'synthetic'};
 f.engine.runFactory=options=>({async start(){assert.equal(f.store.task(f.task.id).harnessChildren[0].status,'interrupted');options.onEvent({type:'assistant/message',data:answer('New process completed the remaining calculation.')});},async stop(){},async dispose(){}});
 await Engine.prototype.pump.call(f.engine);await Promise.all([...f.engine.active.values()].map(a=>a.completion));assert.equal(f.store.task(f.task.id).status,'completed');assert.equal(f.store.task(f.task.id).harnessChildren[0].status,'interrupted');await f.engine.shutdown();
});
