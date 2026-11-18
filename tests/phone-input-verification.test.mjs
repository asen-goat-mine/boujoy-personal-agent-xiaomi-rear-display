import test from 'node:test';
import assert from 'node:assert/strict';
import {createTaskContract} from '../src/core/task-contract.mjs';
import {effectIdentity,effectPlan} from '../src/adapters/phone-effects.mjs';
import {verifyUnknownMessageInput} from '../src/adapters/phone-input-verification.mjs';
import {Broker} from '../src/tools/broker.mjs';
import {RemoteService} from '../src/remote/service.mjs';
import {Phone} from '../src/adapters/phone.mjs';
import {nativePage,nativeNode} from './helpers/phone-native-fixture.mjs';

function fixture(){
 const task={id:'task',status:'unknown_result',source:'user',messages:[{id:'user',role:'user',content:'在微信给文件传输助手发送“合成原文”'}]};task.taskContract=createTaskContract(task);
 const scope={taskId:task.id,packageName:'com.tencent.mm',mode:'general',contractId:task.taskContract.id,contractRevision:task.taskContract.revision,effectPlan:effectPlan(task.taskContract)};task.phoneUseScope=scope;
 const action={id:'original',taskId:task.id,status:'unknown',tool:'phone_action',phoneOperation:'type',nativeRequestId:'00000000-0000-4000-8000-000000000001',phoneEffect:{kind:'effect_message_input',packageName:scope.packageName,witness:{contractId:scope.contractId,contractRevision:scope.contractRevision,effectKey:effectIdentity(scope)}}};
 let epoch=8,paused=false,protocol=2,reads=0,verifications=0,statuses=0;const calls=[];
 const frame=()=>({id:'page-'+reads,taskId:task.id,at:Date.now(),native:{at:Date.now(),deviceId:'native-phone',serviceInstanceId:'native-session',packageName:scope.packageName,windowId:3},ocr:{height:2000,lines:[{text:'文件传输助手',bounds:[100,80,500,160]}]},tree:{content:[{type:'text',text:JSON.stringify({ok:true,result:{display:'main',windowPkg:scope.packageName,tree:`window pkg=${scope.packageName} bounds=0,0,1000,2000\nView bounds=0,0,1000,2000`}})}]}});
 const phone={remoteControlState:()=>({paused,controlEpoch:epoch}),remoteDeviceTelemetry:()=>({typingProtocol:protocol}),acquire:()=>calls.push('acquire'),release:()=>calls.push('release'),phoneUseDevice:()=> 'native-phone',phoneUse:{client:{active:new Map(),status:async()=>{statuses++;calls.push('status');return {device_id:'native-phone',service_instance_id:'native-session',paused:false,stopped:false,executing_request_id:null};}}},observeGeneral:async()=>{reads++;calls.push('observe');phone.observation=frame();},ime:{request:()=>assert.fail('must never type'),verify:async input=>{verifications++;calls.push('verify');assert.equal(input.referenceId,action.nativeRequestId);assert.equal(input.text,'合成原文');return {id:'verification-'+verifications,status:'verified',proof:{referenceId:input.referenceId,controlEpoch:input.controlEpoch,editorIdentity:'a'.repeat(64),exact:true,reads:2}};}},act:()=>assert.fail('must never dispatch'),actGeneral:()=>assert.fail('must never dispatch')};
 const store={data:{tasks:[task],actions:[action]},task:()=>task,transaction:fn=>fn(store.data)};
 return {task,action,scope,phone,store,calls,setEpoch:value=>epoch=value,setPaused:value=>paused=value,setProtocol:value=>protocol=value,counts:()=>({reads,verifications,statuses}),run:()=>verifyUnknownMessageInput({task,action,phone})};
}
test('read-only message input reconciliation preserves the original unknown and appends independent exact-editor evidence',async()=>{
 const f=fixture(),result=await Broker.prototype.reconcilePhoneNavigation.call({store:f.store,phone:f.phone},f.task.id);
 assert.equal(result.resolved,true);assert.equal(f.action.status,'unknown');assert.equal(f.action.nativeRequestId,'00000000-0000-4000-8000-000000000001');assert.equal(f.action.resolution.kind,'input_observed');assert.equal(f.action.resolution.nativeOutcome,'unknown');assert.deepEqual(f.action.resolution.verificationIds,['verification-1','verification-2']);assert.deepEqual(f.counts(),{reads:2,verifications:2,statuses:2});assert.equal(f.task.status,'unknown_result','only Engine reconciliation may move the task to paused, never execute it');
});
test('old phone capability, a pause or an in-flight native action cannot dispatch verification',async()=>{
 for(const kind of ['old','pause','inflight']){const f=fixture();if(kind==='old')f.setProtocol(1);if(kind==='pause')f.setPaused(true);if(kind==='inflight')f.phone.phoneUse.client.active.set('other',{});assert.equal((await f.run()).resolved,false);assert.equal(f.counts().verifications,0);assert.equal(f.action.resolution,undefined);}
});
test('foreign recipient, package, service identity or an unfresh page remains unknown before editor verification',async()=>{
 for(const kind of ['recipient','package','instance','stale']){const f=fixture(),capture=f.phone.observeGeneral;f.phone.observeGeneral=async()=>{await capture();if(kind==='recipient')f.phone.observation.ocr.lines[0].text='其他人';if(kind==='package')f.phone.observation.native.packageName='com.example.other';if(kind==='instance')f.phone.observation.native.serviceInstanceId='replacement';if(kind==='stale')f.phone.observation.at-=11000;};assert.equal((await f.run()).resolved,false);assert.equal(f.counts().verifications,0);}
});
test('changed epoch, editor identity, native session, window or unreadable editor never resolves an input',async()=>{
 for(const kind of ['epoch','editor','session','window','unreadable']){const f=fixture(),verify=f.phone.ime.verify,status=f.phone.phoneUse.client.status,capture=f.phone.observeGeneral;
  f.phone.ime.verify=async input=>{const result=await verify(input);if(kind==='epoch')f.setEpoch(9);if(kind==='unreadable')result.status='unverified';if(kind==='editor'&&f.counts().verifications===2)result.proof.editorIdentity='b'.repeat(64);return result;};
  f.phone.phoneUse.client.status=async()=>{const result=await status();if(kind==='session'&&f.counts().statuses===2)result.service_instance_id='new';return result;};
  f.phone.observeGeneral=async()=>{await capture();if(kind==='window'&&f.counts().reads===2)f.phone.observation.native.windowId=4;};
  const result=await Broker.prototype.reconcilePhoneNavigation.call({store:f.store,phone:f.phone},f.task.id);assert.equal(result.resolved,false,kind);assert.equal(f.action.resolution,undefined,kind);assert.equal(f.action.status,'unknown');
 }
});
test('an unknown tap, changed contract or substituted request cannot use message-input recovery',async()=>{
 for(const kind of ['tap','contract','request']){const f=fixture();if(kind==='tap')f.action.phoneOperation='tap';if(kind==='contract')f.task.taskContract.revision++;if(kind==='request'){const verify=f.phone.ime.verify;f.phone.ime.verify=async input=>{const result=await verify(input);result.proof.referenceId='different';return result;};}assert.equal((await f.run()).resolved,false);assert.equal(f.action.resolution,undefined);}
});
test('a contract change during the last verification cannot commit a resolution',async()=>{
 const f=fixture(),verify=f.phone.ime.verify;f.phone.ime.verify=async input=>{const result=await verify(input);if(f.counts().verifications===2)f.task.taskContract.revision++;return result;};
 const result=await Broker.prototype.reconcilePhoneNavigation.call({store:f.store,phone:f.phone},f.task.id);assert.equal(result.resolved,false);assert.equal(f.action.resolution,undefined);
});
test('verification service requires fresh advertised support and rechecks the control epoch after the receipt',async()=>{
 for(const kind of ['old','paused','changed','good']){
  let calls=0;const context={closed:false,phone:{remoteMaintenance:false},state:{data:{control:{controlEpoch:8,paused:kind==='paused'}}},deviceTelemetry:()=>({deviceId:'phone',certificateFingerprint:'certificate',...(kind==='old'?{}:{typingProtocol:2})})};
  context.gateway={typing:{request:async input=>{calls++;assert.equal(input.operation,'verify_replace');assert.equal(input.deviceId,'phone');if(kind==='changed')context.state.data.control.controlEpoch++;return {status:'verified'};}}};
  const work=RemoteService.prototype.verifyInput.call(context,{text:'exact',packageName:'com.example.app',referenceId:'original',controlEpoch:8});
  if(kind==='good')assert.equal((await work).status,'verified');else await assert.rejects(work);
  assert.equal(calls,['changed','good'].includes(kind)?1:0);
 }
});
test('real 1.3.0 status shape may omit paused, but stopped and malformed pause fields never authorize a proof',async()=>{
 for(const [paused,stopped,pass] of [[undefined,false,true],[false,false,true],[true,false,false],['false',false,false],[0,false,false],[undefined,true,false],[undefined,undefined,false],[undefined,'false',false]]){
  const f=fixture(),status=f.phone.phoneUse.client.status;f.phone.phoneUse.client.status=async()=>{const row=await status();row.stopped=stopped;if(paused===undefined)delete row.paused;else row.paused=paused;return row;};
  assert.equal((await f.run()).resolved,pass,JSON.stringify({paused,stopped}));
 }
});
test('normalization and the actual Phone.observeGeneral path preserve the native timestamp, display and window identity used by recovery',async()=>{
 const f=fixture(),store={data:{settings:{phoneBackend:'phoneuse',phoneEnabled:true,phoneUseDeviceId:'fixture'},tasks:[f.task],actions:[f.action]},event(){}};
 const client={active:new Map(),status:async()=>({device_id:'fixture',service_instance_id:'service',stopped:false,executing_request_id:null})};
 const phone=new Phone(store,{phoneUse:{client}});phone.remoteControlState=f.phone.remoteControlState;phone.remoteDeviceTelemetry=f.phone.remoteDeviceTelemetry;phone.ime=f.phone.ime;
 phone.captureStableFrame=async()=>nativePage({packageName:'com.tencent.mm'},[nativeNode('文件传输助手',70)]);
 const original=phone.observationResult;let pages=0;
 phone.observationResult=function(...args){const value=original.apply(this,args);pages++;assert.equal(this.observation.native.windowId,2);assert.equal(this.observation.native.display.height,2400);assert.ok(Number.isSafeInteger(this.observation.native.at));return value;};
 const result=await verifyUnknownMessageInput({task:f.task,action:f.action,phone});assert.equal(result.resolved,true);assert.equal(pages,2);assert.equal(result.resolution.windowId,2);assert.equal(phone.lease,null);
});
