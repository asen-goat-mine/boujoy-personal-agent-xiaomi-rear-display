import {createHash,randomUUID} from 'node:crypto';
import {requireValue,shortText} from './errors.mjs';
import {groupTaskContext,groupTaskAccess} from './groups.mjs';
import {validateTaskContract,requestHash} from './task-contract.mjs';
import {parseLocalReminderRequest} from './schedule-contract.mjs';
import {affirmativeInstructions} from './instruction-scope.mjs';
import {boundedPublicField,publicReadSupportsField} from './group-public-reads.mjs';

const normalized=value=>String(value||'').normalize('NFKC').replace(/[\s\p{P}]/gu,'');
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function sourceFor(task,store){
 const rootRef=task.delegationGrant?.rootSource,root=rootRef?store.data.tasks.find(t=>t.id===rootRef.taskId):task;
 const contract=root?.taskContract,source=rootRef||contract?.source;
 const message=root?.messages?.find(m=>m.id===(source?.originMessageId||source?.messageId)&&m.role==='user'&&!m.externalContent&&!m.external_content);
 const expected=source?.originContentSha256||source?.contentSha256;
 return root?.source==='user'&&!root.parentId&&message&&requestHash(message.content)===expected?{root,message}:null;
}
export function groupReminderAuthority(task,store,{at=Date.now(),timezone='Asia/Shanghai'}={}){
 const context=groupTaskContext(task,store),group=store.data.groups?.find(g=>g.id===context?.groupId&&!g.archivedAt),source=sourceFor(task,store);
 if(!group||!source||source.root.taskContract?.intent!=='task'||!group.memberRoleIds.includes(task.roleId)||!store.data.roles.some(r=>r.id===task.roleId&&!r.hidden&&!r.deletedAt)||!source.root.cloudConsent||!validateTaskContract(task,{store,at}).valid||!groupTaskAccess(source.root,group,store))return null;
 const schedule=parseLocalReminderRequest(source.message.content,{referenceAt:source.message.at||source.root.createdAt,timezone:source.root.timezone||timezone});
 if(!schedule||Date.parse(schedule.at)<=at)return null;
 return {...source,group,schedule};
}
export function planGroupReminder(task,store,args,options={}){
 const authority=groupReminderAuthority(task,store,options);requireValue(authority,'当前群没有来源有效且时间明确的单次提醒授权','group_standing_unavailable');
 const {group,root,message,schedule}=authority;
 requireValue(args.kind==='once'&&args.taskKind==='reminder'&&Date.parse(args.at)===Date.parse(schedule.at)&&(!args.timezone||args.timezone===schedule.timezone)&&!args.time&&!args.weekdays?.length,'群提醒只能在原用户指定的单次时刻本机送达，不能改变时间或变成后台执行','group_reminder_scope');
 const requestedName=shortText(args.name,'提醒名称',120),prompt=shortText(args.prompt,'提醒正文',2000);
 if(schedule.name)requireValue(requestedName===schedule.name,'提醒名称须与原用户指定的一致','group_reminder_scope');
 const name=schedule.name||'群提醒';
 const verified=(store.data.groupMessages||[]).filter(m=>m.groupId===group.id&&m.kind==='assistant'&&m.taskId).filter(m=>{const t=store.data.tasks.find(t=>t.id===m.taskId);return t?.status==='completed'&&t.report?.evidence?.length&&(t.id===root.id||t.delegationGrant?.rootSource?.taskId===root.id);});
 const userText=normalized(affirmativeInstructions(message.content)),reports=verified.map(m=>normalized(m.content));
 const pieces=prompt.split(/[、，,；;。：:\n]|和|及/).map(piece=>piece.trim().replace(/^(?:(?:提醒(?:你|我|我们)?|请|记得|今晚|今天|现在|做|准备)\s*)+/,'')).filter(piece=>normalized(piece));
 const incoming=(store.data.groupHandoffs||[]).find(h=>h.taskId===task.id&&h.fromTaskId===task.parentId&&h.groupId===group.id);
 const source=store.data.tasks.find(t=>t.id===incoming?.fromTaskId);
 const rootRef={taskId:root.id,messageId:message.id,contentSha256:requestHash(message.content)};
 requireValue(pieces.length>0&&pieces.every(field=>userText.includes(normalized(field))||boundedPublicField(field)&&reports.some(report=>report.includes(normalized(field)))||publicReadSupportsField(store,{group,incoming,source,root:rootRef,field,at:options.at})),'提醒正文只能复用原用户内容、本群已核实结果或交班前实际读到的公开片段，不能引入私聊内容或额外事项','group_reminder_content');
 const authorityRecord={schemaVersion:1,groupId:group.id,rootTaskId:root.id,messageId:message.id,contentSha256:requestHash(message.content),at:schedule.at,timezone:schedule.timezone,nameSha256:requestHash(name),promptSha256:requestHash(prompt)};
 const key=digest([group.id,root.id,message.id,schedule.at]),existing=store.data.routines.find(r=>r.groupReminderKey===key);
 const spent=(store.data.groupMessages||[]).some(m=>m.groupId===group.id&&m.groupReminderKey===key&&m.routineId);
 requireValue(existing?existing.enabled:!spent,'原提醒已暂停、已送达或已删除，同一用户授权不能再次创建','group_reminder_consumed');
 if(existing)requireValue(existing.name===name&&existing.prompt===prompt,'同一群提醒授权已经使用，不能另建不同正文','group_reminder_conflict');
 return {existing,input:{name,prompt,roleId:task.roleId,kind:'once',taskKind:'reminder',nextAt:schedule.at,timezone:schedule.timezone,cloudConsent:false,memoryConsent:false},binding:{groupId:group.id,groupReminderAuthority:authorityRecord,groupReminderKey:key,originTaskId:task.id,createdFrom:'group',conversationId:task.conversationId||task.id}};
}
export function groupReminderAvailable(routine,store,{slot=routine?.nextAt}={}){
 const auth=routine?.groupReminderAuthority,group=store.data.groups?.find(g=>g.id===routine?.groupId&&!g.archivedAt),root=store.data.tasks.find(t=>t.id===auth?.rootTaskId),message=root?.messages?.find(m=>m.id===auth?.messageId&&m.role==='user'&&!m.externalContent&&!m.external_content);
 return !!(auth?.schemaVersion===1&&group&&auth.groupId===group.id&&group.memberRoleIds.includes(routine.roleId)&&store.data.roles.some(r=>r.id===routine.roleId&&!r.hidden&&!r.deletedAt)&&routine.kind==='once'&&routine.taskKind==='reminder'&&!routine.cloudConsent&&!routine.memoryConsent&&Date.parse(slot)===Date.parse(auth.at)&&routine.timezone===auth.timezone&&requestHash(routine.name)===auth.nameSha256&&requestHash(routine.prompt)===auth.promptSha256&&message&&requestHash(message.content)===auth.contentSha256);
}
export function bindGroupReminderTask(state,routine,task,{slot,at}){
 task.routineGroupId=routine.groupId;task.routineSlot=slot;task.memoryMode='do_not_remember';task.memoryConsent=false;task.cloudConsent=false;
 const messageId=randomUUID();task.groupContext={groupId:routine.groupId,messageId,recipientRoleId:task.roleId};
 (state.groupMessages||=[]).push({id:messageId,groupId:routine.groupId,kind:'reminder',roleId:task.roleId,recipientRoleIds:[task.roleId],content:`本机提醒：${routine.name}`,createdAt:new Date(at).toISOString(),taskIds:[task.id],routineId:routine.id,authority:false});
}
