import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {ORIGIN} from '../config.mjs';
import {publicURL} from '../adapters/browser.mjs';
import {requireValue,AppError} from './errors.mjs';
import {signEventEnvelope} from './event-triggers.mjs';

const ID=/^[a-f0-9-]{36}$/i;
const digest=v=>createHash('sha256').update(v).digest('hex');
const iso=at=>new Date(at).toISOString();
export class SignedEventMonitor{
 constructor({store,secrets,eventTriggers,origin=ORIGIN,clock=Date.now}={}){const url=new URL(origin);requireValue(url.protocol==='http:'&&url.hostname==='127.0.0.1'&&!url.username&&!url.password,'监控投递入口必须为本应用loopback');Object.assign(this,{store,secrets,eventTriggers,origin:url.origin,clock});this.running=new Map();this.closed=false;}
 list(){return (this.store.data.eventMonitors||[]).filter(r=>!r.deletedAt).map(({pending,credentialName,...row})=>({...row,credential:!!credentialName,pending:!!pending}));}
 row(id){const row=this.store.data.eventMonitors?.find(r=>r.id===id&&!r.deletedAt);requireValue(row,'监控不存在','not_found');return row;}
 valid(id,revision){const row=this.row(id),rule=this.store.data.eventRules?.find(r=>r.id===row.ruleId);requireValue(!this.closed&&!this.store.data.recoveryFence?.required&&!this.store.data.schedulerPaused&&row.enabled&&(!revision||row.revision===revision)&&rule?.enabled&&!rule.deletedAt&&rule.authorization&&!rule.authorization.revokedAt&&rule.authorization.id===row.authorizationId&&(!rule.authorization.expiresAt||Date.parse(rule.authorization.expiresAt)>this.clock())&&!this.store.data.roles.some(r=>r.id===rule.roleId&&r.deletedAt),'监控或规则授权已失效','monitor_not_authorized');return {row,rule};}
 async configure(input){
  requireValue(input&&typeof input==='object'&&Object.keys(input).every(k=>['id','name','ruleId','url','fields','intervalSeconds','allowLocal','enabled','authToken'].includes(k)),'监控参数无效');
  const previous=input.id?this.row(input.id):null,merged={...previous,...input};requireValue(!input.id||ID.test(input.id),'监控编号无效');
  requireValue(typeof merged.name==='string'&&merged.name.trim().length>0&&merged.name.length<=120&&ID.test(merged.ruleId),'监控名称或规则无效');
  const rule=this.eventTriggers.read(merged.ruleId);requireValue(rule.enabled&&rule.authorization&&!rule.authorization.revokedAt,'请先启用具体事件规则','monitor_not_authorized');
  requireValue(Array.isArray(merged.fields)&&merged.fields.length>0&&merged.fields.length<=16&&new Set(merged.fields).size===merged.fields.length&&merged.fields.every(k=>/^[a-zA-Z][\w]{0,39}$/.test(k)),'监控字段必须明确且唯一');requireValue(!rule.condition||merged.fields.includes(rule.condition.field),'监控字段必须包含规则条件字段');
  requireValue(Number.isInteger(merged.intervalSeconds)&&merged.intervalSeconds>=30&&merged.intervalSeconds<=86400,'监控间隔为30秒至1天');
  const url=new URL(merged.url);requireValue(!url.username&&!url.password&&!url.hash&&!url.search,'监控地址不能包含凭证或参数');const local=url.protocol==='http:'&&url.hostname==='127.0.0.1'&&merged.allowLocal===true;requireValue(local||url.protocol==='https:','监控来源需要HTTPS或明确允许的本机服务');requireValue(url.origin!==this.origin,'监控来源不能是本应用自身');if(!local)await publicURL(url.href);
  requireValue(input.authToken===undefined||typeof input.authToken==='string'&&input.authToken.length>=8&&input.authToken.length<=8192&&!/[\r\n]/.test(input.authToken),'监控认证凭证无效');
  const id=previous?.id||randomUUID(),credentialName='monitor-'+id;requireValue(input.authToken||previous?.credentialName,'监控来源需要明确的认证凭证');if(input.authToken)await this.secrets.set(credentialName,input.authToken);
  const at=this.clock(),row={id,name:merged.name.trim(),ruleId:rule.id,url:url.href,fields:[...merged.fields],intervalSeconds:merged.intervalSeconds,allowLocal:local,enabled:merged.enabled!==false,credentialName,authorizationId:rule.authorization.id,revision:(previous?.revision||0)+1,nextAt:iso(at),createdAt:previous?.createdAt||iso(at),updatedAt:iso(at),lastAt:previous?.lastAt||null,lastOutcome:null,lastError:null,pending:null};
  this.running.get(id)?.abort();this.store.transaction(s=>{s.eventMonitors||=[];const old=s.eventMonitors.find(r=>r.id===id);if(old)Object.assign(old,row);else s.eventMonitors.push(row);});return this.list().find(r=>r.id===id);
 }
 async remove(id){const row=this.row(id);this.running.get(id)?.abort();this.store.transaction(s=>{const r=s.eventMonitors.find(x=>x.id===id);r.enabled=false;r.deletedAt=iso(this.clock());r.pending=null;});await this.secrets.remove(row.credentialName);return {removed:true,id};}
 async poll(id){
  requireValue(!this.running.has(id),'该监控正在读取','monitor_busy');const {row,rule}=this.valid(id),revision=row.revision,controller=new AbortController();this.running.set(id,controller);
  const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(15000)]),check=()=>{requireValue(!signal.aborted,'监控已停止','cancelled');return this.valid(id,revision);};
  try{
   let pending=row.pending;
   if(pending&&this.clock()-Number(pending.timestamp)>300000){this.store.transaction(s=>{const r=s.eventMonitors.find(x=>x.id===id);r.pending=null;r.lastOutcome='expired';r.nextAt=iso(this.clock()+r.intervalSeconds*1000);});return {monitorId:id,outcome:'expired'};}
   if(!pending){
    const token=await this.secrets.get(row.credentialName);check();requireValue(token,'监控来源凭证不可用','monitor_credential_missing');if(!row.allowLocal)await publicURL(row.url);check();
    const response=await fetch(row.url,{headers:{Authorization:'Bearer '+token,Accept:'application/json'},redirect:'error',signal});requireValue(response.ok&&/application\/json/i.test(response.headers.get('content-type')||''),'监控来源未返回有效JSON','monitor_source_failed');let size=0,chunks=[];for await(const chunk of response.body){size+=chunk.length;requireValue(size<=16384,'监控来源响应过大','monitor_source_limit');chunks.push(chunk);}const source=JSON.parse(Buffer.concat(chunks).toString('utf8'));requireValue(source&&typeof source==='object'&&!Array.isArray(source),'监控来源格式无效');const payload={};for(const field of row.fields){const value=source[field];requireValue(Object.hasOwn(source,field)&&(typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value)||typeof value==='string'&&value.length<=256&&!/[\u0000-\u001f]/.test(value)),'监控缺少批准的有限字段','monitor_source_invalid');payload[field]=value;}check();
    const eventId='monitor-'+randomUUID(),timestamp=String(this.clock()),nonce=randomBytes(18).toString('base64url'),rawBody=JSON.stringify({eventId,type:rule.eventType,payload});pending={eventId,timestamp,nonce,rawBody,bodySha256:digest(rawBody)};
    this.store.transaction(s=>{check();s.eventMonitors.find(x=>x.id===id).pending=pending;});
   }
   const signingKey=await this.secrets.get('event-'+rule.id);check();requireValue(signingKey,'事件签名凭证不可用','monitor_credential_missing');requireValue(digest(pending.rawBody)===pending.bodySha256,'监控待投递记录损坏','monitor_pending_corrupt');
   const signature=signEventEnvelope({secret:signingKey,ruleId:rule.id,timestamp:pending.timestamp,nonce:pending.nonce,rawBody:Buffer.from(pending.rawBody)});
   const response=await fetch(this.origin+'/events/ingest/'+rule.id,{method:'POST',headers:{'Content-Type':'application/json','x-boujoy-event-time':pending.timestamp,'x-boujoy-event-nonce':pending.nonce,'x-boujoy-event-signature':signature},body:pending.rawBody,redirect:'error',signal});const result=await response.json();requireValue(response.ok&&result.accepted===true,'本机事件未确认接收','monitor_delivery_failed');check();
   const outcome=result.conditionReason||'accepted';this.store.transaction(s=>{check();const r=s.eventMonitors.find(x=>x.id===id);r.pending=null;r.lastAt=iso(this.clock());r.nextAt=iso(this.clock()+r.intervalSeconds*1000);r.lastOutcome=outcome;r.lastError=null;r.lastReceiptId=result.receiptId;r.lastTaskId=result.taskId||null;});return {monitorId:id,outcome,taskId:result.taskId||null,receiptId:result.receiptId};
  }catch(error){const current=this.store.data.eventMonitors?.find(r=>r.id===id);if(current&&!current.deletedAt&&current.revision===revision)this.store.transaction(s=>{const r=s.eventMonitors.find(x=>x.id===id);r.lastAt=iso(this.clock());r.lastError=error.code||'monitor_failed';r.nextAt=iso(this.clock()+r.intervalSeconds*1000);});throw error;
  }finally{if(this.running.get(id)===controller)this.running.delete(id);}
 }
 start(){this.closed=false;if(this.timer)return;this.timer=setInterval(()=>{for(const row of this.store.data.eventMonitors||[])if(row.enabled&&!row.deletedAt&&!this.running.has(row.id)&&Date.parse(row.nextAt)<=this.clock()){try{this.valid(row.id);}catch{continue;}void this.poll(row.id).catch(()=>{});}},1000);this.timer.unref();}
 close(){this.closed=true;clearInterval(this.timer);this.timer=null;for(const controller of this.running.values())controller.abort();}
}
