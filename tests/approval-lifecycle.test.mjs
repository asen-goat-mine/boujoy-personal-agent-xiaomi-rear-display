import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../src/core/store.mjs';
import {Approvals} from '../src/core/approvals.mjs';

function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'boujoy-approval-lifecycle-')),store=new Store(dir),approvals=new Approvals(store),controller=new AbortController();
 store.transaction(state=>state.tasks.push({id:'task',status:'running',messages:[],events:[]}));
 t.after(()=>{approvals.cancelTask('task');store.close();fs.rmSync(dir,{recursive:true,force:true});});
 const request=()=>approvals.request('task',{tool:'harness_native',args:{command:'synthetic-no-execution'},summary:'fixture'},controller.signal);
 return {store,approvals,controller,request,id:()=>store.data.approvals.at(-1).id};
}

test('allow followed by stop before the await resumes cannot hand a native tool permission',async t=>{
 const f=fixture(t);let dispatches=0;
 const pending=f.request().then(()=>{dispatches++;return 'allowed-once';});
 f.approvals.resolve(f.id(),true);f.store.updateTask('task',task=>{task.status='paused';});f.controller.abort();f.approvals.cancelTask('task');
 await assert.rejects(pending,error=>error.code==='cancelled');assert.equal(dispatches,0);assert.equal(f.store.task('task').status,'paused');assert.equal(f.approvals.waiters.size,0);
});

test('a task stopped without its optional signal also cannot consume an already resolved approval',async t=>{
 const f=fixture(t),pending=f.request();f.approvals.resolve(f.id(),true);f.store.updateTask('task',task=>{task.status='cancelled';});
 await assert.rejects(pending,error=>error.code==='cancelled');assert.equal(f.store.task('task').status,'cancelled');
});

test('an unchanged live approval remains single-use and resumes its waiting task',async t=>{
 const f=fixture(t),pending=f.request(),id=f.id();f.approvals.resolve(id,true);const record=await pending;
 assert.equal(record.id,id);assert.equal(f.store.task('task').status,'running');assert.equal(f.store.data.approvals.at(-1).status,'approved');
 assert.throws(()=>f.approvals.resolve(id,true),error=>error.code==='approval_expired');
});

test('a denied live approval remains a denial and never replays',async t=>{
 const f=fixture(t),pending=f.request(),id=f.id();f.approvals.resolve(id,false);
 await assert.rejects(pending,error=>error.code==='not_approved');assert.equal(f.store.data.approvals.at(-1).status,'denied');assert.throws(()=>f.approvals.resolve(id,true),error=>error.code==='approval_expired');
});

for(const value of ['at-deadline','invalid'])test(`approval expiry rejects ${value} before settling its waiter`,async t=>{
 const f=fixture(t),pending=f.request().catch(error=>error.code),id=f.id(),at=Date.now();
 t.mock.method(Date,'now',()=>at);
 f.store.transaction(state=>{state.approvals.find(row=>row.id===id).expiresAt=value==='at-deadline'?new Date(at).toISOString():'not-a-date';});
 try{assert.throws(()=>f.approvals.resolve(id,true),error=>error.code==='approval_expired');assert.equal(f.store.data.approvals.at(-1).status,'pending');}
 finally{f.approvals.cancelTask('task');await pending;}
});
