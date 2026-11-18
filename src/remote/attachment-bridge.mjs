import {randomUUID,randomBytes} from 'node:crypto';
import {requireValue} from '../core/errors.mjs';
import {validateAttachmentAuthorization,readAttachmentPayload} from '../core/attachment-contract.mjs';
import {hash} from './protocol.mjs';

/** Task-scoped, memory-only transfer tickets. A restart invalidates every ticket. */
export class AttachmentBridge {
 constructor({state,store,dataDir,clock=Date.now}){Object.assign(this,{state,store,dataDir,clock});this.jobs=new Map();this.requests=new Map();this.closed=false;}
 guard(job,device){
  requireValue(!this.closed&&job&&!job.invalidated&&Date.parse(job.expiresAt)>this.clock(),'附件交接已失效','attachment_expired');
  const bound=Object.values(this.state.data.devices).find(d=>d.id===job.deviceId&&d.active);
  requireValue(bound&&(!device||device.id===job.deviceId)&&!this.state.data.control.paused&&this.state.data.control.controlEpoch===job.controlEpoch,'手机已接管或连接授权已变化','attachment_expired');
  const task=this.store.task(job.taskId);requireValue(!task.remoteDeviceId||task.remoteDeviceId===job.deviceId,'附件设备不匹配','attachment_not_authorized');
  requireValue(task.remoteControlEpoch===undefined||task.remoteControlEpoch===job.controlEpoch,'任务属于旧控制代际','attachment_expired');
  requireValue(['phone','files'].every(domain=>job.executionEpochs?.[domain]===(this.store.data.settings.executionEpochs?.[domain]||0)),'附件交接属于已撤销的执行权限，重新开启不会恢复旧交接','attachment_expired');
  validateAttachmentAuthorization({task,store:this.store,artifactId:job.artifactId,targetPackage:job.targetPackage,authorization:job.authorization,at:this.clock()});return task;
 }
 view(job){return Object.fromEntries(['jobId','status','artifactId','taskId','deviceId','controlEpoch','expiresAt','name','mime','size','sha256','targetPackage','targetLabel','buttonText','dispatchAttemptId','dispatchedAt','contentOpenedByTargetAt','failure'].filter(k=>job[k]!==undefined).map(k=>[k,job[k]]));}
 async prepareShare(input){
  const task=this.store.task(input.taskId),plan=validateAttachmentAuthorization({task,store:this.store,artifactId:input.artifactId,targetPackage:input.targetPackage,authorization:input.authorization,at:this.clock()});
  requireValue(typeof input.requestId==='string'&&/^[\w-]{1,128}$/.test(input.requestId),'附件请求编号无效');
  const digest=hash(JSON.stringify({taskId:input.taskId,artifactId:input.artifactId,targetPackage:input.targetPackage,authorization:plan})),prior=this.requests.get(input.requestId);
  if(prior){requireValue(prior.digest===digest,'不能复用编号发送不同附件');return this.shareStatus(prior.jobId);}
  const sameAuthorization=[...this.jobs.values()].find(j=>j.taskId===input.taskId&&j.artifactId===input.artifactId&&j.authorization.contractId===plan.contractId&&j.authorization.contractRevision===plan.contractRevision);if(sameAuthorization){this.requests.set(input.requestId,{digest,jobId:sameAuthorization.jobId});return this.shareStatus(sameAuthorization.jobId);}
  const devices=Object.values(this.state.data.devices).filter(d=>d.active&&(!task.remoteDeviceId||d.id===task.remoteDeviceId));requireValue(devices.length===1,'没有唯一已绑定手机','attachment_device_unavailable');
  const jobId=randomUUID(),job={jobId,status:'queued',taskId:task.id,deviceId:devices[0].id,artifactId:input.artifactId,controlEpoch:this.state.data.control.controlEpoch,executionEpochs:Object.fromEntries(['phone','files'].map(domain=>[domain,this.store.data.settings.executionEpochs?.[domain]||0])),expiresAt:new Date(Math.min(Date.parse(plan.expiresAt),this.clock()+90000)).toISOString(),...plan.artifact,targetPackage:input.targetPackage,targetLabel:plan.app,buttonText:'准备附件 '+jobId.slice(0,8),ticket:randomBytes(32).toString('base64url'),authorization:plan};
  delete job.id;this.guard(job);requireValue(![...this.jobs.values()].some(j=>!j.invalidated&&j.deviceId===job.deviceId&&Date.parse(j.expiresAt)>this.clock()&&!['failed','intent_dispatched'].includes(j.status)),'手机仍有附件交接待核实','attachment_busy');
  await readAttachmentPayload(task,{store:this.store,artifactId:input.artifactId,dataDir:this.dataDir,at:this.clock()});this.guard(job);
  // Payload validation awaits disk IO. A concurrent request may already have
  // reserved this authorization; never issue a second transfer ticket afterward.
  const lateRequest=this.requests.get(input.requestId);if(lateRequest){requireValue(lateRequest.digest===digest,'不能复用编号发送不同附件');return this.shareStatus(lateRequest.jobId);}
  const lateAuthorization=[...this.jobs.values()].find(j=>j.taskId===input.taskId&&j.artifactId===input.artifactId&&j.authorization.contractId===plan.contractId&&j.authorization.contractRevision===plan.contractRevision);
  if(lateAuthorization){this.requests.set(input.requestId,{digest,jobId:lateAuthorization.jobId});return this.shareStatus(lateAuthorization.jobId);}
  requireValue(![...this.jobs.values()].some(j=>!j.invalidated&&j.deviceId===job.deviceId&&Date.parse(j.expiresAt)>this.clock()&&!['failed','intent_dispatched'].includes(j.status)),'手机仍有附件交接待核实','attachment_busy');
  this.jobs.set(jobId,job);this.requests.set(input.requestId,{digest,jobId});return this.view(job);
 }
 shareStatus(id){const job=this.jobs.get(id);requireValue(job,'附件交接不存在');try{this.guard(job);}catch{job.invalidated=true;}return {...this.view(job),...(job.invalidated?{status:job.dispatchAttemptId?'unknown_result':'expired',lastKnownStatus:job.status,authorizationExpired:true,requiresReconciliation:!!job.dispatchAttemptId}:{})};}
 next(device){for(const job of [...this.jobs.values()].sort((a,b)=>(a.status==='intent_dispatched')-(b.status==='intent_dispatched'))){try{this.guard(job,device);if(['queued','prepared','dispatching','intent_dispatched'].includes(job.status))return {...this.view(job),ticket:job.ticket};}catch{}}return null;}
 async bytes(id,device){const job=this.jobs.get(id),task=this.guard(job,device);const result=await readAttachmentPayload(task,{store:this.store,artifactId:job.artifactId,dataDir:this.dataDir,at:this.clock()});this.guard(job,device);return {job:this.view(job),bytes:result.bytes};}
 receipt(id,device,input){
  const job=this.jobs.get(id);this.guard(job,device);requireValue(input.ticket===job.ticket&&input.controlEpoch===job.controlEpoch&&input.sha256===job.sha256,'附件回执身份不匹配');
  const next=input.status;
  if(next==='prepared'){requireValue(['queued','prepared'].includes(job.status),'附件不能重新准备');job.status=next;}
  else if(next==='dispatching'){
   requireValue(typeof input.dispatchAttemptId==='string'&&/^[\w-]{1,128}$/.test(input.dispatchAttemptId),'附件分发编号无效');
   requireValue(job.status==='prepared'||job.status==='dispatching'&&job.dispatchAttemptId===input.dispatchAttemptId,'附件分发已开始，不能重放','attachment_unknown');job.status=next;job.dispatchAttemptId=input.dispatchAttemptId;
  }else if(next==='intent_dispatched'){
   requireValue(['dispatching','intent_dispatched'].includes(job.status)&&input.dispatchAttemptId===job.dispatchAttemptId,'附件分发编号不匹配');job.status=next;job.dispatchedAt||=new Date(this.clock()).toISOString();
  }else if(next==='content_opened'){
   requireValue(['dispatching','intent_dispatched'].includes(job.status)&&input.dispatchAttemptId===job.dispatchAttemptId&&input.targetPackage===job.targetPackage,'附件读取目标不匹配');job.contentOpenedByTargetAt||=new Date(this.clock()).toISOString();
  }else if(next==='failed'){job.status='failed';job.failure=String(input.failure||'attachment_dispatch_failed').slice(0,150);}
  else requireValue(false,'不支持的附件状态');return this.view(job);
 }
 invalidateAll(){for(const job of this.jobs.values())job.invalidated=true;}
 close(){this.closed=true;this.invalidateAll();}
}
