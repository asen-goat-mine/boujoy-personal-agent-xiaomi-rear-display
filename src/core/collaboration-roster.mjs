import {groupTaskLineage,groupTaskContext} from './groups.mjs';
import {createHash} from 'node:crypto';
import {AppError} from './errors.mjs';
import {topLevelRoleMentionNames,matchingMentionRoles} from './role-mentions.mjs';
// Role discovery and explicit user invitations are planning context, never grants.
const normalize=value=>String(value||'').normalize('NFKC').trim();
const EXTERNAL=/(?:网页|页面|广告|商家|模型|知识库|附件|文档).{0,12}(?:说|写着|内容|原文|显示|要求|建议|指示)|引用|转述|粘贴|以下(?:是|为).{0,12}(?:原文|内容|消息)/;
const PENDING=new Set(['queued','running','waiting_approval','waiting_children']);
export function availableRoles(store){return (store?.data?.roles||[]).filter(role=>!role.hidden&&!role.deletedAt&&typeof role.id==='string'&&typeof role.name==='string'&&role.name.trim()).map(role=>({id:role.id,name:role.name.trim(),description:String(role.description||'').slice(0,500)}));}
const mentionNames=raw=>[...new Set(topLevelRoleMentionNames(raw).map(normalize))];
export function explicitCollaboration(task,{store}={}){
 const empty={requested:false,valid:false,roleIds:[],roles:[],ambiguousNames:[],unknownNames:[],reason:null,sourceMessageId:null,planningOnly:true},message=task?.messages?.filter(m=>m.role==='user').at(-1);
 if(!message||task.source&&task.source!=='user'||task.taskContract?.source?.kind&&task.taskContract.source.kind!=='user'||message.externalContent===true||message.external_content===true||typeof message.content!=='string'||EXTERNAL.test(message.content))return {...empty,reason:'not_direct_user_invitation'};
 if(groupTaskContext(task,store))return {...empty,reason:'group_already_routed'};
 const names=mentionNames(message.content);if(!names.length)return empty;
 const roles=availableRoles(store),selected=[],ambiguousNames=[],unknownNames=[];
 for(const name of names){const matches=matchingMentionRoles(roles,name);if(matches.length>1)ambiguousNames.push(name);else if(!matches.length)unknownNames.push(name);else selected.push(matches[0]);}
 const valid=!ambiguousNames.length&&!unknownNames.length&&selected.length>=1;
 return {...empty,requested:true,valid,roleIds:valid?selected.map(role=>role.id):[],roles:valid?selected:[],ambiguousNames,unknownNames,sourceMessageId:message.id||null,reason:ambiguousNames.length?'ambiguous_role_name':unknownNames.length?'unknown_role_name':selected.length<1?'requires_role':null};
}
export function childTaskSummaries(task,{store}={}){return (task?.children||[]).map(id=>{const child=store?.data?.tasks?.find(row=>row.id===id);if(!child)return {id,status:'missing',currentAuthorization:true,roleId:null,roleName:'未知助理',title:'',result:null,blockedReason:'子任务记录缺失',artifacts:[]};const role=(store.data.roles||[]).find(row=>row.id===child.roleId),grant=child.delegationGrant,currentAuthorization=!grant||grant.parentContractId===task.taskContract?.id&&grant.parentContractRevision===task.taskContract?.revision;return {id,roleId:child.roleId,roleName:role?.name||'已移除的助理',title:child.title||'',status:child.status,currentAuthorization,result:child.result||null,blockedReason:child.blockedReason||'',artifacts:(store.data.artifacts||[]).filter(a=>a.taskId===id&&a.kind!=='input').map(({id,name,mime,size})=>({id,name,mime,size}))};});}
export function collaborationState(task,{store}={}){const children=childTaskSummaries(task,{store}),current=children.filter(child=>child.currentAuthorization),pending=current.filter(child=>PENDING.has(child.status)),incomplete=current.filter(child=>!PENDING.has(child.status)&&child.status!=='completed');return {children,pending,incomplete,allCompleted:current.length>0&&current.every(child=>child.status==='completed'),summaryReady:current.length>0&&pending.length===0};}

