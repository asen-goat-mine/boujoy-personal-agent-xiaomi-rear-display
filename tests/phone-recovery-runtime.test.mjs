import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../src/core/store.mjs';
import {Engine} from '../src/core/engine.mjs';
import {Broker} from '../src/tools/broker.mjs';
import {Phone} from '../src/adapters/phone.mjs';
import {AppError} from '../src/core/errors.mjs';
import {deriveDelegation} from '../src/core/delegation.mjs';
import {setExecutionPermissions} from '../src/core/execution-permissions.mjs';

const DEVICE='11111111-1111-4111-8111-111111111111';
const decode=result=>result.content.filter(row=>row.type==='text').map(row=>JSON.parse(row.text));
const frameError=()=>Object.assign(new AppError('phoneuse_error','后台显示读取失败（FRAME_UNAVAILABLE）',409),{phoneuseCode:'FRAME_UNAVAILABLE',dispatchState:'not_sent'});
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'boujoy-recovery-runtime-')),store=new Store(dir);
 store.transaction(s=>{s.settings.phoneEnabled=true;s.settings.maxTaskMinutes=20;});
 let at=Date.now(),unavailable=true,captures=0;
 const phone=new Phone(store,{clock:()=>at,wait:async()=>{},phoneUse:{client:{}}});
 // Only the device frame is simulated: actual Phone observation handling, Broker,
 // persistent Store and Engine authorization all run below.
 phone.captureStableFrame=async taskId=>{
  captures++;if(unavailable)throw frameError();
  return {taskId,at,aligned:true,hash:'fixture-frame',imageHash:'fixture-image',
   tree:{content:[{type:'text',text:JSON.stringify({ok:true,result:{display:'main',foreground:'com.android.settings',windowPkg:'com.android.settings',window:7,tree:'window pkg=com.android.settings bounds=0,0,1080,2400'}})}]},
   ocr:{width:1080,height:2400,lines:[]},image:null};
 };
 const broker=new Broker({store,dataDir:dir,phone,browser:{close(){}},memory:{},approvals:{cancelTask(){}}});
 const engine=new Engine({store,broker,clock:()=>at,secrets:{get:async()=>null},memory:{}});engine.pump=async()=>{};
 const make=(input={})=>{
  const row=engine.create({prompt:'打开设置查看电池',cloudConsent:true,maxRunSeconds:120,...input});
  store.updateTask(row.id,task=>{task.status='running';task.phoneUseScope={taskId:task.id,mode:'general',decisionOwner:'harness',packageName:'com.android.settings',appName:'设置'};});
  return store.task(row.id);
 };
 const active=id=>{const value={taskId:id,token:'runtime-'+id,controller:new AbortController()};engine.active.set(id,value);engine.tokens.set(value.token,value);return value;};
 const seed=id=>broker.phoneFailure(id,frameError());
 t.after(()=>{engine.active.clear();engine.tokens.clear();engine.groups.close();store.close();fs.rmSync(dir,{recursive:true,force:true});});
 return {store,broker,engine,phone,make,active,seed,captures:()=>captures,available:()=>{unavailable=false;},advance:ms=>{at+=ms;}};
}
function denied(f,active){
 assert.throws(()=>f.engine.authorizeRuntime(active),{code:'runtime_unauthorized'});
 assert.equal(active.controller.signal.aborted,true);assert.equal(f.engine.tokens.has(active.token),false);
}

test('Engine and Broker keep FRAME_UNAVAILABLE recovery readable beyond four requests, then return a fresh observation',async t=>{
 const f=fixture(t),task=f.make(),active=f.active(task.id),deadline=task.deadlineAt;
 const feedback=decode(f.seed(task.id))[0];assert.equal(feedback.code,'phoneuse_error');assert.equal(feedback.attempts,1);assert.equal(feedback.recoverable,true);
 const start=f.store.task(task.id).phoneRecovery.startRequests;
 for(let request=1;request<=6;request++){
  f.store.updateTask(task.id,row=>row.requests=start+request);
  assert.equal(f.engine.authorizeRuntime(active),active);
  const result=decode(await f.broker.execute(task.id,'phone_use',{action:'read'},active.controller.signal));
  assert.equal(result[0].failureCode,'FRAME_UNAVAILABLE');assert.equal(result[0].stability,'uncertain');
  assert.equal(f.store.task(task.id).status,'running');assert.equal(active.controller.signal.aborted,false);
 }
 assert.equal(f.captures(),6);assert.equal(f.store.task(task.id).report,null);
 f.available();assert.equal(f.engine.authorizeRuntime(active),active);
 const recovered=decode(await f.broker.execute(task.id,'phone_use',{action:'read'},active.controller.signal));
 assert.equal(recovered[0].stability,'fresh');assert.match(recovered[0].observationId,/^screen-/);
 assert.equal(f.store.task(task.id).status,'running');assert.equal(f.store.task(task.id).deadlineAt,deadline);
 assert.equal(f.store.task(task.id).phoneRecovery.code,'phoneuse_error','a successful read does not silently erase unrelated recovery semantics');
 assert.equal(f.store.data.actions.length,0,'reads do not navigate or replay an action');
 assert.equal(f.engine.tokens.get(active.token),active);
});

