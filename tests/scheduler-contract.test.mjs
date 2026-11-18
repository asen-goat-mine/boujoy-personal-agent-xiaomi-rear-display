import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {Store} from '../src/core/store.mjs';
import {Engine} from '../src/core/engine.mjs';
import {createRoutine,updateRoutine,nextScheduled,Scheduler,routineTaskInput} from '../src/core/scheduler.mjs';
import {validateTaskContract} from '../src/core/task-contract.mjs';
const fixed=Date.parse('2026-10-14T00:00:00Z');
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'boujoy-schedule-')),store=new Store(dir);let clock=fixed;const engine=new Engine({store,clock:()=>clock,broker:{calls:new Map(),approvals:{cancelTask(){}},phone:{release(){}}},secrets:{get:async()=>null},memory:{}});engine.pump=async()=>{};t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});return {store,engine,scheduler:new Scheduler(store,engine),setClock:v=>clock=v};}
test('weekly timezone schedules and DST repeated/nonexistent minutes have explicit next instants',()=>{
 assert.equal(nextScheduled({kind:'weekly',weekdays:[1,5],time:'09:00',timezone:'Asia/Shanghai'},new Date(fixed)),'2026-10-16T01:00:00.000Z');
 assert.equal(nextScheduled({kind:'daily',time:'02:30',timezone:'America/New_York'},new Date('2026-03-08T05:00:00Z')),'2026-03-09T06:30:00.000Z');
 assert.equal(nextScheduled({kind:'daily',time:'01:30',timezone:'America/New_York'},new Date('2026-11-01T05:40:00Z')),'2026-11-02T06:30:00.000Z');
 assert.throws(()=>nextScheduled({kind:'weekly',weekdays:[],time:'09:00'}));assert.throws(()=>nextScheduled({kind:'daily',time:'09:00',timezone:'Wrong/Zone'}));
});
test('routine authorization is persistent, prompt bound, revocable and inherited only by its occurrence',t=>{
 const f=fixture(t),r=createRoutine({name:'天气',prompt:'打开微信查看指定会话消息',kind:'once',nextAt:new Date(fixed+1000).toISOString(),cloudConsent:true,memoryConsent:true},{at:fixed});
 f.store.transaction(s=>s.routines.push(r));f.setClock(fixed+1000);f.scheduler.tick(fixed+1000);f.scheduler.tick(fixed+1000);
 assert.equal(f.store.data.tasks.length,1);const task=f.store.data.tasks[0];assert.equal(task.cloudConsent,true);assert.equal(task.memoryConsent,true);assert.equal(validateTaskContract(task,{at:fixed+1000}).valid,true);assert.equal(task.routineAuthorization.id,r.authorization.id);
 const edited=updateRoutine({...r,kind:'daily',time:'09:00'},{prompt:'在微信发送“其他任务”'},{at:fixed+1000});assert.equal(edited.cloudConsent,false);assert.equal(edited.authorization,null);
 const paused=updateRoutine({...r,kind:'daily',time:'09:00'},{enabled:false},{at:fixed+1000});assert.ok(paused.pausedAt);assert.equal(paused.authorization.id,r.authorization.id);
});
test('expired slots never create late jobs and replayed persisted slot never duplicates an occurrence',t=>{
 const f=fixture(t),r=createRoutine({name:'提醒',prompt:'提醒喝水',taskKind:'reminder',kind:'daily',time:'09:00',executionWindowSeconds:10},{at:fixed});r.nextAt=new Date(fixed-20000).toISOString();
 f.store.transaction(s=>s.routines.push(r));f.scheduler.tick(fixed);assert.equal(f.store.data.tasks.length,0);assert.equal(f.store.data.routines[0].history.at(-1).status,'expired');
 const slot=new Date(fixed-1000).toISOString();f.store.transaction(s=>{s.routines[0].nextAt=slot;});f.scheduler.tick(fixed);assert.equal(f.store.data.tasks.length,1);
 f.store.transaction(s=>{s.routines[0].nextAt=slot;});f.scheduler.tick(fixed);assert.equal(f.store.data.tasks.length,1);assert.equal(f.store.data.routines[0].history.at(-1).status,'deduplicated');
});
test('pausing a routine revokes its queued execution while a manual test preserves paused scheduling',async t=>{
 const f=fixture(t),r=createRoutine({name:'蓝牙',prompt:'开启蓝牙',kind:'daily',time:'09:00',cloudConsent:true,memoryConsent:true},{at:fixed});
 f.store.transaction(s=>s.routines.push(r));const task=f.engine.create(routineTaskInput(r,{at:fixed,sourceTest:true}));
 assert.equal(validateTaskContract(task,{at:fixed}).valid,true);
 const paused=updateRoutine(r,{enabled:false},{at:fixed});f.store.transaction(s=>{s.routines[0]=paused;});
 await f.engine.revokeRoutineTasks(r.id);const revoked=f.store.task(task.id);
 assert.equal(revoked.status,'paused');assert.equal(revoked.cloudConsent,false);assert.equal(revoked.memoryConsent,false);assert.equal(validateTaskContract(revoked,{at:fixed}).reason,'routine_authorization_missing');
 const input=routineTaskInput(paused,{at:fixed,sourceTest:true});assert.equal(input.routineTest,true);assert.equal(input.cloudConsent,true);assert.equal(input.submittedAt,new Date(fixed).toISOString());assert.equal(f.store.data.routines[0].enabled,false);
});
