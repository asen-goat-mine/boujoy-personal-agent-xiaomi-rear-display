import {randomUUID} from 'node:crypto';
import {AppError,requireValue} from '../core/errors.mjs';

// One in-memory typing job. The text is delivered only to the bound phone over
// the existing encrypted chat channel and is never written to disk or logs.
const DIAGNOSTICS=new Set(['invalid_request','service_unavailable','control_paused','focus_missing','protected_input','editor_changed_before_commit','editor_changed_after_commit','readback_verified','readback_unavailable','readback_partial','readback_mismatch','commit_timeout','prepare_timeout','commit_exception','prepare_exception']);
const STATUSES=new Set(['typed','submitted','password','unfocused','permission','failed','verified','unverified']);
export class PhoneTyping{
 constructor({clock=Date.now,timeoutMs=12000,pollMs=11000}={}){Object.assign(this,{clock,timeoutMs,pollMs,pending:null,waiters:[],results:new Map(),done:new Map(),closed:false});}
 request({deviceId,text,mode='insert',packageName,operation='type',referenceId,controlEpoch}={}){
  if(this.closed)throw Object.assign(new AppError('phone_input_unavailable','手机输入通道已关闭',409),{dispatchState:'not_sent'});
  requireValue(typeof deviceId==='string'&&deviceId.length>=8,'没有绑定的手机','phone_input_unavailable');
  requireValue(typeof text==='string'&&text.length>0&&text.length<=2000&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text),'输入内容无效','phone_input_unavailable');
  requireValue(mode==='insert'||mode==='replace','输入模式无效','phone_input_unavailable');
  requireValue(operation==='type'||operation==='verify_replace','输入操作无效','phone_input_unavailable');
  if(operation==='verify_replace')requireValue(mode==='replace'&&typeof referenceId==='string'&&/^[a-f0-9-]{36}$/.test(referenceId)&&Number.isSafeInteger(controlEpoch)&&controlEpoch>=0&&typeof packageName==='string','核验请求无效','phone_input_unavailable');
  if(this.pending||this.results.size)throw new AppError('phone_input_busy','上一次输入还没结束',409);
  requireValue(packageName===undefined||typeof packageName==='string'&&/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(packageName),'输入目标应用无效','phone_input_unavailable');
  const id=randomUUID(),job={id,deviceId,text,mode,...(packageName?{packageName}:{}),...(operation==='verify_replace'?{operation,referenceId,controlEpoch}:{})};
  return new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{
    const pending=this.results.get(id);if(!pending)return;
    if(this.pending?.id===id)this.pending=null;this.results.delete(id);
    if(pending.delivered){const status=operation==='verify_replace'?'unverified':'submitted';this.done.set(id,{deviceId,status,at:this.clock()});resolve({id,status});}
    else reject(Object.assign(new AppError('phone_input_unavailable','手机没有在限定时间内收到输入任务。请确认 Boujoy 正在运行。',409),{dispatchState:'not_sent'}));
   },this.timeoutMs);
   this.results.set(id,{resolve,reject,timer,deviceId,delivered:false,operation,referenceId,controlEpoch});
   this.pending=job;for(const waiter of [...this.waiters])waiter.notify();
  });
 }
 wait(deviceId,{signal,protocol=1}={}){
  requireValue(typeof deviceId==='string'&&deviceId,'设备无效');
  if(this.closed||signal?.aborted)return Promise.resolve(null);
  const take=()=>!this.closed&&!signal?.aborted&&this.pending?.deviceId===deviceId&&(this.pending.operation!=='verify_replace'||protocol===2)?this.pending:null;
  return new Promise(resolve=>{
   let settled=false;
   const finish=job=>{if(settled)return;settled=true;cleanup();if(job&&this.pending?.id===job.id){const receipt=this.results.get(job.id);if(receipt)receipt.delivered=true;this.pending=null;}if(job){const {deviceId:ignored,...payload}=job;resolve(payload);}else resolve(null);};
   const waiter={finish,notify:()=>{if(settled)return;if(this.closed||signal?.aborted)return finish(null);const job=take();if(job)finish(job);}};
   const timer=setTimeout(()=>finish(null),this.pollMs);
   const onAbort=()=>finish(null);
   const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',onAbort);this.waiters=this.waiters.filter(item=>item!==waiter);};
   this.waiters.push(waiter);signal?.addEventListener('abort',onAbort,{once:true});
   waiter.notify();
  });
 }
 close(){
  if(this.closed)return;this.closed=true;this.pending=null;
  for(const [id,entry] of this.results){
   clearTimeout(entry.timer);
   if(entry.delivered){const status=entry.operation==='verify_replace'?'unverified':'submitted';this.done.set(id,{deviceId:entry.deviceId,status,at:this.clock()});entry.resolve({id,status});}
   else entry.reject(Object.assign(new AppError('phone_input_unavailable','手机输入通道已关闭，输入任务尚未交付',409),{dispatchState:'not_sent'}));
  }
  this.results.clear();for(const waiter of [...this.waiters])waiter.finish(null);
 }
 complete(deviceId,id,status,diagnostic,proof){
  requireValue(STATUSES.has(status),'输入结果无效');
  const prior=this.done.get(id);
  if(prior){requireValue(prior.deviceId===deviceId,'输入任务不存在或已过期','typing_expired');return {accepted:true,status:prior.status,duplicate:true};}
  const waiter=this.results.get(id);
  requireValue(waiter&&waiter.deviceId===deviceId,'输入任务不存在或已过期','typing_expired');
  requireValue(waiter.delivered,'输入任务尚未交付','typing_expired');
  let verified={};
  if(waiter.operation==='verify_replace'){
   requireValue(status==='verified'||status==='unverified','核验不能冒充输入回执','typing_invalid_proof');
   if(status==='verified'){
    requireValue(proof&&proof.referenceId===waiter.referenceId&&proof.controlEpoch===waiter.controlEpoch&&/^[a-f0-9]{64}$/.test(proof.editorIdentity||'')&&proof.exact===true&&proof.reads===2,'编辑器核验证据无效','typing_invalid_proof');
    verified={proof:{referenceId:proof.referenceId,controlEpoch:proof.controlEpoch,editorIdentity:proof.editorIdentity,exact:true,reads:2}};
   }
  }else requireValue(status!=='verified'&&status!=='unverified','输入不能冒充独立核验','typing_invalid_proof');
  this.results.delete(id);clearTimeout(waiter.timer);if(this.pending?.id===id)this.pending=null;
  const detail=DIAGNOSTICS.has(diagnostic)?{diagnostic}:{};
  this.done.set(id,{deviceId,status,...detail,...verified,at:this.clock()});
  for(const [key,value] of this.done)if(this.clock()-(value.at||0)>60000)this.done.delete(key);
  waiter.resolve({id,status,...detail,...verified});return {accepted:true,status};
 }
}
