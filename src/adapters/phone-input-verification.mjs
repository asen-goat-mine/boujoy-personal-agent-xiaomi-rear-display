import {effectIdentity,effectNodes} from './phone-effects.mjs';
import {nativeWindowConflict} from './phone-window-identity.mjs';
import {nativeState} from './phone-purchase-navigation.mjs';
import {beginInputRecoveryCapture,exactComposeSurface,inputVerificationTarget} from './input-recovery-capture.mjs';

export {inputVerificationTarget};
const verifyingPhones=new WeakSet();
function pageIdentity(page,task,target,deviceId,instance){
 const n=page?.native,state=nativeState(page),age=Date.now()-page?.at,nativeAge=Date.now()-page?.native?.at;
 if(nativeWindowConflict(n)||page?.taskId!==task.id||!page.id||!Number.isFinite(age)||age<0||age>10000||!Number.isFinite(nativeAge)||nativeAge< -1000||nativeAge>10000||n?.deviceId!==deviceId||n.serviceInstanceId!==instance||n.packageName!==target.scope.packageName||!Number.isSafeInteger(n.windowId)||state?.windowPkg!==target.scope.packageName||state.display!=='main')return null;
 const nodes=effectNodes(state.tree),height=page.ocr?.height||n.display?.height;
 if(nodes.some(node=>node.secret))return null;
 if(page.isolatedInputProof)return exactComposeSurface(page,target)?{windowId:n.windowId,observationId:n.observationId,nativeAt:n.at}:null;
 const header=nodes.some(node=>!node.editable&&node.bounds[1]<height*.22&&node.values.includes(target.plan.recipient))||(page.ocr?.lines||[]).some(line=>line.bounds?.[1]<height*.22&&line.text===target.plan.recipient);
 return header?{windowId:n.windowId,observationId:page.id}:null;
}

/** Only reads status, the actual page and the editor. Never calls an input/action tool. */
export async function verifyUnknownMessageInput({task,action,phone,signal}){
 const target=inputVerificationTarget(task,action),failure=reason=>({resolved:false,outcome:reason,actionId:action.id,requestId:action.nativeRequestId});
 if(!target)return failure('input_not_eligible');
 const telemetry=phone.remoteDeviceTelemetry?.();
 if(typeof phone.ime?.verify!=='function'||telemetry?.typingProtocol!==2||phone.isBackground?.())return failure('verification_not_supported');
 if(task.remoteDeviceId&&task.remoteDeviceId!==telemetry.deviceId)return failure('device_changed');
 const initial=phone.remoteControlState?.(),epoch=initial?.controlEpoch;
 const allowed=()=>!signal?.aborted&&phone.remoteControlState?.()?.paused===false&&phone.remoteControlState?.()?.controlEpoch===epoch&&!phone.remoteMaintenance&&(!task.remoteDeviceId||phone.remoteDeviceTelemetry?.()?.deviceId===task.remoteDeviceId);
 if(!Number.isSafeInteger(epoch)||initial.paused!==false||!allowed())return failure('control_changed');
 if(verifyingPhones.has(phone))return failure('request_in_flight');
 verifyingPhones.add(phone);let acquired=false,isolated;
 try{
  phone.acquire(task.id);acquired=true;
  const client=phone.phoneUse?.client,deviceId=phone.phoneUseDevice();
  if(!client||client.active?.size)return failure('request_in_flight');
  const before=await client.status(deviceId,{signal,timeout:8000});
  const idle=value=>value?.device_id===deviceId&&typeof value.service_instance_id==='string'&&value.service_instance_id.length>0&&value.executing_request_id===null&&(value.paused===undefined||value.paused===false)&&value.stopped===false;
  if(!allowed()||!idle(before))return failure('request_in_flight');
  if(task.remoteDeviceId&&task.remoteControlEpoch!==epoch){
   isolated=beginInputRecoveryCapture({phone,task,action,target,client,deviceId,instance:before.service_instance_id,epoch,signal});
   if(!isolated)return failure('read_only_capture_unavailable');
  }
  const stillAllowed=()=>allowed()&&(!isolated||isolated.live());
  const capture=async()=>{if(isolated)return isolated.page();await phone.observeGeneral(task.id,target.scope,{signal});return phone.observation;};
  const first=pageIdentity(await capture(),task,target,deviceId,before.service_instance_id);
  if(!stillAllowed()||!first)return failure('conversation_not_observed');
  const inspect=()=>phone.ime.verify({text:target.plan.content,packageName:target.scope.packageName,referenceId:target.referenceId,controlEpoch:epoch});
  const exactProof=result=>result?.status==='verified'&&result.proof?.referenceId===target.referenceId&&result.proof.controlEpoch===epoch&&result.proof.exact===true&&result.proof.reads===2&&/^[a-f0-9]{64}$/.test(result.proof.editorIdentity||'');
  const proof1=await inspect();
  if(!stillAllowed()||!exactProof(proof1))return {...failure('editor_not_verified'),diagnostic:proof1?.diagnostic};
  const second=pageIdentity(await capture(),task,target,deviceId,before.service_instance_id);
  if(!stillAllowed()||!second||second.windowId!==first.windowId||isolated&&(second.observationId===first.observationId||second.nativeAt<first.nativeAt))return failure('conversation_changed');
  const after=await client.status(deviceId,{signal,timeout:8000});
  if(!stillAllowed()||!idle(after)||after.service_instance_id!==before.service_instance_id||client.active?.size)return failure('identity_changed');
  const proof2=await inspect();
  if(!stillAllowed()||isolated&&(!proof1.id||!proof2?.id||proof1.id===proof2.id)||!exactProof(proof2)||proof2.proof.editorIdentity!==proof1.proof.editorIdentity)return failure('editor_changed');
  return {resolved:true,outcome:'input_observed',actionId:action.id,requestId:target.referenceId,resolution:{kind:'input_observed',nativeOutcome:'unknown',at:new Date().toISOString(),referenceId:target.referenceId,contractId:target.scope.contractId,contractRevision:target.scope.contractRevision,effectKey:effectIdentity(target.scope),deviceId,serviceInstanceId:before.service_instance_id,windowId:first.windowId,packageName:target.scope.packageName,controlEpoch:epoch,observationId:second.observationId,verificationIds:[proof1.id,proof2.id],...(isolated?{verificationCapture:'bound_control_observe',originalControlEpoch:task.remoteControlEpoch,nativeObservationIds:[first.observationId,second.observationId]}:{}),editorIdentity:proof2.proof.editorIdentity}};
 }catch(error){return failure(['cancelled','phone_control_paused','phone_busy','typing_verification_unavailable','typing_verification_changed'].includes(error.code)?error.code:'verification_unavailable');}
 finally{isolated?.close();verifyingPhones.delete(phone);if(acquired)phone.release(task.id);}
}
