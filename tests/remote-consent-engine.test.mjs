import {DISTRIBUTION,ANDROID_PACKAGE} from '../src/distribution.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/core/store.mjs';
import {Engine} from '../src/core/engine.mjs';
import {Approvals} from '../src/core/approvals.mjs';
import {taskCheckoutPlan} from '../src/core/checkout.mjs';
import {validateTaskContract} from '../src/core/task-contract.mjs';
import {RemoteState,spkiPin} from '../src/remote/state.mjs';
import {createGateway} from '../src/remote/gateway.mjs';
import {identities,request} from './helpers/remote-tls.mjs';

test('actual remote gateway and Engine preserve the current meal through mobile consent, stop and bodyless continue',async t=>{
 const identitiesFixture=identities(),store=new Store(identitiesFixture.dir,{lock:false}),state=new RemoteState(identitiesFixture.dir),deviceId=randomUUID();
 const broker={calls:new Map(),approvals:new Approvals(store)},engine=new Engine({store,broker,secrets:{get:async()=>null},memory:{}});
 // Keep scheduling disabled: this verifies the real source-contract transitions,
 // without a fake Engine and without calling a model or phone.
 engine.pump=async()=>{};store.data.settings.chatCloudConsent=false;
 const gateway=createGateway({identity:identitiesFixture.server,state,store,engine,phone:{lease:null},dataDir:identitiesFixture.dir});const port=await gateway.listen();
 t.after(async()=>{await gateway.close();store.close();identitiesFixture.cleanup();});
 const call=(pathname,body)=>request({port,identity:identitiesFixture.client,pin:spkiPin(identitiesFixture.server.cert),pathname,method:body?'POST':'GET',body});
 const control=async(controlEpoch,paused)=>assert.equal((await call('/v1/device/control',{messageId:randomUUID(),controlEpoch,paused})).status,200);
 const pairing=state.issuePairing({deviceId});assert.equal((await call('/v1/pair',{edition:DISTRIBUTION.edition,androidApplicationId:ANDROID_PACKAGE,pairToken:pairing.pairToken})).status,200);await control(1,false);
 const received=await call('/v1/messages',{messageId:randomUUID(),text:'淘宝闪购点一杯冰美式，到结算页',createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+299000).toISOString(),controlEpoch:1});assert.equal(received.status,200);
 const id=received.body.taskId,original=store.task(id),query=structuredClone(original.phoneQuery),plan=taskCheckoutPlan(original),deadline=original.deadlineAt,source=structuredClone(original.taskContract.source);
 // The message expiry only bounds delivery; an accepted phone task works as long as one typed on the Mac (unlimited by default).
 assert.ok(original.remoteExpiresAt);assert.equal(original.deadlineAt,null);
 assert.equal(original.status,'waiting_consent');assert(plan);await control(2,false);
 const consent=await call('/v1/tasks/'+id+'/consent',{messageId:randomUUID(),controlEpoch:2,cloudConsent:true});assert.equal(consent.status,200);assert.equal(consent.body.status,'queued');
 const assertPreserved=()=>{const task=store.task(id);assert.deepEqual(task.phoneQuery,query,'a user consent/continue click must preserve the current source-verified meal');assert.deepEqual(taskCheckoutPlan(task),plan);assert.equal(task.deadlineAt,deadline);assert.deepEqual(task.taskContract.source,source);assert.equal(validateTaskContract(task,{store}).valid,true);assert.equal(task.memoryConsent,false);};assertPreserved();
 assert.equal((await call('/v1/tasks/'+id+'/stop',{messageId:randomUUID(),controlEpoch:3})).status,200);assert.equal(store.task(id).status,'paused');await control(4,false);
 assert.equal((await call('/v1/tasks/'+id+'/continue',{messageId:randomUUID(),controlEpoch:4})).status,200);assertPreserved();assert.equal(store.task(id).remoteControlEpoch,4);
 // A saved global model grant applies to every new phone message; no per-task
 // consent request is generated, and memory remains independently disabled.
 store.transaction(s=>{s.settings.chatCloudConsent=true;s.settings.chatMemoryConsent=false;});
 for(const text of ['打开设置，查看电池用量','打开计算器，计算2+2','你干嘛呢']){
  const response=await call('/v1/messages',{messageId:randomUUID(),text,createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+299000).toISOString(),controlEpoch:4});
  assert.equal(response.status,200);const task=store.task(response.body.taskId);assert.equal(task.status,'queued');assert.equal(task.cloudConsent,true);assert.equal(task.memoryConsent,false);assert.equal(task.remoteDeviceId,deviceId);
 }
 store.transaction(s=>s.settings.chatCloudConsent=false);
 const localOnly=await call('/v1/messages',{messageId:randomUUID(),text:'打开设置',createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+299000).toISOString(),controlEpoch:4});assert.equal(store.task(localOnly.body.taskId).status,'waiting_consent');

});
