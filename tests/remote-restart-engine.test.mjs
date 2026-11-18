import {DISTRIBUTION,ANDROID_PACKAGE} from '../src/distribution.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/core/store.mjs';
import {Engine} from '../src/core/engine.mjs';
import {Approvals} from '../src/core/approvals.mjs';
import {RemoteState,spkiPin} from '../src/remote/state.mjs';
import {createGateway} from '../src/remote/gateway.mjs';
import {validateTaskContract} from '../src/core/task-contract.mjs';
import {effectIdentity,effectPlan} from '../src/adapters/phone-effects.mjs';
import {identities,request} from './helpers/remote-tls.mjs';
async function fixture(t){
 const identity=identities(),store=new Store(identity.dir,{lock:false}),state=new RemoteState(identity.dir),deviceId=randomUUID();let clock=Date.now();
  // These cases exercise the bounded-time configuration (unlimited is the default).
  store.transaction(s=>{s.settings.maxTaskMinutes=20;});
 const engine=new Engine({store,broker:{calls:new Map(),approvals:new Approvals(store)},secrets:{get:async()=>assert.fail('must not read model credentials')},memory:{},clock:()=>clock});engine.pump=async()=>{};
 const gateway=createGateway({identity:identity.server,state,store,engine,phone:{lease:null},dataDir:identity.dir});const port=await gateway.listen();t.after(async()=>{await gateway.close();store.close();identity.cleanup();});
 const call=(pathname,body)=>request({port,identity:identity.client,pin:spkiPin(identity.server.cert),pathname,method:body?'POST':'GET',body});const pairing=state.issuePairing({deviceId});assert.equal((await call('/v1/pair',{edition:DISTRIBUTION.edition,androidApplicationId:ANDROID_PACKAGE,pairToken:pairing.pairToken})).status,200);assert.equal((await call('/v1/device/control',{messageId:randomUUID(),controlEpoch:1,paused:false})).status,200);
 function expired(input={}){clock=Date.now()-120000;const task=engine.create({prompt:'打开设置，查看电池用量，再返回设置首页。只查看，不修改任何设置。',cloudConsent:true,memoryConsent:false,maxRunSeconds:60,remoteDeviceId:deviceId,remoteControlEpoch:1,...input});store.updateTask(task.id,t=>t.status='expired');clock=Date.now();return task;}
 return {store,engine,call,expired};
}
test('one explicit restart renews only the displayed original goal and duplicate delivery cannot restart twice',async t=>{
 const f=await fixture(t),task=f.expired(),originalDeadline=task.deadlineAt,detail=(await f.call('/v1/tasks/'+task.id)).body;assert.match(detail.restartKey,/^[a-f0-9]{64}$/);assert.equal(detail.deadlineAt,originalDeadline);
 const body={messageId:randomUUID(),controlEpoch:1,restartKey:detail.restartKey,memoryConsent:true};const first=await f.call('/v1/tasks/'+task.id+'/restart',body);assert.equal(first.status,200);const saved=f.store.task(task.id),renewed=saved.deadlineAt,count=saved.messages.length;assert.ok(Date.parse(renewed)>Date.parse(originalDeadline));assert.ok(saved.messages.at(-1).content.startsWith('重新执行：打开设置'));assert.equal(saved.cloudConsent,true);assert.equal(saved.memoryConsent,false);assert.equal(validateTaskContract(saved,{store:f.store}).valid,true);
 const duplicate=await f.call('/v1/tasks/'+task.id+'/restart',body);assert.equal(duplicate.status,200);assert.deepEqual(duplicate.body,first.body);assert.equal(f.store.task(task.id).deadlineAt,renewed);assert.equal(f.store.task(task.id).messages.length,count);assert.equal(f.store.task(task.id).requests,0);
 assert.equal((await f.call('/v1/tasks/'+task.id+'/restart',{...body,messageId:randomUUID()})).status,400);
});
test('stale restart button cannot execute a later user goal',async t=>{
 const f=await fixture(t),task=f.expired(),old=(await f.call('/v1/tasks/'+task.id)).body.restartKey;
 f.store.updateTask(task.id,t=>t.messages.push({id:randomUUID(),role:'user',content:'打开相册查看照片',at:new Date().toISOString()}));const updated=(await f.call('/v1/tasks/'+task.id)).body;assert.notEqual(updated.restartKey,old);
 const reply=await f.call('/v1/tasks/'+task.id+'/restart',{messageId:randomUUID(),controlEpoch:1,restartKey:old});assert.equal(reply.status,400);assert.equal(reply.body.error.code,'restart_scope_changed');assert.equal(f.store.task(task.id).status,'expired');
});
test('unknown actions, external sources, missing model consent and live deadlines never offer or accept restart',async t=>{
 const f=await fixture(t);
 for(const variation of ['unknown','consent','routine','external','live']){
  const task=f.expired(variation==='consent'?{cloudConsent:false}:{});
  f.store.updateTask(task.id,(t,s)=>{if(variation==='unknown')s.actions.push({id:randomUUID(),taskId:t.id,tool:'phone_open_app',status:'unknown'});if(variation==='routine')t.source='routine';if(variation==='external')t.messages.at(-1).externalContent=true;if(variation==='live'){t.timeline.deadlineAt=new Date(Date.now()+60000).toISOString();t.status='paused';}});
  const detail=(await f.call('/v1/tasks/'+task.id)).body;assert.equal(detail.restartKey,null,variation);const before=JSON.stringify(f.store.task(task.id));const reply=await f.call('/v1/tasks/'+task.id+'/restart',{messageId:randomUUID(),controlEpoch:1,restartKey:'a'.repeat(64),cloudConsent:true});assert.equal(reply.status,400,variation);assert.equal(JSON.stringify(f.store.task(task.id)),before);
 }
});