test('recovery diagnostics never resume blocked, paused or unknown-result tasks',async t=>{
 for(const status of ['blocked','paused','unknown_result'])await t.test(status,async t=>{
  const f=fixture(t),task=f.make(),active=f.active(task.id);f.seed(task.id);
  f.store.updateTask(task.id,row=>{row.requests+=10;row.status=status;});
  denied(f,active);await assert.rejects(f.broker.execute(task.id,'phone_use',{action:'read'}),/任务当前不能执行工具/);
  assert.equal(f.captures(),0);assert.equal(f.store.task(task.id).status,status);
 });
});

test('recovery keeps cloud consent, device control epoch, deadline and recovery-fence runtime checks',async t=>{
 const cases={
  cloud_consent:f=>f.store.updateTask(f.id,row=>row.cloudConsent=false),
  device_paused:f=>{f.engine.remoteControlState=()=>({paused:true,controlEpoch:7});},
  device_epoch:f=>{f.engine.remoteControlState=()=>({paused:false,controlEpoch:8});},
  deadline:f=>f.advance(121000),
  recovery_fence:f=>f.store.transaction(s=>s.recoveryFence={required:true})
 };
 for(const [name,change]of Object.entries(cases))await t.test(name,t=>{
  const f=fixture(t),task=f.make({remoteDeviceId:DEVICE,remoteControlEpoch:7}),active=f.active(task.id);f.id=task.id;
  f.engine.remoteControlState=()=>({paused:false,controlEpoch:7});f.seed(task.id);f.store.updateTask(task.id,row=>row.requests+=10);
  assert.equal(f.engine.authorizeRuntime(active),active);change(f);denied(f,active);assert.equal(f.captures(),0);
 });
});

test('phone execution revocation stops recovery and re-enabling never resumes it',async t=>{
 const f=fixture(t),task=f.make(),active=f.active(task.id);f.seed(task.id);
 f.store.updateTask(task.id,row=>{row.requests+=10;row.executionDomains=['phone'];});
 assert.equal(f.engine.authorizeRuntime(active),active);
 await setExecutionPermissions({store:f.store,engine:f.engine}, {phoneEnabled:false});
 assert.equal(f.store.task(task.id).status,'paused');denied(f,active);
 await assert.rejects(f.broker.execute(task.id,'phone_use',{action:'read'}),{code:'execution_disabled',dispatchState:'not_sent'});
 await setExecutionPermissions({store:f.store,engine:f.engine}, {phoneEnabled:true});
 await assert.rejects(f.broker.execute(task.id,'phone_use',{action:'read'}),/任务当前不能执行工具/);
 assert.equal(f.store.task(task.id).status,'paused');assert.equal(f.captures(),0);
});

test('parent revocation still denies a recovering child before reading the device',async t=>{
 const f=fixture(t),parent=f.make(),child=f.engine.create(deriveDelegation(parent,{prompt:'打开设置查看电池',roleId:'life'},f.store));
 f.store.updateTask(child.id,row=>row.status='running');const active=f.active(child.id);f.seed(child.id);f.store.updateTask(child.id,row=>row.requests+=10);
 assert.equal(f.engine.authorizeRuntime(active),active);f.store.updateTask(parent.id,row=>row.status='paused');
 denied(f,active);await assert.rejects(f.broker.execute(child.id,'phone_status',{}),{code:'delegation_not_authorized'});assert.equal(f.captures(),0);
});

test('unresolved action receipts still block new effects and cannot be resumed as recovery',async t=>{
 const f=fixture(t),task=f.make(),active=f.active(task.id);f.seed(task.id);
 f.store.updateTask(task.id,(row,s)=>{row.requests+=10;s.actions.push({id:'unknown-original',taskId:task.id,tool:'phone_use',status:'unknown'});});
 assert.equal(f.engine.authorizeRuntime(active),active);
 await assert.rejects(f.broker.execute(task.id,'phone_use',{action:'tap',target:'电池'},active.controller.signal),{code:'outcome_unknown'});
 assert.equal(f.store.task(task.id).status,'unknown_result');denied(f,active);
 await assert.rejects(f.engine.continue(task.id,{}),/核实原操作结果/);
 assert.equal(f.captures(),0);assert.equal(f.store.data.actions.length,1);assert.equal(f.store.data.actions[0].status,'unknown');assert.equal(f.store.data.actions[0].resolution,undefined);
});
