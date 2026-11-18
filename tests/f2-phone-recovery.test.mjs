import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../src/core/store.mjs';
import {Engine} from '../src/core/engine.mjs';
import {Broker,unresolvedPhoneAction} from '../src/tools/broker.mjs';
import {HarnessRun,childToolFilter} from '../src/adapters/harness.mjs';
import {deriveDelegation} from '../src/core/delegation.mjs';
import {validateTaskContract} from '../src/core/task-contract.mjs';

const mixed='一边整理下载里的发票，一边把外卖做到付款页就停（别付、别填验证码、别提交订单）；中途再问一句现在几点。两件长活都不能丢，要能停能续，完成后有回执。';
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'boujoy-f2-')),store=new Store(dir);
 store.transaction(s=>{s.settings.phoneEnabled=true;});
 const phone={lease:null,release(){},close(){},assertRemoteDataAvailable(){throw Object.assign(new Error('手机锁屏；解锁后在 Boujoy 点继续'),{code:'phone_control_paused',dispatchState:'not_sent'});}};
 const broker=new Broker({store,dataDir:dir,phone,browser:{close(){}},memory:{},approvals:{cancelTask(){}}});
 const engine=new Engine({store,broker,secrets:{get:async()=>null},memory:{}});engine.pump=async()=>{};
 t.after(()=>{engine.groups.close();store.close();fs.rmSync(dir,{recursive:true,force:true});});
 const create=prompt=>{const task=engine.create({prompt,cloudConsent:true});store.updateTask(task.id,t=>t.status='running');return store.task(task.id);};
 return {store,broker,engine,create};
}
test('F2 mixed file and phone work pauses once before dispatch and explicitly resumes without losing evidence',async t=>{
 const f=fixture(t),task=f.create(mixed),deadline=task.deadlineAt,contract=structuredClone(task.taskContract);
 f.store.event(task.id,'tool_result','发票清单已保留',{tool:'mac_files',evidenceRef:'f2-invoice-proof'});
 await assert.rejects(f.broker.execute(task.id,'phone_use',{action:'open_app',app:'外卖'}),{code:'phone_control_paused',dispatchState:'not_sent'});
 assert.equal(f.store.task(task.id).status,'paused');assert.equal(f.store.data.actions.length,0);
 await assert.rejects(f.broker.execute(task.id,'phone_use',{action:'read'}),/任务当前不能执行工具/);
 const errors=f.store.task(task.id).events.filter(e=>e.code==='phone_control_paused');assert.equal(errors.length,1);
 await f.engine.continue(task.id,{});
 const resumed=f.store.task(task.id);assert.equal(resumed.status,'queued');assert.equal(resumed.deadlineAt,deadline);
 assert.equal(resumed.taskContract.goal,contract.goal);assert.deepEqual(resumed.taskContract.source,contract.source);
 assert.equal(validateTaskContract(resumed,{store:f.store}).valid,true);
 assert.ok(resumed.events.some(e=>e.evidenceRef==='f2-invoice-proof'));
 assert.ok(f.broker.catalog(resumed).some(tool=>tool.name==='mac_files'));
});
test('F2 accidental phone access on desktop work stays actionable and preserves not_sent',async t=>{
 const f=fixture(t),task=f.create('用浏览器打开 github');
 await assert.rejects(f.broker.execute(task.id,'phone_use',{action:'read'}),{code:'phone_unavailable',dispatchState:'not_sent'});
 assert.equal(f.store.task(task.id).status,'running');
 assert.ok(f.broker.catalog(f.store.task(task.id)).some(tool=>tool.name==='mac_files'));
});
test('F2 a current delegated file reader receives mac_files; revoked and disabled grants do not',t=>{
 const f=fixture(t),parent=f.create(mixed),child=f.engine.create(deriveDelegation(parent,{prompt:'整理下载里的发票',roleId:'work'},f.store));
 assert.equal(validateTaskContract(child,{store:f.store}).valid,true);
 const names=()=>f.broker.catalog(f.store.task(child.id)).map(t=>t.name);
 for(const name of ['mac_files','artifact_read','artifact_write','document_create'])assert.ok(names().includes(name),name);
 f.store.transaction(s=>{s.settings.filesEnabled=false;});assert.ok(!names().includes('mac_files'));
 f.store.transaction(s=>{s.settings.filesEnabled=true;s.tasks.find(t=>t.id===parent.id).status='paused';});assert.ok(!names().includes('mac_files'));
});
test('F2 a warm Harness with a frozen file filter is refreshed when file capabilities change',()=>{
 const run=new HarnessRun({task:{id:'old'},toolNames:['task_context','finish_task']});
 assert.equal(run.canReuseToolCatalog(['task_context','finish_task']),true);
 assert.equal(run.canReuseToolCatalog(['task_context','finish_task','mac_files','artifact_read']),false);
 const files=new HarnessRun({task:{id:'files'},toolNames:['task_context','mac_files','artifact_read']});
 assert.equal(files.canReuseToolCatalog(['artifact_read','task_context','mac_files','phone_use']),false);
 assert.equal(files.canReuseToolCatalog(['task_context']),false);
 const extras=[{insert:[{id:'tool-subagent',config:{toolFilter:{allow:['mcp__personal__task_context','mcp__personal__mac_files','mcp__personal__artifact_read']}}}]}];
 const allow=childToolFilter(extras,['task_context','mac_files','artifact_read'])[0].insert[0].config.toolFilter.allow;
 assert.ok(allow.includes('mcp__personal__mac_files'));assert.ok(allow.includes('mcp__personal__artifact_read'));
});
test('F2 unresolved old actions are preserved and cannot be resumed as new work',async t=>{
 const f=fixture(t),old=f.create('打开设置');
 f.store.transaction(s=>{s.tasks.find(t=>t.id===old.id).status='unknown_result';s.actions.push({id:'old-action',taskId:old.id,status:'unknown',tool:'phone_use'});});
 await assert.rejects(f.engine.continue(old.id,{}),/核实原操作结果/);
 const fresh=f.create('打开计算器');assert.notEqual(fresh.id,old.id);assert.equal(fresh.status,'running');
 assert.equal(!!unresolvedPhoneAction(f.store.data.actions,fresh.id,f.store.data.tasks),false);
 assert.equal(!!unresolvedPhoneAction(f.store.data.actions,old.id,f.store.data.tasks),true);
 assert.equal(f.store.task(old.id).status,'unknown_result');assert.equal(f.store.data.actions[0].status,'unknown');
});
test('F2 Engine replaces a warm run whose child file allowlist predates enabling files',t=>{
 const f=fixture(t),old=f.create('整理下载里的发票');f.store.updateTask(old.id,t=>t.status='completed');
 const next=f.engine.create({prompt:'继续整理下载里的发票',conversationId:old.conversationId,roleId:old.roleId,cloudConsent:true});
 let disposed=0;const run=new HarnessRun({task:old,toolNames:['task_context','finish_task']});run.alive=()=>true;run.dispose=()=>{disposed++;};
 const key=old.conversationId||old.id,stub={};f.engine.tokens.set('old-token',stub);
 f.engine.warm.set(key,{key,run,token:'old-token',stub,roleId:old.roleId,lastTaskId:old.id});
 assert.equal(f.engine.takeWarm(next),null);assert.equal(disposed,1);assert.equal(f.engine.tokens.has('old-token'),false);
 assert.equal(f.store.task(old.id).status,'completed');assert.equal(f.store.task(next.id).status,'queued');
});


