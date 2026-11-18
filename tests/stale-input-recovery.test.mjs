import test from 'node:test';
import assert from 'node:assert/strict';
import {staleInputFixture} from './helpers/stale-input-fixture.mjs';

test('an expired remote input retains its unknown, deadline and original control epoch after two independently bound editor readbacks',async()=>{
 const f=staleInputFixture();
 const result=await f.run();assert.equal(result.resolved,true,JSON.stringify(result.results));
 assert.deepEqual(f.calls,['status','capture','verify','capture','status','verify']);
 assert.equal(f.task.status,'unknown_result');assert.equal(f.task.remoteControlEpoch,7);assert.equal(f.task.deadlineAt,'2001-01-01T00:00:00.000Z');
 assert.equal(f.action.status,'unknown');assert.equal(f.action.resolution.nativeOutcome,'unknown');assert.equal(f.action.resolution.originalControlEpoch,7);assert.equal(f.action.resolution.controlEpoch,8);
 assert.deepEqual(f.action.resolution.nativeObservationIds,['session-fixture:1','session-fixture:2']);assert.deepEqual(f.action.resolution.verificationIds,['verify-1','verify-2']);
 assert.equal(f.phone.lease,null);assert.equal(f.phone.observation,undefined);
 const logged=JSON.stringify(result);for(const privateData of ['合成原文','文件传输助手','ZGF0YQ=='])assert.ok(!logged.includes(privateData));
 for(const options of [f.options[0],{lease:{}},{lease:f.options[0].lease,action:'tap'}])await assert.rejects(f.client.observeForInputVerification(f.deviceId,options),{code:'input_verification_scope'});
 assert.equal(f.frames.length,2);
});
test('fresh native app, device, service, unclipped tree, same window, exact centered title + draft beside Send and unique editor proofs are all required',async()=>{
 const variants={
  device:f=>f.hooks.frame=r=>r.device_id='alien',instance:f=>f.hooks.frame=r=>r.service_instance_id='other',app:f=>f.hooks.frame=r=>r.package_name='com.example.other',
  stale:f=>f.hooks.frame=r=>r.captured_at_ms-=20000,truncated:f=>f.hooks.frame=r=>{r.tree.collection_truncated=true;r.tree.truncated=true;},secret:f=>f.hooks.frame=r=>r.tree.elements[0].password=true,
  swappedWindow:f=>f.hooks.frame=(r,n)=>{if(n===2){r.window_id=3;r.windows[0].window_id=3;}},
  cachedFrame:f=>f.hooks.frame=r=>r.observation_id=f.instance+':1',
  titleSubstring:f=>f.ocr.lines[0].text+='的好友',titleOutOfBar:f=>f.ocr.lines[0].bounds=[210,480,305,520],ambiguousTitle:f=>f.ocr.lines.push(f.ocr.lines[0]),
  messageBubble:f=>f.ocr.lines[1].bounds=[60,260,250,290],wrongDraft:f=>f.ocr.lines[1].text='别的草稿',noSend:f=>f.ocr.lines.pop(),
  weakReceipt:f=>f.hooks.proof=r=>r.proof.exact=false,oneRead:f=>f.hooks.proof=r=>r.proof.reads=1,
  repeatedJob:f=>f.hooks.proof=r=>r.id='same-job',differentEditor:f=>f.hooks.proof=(r,n)=>{if(n===2)r.proof.editorIdentity='b'.repeat(64);},
  unreadableEditor:f=>f.hooks.proof=r=>{r.status='unverified';},foreignReceipt:f=>f.hooks.proof=r=>r.proof.referenceId='other'
 };
 for(const [kind,change] of Object.entries(variants)){const f=staleInputFixture();change(f);const r=await f.run();assert.equal(r.resolved,false,kind);assert.equal(f.action.resolution,undefined,kind);assert.equal(f.action.status,'unknown');assert.equal(f.phone.lease,null);}
});
test('a pause, epoch change, expired telemetry, changed certificate, revoked permission or original authority cannot be crossed by a read-only capture',async()=>{
 const variants={
  pause:f=>f.control.paused=true,epoch:f=>f.control.controlEpoch++,certificate:f=>f.telemetry.certificateFingerprint='other',
  telemetry:f=>f.telemetry.fresh=false,device:f=>f.telemetry.deviceId='other',permission:f=>f.store.data.settings.executionEpochs.phone++,
  replacedChannel:f=>f.client.controlRpc={},deadChannel:f=>f.client.controlRpc.dead=true,
  disabled:f=>f.store.data.settings.phoneEnabled=false,fence:f=>f.store.data.recoveryFence={required:true},maintenance:f=>f.phone.remoteMaintenance=true,
  contract:f=>f.task.taskContract.revision++,source:f=>f.task.messages[0].content='different',taskOwner:f=>f.task.remoteDeviceId='new-owner',
  delegated:f=>f.task.parentId='other-task',receipt:f=>f.action.nativeRequestId='new-request',reboundTask:f=>f.task.remoteControlEpoch=8
 };
 for(const [kind,change] of Object.entries(variants)){
  const f=staleInputFixture();f.hooks.frame=()=>change(f);const result=await f.run();
  assert.equal(result.resolved,false,kind);assert.equal(f.proofs.length,0,kind);assert.equal(f.action.resolution,undefined,kind);assert.equal(f.phone.lease,null);
 }
 const f=staleInputFixture();let statuses=0;f.hooks.status=()=>{if(++statuses===2)f.telemetry.certificateFingerprint='changed';};
 assert.equal((await f.run()).resolved,false);assert.equal(f.proofs.length,1,'do not ask the new binding for an editor read');
});

test('a full-screen focused foreign window invalidates either native frame before an editor read on that frame',async()=>{
 for(const frame of [1,2]){
  const f=staleInputFixture();f.hooks.frame=(raw,n)=>{if(n!==frame)return;const app=raw.windows[0];app.active=false;app.focused=false;raw.windows.push({...app,window_id:20,type:3,layer:100,active:true,focused:true});};
  const outcome=await f.run();assert.equal(outcome.resolved,false);assert.equal(f.proofs.length,frame-1);assert.equal(f.action.resolution,undefined);assert.equal(f.action.status,'unknown');
 }
 const f=staleInputFixture();f.hooks.frame=raw=>{const app=raw.windows[0];app.active=false;app.focused=false;raw.windows.push({...app,window_id:20,type:2,layer:100,active:true,focused:true,bounds:[0,1450,1000,2400]});};assert.equal((await f.run()).resolved,true);
});
