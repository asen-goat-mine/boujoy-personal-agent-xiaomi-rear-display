import {randomBytes,randomUUID,createHmac,createHash,timingSafeEqual} from 'node:crypto';
import {createTaskContract,requestHash} from './task-contract.mjs';
import {requireValue,shortText,AppError} from './errors.mjs';
import {normalizeEventCondition,evaluateEventCondition} from './event-conditions.mjs';

const iso=at=>new Date(at).toISOString();
const ID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const NAME=/^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,119}$/;
const RULE_FIELDS=['name','prompt','roleId','kind','eventType','enabled','cloudConsent','memoryConsent','includePayload','payloadFields','authorizationExpiresAt','maxRunSeconds','executionWindowSeconds','condition'];
function exact(value,keys){requireValue(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>keys.includes(key)),'事件字段格式无效');}
function eventAuthorization(rule,input,at){
 if(input.cloudConsent!==true&&rule.kind!=='reminder')return null;
 const expiresAt=input.authorizationExpiresAt||null;requireValue(!expiresAt||Number.isFinite(Date.parse(expiresAt))&&Date.parse(expiresAt)>at,'事件授权有效期必须在未来');
 const contract=createTaskContract({id:rule.id,source:'user',prompt:rule.prompt,messages:[{id:'rule-configuration',role:'user',content:rule.prompt}],cloudConsent:true,memoryConsent:input.memoryConsent===true},{at});
 const localOnly=rule.kind==='reminder';
 return {id:randomUUID(),source:'event_rule_configuration',ruleId:rule.id,ruleRevision:rule.revision,promptSha256:requestHash(rule.prompt),approvedAt:iso(at),expiresAt,localOnly,cloudConsent:!localOnly&&input.cloudConsent===true,memoryConsent:!localOnly&&input.memoryConsent===true,includePayload:!localOnly&&input.includePayload===true,payloadFields:[...rule.payloadFields],condition:rule.condition||null,effects:localOnly?[]:contract.effects,allowedApps:localOnly?[]:contract.allowedApps};
}
function validateDefinition(input){
 exact(input,RULE_FIELDS);const result={name:shortText(input.name,'规则名称',120),prompt:shortText(input.prompt),roleId:input.roleId||'concierge',kind:input.kind||'general',eventType:shortText(input.eventType,'事件类型',120),enabled:input.enabled!==false,payloadFields:input.payloadFields||[],maxRunSeconds:input.maxRunSeconds??60,executionWindowSeconds:input.executionWindowSeconds??120};
 requireValue(NAME.test(result.eventType)&&typeof result.roleId==='string'&&['general','work','reminder'].includes(result.kind),'事件规则类型无效');
 for(const key of ['enabled','cloudConsent','memoryConsent','includePayload'])requireValue(input[key]===undefined||typeof input[key]==='boolean',`${key} 应为布尔值`);
 requireValue(Array.isArray(result.payloadFields)&&result.payloadFields.length<=16&&result.payloadFields.every(field=>typeof field==='string'&&/^[a-zA-Z][\w]{0,39}$/.test(field))&&new Set(result.payloadFields).size===result.payloadFields.length,'事件数据字段必须是唯一的简单字段名');
 requireValue(input.includePayload!==true||result.payloadFields.length>0,'允许云端读取事件数据时必须指定最小字段');
 requireValue(Number.isInteger(result.maxRunSeconds)&&result.maxRunSeconds>=10&&result.maxRunSeconds<=1200&&Number.isInteger(result.executionWindowSeconds)&&result.executionWindowSeconds>=10&&result.executionWindowSeconds<=300,'事件执行时限无效');
 result.condition=normalizeEventCondition(input.condition);return result;
}
export function signEventEnvelope({secret,ruleId,timestamp,nonce,rawBody}){
 return 'sha256='+createHmac('sha256',secret).update(`v1\n${ruleId}\n${timestamp}\n${nonce}\n`).update(rawBody).digest('hex');
}
function constantEqual(a,b){const left=Buffer.from(a),right=Buffer.from(b);return left.length===right.length&&timingSafeEqual(left,right);}
function sanitizedPayload(payload,fields){
 const result={};for(const field of fields){if(!Object.hasOwn(payload,field))continue;const value=payload[field];requireValue(value===null||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value)||typeof value==='string'&&value.length<=2000&&!/[\u0000-\u0008]/.test(value),'事件字段只接受有限长度文本或标量');result[field]=value;}
 requireValue(Buffer.byteLength(JSON.stringify(result))<=16000,'事件数据过大');return result;
}
export function validateEventAuthorization(task,store,{at=Date.now()}={}){
 const fail=reason=>({valid:false,reason});const auth=task?.eventAuthorization;
 if(task?.source!=='event'||!auth||auth.source!=='event_rule_configuration'||!store?.data)return fail('event_authorization_missing');
 const rule=store.data.eventRules?.find(row=>row.id===task.eventRuleId);
 if(!rule?.enabled||rule.deletedAt||!rule.authorization||rule.authorization.revokedAt||rule.revision!==auth.ruleRevision||rule.authorization.id!==auth.id||JSON.stringify(rule.authorization)!==JSON.stringify(auth))return fail('event_authorization_revoked');
 const cloudValid=auth.localOnly===true?rule.kind==='reminder'&&task.kind==='reminder'&&task.cloudConsent===false&&!task.memoryConsent&&auth.effects.length===0:auth.cloudConsent===true&&task.cloudConsent===true;
 if(!cloudValid||task.memoryConsent===true&&!auth.memoryConsent||auth.expiresAt&&Date.parse(auth.expiresAt)<=at||auth.promptSha256!==requestHash(task.prompt)||rule.prompt!==task.prompt)return fail('event_scope_changed');
 if(store.data.roles?.find(role=>role.id===rule.roleId)?.deletedAt)return fail('event_role_deleted');
 const receipt=store.data.eventReceipts?.find(row=>row.id===task.eventReceiptId&&row.taskId===task.id&&row.ruleId===rule.id);
 if(!receipt||receipt.authorizationId!==auth.id)return fail('event_receipt_missing');
 if(task.eventData&&(!auth.includePayload||Object.keys(task.eventData).some(key=>!auth.payloadFields.includes(key))||requestHash(JSON.stringify(task.eventData))!==receipt.payloadSha256))return fail('event_payload_changed');
 return {valid:true,reason:null,rule};
}