test('explicit resume clears screen-recovery feedback without renewing deadline or imposing a retry cap',async t=>{
 const f=fixture(t),task=f.create('打开设置查看电量'),deadline=task.deadlineAt;
 f.store.updateTask(task.id,row=>{row.status='blocked';row.requests=14;row.phoneRecovery={code:'phone_observation_required',count:4,startRequests:10,reason:'请读取最新页面'};});
 await f.engine.continue(task.id,{});assert.equal(f.store.task(task.id).phoneRecovery,null);assert.equal(f.store.task(task.id).deadlineAt,deadline);
 f.store.updateTask(task.id,row=>row.status='running');const active={taskId:task.id,controller:new AbortController(),token:'qa-resume'};
 assert.equal(f.engine.authorizeRuntime(active),active);
 f.store.updateTask(task.id,row=>{row.phoneRecovery={code:'phone_observation_required',count:4,startRequests:14,reason:'仍未获得页面'};row.requests=18;});
 f.engine.active.set(task.id,active);assert.equal(f.engine.authorizeRuntime(active),active);
 assert.equal(f.store.task(task.id).status,'running');assert.equal(active.controller.signal.aborted,false);
 assert.equal(f.store.task(task.id).phoneRecovery.count,4);assert.equal(f.store.task(task.id).report,null);
 assert.equal(f.store.task(task.id).deadlineAt,deadline);f.engine.active.delete(task.id);
});
