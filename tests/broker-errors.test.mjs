import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {Store} from '../src/core/store.mjs';import {Broker} from '../src/tools/broker.mjs';
function fixture(t,task={}){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pa-broker-test-'));const store=new Store(dir);t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});store.transaction(s=>{s.tasks.push({id:'task',status:'running',events:[],messages:[],report:null,...task});});const broker=new Broker({store});let blocked;broker.engine={blockToolFailure(id,reason){blocked={id,reason};store.updateTask(id,t=>{t.status='blocked';});}};return {store,broker,blocked:()=>blocked};}
test('invented finish evidence is rejected each time and reported to the model; the watchdog, not a count, ends a loop',async t=>{
 const f=fixture(t);for(let i=0;i<3;i++)await assert.rejects(f.broker.execute('task','finish_task',{outcome:'blocked',summary:'No phone control',evidence:['phone_open_app']}),/未知证据/);
 assert.equal(f.blocked(),undefined);assert.equal(f.store.task('task').status,'running');assert.equal(f.store.task('task').events.filter(e=>e.type==='tool_error').length,3);
});
test('a blocked report needs no fabricated evidence when no observation was possible',async t=>{
 const {store,broker}=fixture(t);await broker.execute('task','finish_task',{outcome:'blocked',summary:'Phone permission unavailable',evidence:[],remaining:'Enable phone control'});
 assert.equal(store.task('task').report.outcome,'blocked');assert.deepEqual(store.task('task').report.evidence,[]);
});
test('for a non-Harness (routine) task, browser acceptance receipts, unrelated evidence and credential handoff do not prove a finished business action',async t=>{
 const {store,broker}=fixture(t,{source:'routine'});broker.approvals={request:async()=>{}};
 broker.browser={act:async()=>({accepted:true,requiresVerification:true,observationId:'after',text:'实际新页面'})};
 broker.remember('task',{observationId:'before'},{source:'browser'});
 const reply=JSON.parse((await broker.execute('task','browser_action',{observationId:'before',index:0,action:'click',reason:'当前用户任务'})).content[0].text);
 assert.equal(store.data.actions[0].executionStatus,'executed');assert.equal(store.data.actions[0].verification,'pending');
 await assert.rejects(broker.execute('task','finish_task',{outcome:'completed',summary:'仅有接受回执',evidence:[reply.actionId]}),/尚未核实/);
 broker.remember('task',{observationId:'unrelated'},{source:'connector'});
 await assert.rejects(broker.execute('task','finish_task',{outcome:'completed',summary:'错误来源',evidence:['unrelated']}),e=>e.code==='effect_not_verified');
 broker.remember('task',{observationId:'credential',credentialBoundary:true,userInputRequired:true},{source:'browser'});
 await assert.rejects(broker.execute('task','finish_task',{outcome:'completed',summary:'到了验证页',evidence:['credential']}),e=>e.code==='effect_not_verified');
 await broker.execute('task','finish_task',{outcome:'completed',summary:'实际页面结果',evidence:['after']});assert.deepEqual(store.task('task').report.evidence,['after']);
});
test('connector result exposes the exact registered observation id and cannot manufacture action verification',async t=>{
 const {broker}=fixture(t);broker.connectors={available:()=>[],call:async()=>({actionId:'accepted-only',verification:'provider_receipt',result:{content:[{type:'text',text:'local fixture result'}]}})};
 const reply=JSON.parse((await broker.execute('task','connector_call',{connectorId:'fixture',tool:'read',arguments:{}})).content[0].text);
 assert.ok(reply.observationId);assert.equal(broker.evidence.get(reply.observationId).source,'connector');
 await broker.execute('task','finish_task',{outcome:'completed',summary:'读取结果',evidence:[reply.observationId]});
});


test('a revoked phone pairing stops the task without dispatch',async t=>{
 const g=fixture(t);g.store.transaction(s=>s.settings.phoneEnabled=true);g.broker.phone={capabilities:async()=>{throw Object.assign(Error('revoked'),{code:'phoneuse_error',phoneuseCode:'PAIRING_REVOKED',dispatchState:'not_sent'});}};
 await assert.rejects(g.broker.execute('task','phone_capabilities',{}),/revoked/);assert.equal(g.blocked().id,'task');
});
test('transient read errors return guidance without fabricating an action or offline receipt',async t=>{
 for(const error of [Object.assign(Error('transient'),{code:'phoneuse_error',dispatchState:'not_sent',phoneuseCode:'NO_ACTIVE_WINDOW'}),Object.assign(Error('unknown'),{code:'outcome_unknown'})]){
  const f=fixture(t);f.store.transaction(s=>s.settings.phoneEnabled=true);f.broker.phone={capabilities:async()=>{throw error;}};
  const result=JSON.parse((await f.broker.execute('task','phone_capabilities',{})).content[0].text);assert.equal(result.recoverable,true);assert.equal(result.recovered,false);assert.equal(f.blocked(),undefined);assert.equal(f.store.data.actions.length,0);
 }
});
test('repeated read failures are reported to the model instead of ending the task by count',async t=>{
 const f=fixture(t);f.store.transaction(s=>{s.settings.phoneEnabled=true;});f.broker.phone={capabilities:async()=>{throw Object.assign(Error('SSL EOF'),{code:'phoneuse_error',dispatchState:'not_sent'});}};
 for(let i=1;i<=4;i++){const result=JSON.parse((await f.broker.execute('task','phone_capabilities',{})).content[0].text);assert.equal(result.recoverable,true);assert.equal(result.recovered,false);assert.equal(result.attempts,i);}
 assert.equal(f.blocked(),undefined);assert.equal(f.store.task('task').status,'running');assert.equal(f.store.data.actions.length,0);
 for(let i=0;i<3;i++)await assert.rejects(f.broker.execute('task','finish_task',{outcome:'completed',summary:'done',evidence:['invented']}),/未知证据/);
 assert.equal(f.blocked(),undefined,'invented evidence is refused each time; the model decides how to recover');
});