const mutationLocks=new WeakMap();
const fail=(code,message)=>{const error=new AppError(code,message,409);error.dispatchState='not_sent';throw error;};
export function collaborationLineage(task,{store}={}){
 const rows=store?.data?.tasks||[],visited=new Set();let root=task;
 while(root?.parentId&&!visited.has(root.id)){visited.add(root.id);const parent=rows.find(row=>row.id===root.parentId);if(!parent)break;root=parent;}
 const groupIds=groupTaskLineage(task,store);
 const ids=groupIds.size?groupIds:new Set(root?[root.id]:[]);if(groupIds.size)root=rows.find(row=>row.id===groupIds.values().next().value)||root;let changed=true;while(changed){changed=false;for(const row of rows)if(ids.has(row.parentId)&&!ids.has(row.id)){ids.add(row.id);changed=true;}}
 return {root,ids};
}
export function assertCollaborationClear(store,taskId){
 const {ids}=collaborationLineage(store.task(taskId),{store});if(ids.size<2)return;
 if(store.data.actions.some(row=>ids.has(row.taskId)&&['executing','unknown'].includes(row.status)&&!row.resolution)||store.data.tasks.some(row=>ids.has(row.id)&&row.status==='unknown_result'))fail('collaboration_result_unresolved','协作链中有在途或未核实的操作；先核实原回执，不能由总助理或另一助理重新执行。');
}
export function isCollaborationMutation(tool,args={}){
 if(tool==='phone_use')return args.action!=='read';
 if(tool==='phone_prepare_attachment')return args.action!=='status';
 return ['phone_action','phone_open_app','phone_search','phone_prepare_payment','browser_open','browser_action'].includes(tool);
}
export async function withCollaborationMutation(store,taskId,run){
 const {root}=collaborationLineage(store.task(taskId),{store});let locks=mutationLocks.get(store);if(!locks){locks=new Set();mutationLocks.set(store,locks);}const key=root?.id||taskId;
 if(locks.has(key))fail('collaboration_action_busy','此协作链已有正在处理的操作，不能并行派发另一操作。');
 assertCollaborationClear(store,taskId);locks.add(key);try{return await run();}finally{locks.delete(key);}
}
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
export function collaborationEffect(task,{store,packageName,plan,kind}={}){
 if(!plan||!packageName)return null;
 const {root}=collaborationLineage(task,{store}),source=task.delegationGrant?.rootSource||root?.taskContract?.source;
 const groupIds=groupTaskLineage(task,store),originSource=groupIds.size?(root?.delegationGrant?.rootSource||root?.taskContract?.source):source;
 const origin={taskId:groupIds.size?root?.delegationGrant?.rootSource?.taskId||root?.id:task.delegationGrant?.rootSource?.taskId||root?.id,messageId:originSource?.originMessageId||originSource?.messageId,contentSha256:originSource?.originContentSha256||originSource?.contentSha256};
 if(!origin.messageId||!origin.contentSha256)return null;
 const semantic={origin,packageName,plan};return {...semantic,kind,key:createHash('sha256').update(JSON.stringify(canonical(semantic))).digest('hex')};
}
export function assertCollaborationEffect(store,taskId,effect,{commitKinds,planForTask}={}){
 const {ids}=collaborationLineage(store.task(taskId),{store});if(ids.size<2||!effect)return;
 for(const row of store.data.actions){
  if(!ids.has(row.taskId)||!['executing','completed','unknown'].includes(row.status)||!commitKinds.has(row.phoneEffect?.kind))continue;
  let previous=row.collaborationEffect;
  if(!previous){const owner=store.data.tasks.find(task=>task.id===row.taskId),plan=owner&&planForTask(owner);previous=owner&&collaborationEffect(owner,{store,packageName:row.phoneEffect.packageName,plan,kind:row.phoneEffect.kind});}
  if(!previous||previous.key===effect.key)fail('collaboration_effect_already_attempted','此协作目标已经提交过；更换助理或改写分工不会获得再次发送、保存或提交的权限。');
 }
}
