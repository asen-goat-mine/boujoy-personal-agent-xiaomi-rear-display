import {randomUUID,randomInt} from 'node:crypto';
import {shortText,requireValue,now} from './errors.mjs';
import {validateTaskContract} from './task-contract.mjs';
// Twelve colors that stay apart at sidebar size. A new bot takes one no other visible bot uses.
export const BOT_COLORS=['violet','amber','green','blue','pink','coral','teal','silver','gold','sky','orchid','lime'];
// Order to hand out free colors in: neighbours in this list look least alike.
const ASSIGN_ORDER=['violet','amber','green','blue','pink','teal','gold','coral','sky','orchid','lime','silver'];
const DEFAULT_BOT_COLORS={concierge:'violet',life:'amber',shopping:'green',travel:'blue',work:'pink'};
const visible=role=>role&&!role.hidden&&!role.deletedAt;
export function chooseBotColor(value,roles=[]){
 if(value!==undefined){requireValue(BOT_COLORS.includes(value),'机器人配色无效');return value;}
 const used=new Set(roles.filter(visible).map(r=>r.botColor)),free=ASSIGN_ORDER.filter(c=>!used.has(c));
 return free.length?free[0]:BOT_COLORS[randomInt(BOT_COLORS.length)];
}
// Give every visible bot its own color, keeping the first holder of each color as it is.
// Returns the ids that changed.
export function distinctBotColors(roles){
 const used=new Set(),changed=[];
 for(const role of roles.filter(visible)){
  let color=BOT_COLORS.includes(role.botColor)?role.botColor:DEFAULT_BOT_COLORS[role.id];
  if(!color||used.has(color))color=ASSIGN_ORDER.find(c=>!used.has(c))||color||BOT_COLORS[0];
  if(color!==role.botColor){role.botColor=color;changed.push(role.id);}
  used.add(color);
 }
 return changed;
}
export function createRole(input,roles=[]){return {id:randomUUID(),name:shortText(input.name,'角色名',40),description:shortText(input.description,'职责',240),instruction:shortText(input.instruction,'角色说明',4000),icon:'◇',botColor:chooseBotColor(input.botColor,roles),hidden:false,createdAt:now()};}
export function canCreateTaskRole(task,{store}={}){
 const message=task?.messages?.filter(m=>m.role==='user').at(-1),checked=validateTaskContract(task,{store});
 return !!(task?.source==='user'&&!task.parentId&&!task.depth&&message&&!message.externalContent&&!message.external_content&&checked.valid&&checked.contract.intent!=='conversation'&&!store?.data?.recoveryFence?.required);
}
const key=name=>name.normalize('NFKC').trim().toLocaleLowerCase();
export function createTaskRole(store,task,input){
 requireValue(canCreateTaskRole(task,{store}),'只有当前用户任务可以创建长期助理，子任务和外部资料不能创建','role_creation_not_authorized');
 const role=createRole(input,store.data.roles),matches=store.data.roles.filter(r=>key(r.name)===key(role.name));
 requireValue(matches.length<=1,'已有多个同名助理，请使用不同名称','role_name_ambiguous');
 const existing=matches[0];
 if(existing){requireValue(!existing.hidden&&!existing.deletedAt,'同名助理已隐藏或删除，请在设置中恢复或使用不同名称','role_name_unavailable');return {roleId:existing.id,name:existing.name,description:existing.description,botColor:existing.botColor,created:false,deduplicated:true};}
 const contract=task.taskContract;
 requireValue(store.data.roles.filter(r=>r.createdByTaskId===task.id&&r.createdByContractId===contract.id&&r.createdByContractRevision===contract.revision).length<4,'本轮最多新建 4 个长期助理','role_creation_limit');
 requireValue(store.data.roles.filter(r=>!r.deletedAt).length<64,'长期助理数量已达上限，请先整理已有助理','role_creation_limit');
 Object.assign(role,{createdByTaskId:task.id,createdByContractId:contract.id,createdByContractRevision:contract.revision,createdByMessageId:contract.source?.messageId});
 store.transaction(s=>s.roles.push(role));
 store.event(task.id,'role_created',`已创建助理：${role.name}`,{roleId:role.id});
 return {roleId:role.id,name:role.name,description:role.description,botColor:role.botColor,created:true,deduplicated:false};
}
