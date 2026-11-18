import {parseMessageRequest} from '../core/message-contract.mjs';
import {stripTopLevelRoleMentions} from '../core/role-mentions.mjs';
import {outboundPlan,classifyOutboundAction,verifyOutboundResult} from './phone-outbound.mjs';
import {travelPreparationPlan,classifyTravelPreparationAction,verifyTravelPreparationResult} from './phone-travel-preparation.mjs';
import {routePlan,classifyRouteAction,verifyRouteResult} from './phone-routes.mjs';
import {createHash} from 'node:crypto';
import {schedulePlan} from '../core/schedule-contract.mjs';
import {classifyScheduleAction,verifyScheduleResult} from './phone-schedule.mjs';
import {businessPlan,classifyBusinessAction,verifyBusinessResult} from './phone-business.mjs';
import {travelPlan,classifyTravelAction,verifyTravelResult} from './phone-travel.mjs';
import {candidateAttachmentPlan,classifyAttachmentAction,verifyAttachmentResult} from './phone-attachment.mjs';
// Contract effects are an upper bound. Every mutation below binds current native
// controls to the exact object/content and later requires an observed result.
const compact=value=>String(value??'').normalize('NFKC').replace(/\s+/g,'');
const inside=(point,b)=>point&&point.x>=b[0]&&point.x<b[2]&&point.y>=b[1]&&point.y<b[3];
const secret=/(?:密码|验证码|PIN|OTP|passcode|password)/i;
const blocked=/(?:支付|付款|转账|充值|下单|订单|登录|授权|权限|允许|同意|删除|清空|卸载|重置|恢复|安装|更新)/i;
const decodeLabel=value=>value.replace(/\\u([0-9a-f]{4})/gi,(_,hex)=>String.fromCharCode(parseInt(hex,16)));
export function effectNodes(tree){
 const nodes=[];let window=false;
 for(const line of String(tree||'').split('\n')){
  if(line.startsWith('window ')){window=true;continue;}if(!window)continue;
  const match=line.match(/bounds=(-?\d+),(-?\d+),(-?\d+),(-?\d+)/);if(!match)continue;
  const bounds=match.slice(1).map(Number),raw=line.replace(/"[^"\n]*"/g,'');
  if(/\boffscreen\b|\bdisabled\b/.test(raw)||bounds[2]<=bounds[0]||bounds[3]<=bounds[1])continue;
  const values=[...line.matchAll(/"([^"\n]*)"/g)].map(match=>decodeLabel(match[1]));
  nodes.push({line,raw,bounds,values,labels:values.map(compact),editable:/\beditable\b/.test(raw),focused:/\bfocused\b/.test(raw),clickable:/\bclickable\b/.test(raw),secret:/\bpassword\b/.test(raw)});
 }
 return nodes;
}
function candidateEffectPlan(contract){
 const object=contract?.objects||{},raw=String(object.rawRequest||''),effects=contract?.effects||[];
 const message=parseMessageRequest(raw);
 if(message&&effects.includes('send')&&message.recipient===object.recipient&&message.content===object.content)return {kind:'send',recipient:message.recipient,content:message.content,...(message.compose?{compose:true,app:message.app}:{})};
 const outbound=outboundPlan(contract);if(outbound)return outbound;
 const travelPreparation=travelPreparationPlan(contract);if(travelPreparation)return travelPreparation;
 const attachment=candidateAttachmentPlan(contract);if(attachment)return attachment;
 const travel=travelPlan(contract);if(travel)return travel;
 if(effects.includes('send')&&typeof object.recipient==='string'&&typeof object.content==='string'&&object.recipient&&object.content&&raw.includes(object.recipient)&&raw.includes(object.content)&&!secret.test(object.recipient))return {kind:'send',recipient:object.recipient,content:object.content};
 if(effects.includes('call')&&(object.dialNumber||object.dialRecipient))return {kind:'call',number:object.dialNumber||null,recipient:object.dialRecipient||null};
 if(effects.includes('modify')&&object.field==='bluetooth'&&typeof object.value==='boolean')return {kind:'setting',field:'蓝牙',value:object.value};
 if(effects.includes('modify')&&['brightness','volume'].includes(object.field)&&Number.isInteger(object.value)&&object.value>=0&&object.value<=100)return {kind:'setting_number',field:object.field==='brightness'?'亮度':'音量',value:String(object.value)};
 const route=routePlan(contract);if(route)return route;
 const schedule=schedulePlan(contract);if(schedule)return schedule;
 return businessPlan(contract);
}
export function effectPlan(contract){
 if(contract)contract={...contract,goal:stripTopLevelRoleMentions(contract.goal),objects:{...contract.objects,rawRequest:stripTopLevelRoleMentions(contract.objects?.rawRequest)}};
 const plan=candidateEffectPlan(contract);if(!plan)return null;
 const supported={send_mail:['send_mail'],publish_media:['publish_media'],travel_preparation:[],send_attachment:['send_attachment'],route:[],navigation:['start_navigation'],ride_request:['request_ride'],service_booking:[plan.operation==='reschedule'?'reschedule_booking':'book_service'],after_sales:[plan.operation==='refund'?'request_refund':'return_goods'],send:['send'],call:['call'],setting:['modify'],setting_number:['modify'],alarm:plan.operation==='check'?[]:[plan.operation==='create'?'create_schedule':plan.operation==='delete'?'delete':'modify'],calendar:plan.operation==='check'?[]:[plan.operation==='create'?'create_schedule':plan.operation==='delete'?'delete':'modify'],file_rename:['modify'],file_move:['modify'],photo_capture:['capture'],social_publish:['publish'],social_comment:['publish'],social_bookmark:['publish'],order_cancel:['cancel_order'],order_read:[]}[plan.kind];
 if(!supported||contract.effects.some(effect=>!['read','navigate',...supported].includes(effect)))return null;
 const instruction=String(parseMessageRequest(contract.objects?.rawRequest)?.instruction||contract.goal||contract.objects?.rawRequest||'').replace(/“[^”]*”|「[^」]*」|"[^"]*"/g,'[正文]');
 const commands={send:/发送|发给|回复/g,call:/拨打|打电话|呼叫/g,file_rename:/重命名/g,file_move:/移动到/g,photo_capture:/拍照|拍一张照片|拍张照片/g,social_publish:/发布|发帖/g,social_comment:/评论/g,social_bookmark:/收藏/g,order_cancel:/取消(?:未付款的|待付款的)?订单/g}[plan.kind];
 if(commands&&[...instruction.matchAll(commands)].length>1)return null;
  const raw=String(contract.objects?.rawRequest||contract.goal||''),quotes=[...raw.matchAll(/“([^”]*)”|「([^」]*)」|"([^"]*)"/g)];
  if(plan.kind==='send'&&!parseMessageRequest(raw)&&quotes.length!==1||plan.kind.startsWith('file_')&&quotes.length!==2)return null;
  if(plan.kind.startsWith('social_')&&[...raw.matchAll(/(?:笔记|帖子|视频)[“「"]/g)].length>1)return null;
 return plan;
}
export function effectIdentity(grant){return createHash('sha256').update(JSON.stringify({contractId:grant.contractId,packageName:grant.packageName,plan:grant.effectPlan})).digest('hex');}
function foregroundHeight(tree){const m=String(tree).split('\n').find(line=>line.startsWith('window '))?.match(/bounds=(-?\d+),(-?\d+),(-?\d+),(-?\d+)/);return m?Number(m[4])-Number(m[2]):0;}
function recipientHeader(nodes,plan,tree,ocr){
 const limit=foregroundHeight(tree)*.22;
 return nodes.some(node=>!node.editable&&node.bounds[1]<limit&&node.labels.includes(compact(plan.recipient)))||(ocr?.lines||[]).some(line=>line.bounds?.[1]<ocr.height*.22&&compact(line.text)===compact(plan.recipient));
}
function editor(nodes){const fields=nodes.filter(node=>node.editable&&node.focused&&!node.secret&&!node.labels.some(label=>secret.test(label)));return fields.length===1?fields[0]:null;}
function countContent(nodes,content){return nodes.filter(node=>!node.editable&&node.values.includes(content)).length;}
const phoneNumber=value=>/^\+?\d[\d ()-]{3,24}\d$/.test(value)?value.replace(/[ ()-]/g,''):null;
// On an opaque chat surface, a historical bubble is not evidence of the draft.
// Limit OCR to a single exact line alongside the unique send button; the broker
// additionally requires the bound IME to attest the complete editor before tapping.
function opaqueComposer(ocr,body){
 const valid=line=>Array.isArray(line.bounds)&&line.bounds.length===4&&line.bounds.every(Number.isFinite);
 const lines=(ocr?.lines||[]).filter(valid),buttons=lines.filter(l=>/^(?:发送|Send)$/i.test(l.text)&&l.bounds[1]>ocr.height*.30);
 if(buttons.length!==1)return null;
 const [left,top,,bottom]=buttons[0].bounds;
 const sameRow=l=>l.bounds[2]<=left&&Math.min(l.bounds[3],bottom)>Math.max(l.bounds[1],top);
 if(lines.filter(l=>l.text===body&&sameRow(l)).length!==1)return null;
 return {beforeOcrCount:lines.filter(l=>l.text===body&&!sameRow(l)).length,requiresEditorProof:true};
}
function dialBinding(nodes,plan,tree){
 const numbers=[...new Set(nodes.flatMap(node=>node.values).map(phoneNumber).filter(Boolean))];
 if(numbers.length!==1||plan.number&&numbers[0]!==plan.number)return null;
 if(plan.recipient&&!recipientHeader(nodes,plan,tree))return null;
 return numbers[0];
}
function targetNode(nodes,args,ocr){
 const matches=args.textTargetId?(ocr?.lines||[]).filter(line=>line.id===args.textTargetId):[];
 if(args.textTargetId&&matches.length!==1)return null;
 const match=matches[0],point=match?.center||{x:args.x,y:args.y};
 const hits=nodes.filter(node=>inside(point,node.bounds)&&(node.clickable||node.editable));
 if(hits.some(node=>node.secret||node.labels.some(label=>secret.test(label)||blocked.test(label))))return null;
 const node=hits.sort((a,b)=>(a.bounds[2]-a.bounds[0])*(a.bounds[3]-a.bounds[1])-(b.bounds[2]-b.bounds[0])*(b.bounds[3]-b.bounds[1]))[0];
 if(!node&&match&&!secret.test(match.text)&&!blocked.test(match.text))return {node:{editable:false,labels:[compact(match.text)],raw:''},label:compact(match.text)};
 if(!node)return null;const label=match?compact(match.text):node.labels.length===1?node.labels[0]:null;
 if(!label&&node.editable&&!args.textTargetId)return {node,label:''};
 if(!label||!node.labels.includes(label)&&!(match&&!node.labels.length))return null;return {node,label};
}
export function classifyEffectAction(args,state,ocr,grant,actions=[],observation=null){
 const plan=grant.effectPlan;if(!plan)return null;const nodes=effectNodes(state.tree);
 if(nodes.some(node=>node.secret||node.editable&&node.labels.some(label=>secret.test(label))))return null;
 const result=(kind,witness={})=>({kind,packageName:grant.packageName,effect:plan.kind,witness:{...witness,contractId:grant.contractId,contractRevision:grant.contractRevision,effectKey:effectIdentity(grant)}});
 if(['send_mail','publish_media'].includes(plan.kind)){const outbound=classifyOutboundAction(args,state,ocr,grant,nodes,actions,observation);return outbound?result(outbound.kind,outbound.witness):null;}
 if(plan.kind==='travel_preparation'){const prepared=classifyTravelPreparationAction(args,state,ocr,grant,nodes,actions,observation);return prepared?result(prepared.kind,prepared.witness):null;}
 if(plan.kind==='send_attachment'){const attachment=classifyAttachmentAction(args,state,ocr,grant,nodes,actions,observation);return attachment?result(attachment.kind,attachment.witness):null;}
 if(['navigation','ride_request','service_booking'].includes(plan.kind)){const travel=classifyTravelAction(args,state,ocr,grant,nodes,actions,observation);return travel?result(travel.kind,travel.witness):null;}
 if(plan.kind==='route'){const route=classifyRouteAction(args,state,ocr,grant,nodes);return route?result(route.kind,route.witness):null;}
 if(['alarm','calendar'].includes(plan.kind)){const schedule=classifyScheduleAction(args,state,ocr,grant,nodes,{actions,observation,effectKey:effectIdentity(grant)});return schedule?result(schedule.kind,schedule.witness):null;}
 const business=classifyBusinessAction(args,state,ocr,grant,nodes);if(business)return result(business.kind,business.witness);
 if(args.action==='type'){
  if(args.inputMode!=='replace'||typeof args.text!=='string'||args.textTargetId)return null;
  const field=editor(nodes);if(!field&&!(plan.kind==='send'&&recipientHeader(nodes,plan,state.tree,ocr)&&args.text===plan.content))return null;
  if(plan.kind==='send'){
   const search=!!field&&field.labels.some(label=>/^(?:搜索|查找|Search)/i.test(label));
   if(search&&args.text===plan.recipient)return result('effect_recipient_search');
   if(recipientHeader(nodes,plan,state.tree,ocr)&&args.text===plan.content&&!search&&nodes.filter(node=>node.editable&&!node.secret).length<=1)return result('effect_message_input');
  }
  if(plan.kind==='call'){
   if(plan.recipient&&field.labels.some(label=>/^(?:搜索|查找|Search)/i.test(label))&&args.text===plan.recipient)return result('effect_recipient_search');
   if(plan.number&&field.labels.some(label=>/^(?:电话号码|号码|输入号码|拨号|Phone number|PhoneNumber)$/i.test(label))&&args.text===plan.number)return result('effect_dial_input');
  }
  if(plan.kind==='setting_number'&&field.labels.some(label=>label===plan.field)&&args.text===plan.value)return result('effect_setting_input');
  return null;
 }
 if(args.action!=='tap')return null;
 const target=targetNode(nodes,args,ocr);if(!target)return null;const {node,label}=target;
 if(plan.kind==='send'){
  if(label===compact(plan.recipient))return result('effect_recipient_open');
  const bound=recipientHeader(nodes,plan,state.tree,ocr);
  if(bound&&node.editable&&nodes.filter(item=>item.editable&&!item.secret).length===1)return result('effect_message_focus');
  if(bound&&/^(?:发送|Send)$/.test(label)){
   const fields=nodes.filter(node=>node.editable);
   if(fields.length===1&&fields[0].values.includes(plan.content))return result('effect_send',{beforeCount:countContent(nodes,plan.content)});
   const opaque=!fields.length&&opaqueComposer(ocr,plan.content);
   if(opaque)return result('effect_send',{beforeCount:countContent(nodes,plan.content),...opaque});
  }
 }
 if(plan.kind==='call'){
  if(plan.recipient&&label===compact(plan.recipient))return result('effect_recipient_open');
  if(plan.number&&node.editable&&node.labels.some(value=>/^(?:电话号码|号码|输入号码|拨号|PhoneNumber)$/i.test(value)))return result('effect_dial_focus');
  const number=dialBinding(nodes,plan,state.tree);
  if(number&&/^(?:拨打|呼叫|打电话|通话|Call|Dial)$/i.test(label)&&!nodes.some(node=>node.labels.some(value=>/正在呼叫|正在拨号|拨号中|通话中|挂断|结束通话|Endcall|Calling/i.test(value))))return result('effect_call',{number,recipient:plan.recipient});
 }
 if(plan.kind==='setting'&&label===plan.field&&/\b(?:checked|unchecked)\b/.test(node.raw)){
  const checked=/\bchecked\b/.test(node.raw);if(checked!==plan.value)return result('effect_setting_toggle',{beforeValue:checked});
 }
 if(plan.kind==='setting_number'&&label===plan.field&&!/\b(?:checked|unchecked)\b|SeekBar|Slider/.test(node.raw))return result(node.editable?'effect_setting_focus':'effect_setting_open');
 if(plan.kind==='setting_number'&&/^(?:保存|确定|完成|Save|Done)$/.test(label)&&nodes.some(node=>node.editable&&node.labels.includes(plan.field)&&node.labels.includes(plan.value)))return result('effect_setting_save');
 return null;
}
export function effectGoalStatus(observation,grant,actions=[]){
 const ocr=observation?.ocr;const plan=grant?.effectPlan;if(!plan)return {verified:false,reason:'no_effect_plan'};
 let state;for(const block of observation?.tree?.content||[])try{state=JSON.parse(block.text)?.result;if(state?.tree)break;}catch{}
 if(!state?.tree||![grant.packageName,...(grant.observationPackages||[])].includes(state.windowPkg)||observation.taskId!==grant.taskId||Date.now()-observation.at>45000)return {verified:false,reason:'fresh_observation_required'};
 const nodes=effectNodes(state.tree),matches=actions.filter(action=>action.status==='completed'&&action.phoneEffect?.witness?.effectKey===effectIdentity(grant));
 if(['send_mail','publish_media'].includes(plan.kind))return verifyOutboundResult(nodes,grant,matches,state,observation);
 if(plan.kind==='travel_preparation')return verifyTravelPreparationResult(nodes,grant,matches,state,observation);
 if(plan.kind==='send_attachment')return verifyAttachmentResult(nodes,grant,matches,state,observation);
 if(['navigation','ride_request','service_booking'].includes(plan.kind))return verifyTravelResult(nodes,grant,matches,state,observation);
 if(plan.kind==='route')return verifyRouteResult(nodes,grant,state,observation);
 if(plan.kind==='send'){
  const sent=matches.filter(action=>action.phoneEffect.kind==='effect_send').at(-1),editorEmpty=!nodes.some(node=>node.editable&&node.values.includes(plan.content));
  const failed=nodes.some(node=>node.labels.some(label=>/发送失败|发送中|未发送|正在发送|重发|Sendfailed|Sending|Notdelivered/i.test(label)));
  return {verified:!!sent&&!failed&&recipientHeader(nodes,plan,state.tree,ocr)&&editorEmpty&&(sent.phoneEffect.witness.requiresEditorProof
    ? Number.isSafeInteger(sent.phoneEffect.witness.beforeOcrCount)&&!(ocr?.lines||[]).some(line=>/^(?:发送|Send)$/i.test(line.text))&&(ocr?.lines||[]).filter(line=>line.text===plan.content&&line.bounds?.[1]>ocr.height*.12).length===sent.phoneEffect.witness.beforeOcrCount+1
    : countContent(nodes,plan.content)===sent.phoneEffect.witness.beforeCount+1),kind:'message_sent',reason:'requires_matching_recipient_new_message_and_cleared_editor'};
 }
 if(plan.kind==='call'){
  const called=matches.filter(action=>action.phoneEffect.kind==='effect_call').at(-1),number=dialBinding(nodes,plan,state.tree),labels=nodes.flatMap(node=>node.labels);
  const dialing=labels.some(label=>/^(?:正在呼叫|正在拨号|拨号中|呼叫中|振铃|Calling|Dialing|Ringing)$/i.test(label)),active=labels.some(label=>/^(?:通话中|Incall|\d{1,2}:\d{2})$/i.test(label));
  const hangup=nodes.some(node=>node.clickable&&node.labels.some(label=>/^(?:挂断|结束通话|Endcall)$/i.test(label))),ended=labels.some(label=>/呼叫失败|通话结束|无法接通|Callfailed|Callended/i.test(label));
  return {verified:!!called&&number===called.phoneEffect.witness.number&&hangup&&!ended&&(dialing||active),kind:'call_initiated',phase:active?'active':dialing?'dialing':null,reason:'requires_exact_number_and_observed_outgoing_call_state'};
 }
 if(plan.kind==='setting'){
  const controls=nodes.filter(node=>node.labels.includes(plan.field)&&/\b(?:checked|unchecked)\b/.test(node.raw));return {verified:controls.length===1&&/\bchecked\b/.test(controls[0].raw)===plan.value,kind:'setting_verified'};
 }
 if(plan.kind==='setting_number')return {verified:nodes.some(node=>!node.editable&&node.labels.includes(plan.field)&&node.labels.some(label=>label===plan.value||label===plan.value+'%')),kind:'setting_verified'};
 if(['alarm','calendar'].includes(plan.kind))return verifyScheduleResult(nodes,grant,matches,state,observation);
 return verifyBusinessResult(nodes,grant,matches);
}