test('restart after a short continuation keeps the verified original task instead of restarting the word continue',async t=>{
 const f=await fixture(t),task=f.expired(),goal=task.prompt;
 // A source-bound content-free followup may arrive before the original expiry.
 const deadline=task.deadlineAt;f.engine.clock=()=>Date.parse(deadline)-1000;await f.engine.continue(task.id,{message:'继续'});f.store.updateTask(task.id,t=>t.status='expired');f.engine.clock=Date.now;
 const detail=(await f.call('/v1/tasks/'+task.id)).body;assert.match(detail.restartKey,/^[a-f0-9]{64}$/);
 const response=await f.call('/v1/tasks/'+task.id+'/restart',{messageId:randomUUID(),controlEpoch:1,restartKey:detail.restartKey});assert.equal(response.status,200);assert.equal(f.store.task(task.id).messages.at(-1).content,'重新执行：'+goal);assert.equal(f.store.task(task.id).taskContract.goal,'重新执行：'+goal);assert.equal(f.store.task(task.id).maxRunSeconds,60);assert.ok(Date.parse(f.store.task(task.id).deadlineAt)-Date.now()<=60000);
});
test('an unresolved child action prevents a parent restart without mutating its original receipt',async t=>{
 const f=await fixture(t),task=f.expired(),child=randomUUID();f.store.transaction(s=>{s.tasks.push({id:child,parentId:task.id,status:'unknown_result',children:[]});s.tasks.find(t=>t.id===task.id).children.push(child);s.actions.push({id:'original-child-receipt',taskId:child,status:'unknown',tool:'phone_action'});});
 assert.equal((await f.call('/v1/tasks/'+task.id)).body.restartKey,null);assert.equal((await f.call('/v1/tasks/'+task.id+'/restart',{messageId:randomUUID(),controlEpoch:1,restartKey:'a'.repeat(64)})).status,400);assert.equal(f.store.data.actions.find(a=>a.id==='original-child-receipt').status,'unknown');
});


