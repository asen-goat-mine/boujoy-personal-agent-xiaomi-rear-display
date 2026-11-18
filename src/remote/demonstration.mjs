import {ANDROID_PACKAGE} from '../distribution.mjs';
import {randomUUID} from 'node:crypto';
import {requireValue} from '../core/errors.mjs';
import {requestHash} from '../core/task-contract.mjs';
import {assertExecutionPermission,withExecutionPermission} from '../core/execution-permissions.mjs';

const COMMON_LABEL=/^(?:搜索|返回|下一步|上一步|首页|我的|设置|更多|取消|确认|确定|保存|完成|添加|新建|选择|关闭|菜单|Search|Back|Next|Home|Settings|Cancel|Save|Done|Close)$/i;
/** Observes structural page changes only. It never infers or injects taps. */
export function demonstrationPage(raw,now=Date.now()){
 requireValue(raw&&typeof raw.package_name==='string'&&/^[A-Za-z][\w]*(?:\.[\w]+)+$/.test(raw.package_name)&&raw.observation_status==='complete'&&raw.tree?.available===true&&Array.isArray(raw.tree.elements)&&raw.tree.elements.length<=1500&&Number.isFinite(raw.captured_at_ms)&&now-raw.captured_at_ms>=-2000&&now-raw.captured_at_ms<=5000,'示范页面尚未完整读取','demo_invalid_observation');
 requireValue(!raw.screenshot,'示范不保存截图','demo_invalid_observation');
 const elements=raw.tree.elements;
 if(elements.some(n=>n.password===true||/密码|验证码|支付密码|安全码|人脸验证|指纹验证|扫码登录|扫码登陆|one.time.password|credit.card|cvv|passcode|sign.in|log.in/i.test([n.text,n.description,n.hint,n.view_id].filter(Boolean).join(' '))))return {sensitive:true};
 const controls=elements.filter(n=>!n.editable&&!n.password&&Array.isArray(n.actions)&&n.actions.length).slice(0,40).map(n=>({viewId:typeof n.view_id==='string'&&/^[A-Za-z][\w.]*:id\/[A-Za-z][\w]{0,80}$/.test(n.view_id)?n.view_id:null,className:typeof n.class==='string'?n.class.slice(0,120):null,...(COMMON_LABEL.test(n.text||'')?{label:n.text}:{})}));
 const nodeSummary={nodeCount:elements.length,editableCount:elements.filter(n=>n.editable).length,controls};
 // The digest deliberately excludes user-entered text, descriptions, hints and values.
 const structure=elements.map(n=>({id:n.element_id,class:n.class,viewId:n.view_id,bounds:n.bounds,actions:n.actions,editable:!!n.editable,label:COMMON_LABEL.test(n.text||'')?n.text:null}));
 return {at:new Date(now).toISOString(),packageName:raw.package_name,screenHash:requestHash(JSON.stringify({packageName:raw.package_name,structure})),nodeSummary};
}
export class Demonstrations{
 constructor({state,store,engine,phone,clock=Date.now,intervalMs=2000}){
  Object.assign(this,{state,store,engine,phone,clock,intervalMs});this.active=null;this.last=null;this.closed=false;this.timer=null;
  this.client=phone?.phoneUse?.client;if(this.client)this.client.demoLeaseGuard=(lease,deviceId)=>this.valid(lease,deviceId);
 }
 permissionsValid(s){return ['phone','files'].every(domain=>this.store.data.settings[domain+'Enabled']!==false&&s.executionEpochs?.[domain]===(this.store.data.settings.executionEpochs?.[domain]||0));}
 valid(lease,deviceId){const s=this.active;if(this.closed||!s||!this.permissionsValid(s)||s.lease!==lease||s.phoneDeviceId!==deviceId||s.controller.signal.aborted||this.clock()>=Date.parse(s.expiresAt)||!this.state.data.control.paused||this.state.data.control.controlEpoch!==s.controlEpoch||!this.state.device(s.certificateFingerprint)||this.store.data.recoveryFence?.required)return false;const task=this.store.data.tasks.find(t=>t.id===s.sourceTaskId),message=task?.messages?.find(m=>m.id===s.sourceMessageId);return !!message&&message.role==='user'&&requestHash(message.content)===s.sourceSha256;}
 view(s){if(!s)return null;return Object.fromEntries(['id','sourceTaskId','name','startedAt','expiresAt','endedAt','stopReason','draftId','error','status'].filter(k=>s[k]!==undefined).map(k=>[k,s[k]]).concat([['pageCount',s.observations.length]]));}
 summary(device){const s=this.active||this.last;return s?.deviceId===device.id?this.view(s):null;}
 async start(taskId,device,fp,epoch){
  assertExecutionPermission(this.store,['phone','files']);const executionEpochs=Object.fromEntries(['phone','files'].map(domain=>[domain,this.store.data.settings.executionEpochs?.[domain]||0]));
  requireValue(!this.closed&&!this.active&&this.client?.observeForDemo&&this.engine.broker?.workflows?.createDemonstrationDraft,'示范采集尚未可用或已有会话','demo_unavailable');
  requireValue(this.state.data.control.paused&&this.state.data.control.controlEpoch===epoch,'请先接管手机再开始示范');
  const task=this.store.task(taskId),message=task.messages.filter(m=>m.role==='user').at(-1);requireValue((task.source||'user')==='user'&&message&&!message.externalContent&&!message.external_content&&task.taskContract?.source?.contentSha256===requestHash(message.content),'示范必须关联当前直接用户任务');
  const phoneDeviceId=this.store.data.settings.phoneUseDeviceId;requireValue(typeof phoneDeviceId==='string'&&phoneDeviceId,'手机执行器尚未绑定','demo_unavailable');
  await this.engine.stop(taskId,{pause:true});requireValue(!this.closed&&this.state.data.control.paused&&this.state.data.control.controlEpoch===epoch&&this.state.device(fp),'控制状态已变化');
  requireValue(this.permissionsValid({executionEpochs}),'示范执行权限已变化','execution_revoked');
  requireValue(!this.phone.lease&&!this.client.active?.size,'先等待在途手机动作结束再示范','demo_phone_busy');
  const started=this.clock();const s={id:randomUUID(),sourceTaskId:task.id,sourceMessageId:message.id,sourceSha256:requestHash(message.content),objective:task.taskContract.goal,name:'手机示范',startedBy:'authenticated_user',deviceId:device.id,certificateFingerprint:fp,phoneDeviceId,controlEpoch:epoch,executionEpochs,startedAt:new Date(started).toISOString(),expiresAt:new Date(started+120000).toISOString(),observations:[],status:'recording',lease:Symbol('user-demonstration'),controller:new AbortController()};this.active=s;
  this.timer=setInterval(()=>void this.sample(),this.intervalMs);this.timer.unref();this.deadlineTimer=setTimeout(()=>void this.finish('timeout'),120000);this.deadlineTimer.unref();void this.sample();return this.view(s);
 }
 async sample(){const s=this.active;if(!s||s.busy)return;if(!this.valid(s.lease,s.phoneDeviceId)){await this.finish('authorization_ended');return;}s.busy=true;
  try{const raw=await this.client.observeForDemo(s.phoneDeviceId,{lease:s.lease,signal:s.controller.signal});if(!this.valid(s.lease,s.phoneDeviceId))return;const page=demonstrationPage(raw,this.clock());
   if(page.sensitive){await this.finish('sensitive_screen');return;}
   if(page.packageName===ANDROID_PACKAGE||page.packageName==='ai.nidhoggfgg.phoneuse')return;
   if(!s.observations.some(p=>p.screenHash===page.screenHash))s.observations.push(page);if(s.observations.length>=60)await this.finish('page_limit');
  }catch(error){if(this.active===s&&!s.controller.signal.aborted)await this.finish(error.code||'observation_failed');}finally{s.busy=false;}
 }
 async finish(reason='user_stopped',device,sessionId){const s=this.active;if(!s){if(device)requireValue(this.last?.deviceId===device.id&&(!sessionId||this.last.id===sessionId),'示范会话不存在');return this.view(this.last);}
  if(device)requireValue(s.deviceId===device.id&&s.id===sessionId,'示范会话不匹配');this.active=null;clearInterval(this.timer);clearTimeout(this.deadlineTimer);this.timer=null;this.deadlineTimer=null;s.controller.abort();s.endedAt=new Date(this.clock()).toISOString();s.stopReason=reason;s.status='stopped';this.last=s;
  if(s.observations.length){try{requireValue(this.permissionsValid(s),'示范执行权限已变化，未保存旧草稿','execution_revoked');const {lease,controller,busy,...record}=s;const draft=await withExecutionPermission(this.store,['files'],s.sourceTaskId,()=>this.engine.broker.workflows.createDemonstrationDraft(record));s.draftId=draft.id;s.status='draft_created';}catch(e){s.error=e.code||'demo_draft_failed';}}else s.error='no_observable_page_change';return this.view(s);
 }
 invalidateChanged(){if(this.active&&!this.valid(this.active.lease,this.active.phoneDeviceId))void this.finish('epoch_changed');}
 disconnect(){void this.finish('disconnected');}
 close(){this.closed=true;void this.finish('closed');}
}
