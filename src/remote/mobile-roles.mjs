import {randomUUID} from 'node:crypto';
import {requireValue,shortText,now} from '../core/errors.mjs';
import {createRole,chooseBotColor} from '../core/roles.mjs';
import {briefSettings,removeNote,workbench} from '../core/bots.mjs';
import {effectiveTimezone} from '../core/timezone.mjs';

// A bound phone sees its own tasks and shared desktop tasks, just like /v1/state.
export function mobileRoles(store,deviceId){
 const scoped={data:{...store.data,tasks:store.data.tasks.filter(t=>!t.remoteDeviceId||t.remoteDeviceId===deviceId)}};
 return workbench(scoped).map(summary=>{
  const r=store.data.roles.find(r=>r.id===summary.id);
  return {...summary,instruction:r.instruction,notes:(r.notes||[]).map(({id,text})=>({id,text})),
   watches:(store.data.watches||[]).filter(w=>w.roleId===r.id&&['active','paused'].includes(w.status)).map(({id,goal,status,lastSummary})=>({id,goal,status,lastSummary})),
   routineCount:summary.routines,watchCount:summary.watches};
 });
}
export function mutateMobileRole(store,id,input,{deviceId,digest}={}){
 const existing=deviceId&&store.data.roles.find(r=>r.remoteCreation?.deviceId===deviceId&&r.remoteCreation?.requestId===input.messageId);
 if(existing){requireValue(existing.remoteCreation.digest===digest,'同一提交编号不能用于不同内容');return {id:existing.id,name:existing.name};}
 const stamp=role=>{if(deviceId)role.remoteCreation={deviceId,requestId:input.messageId,digest};return role;};
 let result;
 store.transaction(s=>{
  if(!id){requireValue(s.roles.filter(r=>!r.deletedAt).length<64,'助理数量已达上限');result=stamp(createRole(input,s.roles));s.roles.push(result);return;}
  const r=s.roles.find(r=>r.id===id&&!r.hidden&&!r.deletedAt);requireValue(r,'助理不存在或已停用');
  if(input.copy===true){
   requireValue(s.roles.filter(r=>!r.deletedAt).length<64,'助理数量已达上限');
   result={id:randomUUID(),name:(r.name.slice(0,36)+' 副本'),description:r.description,instruction:r.instruction,icon:r.icon,botColor:chooseBotColor(undefined,s.roles),createdAt:now(),hidden:false,notes:[],brief:null};stamp(result);s.roles.push(result);return;
  }
  if(input.botColor!==undefined)r.botColor=chooseBotColor(input.botColor);
  for(const [key,max,label] of [['name',40,'助理名称'],['description',240,'职责'],['instruction',4000,'角色说明']])if(input[key]!==undefined)r[key]=shortText(input[key],label,max);
  if(input.brief!==undefined)r.brief={...briefSettings(input.brief,{timezone:effectiveTimezone(s.settings)}),lastAt:r.brief?.lastAt||null};
  if(input.forgetNote!==undefined){requireValue(typeof input.forgetNote==='string','记忆编号无效');requireValue(removeNote(r,input.forgetNote),'这条记忆已不存在');}
  result=r;
 });
 return {id:result.id,name:result.name};
}
