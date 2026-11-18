import {randomUUID} from 'node:crypto';
import {AppError,requireValue} from '../core/errors.mjs';

// Background-display commands for the bound phone (docs/display-backend-protocol.md).
// The phone long-polls the authenticated gateway; a command is handed out at most
// once. A delivered command without a receipt is never re-sent: effects become
// outcome_unknown and reads simply fail, exactly like the typing channel.
// Handoff/close mutate a session too: once delivered, a lost reply is unknown.
export const DISPLAY_PROTOCOL=1;
export const DISPLAY_OPS=new Set(['status','list_apps','session_open','session_close','session_handoff','observe','launch_app','tap','long_press','swipe','scroll','input_text','back']);
// session_handoff: keep the display for the user to take over on the main screen.
export const DISPLAY_FEATURES=new Set(['session_handoff']);
export const DISPLAY_EFFECT_OPS=new Set(['session_close','session_handoff','launch_app','tap','long_press','swipe','scroll','input_text','back']);
const SESSION_FREE=new Set(['status','list_apps','session_open']);
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OBJECT=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);

export function validSession(session){
 return OBJECT(session)&&typeof session.sessionId==='string'&&UUID.test(session.sessionId)&&Number.isSafeInteger(session.generation)&&session.generation>=0&&Number.isSafeInteger(session.displayId)&&session.displayId>0;
}

export class DisplayCommands{
 constructor({clock=Date.now,pollMs=11000,maxQueue=8}={}){Object.assign(this,{clock,pollMs,maxQueue,queue:[],waiters:[],pending:new Map(),done:new Map(),closed:false});}
 request({deviceId,op,args={},session=null,controlEpoch,taskId=null,timeoutMs=20000,signal}={}){
  try{
  if(this.closed)throw new AppError('display_backend_unavailable','后台执行通道已关闭',409);
  requireValue(typeof deviceId==='string'&&deviceId.length>=8,'没有绑定的手机','display_backend_unavailable');
  requireValue(DISPLAY_OPS.has(op),'后台执行命令无效','invalid_action');
  requireValue(OBJECT(args),'后台执行参数无效','invalid_action');
  requireValue(Number.isSafeInteger(controlEpoch)&&controlEpoch>=0,'控制代次无效','display_backend_unavailable');
  requireValue(taskId===null||typeof taskId==='string'&&taskId.length<=128,'任务编号无效');
  requireValue(SESSION_FREE.has(op)||validSession(session),'后台显示会话无效','display_session_stale');
  requireValue(Number.isFinite(timeoutMs)&&timeoutMs>=500&&timeoutMs<=120000,'后台执行超时无效');
  if(op==='session_handoff'){
   requireValue(typeof args.task_id==='string'&&args.task_id.trim()&&args.task_id.length<=128&&args.task_id===taskId,'交接任务编号无效');
   requireValue(typeof args.title==='string'&&[...args.title].length<=40&&typeof args.summary==='string'&&[...args.summary].length<=160,'交接说明无效');
  }
  if(signal?.aborted)throw Object.assign(new AppError('action_cancelled','任务已停止，动作未发送到手机',409),{dispatchState:'not_sent'});
  if(this.queue.length>=this.maxQueue)throw Object.assign(new AppError('phone_busy','手机后台执行通道繁忙',409),{dispatchState:'not_sent'});
  }catch(error){throw Object.assign(error,{dispatchState:'not_sent'});}
  const id=randomUUID(),deadlineAtMs=this.clock()+timeoutMs;
  const command={id,op,controlEpoch,taskId,deadlineAtMs,session:session?{sessionId:session.sessionId,generation:session.generation,displayId:session.displayId}:null,args};
  return new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{
    const entry=this.pending.get(id);if(!entry)return;this.pending.delete(id);
    this.queue=this.queue.filter(item=>item.command.id!==id);
    this.done.set(id,{deviceId,at:this.clock(),expired:true});
    if(!entry.delivered)return entry.reject(Object.assign(new AppError('display_backend_unavailable','手机没有在限定时间内取走后台执行命令。请确认 Boujoy 正在运行、后台执行已就绪。',409),{dispatchState:'not_sent'}));
    if(DISPLAY_EFFECT_OPS.has(op))return entry.reject(Object.assign(new AppError('outcome_unknown','手机后台动作结果尚未确认，暂不重复执行。',409),{dispatchState:'unknown',requestId:id}));
    entry.reject(Object.assign(new AppError('rpc_timeout','手机后台读取等待超时',409),{dispatchState:'not_sent'}));
   },timeoutMs);
   const onAbort=()=>{
    const entry=this.pending.get(id);if(!entry)return;this.pending.delete(id);clearTimeout(entry.timer);
    this.queue=this.queue.filter(item=>item.command.id!==id);this.done.set(id,{deviceId,at:this.clock(),expired:true});
    if(!entry.delivered)return entry.reject(Object.assign(new AppError('action_cancelled','任务已停止，动作未发送到手机',409),{dispatchState:'not_sent'}));
    if(DISPLAY_EFFECT_OPS.has(op))return entry.reject(Object.assign(new AppError('outcome_unknown','任务已停止；这次后台动作已交给手机，结果未确认，不会重复执行。',409),{dispatchState:'unknown',requestId:id}));
    entry.reject(Object.assign(new AppError('cancelled','任务已停止',409),{dispatchState:'not_sent'}));
   };
   signal?.addEventListener('abort',onAbort,{once:true});
   this.pending.set(id,{resolve:value=>{signal?.removeEventListener('abort',onAbort);resolve(value);},reject:error=>{signal?.removeEventListener('abort',onAbort);reject(error);},timer,deviceId,delivered:false,op});
   this.queue.push({deviceId,command});
   for(const waiter of [...this.waiters])waiter.notify();
  });
 }
 // Remove queued (never delivered) commands for a device, e.g. after a local
 // stop on the phone. Delivered ones keep waiting for their own receipt.
 cancelUndelivered(deviceId,reason='任务已停止'){
  for(const item of [...this.queue]){
   if(deviceId!==null&&item.deviceId!==deviceId)continue;
   const entry=this.pending.get(item.command.id);if(!entry||entry.delivered)continue;
   this.queue=this.queue.filter(other=>other!==item);this.pending.delete(item.command.id);clearTimeout(entry.timer);
   entry.reject(Object.assign(new AppError('action_cancelled',reason+'，动作未发送到手机',409),{dispatchState:'not_sent'}));
  }
 }
 wait(deviceId,{signal,paused=false}={}){
  requireValue(typeof deviceId==='string'&&deviceId,'设备无效');
  if(this.closed||signal?.aborted)return Promise.resolve(null);
  const take=()=>{
   if(paused||this.closed||signal?.aborted)return null;
   const index=this.queue.findIndex(item=>item.deviceId===deviceId);if(index<0)return null;
   const [item]=this.queue.splice(index,1),entry=this.pending.get(item.command.id);
   if(!entry)return take();
   if(item.command.deadlineAtMs<=this.clock())return take();
   entry.delivered=true;return item.command;
  };
  return new Promise(resolve=>{
   let settled=false;
   const finish=command=>{if(settled)return;settled=true;cleanup();resolve(command||null);};
   const waiter={finish,notify:()=>{if(settled)return;if(this.closed||signal?.aborted)return finish(null);const command=take();if(command)finish(command);}};
   const timer=setTimeout(()=>finish(null),this.pollMs);
   const onAbort=()=>finish(null);
   const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',onAbort);this.waiters=this.waiters.filter(item=>item!==waiter);};
   this.waiters.push(waiter);signal?.addEventListener('abort',onAbort,{once:true});
   waiter.notify();
  });
 }
 complete(deviceId,id,result){
  requireValue(typeof id==='string'&&UUID.test(id),'后台执行编号无效','display_expired');
  requireValue(OBJECT(result),'后台执行结果无效');
  const prior=this.done.get(id);
  if(prior){requireValue(prior.deviceId===deviceId,'后台执行命令不存在或已过期','display_expired');requireValue(!prior.expired,'后台执行命令已过期','display_expired');return {accepted:true,duplicate:true};}
  const entry=this.pending.get(id);
  requireValue(entry&&entry.deviceId===deviceId,'后台执行命令不存在或已过期','display_expired');
  requireValue(entry.delivered,'后台执行命令尚未交付','display_expired');
  this.pending.delete(id);clearTimeout(entry.timer);
  this.done.set(id,{deviceId,at:this.clock()});
  for(const [key,value] of this.done)if(this.clock()-(value.at||0)>120000)this.done.delete(key);
  entry.resolve(result);return {accepted:true};
 }
 close(){if(this.closed)return;this.closed=true;for(const [id,entry] of this.pending){clearTimeout(entry.timer);entry.reject(Object.assign(new AppError(entry.delivered&&DISPLAY_EFFECT_OPS.has(entry.op)?'outcome_unknown':'display_backend_unavailable','后台执行通道已关闭',409),{dispatchState:entry.delivered&&DISPLAY_EFFECT_OPS.has(entry.op)?'unknown':'not_sent'}));this.pending.delete(id);}this.queue=[];for(const waiter of [...this.waiters])waiter.finish(null);}
}

