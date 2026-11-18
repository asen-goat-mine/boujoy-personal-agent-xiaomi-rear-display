import {ANDROID_PACKAGE} from '../src/distribution.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {returnAfterCompletion} from '../src/adapters/phone-completion-return.mjs';
function fixture(){
 const task={id:'t',status:'completed',remoteControlEpoch:7,events:[]},native={deviceId:'d',serviceInstanceId:'s',packageName:'com.android.settings'};
 let count=0;const calls=[],control={paused:false,controlEpoch:7};
 const phone={store:{data:{tasks:[task],actions:[],settings:{phoneEnabled:true}},event:(id,type,text,extra)=>task.events.push({type,...extra})},lease:'t',observation:{taskId:'t',native},isPhoneUse:()=>true,remoteControlState:()=>control,phoneUseDevice:()=> 'd',phoneUse:{capture:async()=>({native:{...native,packageName:count++?ANDROID_PACKAGE:native.packageName}})},call:async(...args)=>calls.push(args)};
 return {phone,task,native,calls,control};
}
test('completed phone run returns once and verifies foreground; no replay',async()=>{const f=fixture();await returnAfterCompletion(f.phone,'t');assert.equal(f.calls.length,1);assert.equal(f.calls[0][1].packageName,ANDROID_PACKAGE);assert.equal(f.task.events.at(-1).outcome,'returned');await returnAfterCompletion(f.phone,'t');assert.equal(f.calls.length,1);});
test('handoff, stop, other lease, revoked epoch, desktop-only and unresolved actions never navigate',async()=>{
 for(const mutate of [f=>f.task.status='ready_for_user',f=>f.task.status='paused',f=>f.control.paused=true,f=>f.control.controlEpoch=8,f=>f.phone.lease='other',f=>f.phone.observation=null,f=>f.task.source='watch',f=>f.task.parentId='p',f=>f.phone.store.data.actions.push({taskId:'t',status:'unknown'})]){const f=fixture();mutate(f);await returnAfterCompletion(f.phone,'t');assert.equal(f.calls.length,0);}
});
test('changed foreground or revocation during observation prevents launch',async()=>{for(const kind of ['foreground','pause','epoch']){const f=fixture();f.phone.phoneUse.capture=async()=>{if(kind==='pause')f.control.paused=true;if(kind==='epoch')f.control.controlEpoch++;return {native:{...f.native,packageName:kind==='foreground'?'com.other.app':f.native.packageName}};};await returnAfterCompletion(f.phone,'t');assert.equal(f.calls.length,0);}});
test('unknown launch is recorded without replay or changing completed result',async()=>{const f=fixture();f.phone.call=async()=>{f.calls.push('launch');throw Object.assign(new Error(),{code:'outcome_unknown'});};await returnAfterCompletion(f.phone,'t');await returnAfterCompletion(f.phone,'t');assert.equal(f.calls.length,1);assert.equal(f.task.status,'completed');assert.equal(f.task.events.at(-1).outcome,'unverified');});


test('a different Boujoy installation never verifies the current edition return',async()=>{
 for(const foreign of ['dev.boujoy.personalagent','dev.boujoy.phoneuse','dev.boujoy.xiaomi'].filter(value=>value!==ANDROID_PACKAGE)){
  const f=fixture();let reads=0;f.phone.phoneUse.capture=async()=>({native:{...f.native,packageName:reads++?foreign:f.native.packageName}});
  await returnAfterCompletion(f.phone,'t');assert.equal(f.calls.length,1);assert.equal(f.calls[0][1].packageName,ANDROID_PACKAGE);assert.equal(f.task.events.at(-1).outcome,'unverified',foreign);
 }
});
test('current edition foreground needs no completion launch',async()=>{
 const f=fixture();f.native.packageName=ANDROID_PACKAGE;await returnAfterCompletion(f.phone,'t');assert.equal(f.calls.length,0);assert.equal(f.task.events.at(-1).outcome,'already_home');
});
