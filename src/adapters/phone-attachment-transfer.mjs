import {ANDROID_PACKAGE} from '../distribution.mjs';
import {verifyOutboundDraft} from './phone-outbound.mjs';
import {randomUUID} from 'node:crypto';
import {attachmentPlan,readAttachmentPayload,validateAttachmentAuthorization} from '../core/attachment-contract.mjs';
import {verifyAttachmentDraft} from './phone-attachment.mjs';
import {phoneUseGrant,phoneUseCanObserve} from './phone-use.mjs';
import {effectNodes} from './phone-effects.mjs';
import {requireValue,AppError,now} from '../core/errors.mjs';

const BRIDGE=ANDROID_PACKAGE;
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function nativeState(tree){for(const item of tree?.content||[])try{const state=JSON.parse(item.text)?.result;if(state?.tree)return state;}catch{}return null;}
// This entry only transports an already-authorized artifact to a foreground
// draft. Android intent acknowledgement is never evidence that a file was sent.
export async function preparePhoneAttachment({phone,store,taskId,artifactId,dataDir,signal,statusOnly=false}){
 requireValue(phone.isPhoneUse()&&phone.remoteAttachments,'附件传输需要已连接的 Boujoy 手机桥','attachment_bridge_unavailable');
 phone.acquire(taskId);
 const task=()=>store.task(taskId);let plan=attachmentPlan(task(),{store,artifactId});
 const scope=()=>phoneUseGrant(task(),task().phoneUseScope||{},{store});
 let grant=scope();requireValue(['send_attachment','send_mail','publish_media'].includes(grant?.effectPlan?.kind),'请先打开授权应用并进入指定收件人的空白会话','attachment_composer_required');
 validateAttachmentAuthorization({task:task(),store,artifactId:plan.artifact.id,targetPackage:grant.packageName,authorization:plan});
 const guard=()=>{phone.assertRemoteAvailable();if(signal?.aborted)throw new AppError('cancelled','附件准备已停止',409);requireValue(same(plan,attachmentPlan(task(),{store,artifactId:plan.artifact.id})),'附件授权已变化','attachment_not_authorized');};
 const capture=async()=>{guard();const frame=await phone.phoneUse.capture(phone.phoneUseDevice(),{mode:'tree',signal,timeout:6000});guard();return {...frame,id:randomUUID(),taskId,at:Date.now(),stability:'fresh',stabilityScope:'phone_use'};};
 const verifyDraft=(observation,binding,options)=>['send_mail','publish_media'].includes(binding?.effectPlan?.kind)?verifyOutboundDraft(observation,binding,options):verifyAttachmentDraft(observation,binding,options);
 const save=value=>store.updateTask(taskId,t=>{t.phoneAttachment={...t.phoneAttachment,...value};});
 const refresh=async()=>{guard();const before=task().phoneAttachment;requireValue(before?.jobId,'没有本任务附件传输','attachment_job_missing');const received=await phone.remoteAttachments.shareStatus(before.jobId);guard();requireValue(received.jobId===before.jobId&&received.taskId===taskId&&received.sha256===plan.artifact.sha256&&received.name===plan.artifact.name&&received.size===plan.artifact.size&&received.mime===plan.artifact.mime&&received.targetPackage===grant.packageName,'附件桥回执与本次授权不一致','attachment_receipt_mismatch');save(received);return task().phoneAttachment;};
 const report=async()=>{
  const transfer=await refresh();grant=scope();
  if(transfer.status!=='intent_dispatched')return {status:transfer.status,jobId:transfer.jobId,sent:false,draftVerified:false,requiresUser:!!transfer.launchAttemptedAt||!!transfer.dispatchAttemptedAt};
  store.updateTask(taskId,t=>{t.phoneUseScope=grant;});const observed=await capture();const verified=verifyDraft(observed,grant);
  if(!verified.verified){const readable=phoneUseCanObserve(taskId,observed.tree,grant);const observation=readable?await phone.observeUse(taskId,grant,{signal}):null;guard();return {status:'intent_dispatched',jobId:transfer.jobId,sent:false,draftVerified:false,reason:verified.reason,requiresUser:!readable,...(observation?{observation}:{})};}
  save({draftVerified:true,draftEvidence:verified});
  const observation=await phone.observeUse(taskId,grant,{signal});guard();return {status:'draft_ready',jobId:transfer.jobId,sent:false,draftVerified:true,artifactId:plan.artifact.id,recipient:plan.recipient||plan.account,observation};
 };
 // Queue creation only writes an idempotent transfer ticket. If its reply was
 // lost before a job ID was persisted, recover that same ticket; never recreate
 // a launch or dispatch, and recheck the file and current empty composer first.
 if(task().phoneAttachment&&!task().phoneAttachment.jobId&&!statusOnly){
  const prior=task().phoneAttachment;requireValue(prior.status==='queueing'&&prior.requestId&&!prior.launchAttemptedAt&&!prior.dispatchAttemptedAt&&prior.artifactId===plan.artifact.id&&prior.contractId===plan.contractId&&prior.contractRevision===plan.contractRevision,'附件交接记录不完整，需要核实原请求','attachment_already_attempted');
  const read=await readAttachmentPayload(task(),{store,artifactId:plan.artifact.id,dataDir});guard();requireValue(same(read.plan,plan),'附件授权发生变化','attachment_not_authorized');const initial=await capture(),empty=verifyDraft(initial,grant,{allowEmpty:true});requireValue(empty.verified,'指定草稿已经变化','attachment_composer_required');save({emptyDraft:empty});
  const recovered=await phone.remoteAttachments.prepareShare({taskId,artifactId:plan.artifact.id,targetPackage:grant.packageName,targetLabel:plan.app,requestId:prior.requestId,authorization:plan});guard();requireValue(recovered.taskId===taskId&&recovered.sha256===plan.artifact.sha256&&recovered.targetPackage===grant.packageName,'附件桥返回错误绑定','attachment_receipt_mismatch');save(recovered);
 }
 if(task().phoneAttachment){
  const existing=task().phoneAttachment;requireValue(existing.artifactId===plan.artifact.id&&existing.contractId===plan.contractId&&existing.contractRevision===plan.contractRevision,'已有附件任务不能被另一份文件替换','attachment_already_attempted');
  if(statusOnly||existing.launchAttemptedAt||existing.dispatchAttemptedAt)return report();
 }else{
  requireValue(!statusOnly,'没有本任务附件传输','attachment_job_missing');
  const {plan:readPlan}=await readAttachmentPayload(task(),{store,artifactId:plan.artifact.id,dataDir});guard();requireValue(same(plan,readPlan),'附件授权发生变化','attachment_not_authorized');
  const initial=await capture(),empty=verifyDraft(initial,grant,{allowEmpty:true});requireValue(empty.verified,'指定会话必须有空白输入框且没有其他附件','attachment_composer_required');
  const requestId=randomUUID();save({requestId,artifactId:plan.artifact.id,sourceMessageId:plan.sourceMessageId,contractId:plan.contractId,contractRevision:plan.contractRevision,emptyDraft:empty,status:'queueing'});
  const result=await phone.remoteAttachments.prepareShare({taskId,artifactId:plan.artifact.id,targetPackage:grant.packageName,targetLabel:plan.app,requestId,authorization:plan});guard();
  requireValue(result.taskId===taskId&&result.sha256===plan.artifact.sha256&&result.targetPackage===grant.packageName,'附件桥返回错误绑定','attachment_receipt_mismatch');save(result);
 }
 let transfer=await refresh();
 if(transfer.status!=='prepared')return {status:transfer.status,jobId:transfer.jobId,sent:false,draftVerified:false};
 // A queued job may outlive its initial empty composer. Re-read immediately
 // before launching the bridge, and never reuse an unrelated foreground.
 const initial=await capture(),empty=verifyDraft(initial,scope(),{allowEmpty:true});requireValue(empty.verified,'指定会话已变化，请重新核实空白草稿','attachment_composer_required');save({emptyDraft:empty});
 await phone.resolveApp(BRIDGE);guard();
 const attempt=async(kind,run)=>{
  guard();const id=randomUUID();store.updateTask(taskId,(t,s)=>{t.phoneAttachment[kind==='launch'?'launchAttemptedAt':'dispatchAttemptedAt']=now();s.actions.push({id,taskId,tool:'phone_attachment_'+kind,status:'executing',startedAt:now(),contractId:plan.contractId,contractRevision:plan.contractRevision,jobId:transfer.jobId,executionStatus:'not_dispatched',verification:'pending'});});
  try{const result=await run(id);guard();store.transaction(s=>{const row=s.actions.find(a=>a.id===id);row.status='completed';row.executionStatus='accepted';row.finishedAt=now();});return result;}
  catch(error){store.updateTask(taskId,(t,s)=>{const row=s.actions.find(a=>a.id===id);row.status=error.dispatchState==='not_sent'?'not_executed':'unknown';row.finishedAt=now();if(error.requestId)row.nativeRequestId=error.requestId;if(row.status==='unknown'){t.status='unknown_result';t.blockedReason='附件传输动作结果不明，保留原请求，只能核实，不能再次分享。';}});throw error;}
 };
 phone.observation=null;phone.actionBaseline=null;
 await attempt('launch',()=>phone.openPackage(taskId,BRIDGE,{signal}));
 const bridge=await capture(),state=nativeState(bridge.tree);requireValue(state?.windowPkg===BRIDGE&&state.display==='main','尚未核实本任务附件桥页面','attachment_bridge_not_visible');
 const nodes=effectNodes(state.tree),labels=nodes.flatMap(n=>n.values.flatMap(v=>v.split(/\n|\\n/)));
 requireValue(labels.includes('附件任务：'+transfer.jobId)&&labels.includes(plan.artifact.name)&&labels.some(v=>v===plan.app||v==='目标应用：'+plan.app||v==='目标 App：'+plan.app)&&!nodes.some(n=>n.secret),'附件桥页面的任务、文件或应用不一致','attachment_bridge_not_visible');
 const controls=nodes.filter(n=>n.clickable&&n.values.includes(transfer.buttonText));requireValue(controls.length===1,'没有唯一的本任务附件准备按钮','attachment_bridge_not_visible');
 const b=controls[0].bounds,point={x:Math.floor((b[0]+b[2])/2),y:Math.floor((b[1]+b[3])/2)};
 await attempt('dispatch',id=>phone.phoneUse.call(phone.phoneUseDevice(),'tap',point,8000,{signal,native:bridge.native,requestId:id}));
 // Read-only receipt reconciliation: never press the bridge twice.
 transfer=await refresh();
 for(let i=0;i<4&&transfer.status==='dispatching';i++){await phone.wait(150);guard();transfer=await refresh();}
 return report();
}
