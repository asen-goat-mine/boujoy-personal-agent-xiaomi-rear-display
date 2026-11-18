import {ANDROID_PACKAGE} from '../src/distribution.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/core/store.mjs';
import {createTaskContract,initializeTimeline} from '../src/core/task-contract.mjs';
import {WorkflowLibrary} from '../src/core/workflows.mjs';
import {Demonstrations,demonstrationPage} from '../src/remote/demonstration.mjs';

const page=(label='搜索')=>({device_id:'phone-fixture',package_name:'com.example.fixture',captured_at_ms:Date.now(),observation_status:'complete',screenshot:null,tree:{available:true,elements:[{element_id:'0',class:'android.widget.Button',view_id:'com.example.fixture:id/search',actions:['tap'],text:label,bounds:[0,0,100,100]},{element_id:'0.1',class:'android.widget.EditText',view_id:'com.example.fixture:id/entry',actions:['set_text'],editable:true,text:'private-input-not-for-memory',hint:'user secret',bounds:[0,100,100,200]}]}});
async function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'boujoy-demo-')),store=new Store(dir,{lock:false});t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});const device={id:randomUUID(),active:true},fp='fixture-cert',state={data:{control:{controlEpoch:9,paused:true}},device:value=>value===fp&&device.active?device:null};
 const prompt='在京东搜索牛肉面',task={id:randomUUID(),source:'user',roleId:'work',status:'running',prompt,messages:[{id:randomUUID(),role:'user',content:prompt}],cloudConsent:true};initializeTimeline(task,{budgetMs:60000});task.taskContract=createTaskContract(task);store.transaction(s=>{s.tasks.push(task);s.settings.phoneEnabled=true;s.settings.phoneUseDeviceId='phone-fixture';});
 const workflows=new WorkflowLibrary({store,dataDir:dir,root:path.join(dir,'workflow-library')}),client={active:new Map(),count:0,raw:page(),async observeForDemo(id,{lease}){assert.equal(this.demoLeaseGuard(lease,id),true);this.count++;return {...this.raw,captured_at_ms:Date.now()};}},phone={lease:null,phoneUse:{client}},engine={broker:{workflows},async stop(){store.updateTask(task.id,t=>t.status='paused');}};
 const demo=new Demonstrations({state,store,engine,phone,intervalMs:100000});t.after(()=>demo.close());return {dir,store,get task(){return store.task(task.id);},device,fp,state,client,phone,engine,workflows,demo};
}
const settle=()=>new Promise(r=>setImmediate(r));
test('user-started bounded page changes create a real Markdown draft without raw input, screenshots or invented clicks',async t=>{
 const x=await fixture(t),session=await x.demo.start(x.task.id,x.device,x.fp,9);await settle();assert.equal(x.client.count,1);assert.equal(x.task.status,'paused');assert.equal(x.demo.summary(x.device).pageCount,1);
 x.client.raw=page('下一步');await x.demo.sample();await x.demo.sample();assert.equal(x.demo.summary(x.device).pageCount,2);const result=await x.demo.finish('user_stopped',x.device,session.id);assert.equal(result.status,'draft_created');
 const draft=x.workflows.read(result.draftId);assert.equal(draft.status,'draft');assert.equal(draft.demonstration.actionsRecorded,false);assert.equal(draft.demonstration.authorization,false);assert.equal(draft.demonstration.observations.length,2);assert.equal(JSON.stringify(draft).includes('private-input-not-for-memory'),false);assert.equal(JSON.stringify(draft).includes('user secret'),false);assert.equal(x.demo.valid({},'phone-fixture'),false);const before=x.client.count;await x.demo.sample();assert.equal(x.client.count,before);
});
test('credential boundary, source changes, epoch and disconnect stop sampling without resuming the Agent',async t=>{
 const x=await fixture(t);await x.demo.start(x.task.id,x.device,x.fp,9);await settle();x.client.raw=page('支付密码');await x.demo.sample();assert.equal(x.demo.last.stopReason,'sensitive_screen');assert.equal(x.demo.active,null);assert.equal(x.state.data.control.paused,true);
 x.client.raw=page();await x.demo.start(x.task.id,x.device,x.fp,9);await settle();const before=x.client.count;x.state.data.control.controlEpoch++;x.demo.invalidateChanged();await settle();await x.demo.sample();assert.equal(x.client.count,before);assert.equal(x.demo.last.stopReason,'epoch_changed');
 await x.demo.start(x.task.id,x.device,x.fp,10);await settle();x.demo.disconnect();await settle();assert.equal(x.demo.last.stopReason,'disconnected');assert.equal(x.demo.active,null);
 await x.demo.start(x.task.id,x.device,x.fp,10);await settle();x.task.messages[0].content='changed';x.demo.invalidateChanged();await settle();assert.equal(x.demo.last.draftId,undefined);assert.equal(x.demo.active,null);
});
test('a running phone action and unpaused phone cannot begin demonstration and tree validation rejects unverifiable pages',async t=>{
 const x=await fixture(t);x.phone.lease='other';await assert.rejects(x.demo.start(x.task.id,x.device,x.fp,9));assert.equal(x.client.count,0);x.phone.lease=null;x.state.data.control.paused=false;await assert.rejects(x.demo.start(x.task.id,x.device,x.fp,9));
 assert.throws(()=>demonstrationPage({...page(),screenshot:{available:true}}));assert.throws(()=>demonstrationPage({...page(),captured_at_ms:1}));assert.throws(()=>demonstrationPage({...page(),observation_status:'partial'}));
});

test('disabled domains prevent demonstration and off/on permanently ends its old sampling lease',async t=>{
 for(const domain of ['phone','files']){
  const x=await fixture(t);x.store.transaction(s=>s.settings[domain+'Enabled']=false);await assert.rejects(x.demo.start(x.task.id,x.device,x.fp,9),{code:'execution_disabled'});assert.equal(x.client.count,0);x.store.transaction(s=>s.settings[domain+'Enabled']=true);
  await x.demo.start(x.task.id,x.device,x.fp,9);await settle();assert.equal(x.client.count,1);
  x.store.transaction(s=>{s.settings[domain+'Enabled']=false;s.settings.executionEpochs[domain]++;});x.store.transaction(s=>{s.settings[domain+'Enabled']=true;s.settings.executionEpochs[domain]++;});await x.demo.sample();
  assert.equal(x.client.count,1);assert.equal(x.demo.active,null);assert.equal(x.demo.last.error,'execution_revoked');assert.equal(x.demo.last.draftId,undefined);assert.equal(x.task.status,'paused');
 }
});


test('a changing clock cannot make the two-minute demonstration grant exceed its verifier limit',async t=>{
 const x=await fixture(t);let tick=Date.now();x.demo.clock=()=>tick++;const session=await x.demo.start(x.task.id,x.device,x.fp,9);assert.equal(Date.parse(session.expiresAt)-Date.parse(session.startedAt),120000);await settle();const result=await x.demo.finish('user_stopped',x.device,session.id);assert.equal(result.status,'draft_created');
});


test('demonstration never records the current edition chat or Phone Use controller',async t=>{
 const x=await fixture(t);x.client.raw={...page(),package_name:ANDROID_PACKAGE};
 await x.demo.start(x.task.id,x.device,x.fp,9);await settle();assert.equal(x.demo.summary(x.device).pageCount,0);
 x.client.raw={...page(),package_name:'ai.nidhoggfgg.phoneuse'};await x.demo.sample();assert.equal(x.demo.summary(x.device).pageCount,0);
 x.client.raw=page();await x.demo.sample();assert.equal(x.demo.summary(x.device).pageCount,1);
});
