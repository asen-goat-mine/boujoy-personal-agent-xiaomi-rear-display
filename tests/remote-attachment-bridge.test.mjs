import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/core/store.mjs';
import {createTaskContract,initializeTimeline} from '../src/core/task-contract.mjs';
import {attachmentPlan} from '../src/core/attachment-contract.mjs';
import {AttachmentBridge} from '../src/remote/attachment-bridge.mjs';
import {hash} from '../src/remote/protocol.mjs';

function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'boujoy-bridge-')),store=new Store(dir,{lock:false});store.transaction(s=>s.settings.phoneEnabled=true);t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
 const device={id:randomUUID(),active:true},state={data:{devices:{fingerprint:device},control:{controlEpoch:3,paused:false}}},prompt='把文件“报告.txt”通过微信发给张三';
 const task={id:randomUUID(),source:'user',roleId:'work',status:'running',prompt,messages:[{id:randomUUID(),role:'user',content:prompt}],cloudConsent:true,remoteDeviceId:device.id,remoteControlEpoch:3};initializeTimeline(task,{budgetMs:60000});task.taskContract=createTaskContract(task);
 const bytes=Buffer.from('only the exact current task artifact'),artifact={id:randomUUID(),taskId:task.id,name:'报告.txt',mime:'text/plain',size:bytes.length,sha256:hash(bytes),path:task.id+'/report.txt'};fs.mkdirSync(path.join(dir,'artifacts',task.id),{recursive:true});fs.writeFileSync(path.join(dir,'artifacts',artifact.path),bytes);store.transaction(s=>{s.tasks.push(task);s.artifacts.push(artifact);});
 const bridge=new AttachmentBridge({state,store,dataDir:dir}),input={taskId:task.id,artifactId:artifact.id,targetPackage:'com.tencent.mm',requestId:randomUUID(),authorization:attachmentPlan(task,{store})};return {bridge,state,store,task,device,input,artifact,dir,bytes};
}
test('transfer binds exact task bytes, device, recipient and source; same authorization cannot produce a second dispatch',async t=>{
 const x=fixture(t);await assert.rejects(x.bridge.prepareShare({...x.input,targetPackage:'com.whatsapp'}));await assert.rejects(x.bridge.prepareShare({...x.input,authorization:{...x.input.authorization,recipient:'李四'}}));
 const job=await x.bridge.prepareShare(x.input),issued=x.bridge.next(x.device);assert.equal(job.jobId,issued.jobId);assert.equal(job.artifactId,x.artifact.id);assert.deepEqual((await x.bridge.bytes(job.jobId,x.device)).bytes,x.bytes);await assert.rejects(x.bridge.bytes(job.jobId,{id:'wrong'}));
 const receipt={ticket:issued.ticket,sha256:job.sha256,controlEpoch:job.controlEpoch};assert.throws(()=>x.bridge.receipt(job.jobId,x.device,{...receipt,ticket:'wrong',status:'prepared'}));x.bridge.receipt(job.jobId,x.device,{...receipt,status:'prepared'});
 const attempt=randomUUID();x.bridge.receipt(job.jobId,x.device,{...receipt,status:'dispatching',dispatchAttemptId:attempt});assert.throws(()=>x.bridge.receipt(job.jobId,x.device,{...receipt,status:'dispatching',dispatchAttemptId:randomUUID()}));
 const dispatched=x.bridge.receipt(job.jobId,x.device,{...receipt,status:'intent_dispatched',dispatchAttemptId:attempt});assert.equal(dispatched.contentOpenedByTargetAt,undefined);assert.equal(dispatched.sent,undefined);
 const same=await x.bridge.prepareShare({...x.input,requestId:randomUUID()});assert.equal(same.jobId,job.jobId);assert.equal(same.status,'intent_dispatched');
 x.task.messages[0].content='换收件人';await assert.rejects(x.bridge.bytes(job.jobId,x.device));assert.equal(x.bridge.next(x.device),null);
});
test('changing bytes, stopping the task, a new epoch and revocation invalidate live file grants',async t=>{
 const x=fixture(t),job=await x.bridge.prepareShare(x.input);fs.writeFileSync(path.join(x.dir,'artifacts',x.artifact.path),Buffer.alloc(x.bytes.length));await assert.rejects(x.bridge.bytes(job.jobId,x.device));fs.writeFileSync(path.join(x.dir,'artifacts',x.artifact.path),x.bytes);
 x.task.status='paused';assert.equal(x.bridge.next(x.device),null);x.task.status='running';x.state.data.control.controlEpoch++;assert.equal(x.bridge.next(x.device),null);x.state.data.control.controlEpoch--;x.device.active=false;assert.equal(x.bridge.next(x.device),null);
});

