import {createHash} from 'node:crypto';
import {scheduleDays,summarizeScheduleConflicts} from './phone-schedule-conflicts.mjs';
const compact=value=>String(value??'').normalize('NFKC').replace(/\s+/g,'');
const inside=(point,b)=>point&&point.x>=b[0]&&point.x<b[2]&&point.y>=b[1]&&point.y<b[3];
const targetHash=plan=>createHash('sha256').update(JSON.stringify(plan.target)).digest('hex');
const isSchedule=plan=>['alarm','calendar'].includes(plan?.kind);
const FIELD_LABELS={time:/^(?:时间|开始时间|闹钟时间|Time)$/,date:/^(?:日期|开始日期|Date)$/,endTime:/^(?:结束时间|EndTime)$/,endDate:/^(?:结束日期|EndDate)$/,title:/^(?:标题|活动标题|日程标题|闹钟名称|Title)$/};
const toggle=node=>/\b(?:checked|unchecked|checkable)\b|Switch(?:Compat|Material)?|CheckBox|ToggleButton|RadioButton/i.test(node.raw);
function labels(nodes){return nodes.flatMap(node=>node.labels);}
function recurrenceMatches(values,record){
 const rule=record?.repeatRule;if(!rule)return true;if(rule.kind==='once')return values.some(label=>/^(?:仅一次|不重复)$/.test(label));
 if(rule.kind==='daily')return values.includes('每天');
 return values.includes('每周'+rule.weekdays.map(day=>'一二三四五六日'[day-1]).join('、'));
}
function recordMatches(nodes,record,{enabled=false}={}){
 const values=labels(nodes),field=(key,value)=>nodes.some(node=>node.labels.some(label=>FIELD_LABELS[key].test(label))&&node.labels.includes(compact(value))||node.labels.some(label=>{const parts=label.split(/[:：](?=\d{4}-|\d{2}:)/);return parts.length===2&&FIELD_LABELS[key].test(parts[0])&&parts[1]===compact(value);}));
 return ['time','date','title','endTime','endDate'].every(key=>!record?.[key]||(record.endTime&&key!=='title'?field(key,record[key]):values.includes(compact(record[key]))))&&recurrenceMatches(values,record)&&(!enabled||record.enabled===undefined||nodes.some(node=>/\b(?:checked|unchecked)\b/.test(node.raw)&&/\bchecked\b/.test(node.raw)===record.enabled));
}
function childrenOf(nodes,index){const root=nodes[index],depth=root.line.length-root.line.trimStart().length,result=[root];for(let i=index+1;i<nodes.length;i++){if(nodes[i].line.length-nodes[i].line.trimStart().length<=depth)break;result.push(nodes[i]);}return result;}
function rowsFor(nodes,record,{enabled=false}={}){const candidates=nodes.flatMap((node,index)=>{const children=childrenOf(nodes,index);return !node.editable&&!children.some(child=>child.editable)&&recordMatches(children,record,{enabled})?[{node,children}]:[];});return candidates.filter(candidate=>!candidates.some(other=>other!==candidate&&candidate.children.includes(other.node))).map(candidate=>candidate.node);}
function zoneConfirmed(nodes,plan,state,observation){
 if(nodes.some(node=>node.labels.some(label=>/^(?:时区|TimeZone|Timezone)$/.test(label))&&node.labels.includes(compact(plan.timezone))))return true;
 if(state?.timezone===plan.timezone)return true;
 const evidence=observation?.connectorTelemetry,time=typeof evidence?.receivedAt==='number'?evidence.receivedAt:Date.parse(evidence?.receivedAt);
 return evidence?.source==='boujoy_android_authenticated'&&evidence.fresh===true&&evidence.timezone===plan.timezone&&typeof evidence.deviceId==='string'&&Number.isFinite(time)&&Date.now()-time>=-1000&&Date.now()-time<=30000&&Number.isFinite(evidence.ageMs)&&evidence.ageMs<=30000;
}
export {zoneConfirmed as scheduleTimezoneConfirmed};
function nativeTarget(args,nodes,ocr){
 const lines=args.textTargetId?(ocr?.lines||[]).filter(line=>line.id===args.textTargetId):[];if(args.textTargetId&&lines.length!==1)return null;
 const match=lines[0],point=match?.center||{x:args.x,y:args.y},hits=nodes.filter(node=>inside(point,node.bounds)&&(node.clickable||node.editable));if(hits.some(node=>node.secret))return null;
 const node=hits.sort((a,b)=>(a.bounds[2]-a.bounds[0])*(a.bounds[3]-a.bounds[1])-(b.bounds[2]-b.bounds[0])*(b.bounds[3]-b.bounds[1]))[0];if(!node)return null;
 const label=match?compact(match.text):node.labels.length===1?node.labels[0]:null;if(match&&!node.labels.includes(label))return null;return {node,label,hasToggle:hits.some(toggle)};
}
function bound(actions,plan,effectKey){return actions.some(action=>action.status==='completed'&&['effect_schedule_open','effect_schedule_edit'].includes(action.phoneEffect?.kind)&&action.phoneEffect.witness?.effectKey===effectKey&&action.phoneEffect.witness.scheduleTarget===targetHash(plan));}
function preservedValues(nodes,plan){
 const values=labels(nodes),rules=[];
 if(values.some(value=>/^(?:仅一次|不重复)$/.test(value)))rules.push({kind:'once',weekdays:[]});
 if(values.includes('每天'))rules.push({kind:'daily',weekdays:[]});
 for(const value of values){const weekly=value.match(/^每周([一二三四五六日](?:、[一二三四五六日])*)$/);if(weekly)rules.push({kind:'weekly',weekdays:[...new Set([...weekly[1]].filter(day=>day!=='、').map(day=>'一二三四五六日'.indexOf(day)+1))].sort()});}
 const unique=[...new Map(rules.map(rule=>[JSON.stringify(rule),rule])).values()],preserved={};if(unique.length===1)preserved.repeatRule=unique[0];
 if(plan.kind==='alarm'){const controls=nodes.filter(node=>/\b(?:checked|unchecked)\b/.test(node.raw)&&node.labels.some(value=>/^(?:已启用|启用闹钟|闹钟开关|Enabled)$/.test(value)||value===plan.target.time));if(controls.length===1)preserved.enabled=/\bchecked\b/.test(controls[0].raw);}
 return preserved;
}
function updatePreservation(nodes,plan,actions,effectKey){
 if(plan.operation!=='update')return {desired:plan.desired,preserved:null,ready:true};
 const own=actions.filter(action=>action.status==='completed'&&action.phoneEffect?.witness?.effectKey===effectKey&&action.phoneEffect.witness.scheduleTarget===targetHash(plan));
 const existing=own.find(action=>action.phoneEffect.witness.preserved)?.phoneEffect.witness.preserved;
 const mutated=own.some(action=>/^effect_schedule_(?:input|toggle|recurrence_select|save)$/.test(action.phoneEffect.kind));
 // Capture from the original, bound form before the first mutation. A later
 // page cannot redefine what the untouched fields originally meant.
 const originalRows=rowsFor(nodes,plan.target),source=bound(actions,plan,effectKey)?nodes:originalRows.length===1?[originalRows[0]]:[];
 const preserved=existing||(!mutated&&recordMatches(source,plan.target)?preservedValues(source,plan):{});
 const desired={...preserved,...plan.desired};
 const ready=!!desired.repeatRule&&(desired.repeatRule.kind==='once'||plan.scope==='series')&&(plan.kind!=='alarm'||typeof desired.enabled==='boolean');
 return {desired,preserved:ready?preserved:null,ready};
}
function formConsistent(nodes,plan){
 const values=labels(nodes);return ['title','date','time'].every(key=>!plan.target?.[key]||[plan.target[key],plan.desired?.[key]].some(value=>value&&values.includes(compact(value))));
}
export function scheduleDialogLabelAllowed(label,plan){return isSchedule(plan)&&(/^(?:保存|完成|Save|Done|编辑|修改|Edit)$/.test(label)||plan.operation==='delete'&&/^(?:删除|删除闹钟|删除日程|删除活动|确认删除|取消日程|Delete)$/.test(label));}
export function classifyScheduleAction(args,state,ocr,grant,nodes,{actions=[],observation,effectKey}={}){
 const plan=grant.effectPlan;if(!isSchedule(plan))return null;
 const preservation=updatePreservation(nodes,plan,actions,effectKey);
 const witness={scheduleTarget:targetHash(plan),operation:plan.operation,timezone:plan.timezone};const result=(kind,extra={})=>({kind,witness:{...witness,...(preservation.preserved?{preserved:preservation.preserved}:{}),...extra}});
 const oldBound=plan.operation==='create'||bound(actions,plan,effectKey),desired=preservation.desired;
 const saved=actions.filter(action=>action.status==='completed'&&action.phoneEffect?.kind==='effect_schedule_save'&&action.phoneEffect.witness?.effectKey===effectKey).at(-1);
 if(saved){
  if(args.action!=='tap')return null;const picked=nativeTarget(args,nodes,ocr),savedRecord=saved.phoneEffect.witness.desired;
  const list=/RecyclerView|ListView/.test(state.tree)&&!nodes.some(node=>node.editable),matches=rowsFor(nodes,savedRecord,{enabled:plan.kind==='alarm'});
  if(list&&picked&&!picked.hasToggle&&picked.node.clickable&&matches.length===1&&matches[0]===picked.node&&zoneConfirmed(nodes,plan,state,observation))return result('effect_schedule_reopen',{savedActionId:saved.id||null,desired:savedRecord});
  return null;
 }
 if(plan.operation==='check'){
  if(args.action!=='tap')return null;const picked=nativeTarget(args,nodes,ocr);if(!picked||picked.hasToggle||picked.node.editable)return null;
  if(/^(?:日历|日程|日程列表|列表|今天|日)$/.test(picked.label||'')||scheduleDays(plan).includes(picked.label))return result('effect_schedule_navigation');return null;
 }
 if(args.action==='type'){
  const search=nodes.filter(node=>node.editable&&node.focused&&!node.secret&&node.labels.some(label=>/^(?:搜索|搜索日程|搜索活动|Search)$/.test(label)));if(args.inputMode==='replace'&&!args.textTargetId&&search.length===1&&plan.target?.title&&args.text===plan.target.title)return result('effect_schedule_search');
  if(plan.operation==='delete'||args.inputMode!=='replace'||typeof args.text!=='string'||args.textTargetId||!oldBound||!preservation.ready||plan.operation==='update'&&!formConsistent(nodes,plan))return null;
  const fields=nodes.filter(node=>node.editable&&node.focused&&!node.secret);if(fields.length!==1)return null;
  const matches=Object.entries(FIELD_LABELS).filter(([,pattern])=>fields[0].labels.some(label=>pattern.test(label)));if(matches.length!==1)return null;
  const key=matches[0][0];if(desired?.[key]&&args.text===desired[key]&&(plan.operation==='create'||Object.hasOwn(plan.changes,key)))return result('effect_schedule_input',{field:key});
  return null;
 }
 if(args.action!=='tap')return null;const target=nativeTarget(args,nodes,ocr);if(!target)return null;const {node,label,hasToggle}=target;
 if(hasToggle){
  if(plan.operation==='update'&&oldBound&&preservation.ready&&formConsistent(nodes,plan)&&plan.kind==='alarm'&&Object.hasOwn(plan.changes||{},'enabled')&&node.labels.some(value=>/^(?:已启用|启用闹钟|闹钟开关|Enabled)$/.test(value))&&/\b(?:checked|unchecked)\b/.test(node.raw)&&/\bchecked\b/.test(node.raw)!==desired.enabled)return result('effect_schedule_toggle');
  return null;
 }
 if((/^(?:日历|日程|日程列表|闹钟|搜索|搜索日程|搜索活动|列表|Search)$/.test(label||'')||plan.checkConflicts&&scheduleDays(plan).includes(label))&&!node.editable)return result('effect_schedule_navigation');
 if(plan.operation!=='create'){
  const matches=rowsFor(nodes,plan.target);
  if(matches.length===1&&matches[0]===node&&!node.editable&&node.clickable)return result('effect_schedule_open');
  if(/^(?:编辑|修改|Edit)$/.test(label||'')&&matches.length===1)return result('effect_schedule_edit');
  if(!oldBound)return null;
 }
 if(plan.operation==='delete'){
  if(!recordMatches(nodes,plan.target)||!zoneConfirmed(nodes,plan,state,observation))return null;
  const recurring=nodes.some(node=>node.labels.some(label=>/每天|每周|重复日程|重复活动/.test(label)));
  if(recurring&&!plan.target.repeatRule)return null;
  if(recurring&&!nodes.some(node=>node.labels.includes(plan.scope==='series'?'整个系列':'仅本次')))return null;
  const deleteLabel=/^(?:删除|删除闹钟|删除日程|删除活动|确认删除|取消日程|Delete)$/i.test(label||'');if(!deleteLabel)return null;
  // The first delete may apply immediately or open a dialog. Both phases are
  // once-only possible mutations and require a fresh bound result afterwards.
  const confirmation=/Dialog|AlertDialog/.test(state.tree);
  return result(confirmation?'effect_schedule_delete':'effect_schedule_delete_prompt');
 }
 if(!desired||!preservation.ready)return null;
 if(plan.operation==='create'&&(plan.kind==='alarm'?/^(?:添加闹钟|新建闹钟|添加|新建|Addalarm)$/:/^(?:新建日程|添加日程|新建活动|添加活动|添加|新建|Addevent)$/).test(label||''))return result('effect_schedule_create');
 if(plan.operation==='update'&&!formConsistent(nodes,plan))return null;
 const fieldMatches=Object.entries(FIELD_LABELS).filter(([,pattern])=>node.labels.some(value=>pattern.test(value)));
 if(node.editable&&fieldMatches.length===1&&(plan.operation==='create'||Object.hasOwn(plan.changes,fieldMatches[0][0])))return result('effect_schedule_focus');
 if(/^(?:重复|重复规则)$/.test(label||'')&&(plan.operation==='create'||Object.hasOwn(plan.changes,'repeatRule')))return result('effect_schedule_recurrence_open');
 if((label===(plan.repeat||'仅一次')||!plan.repeat&&label==='不重复')&&(plan.operation==='create'||Object.hasOwn(plan.changes,'repeatRule')))return result('effect_schedule_recurrence_select');
 if(/^(?:保存|完成|Save|Done)$/.test(label||'')&&recordMatches(nodes,desired,{enabled:plan.operation==='update'&&plan.kind==='alarm'})&&zoneConfirmed(nodes,plan,state,observation)){
  if(plan.checkConflicts){const conflicts=summarizeScheduleConflicts(plan,actions,{effectKey});if(!conflicts.verified||conflicts.facts.hasConflict)return null;}
  if(plan.operation==='update'&&plan.target.repeatRule&&plan.target.repeatRule.kind!=='once'&&!nodes.some(node=>node.labels.includes(plan.scope==='series'?'整个系列':'仅本次')))return null;
  if(nodes.some(node=>node.labels.some(value=>/时间冲突|日程冲突|存在冲突|重叠日程|conflict/i.test(value))))return null;
  return result('effect_schedule_save',{target:plan.target,desired,scope:plan.scope});
 }
 return null;
}
export function verifyScheduleResult(nodes,grant,matches,state,observation){
 const plan=grant.effectPlan;if(!isSchedule(plan))return null;
 if(!zoneConfirmed(nodes,plan,state,observation))return {verified:false,reason:'schedule_timezone_evidence_required'};
 if(plan.operation==='check')return summarizeScheduleConflicts(plan,matches,{effectKey:matches.find(action=>action.phoneEffect?.kind==='effect_schedule_conflicts')?.phoneEffect.witness.effectKey});
 if(plan.operation==='delete'){
  const deleted=matches.find(action=>['effect_schedule_delete','effect_schedule_delete_prompt'].includes(action.phoneEffect.kind)&&action.phoneEffect.witness.scheduleTarget===targetHash(plan));
  // Absence in a viewport does not prove deletion; require a native acknowledgement
  // carrying the exact target identity, after our once-only delete receipt.
  const tombstone=nodes.some(node=>!node.editable&&node.labels.some(label=>/^(?:闹钟已删除|日程已删除|活动已删除|已取消日程|Alarmdeleted|Eventdeleted)$/.test(label))&&recordMatches([node],plan.target));
  const remaining=rowsFor(nodes.filter(node=>!node.labels.some(label=>/已删除|已取消|deleted/i.test(label))),plan.target);
  return {verified:!!deleted&&tombstone&&!remaining.length,kind:plan.kind+'_deleted',reason:'requires_bound_native_deletion_acknowledgement'};
 }
 const saved=matches.find(action=>action.phoneEffect.kind==='effect_schedule_save'),desired=plan.operation==='update'?{...(saved?.phoneEffect.witness?.preserved||{}),...plan.desired}:plan.desired;
 if(plan.operation==='update'&&(!desired.repeatRule||plan.kind==='alarm'&&typeof desired.enabled!=='boolean'))return {verified:false,reason:'original_schedule_fields_not_preserved'};
 const rows=rowsFor(nodes,desired,{enabled:plan.kind==='alarm'});
 const oldRemaining=plan.operation==='update'&&JSON.stringify(plan.target)!==JSON.stringify(desired)?rowsFor(nodes,plan.target).filter(node=>!rows.includes(node)).length:0;
 const reopened=matches.filter(action=>action.phoneEffect.kind==='effect_schedule_reopen'&&JSON.stringify(action.phoneEffect.witness.desired)===JSON.stringify(desired)).at(-1);
 const reopenedForm=!!reopened&&recordMatches(nodes,desired,{enabled:plan.kind==='alarm'})&&(!/RecyclerView|ListView/.test(state.tree)||nodes.some(node=>node.editable));
 return {verified:!!saved&&reopenedForm&&!oldRemaining,kind:plan.kind+(plan.operation==='update'?'_updated':'_verified'),reason:'requires_saved_entry_reopened_with_exact_identity_and_timezone'};
}
