import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {Store} from '../src/core/store.mjs';
import {Engine} from '../src/core/engine.mjs';
import {createRoutine,routineTaskInput} from '../src/core/scheduler.mjs';
import {validateTaskContract} from '../src/core/task-contract.mjs';
function fixture(t,{hold=false}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'boujoy-engine-preinstall-')),store=new Store(dir);let at=Date.now(),starts=0,release;
 const held=new Promise(resolve=>release=resolve),broker={calls:new Map(),phone:{release(){},async close(){}},browser:{async close(){}},approvals:{cancelTask(){}}};
 const engine=new Engine({store,broker,secrets:{async get(){return 'isolated-fixture';}},memory:{},clock:()=>at,runFactory(){starts++;return {async start(){if(hold)await held;},async dispose(){},async stop(){release();}};}});
 t.after(async()=>{release();await Promise.all([...engine.active.values()].map(run=>run.completion));store.close();fs.rmSync(dir,{recursive:true,force:true});});
 return {store,engine,clock:()=>at,setClock:value=>at=value,starts:()=>starts,release};
}
function routine(f,{consent=true,kind='general'}={}){
 const at=f.clock(),r=createRoutine({name:'授权边界',prompt:kind==='reminder'?'喝水':'生成一份测试文本文件',taskKind:kind,kind:'once',nextAt:new Date(at+100).toISOString(),cloudConsent:consent,...(consent?{authorizationExpiresAt:new Date(at+1000).toISOString()}:{})},{at});
 f.store.transaction(s=>s.routines.push(r));const task=f.engine.newTask(routineTaskInput(r,{at,sourceTest:true}));f.store.transaction(s=>s.tasks.push(task));return task;
}
test('queued routine cannot start a Harness after its authorization expires',async t=>{
 const f=fixture(t),task=routine(f);f.setClock(f.clock()+2000);
 assert.equal(validateTaskContract(f.store.task(task.id),{store:f.store,at:f.clock()}).valid,false);
 await f.engine.pump();assert.equal(f.starts(),0);assert.equal(f.store.task(task.id).status,'paused');
});
test('routine authorization expiry is rechecked at every runtime boundary',async t=>{
 const f=fixture(t,{hold:true}),task=routine(f);await f.engine.pump();const active=f.engine.active.get(task.id);
 assert.ok(active);assert.equal(f.starts(),1);f.setClock(f.clock()+2000);
 assert.throws(()=>f.engine.authorizeRuntime(active),error=>error.code==='runtime_unauthorized');
 assert.equal(active.controller.signal.aborted,true);assert.equal(f.engine.tokens.has(active.token),false);f.release();await active.completion;
});
test('a queued task cancelled during previous expiry is never revived from a stale queue snapshot',async t=>{
 const f=fixture(t),first=f.engine.newTask({prompt:'生成第一份测试文本文件',cloudConsent:true}),second=f.engine.newTask({prompt:'生成第二份测试文本文件',cloudConsent:true});
 first.deadlineAt=first.timeline.deadlineAt=new Date(f.clock()-1).toISOString();f.store.transaction(s=>s.tasks.push(first,second));let cancelled=false;
 const listener=()=>{if(!cancelled&&f.store.task(first.id).status==='paused'){cancelled=true;void f.engine.stop(second.id);}};
 f.store.on('change',listener);try{await f.engine.pump();}finally{f.store.off('change',listener);}
 assert.equal(cancelled,true);assert.equal(f.starts(),0);assert.equal(f.store.task(first.id).status,'expired');assert.equal(f.store.task(second.id).status,'cancelled');
});
test('local scheduled reminders still complete without model authorization or a Harness',async t=>{
 const f=fixture(t),task=routine(f,{consent:false,kind:'reminder'});await f.engine.pump();
 assert.equal(f.starts(),0);assert.equal(f.store.task(task.id).status,'completed');assert.match(f.store.task(task.id).result,/喝水/);
});