// Telemetry is authenticated but still phone-reported: keep only known fields.
export function sanitizeDisplayBackend(value){
 if(!OBJECT(value)||value.protocol!==DISPLAY_PROTOCOL)return null;
 const shizuku=['running','permission_required','not_running','unsupported'].includes(value.shizuku)?value.shizuku:'unsupported';
 const reasons=['shizuku_not_running','shizuku_permission_required','user_service_unavailable','executor_service_disabled','display_unsupported','locked'];
 const session=validSession(value.session)&&[value.session.width,value.session.height,value.session.densityDpi].every(n=>Number.isSafeInteger(n)&&n>0&&n<=10000)
  ?{sessionId:value.session.sessionId,generation:value.session.generation,displayId:value.session.displayId,width:value.session.width,height:value.session.height,densityDpi:value.session.densityDpi,...(Number.isSafeInteger(value.session.createdAtMs)?{createdAtMs:value.session.createdAtMs}:{})}:null;
 const rear=OBJECT(value.rear)?{available:value.rear.available===true,displayId:Number.isSafeInteger(value.rear.displayId)&&value.rear.displayId>0?value.rear.displayId:null,showing:value.rear.showing===true}:{available:false,displayId:null,showing:false};
 const executorService=value.executorService===true,userService=value.userService===true;
 const ready=value.ready===true&&shizuku==='running'&&executorService&&userService;
 // Optional protocol-1 additions a newer phone announces; unknown names are dropped.
 const features=Array.isArray(value.features)?[...new Set(value.features.filter(name=>DISPLAY_FEATURES.has(name)))]:[];
 const handoff=OBJECT(value.handoff)&&['pending','taken','dismissed','expired','failed'].includes(value.handoff.state)&&(value.handoff.taskId===null||typeof value.handoff.taskId==='string'&&value.handoff.taskId.length<=64)
  ?{state:value.handoff.state,taskId:value.handoff.taskId??null,...(typeof value.handoff.at==='string'&&value.handoff.at.length<=40?{at:value.handoff.at}:{})}:null;
 return {protocol:DISPLAY_PROTOCOL,shizuku,executorService,userService,session,rear,ready,reason:ready?null:reasons.includes(value.reason)?value.reason:'display_unsupported',features,handoff};
}