test('phone and files off/on generations cannot revive a previously queued transfer ticket',async t=>{
 for(const domain of ['phone','files']){
  const x=fixture(t),job=await x.bridge.prepareShare(x.input),issued=x.bridge.next(x.device);
  x.store.transaction(s=>{s.settings[domain+'Enabled']=false;s.settings.executionEpochs[domain]++;});x.store.transaction(s=>{s.settings[domain+'Enabled']=true;s.settings.executionEpochs[domain]++;});
  assert.equal(x.bridge.next(x.device),null);await assert.rejects(x.bridge.bytes(job.jobId,x.device),{code:'attachment_expired'});
  assert.throws(()=>x.bridge.receipt(job.jobId,x.device,{ticket:issued.ticket,sha256:job.sha256,controlEpoch:job.controlEpoch,status:'prepared'}),{code:'attachment_expired'});
  const status=x.bridge.shareStatus(job.jobId);assert.equal(status.status,'expired');assert.equal(status.lastKnownStatus,'queued');assert.equal(status.requiresReconciliation,false);
  const retried=await x.bridge.prepareShare({...x.input,requestId:randomUUID()});assert.equal(retried.jobId,job.jobId);assert.equal(retried.status,'expired');assert.equal(x.bridge.jobs.size,1);
 }
});

test('revocation after dispatch reservation retains unknown receipt and never issues a replacement job',async t=>{
 const x=fixture(t),job=await x.bridge.prepareShare(x.input),issued=x.bridge.next(x.device),receipt={ticket:issued.ticket,sha256:job.sha256,controlEpoch:job.controlEpoch};
 x.bridge.receipt(job.jobId,x.device,{...receipt,status:'prepared'});const dispatchAttemptId=randomUUID();x.bridge.receipt(job.jobId,x.device,{...receipt,status:'dispatching',dispatchAttemptId});
 x.store.transaction(s=>{s.settings.filesEnabled=false;s.settings.executionEpochs.files++;});x.store.transaction(s=>{s.settings.filesEnabled=true;s.settings.executionEpochs.files++;});
 const status=x.bridge.shareStatus(job.jobId);assert.equal(status.status,'unknown_result');assert.equal(status.lastKnownStatus,'dispatching');assert.equal(status.dispatchAttemptId,dispatchAttemptId);assert.equal(status.requiresReconciliation,true);assert.equal(x.bridge.next(x.device),null);
 const again=await x.bridge.prepareShare({...x.input,requestId:randomUUID()});assert.equal(again.jobId,job.jobId);assert.equal(again.status,'unknown_result');assert.equal(x.bridge.jobs.size,1);
});

test('concurrent real disk validation still reserves one transfer for the same authorization',async t=>{
 const x=fixture(t),jobs=await Promise.all(Array.from({length:6},()=>x.bridge.prepareShare({...x.input,requestId:randomUUID()})));assert.equal(new Set(jobs.map(j=>j.jobId)).size,1);assert.equal(x.bridge.jobs.size,1);assert.equal(x.bridge.requests.size,6);
});
