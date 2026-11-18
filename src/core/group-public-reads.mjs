import {createTaskContract,taskDeadline} from './task-contract.mjs';

// Only Broker-confirmed public GET results enter this short-lived cache. The
// persisted handoff carries receipt IDs, never the page or a new action grant.
const caches=new WeakMap();
const MAX_READS=32,MAX_HANDOFF_REFS=6,MAX_CHARS=12000,TTL_MS=10*60*1000;
const canonical=value=>String(value||'').normalize('NFKC').replace(/\s+/gu,'');

function scopeKey(groupId,task,root){
 return JSON.stringify([groupId,task.id,task.taskContract.id,task.taskContract.revision,root.taskId,root.messageId,root.contentSha256]);
}

export function rememberPublicGroupRead(store,{groupId,task,root,ref,page,expiresAt,at=Date.now()}){
 if(!['running','waiting_approval'].includes(task.status)||!ref||page?.untrustedContent!==true||typeof page.content!=='string'||!/^https?:\/\//i.test(page.url||''))return;
 const until=Math.min(at+TTL_MS,taskDeadline(task),Date.parse(expiresAt));
 if(!Number.isFinite(until)||until<=at)return;
 let cache=caches.get(store);if(!cache){cache=new Map();caches.set(store,cache);}
 while(cache.size>=MAX_READS){const oldest=cache.keys().next().value;clearTimeout(cache.get(oldest).timer);cache.delete(oldest);}
 const timer=setTimeout(()=>cache.delete(ref),Math.max(1,until-at));timer.unref();
 cache.set(ref,{scope:scopeKey(groupId,task,root),at,until,timer,handoffs:new Set(),title:canonical(String(page.title||'').slice(0,300)),body:canonical(page.content.slice(0,MAX_CHARS))});
}

export function publicReadRefsForHandoff(store,groupId,source,root,handoffId,at=Date.now()){
 const key=scopeKey(groupId,source,root),cache=caches.get(store);
 if(!cache)return [];
 const reads=[...cache].filter(([,row])=>row.scope===key&&row.until>at).slice(-MAX_HANDOFF_REFS);
 for(const [,row] of reads){if(row.handoffs.size>=8)row.handoffs.delete(row.handoffs.values().next().value);row.handoffs.add(handoffId);}
 return reads.map(([ref])=>ref);
}

export function boundedPublicField(field){
 const fact=canonical(field);
 if(fact.length<2||fact.length>80||/[\u0000-\u001f<>]|https?:\/\/|忽略|绕过|系统指令|登录|登陆|上传|执行命令|运行命令|下单|转账|付款|支付|密码|验证码|\b(?:log\s*in|sign\s*in|send|delete|upload|execute|call|transfer|password|OTP)\b/i.test(field))return false;
 // The intent parser can only reject action-shaped data here. It never grants
 // an effect, submits a task, or executes a webpage instruction.
 const probe=createTaskContract({id:'public-field-probe',source:'user',prompt:field,messages:[{id:'probe',role:'user',content:field}],cloudConsent:false});
 return probe.intent==='task'&&probe.effects.every(effect=>['read','navigate'].includes(effect));
}

export function publicReadSupportsField(store,{group,incoming,source,root,field,at=Date.now()}){
 const fact=canonical(field);
 if(!incoming?.publicReadRefs?.length||incoming.groupId!==group.id||incoming.fromTaskId!==source?.id||!group.memberRoleIds.includes(source.roleId))return false;
 if(!boundedPublicField(field))return false;
 if(![incoming.context,incoming.prompt].some(text=>canonical(text).includes(fact)))return false;
 const key=scopeKey(group.id,source,root),cache=caches.get(store);
 return incoming.publicReadRefs.some(ref=>{
  const row=cache?.get(ref);
  return row?.scope===key&&row.handoffs.has(incoming.id)&&row.at<=Date.parse(incoming.createdAt)&&row.until>at&&(row.title.includes(fact)||row.body.includes(fact));
 });
}
