import {effectIdentity,effectPlan} from './phone-effects.mjs';
import {nativeWindowConflict} from './phone-window-identity.mjs';
import {requestHash} from '../core/task-contract.mjs';
import {normalizePhoneUseObservation,mapPhoneUseOcr} from './phoneuse-state.mjs';

const exact=(a,b)=>typeof a==='string'&&a===b;
export function inputVerificationTarget(task,action){
 const scope=task?.phoneUseScope,plan=effectPlan(task?.taskContract),witness=action?.phoneEffect?.witness;
 if(task?.status!=='unknown_result'||action?.taskId!==task.id||action.status!=='unknown'||action.resolution||action.tool!=='phone_action'||action.phoneOperation!=='type'||action.phoneEffect?.kind!=='effect_message_input'||!action.nativeRequestId||!scope||scope.mode!=='general'||plan?.kind!=='send'||!plan.content||scope.effectPlan?.kind!=='send')return null;
 if(!exact(plan.content,scope.effectPlan.content)||!exact(plan.recipient,scope.effectPlan.recipient)||witness?.contractId!==task.taskContract.id||witness.contractRevision!==task.taskContract.revision||witness.effectKey!==effectIdentity(scope)||action.phoneEffect.packageName!==scope.packageName)return null;
 return {scope,plan,referenceId:action.nativeRequestId};
}
// This capability is internal to an explicit unknown-input reconciliation.
// A caller of the phone RPC cannot supply a tool, observation arguments, URL,
// or callback in its place. Only two successful capture attempts are admitted.
const leases=new WeakMap();
export const INPUT_PROOF_FRAME=Object.freeze({mode:'both',output:'legacy',compact:false,include_details:true,diagnostics:true,max_dimension:1440,stable_wait_ms:0,max_attempts:1,timeout_ms:2000});

export function claimInputRecoveryFrame(lease,client,deviceId){
 const row=leases.get(lease);
 if(!row||row.client!==client||row.deviceId!==deviceId||row.remaining<1||!row.live())return null;
 row.remaining--;
 return ()=>leases.get(lease)===row&&row.live();
}

export function beginInputRecoveryCapture({phone,task,action,target,client,deviceId,instance,epoch,signal}){
 const store=phone.store,initial=phone.remoteDeviceTelemetry?.(),fingerprint=initial?.certificateFingerprint;
 if(!store?.data||!task.remoteDeviceId||task.remoteControlEpoch===epoch||!fingerprint||!initial.fresh||initial.deviceId!==task.remoteDeviceId||typeof client.observeForInputVerification!=='function')return null;
 const expiresAt=Date.now()+45000,originalEpoch=task.remoteControlEpoch,binding=task.remoteDeviceId;
 const contractId=task.taskContract.id,revision=task.taskContract.revision,source=structuredClone(task.taskContract.source);
 const phonePermissionEpoch=store.data.settings.executionEpochs?.phone,lease={};
 const rpc=client.rpc,controlRpc=client.controlRpc,transport=client.remoteTransport,endMono=performance.now()+45000;
 function live(){
  const current=store.data.tasks.find(t=>t.id===task.id),original=store.data.actions.find(a=>a.id===action.id);
  const telemetry=phone.remoteDeviceTelemetry?.(),control=phone.remoteControlState?.();
  if(signal?.aborted||Date.now()>=expiresAt||performance.now()>=endMono||store.data.settings.phoneEnabled!==true||store.data.settings.executionEpochs?.phone!==phonePermissionEpoch||store.data.recoveryFence?.required||phone.remoteMaintenance)return false;
  if(phone.lease!==task.id||phone.phoneUseDevice()!==deviceId||phone.phoneUse?.client!==client||client.active?.size||control?.paused!==false||control.controlEpoch!==epoch)return false;
  if(client.closed||client.rpc!==rpc||client.controlRpc!==controlRpc||client.remoteTransport!==transport||rpc?.dead||controlRpc?.dead)return false;
  if(telemetry?.fresh!==true||telemetry.typingProtocol!==2||telemetry.deviceId!==binding||telemetry.certificateFingerprint!==fingerprint)return false;
  if(current?.source!=='user'||current.parentId||current.remoteDeviceId!==binding||current.remoteControlEpoch!==originalEpoch||source?.kind!=='user'||current.taskContract?.id!==contractId||current.taskContract.revision!==revision)return false;
  const sourceValid=(id,hash)=>current.messages?.some(m=>m.id===id&&m.role==='user'&&!m.interjection&&!m.externalContent&&!m.external_content&&requestHash(m.content)===hash);
  if(current.taskContract.source?.messageId!==source.messageId||current.taskContract.source.contentSha256!==source.contentSha256||!sourceValid(source.messageId,source.contentSha256))return false;
  if(source.originMessageId&&!sourceValid(source.originMessageId,source.originContentSha256))return false;
  const checked=inputVerificationTarget(current,original);
  return original?.nativeRequestId===target.referenceId&&checked?.referenceId===target.referenceId&&checked.plan.content===target.plan.content&&checked.plan.recipient===target.plan.recipient&&checked.scope.packageName===target.scope.packageName;
 }
 if(!live())return null;
 leases.set(lease,{client,deviceId,remaining:2,live});
 return {
  live,
  async page(){
   const raw=await client.observeForInputVerification(deviceId,{lease,signal});
   if(!live())return null;
   const frame=normalizePhoneUseObservation(raw,{requireTree:true,requireScreenshot:true});const n=frame.native;
   if(nativeWindowConflict(n)||n.treePartial||n.deviceId!==deviceId||n.serviceInstanceId!==instance||n.packageName!==target.scope.packageName||!n.observationId||n.elements.some(node=>node.password===true))return null;
   const ocr=mapPhoneUseOcr(await phone.recognize(frame.image),frame.mapping);
   if(!live())return null;
   // Never install this frame in the normal actionable observation cache.
   return {id:n.observationId,taskId:task.id,at:Date.now(),tree:frame.tree,native:n,ocr,isolatedInputProof:true};
  },
  close(){leases.delete(lease);}
 };
}

// On apps which export only an opaque accessibility root, require a whole,
// centered title and a separate complete draft beside its Send control. OCR
// here identifies the compose surface. Only IME readback can prove its text.
export function exactComposeSurface(page,target){
 const {width,height,lines}=page.ocr||{};
 if(!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0||!Array.isArray(lines))return false;
 const compact=value=>String(value||'').normalize('NFKC').replace(/\s+/g,'');
 const visible=lines.filter(line=>Array.isArray(line.bounds)&&line.bounds.length===4&&line.bounds.every(Number.isFinite)&&line.bounds[0]>=0&&line.bounds[1]>=0&&line.bounds[2]<=width+1&&line.bounds[3]<=height+1&&line.bounds[2]>line.bounds[0]&&line.bounds[3]>line.bounds[1]);
 const x=b=>(b[0]+b[2])/(2*width),y=b=>(b[1]+b[3])/(2*height);
 const headers=visible.filter(l=>l.text===target.plan.recipient&&x(l.bounds)>=.35&&x(l.bounds)<=.65&&y(l.bounds)>=.015&&y(l.bounds)<=.15&&(l.bounds[3]-l.bounds[1])/height<.08);
 const sends=visible.filter(l=>/^(?:发送|Send)$/.test(l.text)&&x(l.bounds)>.7&&y(l.bounds)>.36);
 if(headers.length!==1||sends.length!==1)return false;
 const send=sends[0].bounds;
 return visible.some(l=>compact(l.text)===compact(target.plan.content)&&l.bounds[2]<send[0]&&Math.abs(y(l.bounds)-y(send))<.035);
}