export class EventTriggers{
 constructor({store,engine,secrets,clock=Date.now}={}){requireValue(store?.data&&engine&&secrets,'事件触发需要本机状态、执行器和凭证存储');Object.assign(this,{store,engine,secrets,clock});}
 list(){return structuredClone((this.store.data.eventRules||[]).filter(rule=>!rule.deletedAt));}
 read(id){requireValue(ID.test(id),'事件规则编号无效');const rule=this.store.data.eventRules?.find(row=>row.id===id&&!row.deletedAt);requireValue(rule,'事件规则不存在','not_found');return structuredClone(rule);}
 async registerRule(input){
  const at=this.clock(),definition=validateDefinition(input),id=randomUUID(),secret=randomBytes(32).toString('base64url');requireValue(this.store.data.roles.some(role=>role.id===definition.roleId&&!role.hidden&&!role.deletedAt),'事件规则角色不可用');
  const rule={id,...definition,revision:1,createdAt:iso(at),updatedAt:iso(at)};rule.authorization=eventAuthorization(rule,input,at);
  await this.secrets.set(`event-${id}`,secret);
  try{this.store.transaction(s=>{(s.eventRules||=[]).push(rule);});}catch(error){await this.secrets.remove(`event-${id}`);throw error;}
  return {rule:structuredClone(rule),signingKey:secret,signing:{algorithm:'hmac-sha256',version:1,maxAgeSeconds:300,headers:['x-boujoy-event-time','x-boujoy-event-nonce','x-boujoy-event-signature']},transport:'authenticated-local-loopback-only'};
 }
 async updateRule(id,input){
  exact(input,RULE_FIELDS);const previous=this.read(id),at=this.clock();
  const base={...Object.fromEntries(RULE_FIELDS.filter(key=>Object.hasOwn(previous,key)).map(key=>[key,previous[key]])),...input};
  const definition=validateDefinition(base),scopeChanged=['prompt','roleId','kind','eventType','payloadFields','condition'].some(key=>JSON.stringify(definition[key])!==JSON.stringify(previous[key]))||input.includePayload!==undefined&&input.includePayload!==previous.authorization?.includePayload;
  requireValue(this.store.data.roles.some(role=>role.id===definition.roleId&&!role.hidden&&!role.deletedAt),'事件规则角色不可用');
  const explicitConsent=input.cloudConsent!==undefined||input.memoryConsent!==undefined||input.authorizationExpiresAt!==undefined||input.includePayload!==undefined;
  const rule={...previous,...definition,revision:previous.revision+1,updatedAt:iso(at)};if(JSON.stringify(definition.condition)!==JSON.stringify(previous.condition))rule.conditionState=null;
  const authInput={cloudConsent:scopeChanged?input.cloudConsent===true:input.cloudConsent??previous.authorization?.cloudConsent??false,memoryConsent:input.memoryConsent??previous.authorization?.memoryConsent??false,includePayload:input.includePayload??previous.authorization?.includePayload??false,authorizationExpiresAt:input.authorizationExpiresAt??previous.authorization?.expiresAt};
  // A fresh grant is revision-bound. Revoked authorization never silently returns when merely re-enabled.
  if(!scopeChanged&&!explicitConsent&&previous.authorization?.revokedAt)authInput.cloudConsent=false;
  rule.authorization=eventAuthorization(rule,authInput,at);if(!rule.enabled&&rule.authorization)rule.authorization.revokedAt=iso(at);
  this.store.transaction(s=>{const current=s.eventRules.find(row=>row.id===id);requireValue(current?.revision===previous.revision,'事件规则已被修改');Object.assign(current,rule);});
  await this.revokeTasks(id);return this.read(id);
 }
 async revokeTasks(id){for(const task of this.store.data.tasks.filter(row=>row.eventRuleId===id&&!['completed','ready_for_user','failed','cancelled','expired'].includes(row.status))){await this.engine.stop(task.id,{pause:true});this.store.updateTask(task.id,t=>{t.cloudConsent=false;t.memoryConsent=false;if(t.eventAuthorization)t.eventAuthorization.revokedAt=iso(this.clock());if(t.status!=='unknown_result')t.blockedReason='事件规则已修改或停用，旧任务不会继续执行。';});}}
 async revokeRule(id){return this.updateRule(id,{enabled:false,cloudConsent:false,memoryConsent:false});}
 async removeRule(id){const previous=this.read(id);this.store.transaction(s=>{const rule=s.eventRules.find(row=>row.id===id);requireValue(rule?.revision===previous.revision,'事件规则已被修改');rule.enabled=false;rule.deletedAt=iso(this.clock());rule.revision++;if(rule.authorization)rule.authorization.revokedAt=rule.deletedAt;});await this.revokeTasks(id);await this.secrets.remove(`event-${id}`);return {removed:true,id};}
 async receive({ruleId,rawBody,headers}){
  requireValue(ID.test(ruleId)&&Buffer.isBuffer(rawBody)&&rawBody.length>0&&rawBody.length<=32768,'事件请求格式或大小无效');exact(headers,['timestamp','nonce','signature']);
  const {timestamp,nonce,signature}=headers,at=this.clock();requireValue(typeof timestamp==='string'&&/^\d{13}$/.test(timestamp)&&Math.abs(at-Number(timestamp))<=300000,'事件签名已过期','event_expired');
  requireValue(typeof nonce==='string'&&/^[A-Za-z0-9_-]{16,128}$/.test(nonce)&&typeof signature==='string'&&/^sha256=[a-f0-9]{64}$/.test(signature),'事件签名格式无效');
  const rule=this.read(ruleId),secret=await this.secrets.get(`event-${ruleId}`);requireValue(secret&&constantEqual(signature,signEventEnvelope({secret,ruleId,timestamp,nonce,rawBody})),'事件签名不匹配','event_signature');
  let event;try{event=JSON.parse(rawBody.toString('utf8'));}catch{throw new AppError('event_format','事件正文不是有效 JSON');}exact(event,['eventId','type','payload']);requireValue(NAME.test(event.eventId)&&event.type===rule.eventType,'事件标识或类型不匹配');exact(event.payload||{},Object.keys(event.payload||{}));
  const bodySha256=shaBody(rawBody),receiptId=randomUUID();let response;
  this.store.transaction(s=>{
   const current=s.eventRules?.find(row=>row.id===ruleId);requireValue(current?.revision===rule.revision&&current.enabled&&!current.deletedAt&&current.authorization&&!current.authorization.revokedAt&&(current.authorization.cloudConsent===true||current.kind==='reminder'&&current.authorization.localOnly===true)&&(!current.authorization.expiresAt||Date.parse(current.authorization.expiresAt)>at),'事件规则未启用或未获持久授权','event_not_authorized');
   requireValue(s.roles.some(role=>role.id===current.roleId&&!role.hidden&&!role.deletedAt),'事件规则角色不可用','event_role_deleted');
   requireValue(!s.recoveryFence?.required&&!s.schedulerPaused,'事件触发已暂停','event_paused');
   const duplicate=(s.eventReceipts||[]).find(row=>row.ruleId===ruleId&&(row.eventId===event.eventId||row.nonce===nonce||row.nonces?.includes(nonce)));
   if(duplicate){requireValue(duplicate.eventId===event.eventId&&duplicate.bodySha256===bodySha256&&duplicate.authorizationId===current.authorization.id,'重复事件的正文或授权已变化，不会重新派发','event_replay');duplicate.nonces||=[duplicate.nonce];if(!duplicate.nonces.includes(nonce)){requireValue(duplicate.nonces.length<32,'该事件重试次数达到上限','event_retry_limit');duplicate.nonces.push(nonce);}response={accepted:true,deduplicated:true,receiptId:duplicate.id,taskId:duplicate.taskId,triggered:!!duplicate.taskId,conditionReason:duplicate.conditionReason||null};return;}
   requireValue((s.eventReceipts||[]).length<10000,'事件收据存储已满，需要本机维护；不会遗忘去重记录','event_receipt_limit');
   const started=Number(timestamp),deadline=started+current.executionWindowSeconds*1000;requireValue(at<deadline,'事件执行窗口已过，不补跑','event_window_expired');
   const decision=evaluateEventCondition(current.condition,current.conditionState,event.payload||{},{at,eventId:event.eventId});if(current.condition)current.conditionState=decision.state;
   if(!decision.trigger){const receipt={id:receiptId,ruleId,eventId:event.eventId,nonce,nonces:[nonce],bodySha256,authorizationId:current.authorization.id,taskId:null,receivedAt:iso(at),signedAt:iso(started),payloadSha256:null,conditionReason:decision.reason};(s.eventReceipts||=[]).push(receipt);response={accepted:true,deduplicated:false,triggered:false,conditionReason:decision.reason,receiptId,taskId:null};return;}
   const payload=current.authorization.includePayload?sanitizedPayload(event.payload||{},current.authorization.payloadFields):null;
   const task=this.engine.newTask({prompt:current.prompt,roleId:current.roleId,kind:current.kind,source:'event',cloudConsent:current.authorization.cloudConsent,memoryConsent:current.authorization.memoryConsent,memoryMode:'session_only',eventRuleId:current.id,eventReceiptId:receiptId,eventAuthorization:current.authorization,...(payload?{eventData:payload}:{}),submittedAt:iso(started),deadlineAt:iso(deadline),maxRunSeconds:current.maxRunSeconds});
   const receipt={id:receiptId,ruleId,eventId:event.eventId,nonce,nonces:[nonce],bodySha256,authorizationId:current.authorization.id,taskId:task.id,receivedAt:iso(at),signedAt:iso(started),payloadSha256:payload?requestHash(JSON.stringify(payload)):null,conditionReason:decision.reason};
   (s.eventReceipts||=[]).push(receipt);s.tasks.push(task);response={accepted:true,deduplicated:false,triggered:true,conditionReason:decision.reason,receiptId,taskId:task.id};
  });
  queueMicrotask(()=>this.engine.pump());return response;
 }
}
const shaBody=bytes=>createHash('sha256').update(bytes).digest('hex');