test('remote navigation reconciliation reads the original receipt without new execution, model consent or deadline',async t=>{
 const f=await fixture(t),task=f.expired(),deadline=task.deadlineAt;let checks=0;
 f.store.updateTask(task.id,(task,s)=>{task.status='unknown_result';s.actions.push({id:'nav',taskId:task.id,status:'unknown',tool:'phone_open_app',nativeRequestId:'original',nativeDeviceId:'phone'});});
 f.engine.broker.reconcilePhoneNavigation=async id=>{checks++;assert.equal(id,task.id);assert.equal(f.store.task(id).remoteControlEpoch,3);f.store.transaction(s=>s.actions.find(a=>a.id==='nav').resolution={kind:'navigation_observed'});return {resolved:true};};
 assert.equal((await f.call('/v1/tasks/'+task.id)).body.canReconcile,true);
 await f.call('/v1/device/control',{messageId:randomUUID(),controlEpoch:3,paused:false});const body={messageId:randomUUID(),controlEpoch:3};let response=await f.call('/v1/tasks/'+task.id+'/reconcile',body);assert.equal(response.status,200);assert.equal(response.body.status,'expired');
 assert.equal(f.store.task(task.id).deadlineAt,deadline);assert.equal(f.store.task(task.id).requests,0);assert.equal(f.store.data.actions.find(a=>a.id==='nav').status,'unknown');
 response=await f.call('/v1/tasks/'+task.id+'/reconcile',body);assert.equal(response.status,200);assert.equal(checks,1);
});
test('remote observation entry never reconciles business effects or operates during local takeover',async t=>{
 const f=await fixture(t),task=f.expired();f.engine.broker.reconcilePhoneNavigation=async()=>assert.fail('not allowed');
 f.store.updateTask(task.id,(t,s)=>{t.status='unknown_result';s.actions.push({id:'send',taskId:t.id,status:'unknown',tool:'phone_action',nativeRequestId:'sent',nativeDeviceId:'phone'});});
 assert.equal((await f.call('/v1/tasks/'+task.id)).body.canReconcile,false);
 assert.equal((await f.call('/v1/tasks/'+task.id+'/reconcile',{messageId:randomUUID(),controlEpoch:1})).status,400);
 f.store.transaction(s=>{s.actions[0].tool='phone_open_app';});await f.call('/v1/device/control',{messageId:randomUUID(),controlEpoch:2,paused:true});
 assert.equal((await f.call('/v1/tasks/'+task.id+'/reconcile',{messageId:randomUUID(),controlEpoch:2})).status,400);
});

test('missing completion report offers a new explicit restart only after expiry with no uncertain effects',async t=>{
 const f=await fixture(t),task=f.expired();f.store.updateTask(task.id,t=>t.status='needs_review');const detail=(await f.call('/v1/tasks/'+task.id)).body;assert.match(detail.restartKey,/^[a-f0-9]{64}$/);
 assert.equal((await f.call('/v1/tasks/'+task.id+'/restart',{messageId:randomUUID(),controlEpoch:1,restartKey:detail.restartKey})).status,200);assert.equal(f.store.task(task.id).requests,0);
 const unsafe=f.expired();f.store.updateTask(unsafe.id,(t,s)=>{t.status='needs_review';s.actions.push({taskId:t.id,status:'unknown',tool:'phone_action'});});assert.equal((await f.call('/v1/tasks/'+unsafe.id)).body.restartKey,null);
});

test('an authenticated remote input check never rebinds the original execution epoch, deadline or unknown receipt',async t=>{
 const f=await fixture(t),task=f.expired({prompt:'在微信给文件传输助手发送“合成原文”'}),deadline=task.deadlineAt;
 const original='00000000-0000-4000-8000-000000000001';
 f.store.updateTask(task.id,(task,s)=>{
  task.status='unknown_result';
  const c=task.taskContract,scope=task.phoneUseScope={mode:'general',packageName:'com.tencent.mm',contractId:c.id,contractRevision:c.revision,effectPlan:effectPlan(c)};
  s.actions.push({id:'original-input',taskId:task.id,status:'unknown',tool:'phone_action',phoneOperation:'type',nativeRequestId:original,phoneEffect:{kind:'effect_message_input',packageName:scope.packageName,witness:{effectKey:effectIdentity(scope),contractId:c.id,contractRevision:c.revision}}});
 });
 let checks=0;
 f.engine.broker.reconcilePhoneNavigation=async id=>{checks++;assert.equal(f.store.task(id).remoteControlEpoch,1);return {resolved:false};};
 assert.equal((await f.call('/v1/tasks/'+task.id)).body.canReconcile,true);
 await f.call('/v1/device/control',{messageId:randomUUID(),controlEpoch:3,paused:false});
 const request={messageId:randomUUID(),controlEpoch:3};
 assert.equal((await f.call('/v1/tasks/'+task.id+'/reconcile',request)).status,200);
 assert.equal((await f.call('/v1/tasks/'+task.id+'/reconcile',request)).status,200);assert.equal(checks,1);
 const current=f.store.task(task.id);assert.equal(current.remoteControlEpoch,1);assert.equal(current.deadlineAt,deadline);assert.equal(current.status,'unknown_result');assert.equal(current.requests,0);
 assert.equal(f.store.data.actions.find(a=>a.nativeRequestId===original).status,'unknown');
});
