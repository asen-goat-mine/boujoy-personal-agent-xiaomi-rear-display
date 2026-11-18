import {ANDROID_PACKAGE} from '../distribution.mjs';
import {nativeWindowConflict} from './phone-window-identity.mjs';
const HOME=ANDROID_PACKAGE;
/** A single foreground return owned by the finishing run, never replayed on startup. */
export async function returnAfterCompletion(phone,taskId,{signal}={}){
 const task=phone.store.data.tasks.find(t=>t.id===taskId),previous=phone.observation?.native;
 const control=phone.remoteControlState?.();
 const epoch=control?.controlEpoch;
 const eligible=()=>task?.status==='completed'&&phone.lease===taskId&&!signal?.aborted&&!phone.remoteMaintenance&&phone.store.data.settings.phoneEnabled!==false&&phone.isPhoneUse()&&!phone.isBackground?.()&&task.source!=='watch'&&task.source!=='routine'&&!task.parentId&&phone.observation?.taskId===taskId&&previous?.packageName&&phone.remoteControlState?.()?.paused===false&&phone.remoteControlState?.()?.controlEpoch===epoch&&(task.remoteControlEpoch==null||task.remoteControlEpoch===epoch)&&!phone.store.data.actions.some(a=>a.taskId===taskId&&['executing','unknown'].includes(a.status)&&!a.resolution)&&!task.events?.some(e=>e.type==='phone_completion_return');
 if(!eligible())return;
 const record=(outcome,extra={})=>phone.store.event(taskId,'phone_completion_return',outcome==='returned'?'任务完成，已返回 Boujoy':'任务完成后的应用返回未执行或未核实',{outcome,...extra});
 if(previous.packageName===HOME){record('already_home');return;}
 const deadline=AbortSignal.timeout(15000),bounded=signal?AbortSignal.any([signal,deadline]):deadline;
 try{
  const device=phone.phoneUseDevice();
  const before=await phone.phoneUse.capture(device,{mode:'tree',signal:bounded,timeout:5000});
  const n=before.native;
  if(!eligible()||bounded.aborted||n?.deviceId!==previous.deviceId||n?.serviceInstanceId!==previous.serviceInstanceId||n?.packageName!==previous.packageName||nativeWindowConflict(n)){record('foreground_changed');return;}
  // Record before dispatch so an interrupted/unknown launch is never replayed.
  record('requested');
  await phone.call('open_app',{packageName:HOME},8000,{signal:bounded,effect:true});
  const after=await phone.phoneUse.capture(device,{mode:'tree',signal:bounded,timeout:5000});
  record(after.native?.deviceId===device&&after.native?.packageName===HOME&&!nativeWindowConflict(after.native)?'returned':'unverified');
 }catch(error){record('unverified',{code:error.code||'return_failed'});}
}
