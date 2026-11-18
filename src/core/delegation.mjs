import {delegationCapacity} from './delegation-limits.mjs';
import {randomUUID} from 'node:crypto';
import {createTaskContract,validateTaskContract,requestHash,taskDeadline} from './task-contract.mjs';
import {requireValue,shortText} from './errors.mjs';
import {attributedInstruction} from './instruction-scope.mjs';

const LIVE_PARENT=new Set(['running','waiting_approval','waiting_children','queued']);
const MUTATIONS=new Set(['modify','send','send_attachment','send_mail','publish_media','call','create_schedule','prepare_purchase','submit_order','delete','publish','cancel_order','capture','request_refund','return_goods','start_navigation','book_service','reschedule_booking','request_ride']);
const INJECTION=/(?:忽略|绕过|覆盖|取消).{0,16}(?:授权|限制|规则|安全|系统指令)|(?:system|developer)\s*(?:prompt|message)|(?:引用|转述|粘贴)/i;
const normalize=value=>String(value||'').normalize('NFKC').replace(/\s+/g,'');
const same=(left,right)=>JSON.stringify(left)===JSON.stringify(right);
function rootSource(parent){
 const contract=parent.taskContract;
 return parent.source==='delegation'?structuredClone(parent.delegationGrant.rootSource):{taskId:parent.id,messageId:contract.source.originMessageId||contract.source.messageId,contentSha256:contract.source.originContentSha256||contract.source.contentSha256,...(parent.source==='event'?{kind:'event_rule_configuration',ruleId:parent.eventRuleId,authorizationId:parent.eventAuthorization.id}:{})};
}
function childContract(parent,prompt,at){
 const contract=parent.taskContract,sourceMessageId=contract.source.originMessageId||contract.source.messageId;
 const source=parent.messages?.find(message=>message.id===sourceMessageId);
 // A relative date/time grant must refer to the accepted user's clock. Using
 // verification time here also made identical explicit schedules drift by ms.
 const referenceAt=contract.objects?.schedule?.referenceAt||source?.at||parent.createdAt||contract.createdAt;
 return createTaskContract({id:'delegation-candidate',source:'user',prompt,timezone:parent.timezone,messages:[{id:'candidate',role:'user',content:prompt,at:referenceAt}],cloudConsent:true,memoryConsent:false},{at});
}
function navigationBound(parent,child){
 if(!child.allowedApps.length)return false;
 let target=normalize(child.goal).replace(/[“”「」"]/g,'');
 for(const app of child.allowedApps)target=target.replaceAll(normalize(app),'');
 target=target.replace(/(?:请|帮我|替我|先|再|然后|并且|打开|进入|查看|看看|浏览|查询|搜索|查找|阅读|读取|手机|应用|页面|界面|一下|里面|里的|的)/g,'');
 const tokens=target.split(/[，。；、!！?？]/).filter(Boolean);
 return tokens.every(token=>normalize(parent.goal).includes(token));
}
function deriveScope(parent,prompt,at){
 const original=parent.taskContract,candidate=childContract(parent,prompt,at);
 const allowedApps=candidate.allowedApps.filter(app=>original.allowedApps.includes(app));
 let effects=candidate.effects.filter(effect=>original.effects.includes(effect));
 const childObjects=candidate.objects,parentObjects=original.objects||{};
 const keys=Object.keys(childObjects).filter(key=>!['rawRequest','operation'].includes(key));
 const objectsBound=keys.every(key=>Object.hasOwn(parentObjects,key)&&same(childObjects[key],parentObjects[key]));
 const newEffect=candidate.effects.some(effect=>MUTATIONS.has(effect)&&(!original.effects.includes(effect)||['prepare_purchase','submit_order','delete','publish','cancel_order','capture'].includes(effect)));
 // A model-derived recipient, message, amount, time or navigation destination is not new authority.
 if(INJECTION.test(prompt)||attributedInstruction(prompt)||candidate.intent!=='task'||newEffect||!objectsBound){effects=[];return {allowedApps:[],effects,objects:childObjects,constraints:structuredClone(original.constraints)};}
 const required={send:['recipient','content'],call:childObjects.dialNumber?['dialNumber']:['dialRecipient'],modify:['field','value'],create_schedule:['when']};
 effects=effects.filter(effect=>{
  if(!MUTATIONS.has(effect))return true;
  const fields=required[effect];if(!fields)return false; // Commerce/delete/publish await concrete object and result schemas.
  return fields.every(key=>Object.hasOwn(childObjects,key)&&Object.hasOwn(parentObjects,key)&&same(childObjects[key],parentObjects[key]));
 });
 const mutation=effects.some(effect=>MUTATIONS.has(effect));
 if(!allowedApps.length)effects=effects.filter(effect=>effect==='read');
 else if(!mutation&&!navigationBound(original,candidate))effects=[];
 return {allowedApps:effects.length?allowedApps:[],effects,objects:childObjects,constraints:structuredClone(original.constraints)};
}
function parentValid(parent,store,at,seen){
 if(!parent||!LIVE_PARENT.has(parent.status)||parent.cloudConsent!==true||taskDeadline(parent)<=at)return false;
 if(parent.source==='delegation'&&!parent.delegationGrant)return false;
 const latest=parent.messages?.filter(m=>m.role==='user').at(-1);if(latest?.id!==parent.taskContract?.source?.messageId)return false;
 if(store.data?.roles?.find(role=>role.id===parent.roleId)?.deletedAt||store.data?.recoveryFence?.required)return false;
 return validateTaskContract(parent,{store,at,seen}).valid;
}
export function deriveDelegation(parent,childRequest,store,{at=Date.now()}={}){
 requireValue(store?.data&&Array.isArray(store.data.tasks),'子任务缺少实时父任务状态');
 const current=store.data.tasks.find(task=>task.id===parent?.id);
 requireValue(current&&parent.taskContract?.id===current.taskContract?.id&&parent.taskContract?.revision===current.taskContract?.revision&&parentValid(current,store,at,new Set()),'父任务授权已失效，不能派生子任务');
 requireValue(childRequest&&typeof childRequest==='object'&&Object.keys(childRequest).every(key=>['prompt','roleId'].includes(key)),'子任务只能指定目标和角色');
 const prompt=shortText(childRequest.prompt),scope=deriveScope(current,prompt,at),source=rootSource(current);
 const grant={schemaVersion:1,id:randomUUID(),parentTaskId:current.id,parentContractId:current.taskContract.id,parentContractRevision:current.taskContract.revision,parentContractSha256:requestHash(JSON.stringify(current.taskContract)),rootSource:source,childPromptSha256:requestHash(prompt),createdAt:new Date(at).toISOString(),expiresAt:Number.isFinite(taskDeadline(current))?new Date(taskDeadline(current)).toISOString():null,...scope};
 return {prompt,roleId:childRequest.roleId||current.roleId,parentId:current.id,depth:(current.depth||0)+1,source:'delegation',originSource:current.originSource||current.source||'user',cloudConsent:current.cloudConsent,memoryConsent:current.memoryConsent,memoryMode:current.memoryMode||'default',submittedAt:new Date(at).toISOString(),deadlineAt:grant.expiresAt,delegationGrant:grant,...(current.remoteDeviceId?{remoteDeviceId:current.remoteDeviceId}:{}),...(current.remoteControlEpoch!==undefined?{remoteControlEpoch:current.remoteControlEpoch}:{})};
}
export function validateDelegationGrant(task,store,{at=Date.now(),seen=new Set()}={}){
 const fail=reason=>({valid:false,reason});const grant=task?.delegationGrant;
 if(!grant||grant.schemaVersion!==1||grant.parentTaskId!==task.parentId)return fail('delegation_missing');
 if(!store?.data?.tasks)return fail('delegation_requires_live_parent');
 if(seen.has(task.id)||seen.size>3)return fail('delegation_cycle');const lineage=new Set(seen);lineage.add(task.id);
 const parent=store.data.tasks.find(row=>row.id===grant.parentTaskId);
 if(!parentValid(parent,store,at,lineage))return fail('delegation_parent_inactive');
 const contract=parent.taskContract,prompt=task.messages?.filter(m=>m.role==='user').at(-1)?.content||task.prompt;
 if(grant.revokedAt||grant.parentContractId!==contract.id||grant.parentContractRevision!==contract.revision||grant.parentContractSha256!==requestHash(JSON.stringify(contract))||grant.childPromptSha256!==requestHash(prompt))return fail('delegation_source_changed');
 const grantDeadline=grant.expiresAt===null?Infinity:Date.parse(grant.expiresAt);
 if(!same(grant.rootSource,rootSource(parent))||Number.isNaN(grantDeadline)||grantDeadline>taskDeadline(parent)||grantDeadline<=at||taskDeadline(task)>grantDeadline)return fail('delegation_bounds_changed');
 if(task.cloudConsent&&!parent.cloudConsent||task.memoryConsent&&!parent.memoryConsent||task.remoteDeviceId!==parent.remoteDeviceId||task.remoteControlEpoch!==parent.remoteControlEpoch)return fail('delegation_consent_changed');
 const scope=deriveScope(parent,prompt,at);
 if(!['allowedApps','effects','objects','constraints'].every(key=>same(grant[key],scope[key])))return fail('delegation_scope_changed');
 return {valid:true,reason:null,parent,grant};
}

// Completed work releases a concurrency slot; history remains available for deduplication.
export function assertDelegationCapacity(task,store){
 const settled=new Set(['completed','ready_for_user','failed','cancelled','expired','blocked','needs_input','needs_review']);
 const pending=(task.children||[]).filter(id=>{const child=store.data.tasks.find(t=>t.id===id);return child&&!settled.has(child.status);});
 requireValue(pending.length<delegationCapacity(store),'已达到用户配置的待执行子任务预算，请先等待已有任务完成','delegation_capacity');
}
