import {resolveWallTime} from '../core/schedule-contract.mjs';
const compact=value=>String(value||'').normalize('NFKC').replace(/\s+/g,'');
export function scheduleDays(plan){
 const desired=plan?.desired;if(!desired?.date||!desired?.endDate||!desired?.endTime)return [];
 const result=[],last=Date.parse(desired.endDate+'T00:00:00Z')-(desired.endTime==='00:00'?86400000:0);
 for(let at=Date.parse(desired.date+'T00:00:00Z');at<=last&&result.length<8;at+=86400000)result.push(new Date(at).toISOString().slice(0,10));return result;
}
function field(nodes,aliases,pattern){
 const found=[];for(const node of nodes)for(const label of node.labels){for(const alias of aliases){if(label===alias)found.push(...node.labels.filter(value=>!aliases.includes(value)&&pattern.test(value)));const combined=label.match(new RegExp('^'+alias+'[:：](.+)$'));if(combined&&pattern.test(combined[1]))found.push(combined[1]);}}
 const unique=[...new Set(found)];return unique.length===1?unique[0]:null;
}
function record(nodes,date,timezone){
 const title=field(nodes,['标题','日程标题','活动标题'],/^.{1,200}$/),time=field(nodes,['开始时间'],/^(?:[01]\d|2[0-3]):[0-5]\d$/),endTime=field(nodes,['结束时间'],/^(?:[01]\d|2[0-3]):[0-5]\d$/);
 if(!title||!time||!endTime)return null;
 const startDate=field(nodes,['开始日期'],/^\d{4}-\d{2}-\d{2}$/)||date,endDate=field(nodes,['结束日期'],/^\d{4}-\d{2}-\d{2}$/)||date;
 const start=resolveWallTime(startDate,time,timezone),end=resolveWallTime(endDate,endTime,timezone);if(start.status!=='unique'||end.status!=='unique'||Date.parse(end.instants[0])<=Date.parse(start.instants[0]))return null;
 return {title,date:startDate,time,endDate,endTime,startAt:start.instants[0],endAt:end.instants[0]};
}
function subtree(nodes,index){const root=nodes[index],depth=root.line.length-root.line.trimStart().length,group=[root];for(let i=index+1;i<nodes.length;i++){if(nodes[i].line.length-nodes[i].line.trimStart().length<=depth)break;group.push(nodes[i]);}return group;}
export function inspectScheduleDay(nodes,plan,state,observation){
 const wanted=scheduleDays(plan),fail=reason=>({verified:false,reason});if(!wanted.length)return fail('schedule_interval_required');
 const header=nodes.flatMap(node=>{const dates=node.labels.filter(value=>wanted.includes(value)),counts=node.labels.map(value=>value.match(/^共(\d{1,3})个(?:日程|活动)$/)).filter(Boolean);return dates.length===1&&counts.length===1?[{node,date:dates[0],count:Number(counts[0][1])}]:[];});
 if(header.length!==1||header[0].count>100)return fail('complete_day_count_required');const {date,count}=header[0];
 if(nodes.some(node=>node.labels.some(label=>/加载中|加载更多|展开更多|未同步|同步失败|离线缓存/.test(label))))return fail('schedule_day_incomplete');
 const candidates=nodes.flatMap((node,index)=>{const group=subtree(nodes,index),value=record(group,date,plan.timezone);return value?[{node,group,value}]:[];});
 const entries=candidates.filter(candidate=>!candidates.some(other=>other!==candidate&&candidate.group.includes(other.node)));
 if(entries.length!==count)return fail('schedule_day_incomplete');
 const dateStart=resolveWallTime(date,'00:00',plan.timezone),nextDate=new Date(Date.parse(date+'T00:00:00Z')+86400000).toISOString().slice(0,10),dateEnd=resolveWallTime(nextDate,'00:00',plan.timezone);
 if(dateStart.status!=='unique'||dateEnd.status!=='unique'||entries.some(({value})=>Date.parse(value.startAt)>=Date.parse(dateEnd.instants[0])||Date.parse(value.endAt)<=Date.parse(dateStart.instants[0])))return fail('schedule_day_identity_mismatch');
 return {verified:true,kind:'schedule_day_read',facts:{date,count,timezone:plan.timezone,events:entries.map(entry=>entry.value),observationId:observation.id,observedAt:observation.at,sourcePackage:state.windowPkg}};
}
export function summarizeScheduleConflicts(plan,actions,{effectKey,at=Date.now()}={}){
 const days=scheduleDays(plan),proofs=actions.filter(action=>action.status==='completed'&&action.phoneEffect?.kind==='effect_schedule_conflicts'&&action.phoneEffect.witness?.effectKey===effectKey&&at-action.phoneEffect.witness.facts?.observedAt<=300000).map(action=>action.phoneEffect.witness.facts),latest=new Map();for(const item of proofs)if(days.includes(item.date)&&item.timezone===plan.timezone)latest.set(item.date,item);
 const missingDays=days.filter(day=>!latest.has(day));if(!days.length||missingDays.length)return {verified:false,kind:'calendar_conflicts_checked',reason:'schedule_days_not_completely_read',missingDays};
 const unique=new Map();for(const proof of latest.values())for(const event of proof.events)unique.set(JSON.stringify(event),event);
 const start=Date.parse(plan.desired.instant),end=Date.parse(plan.desired.endInstant);
 const conflicts=[...unique.values()].filter(event=>Date.parse(event.startAt)<end&&Date.parse(event.endAt)>start).filter(event=>!(plan.operation==='update'&&plan.target?.title===event.title&&plan.target?.date===event.date&&plan.target?.time===event.time));
 return {verified:true,kind:'calendar_conflicts_checked',facts:{startAt:plan.desired.instant,endAt:plan.desired.endInstant,timezone:plan.timezone,coveredDays:days,conflicts,hasConflict:conflicts.length>0,evidence:[...latest.values()].map(item=>item.observationId)}};
}
export function scheduleConflictSummary(facts){return facts.hasConflict?`已检查指定时段，有 ${facts.conflicts.length} 个重叠日程：${facts.conflicts.map(event=>`${event.title}（${event.date} ${event.time} 至 ${event.endDate} ${event.endTime}）`).join('；')}。`:`已完整读取 ${facts.coveredDays.join('、')} 的日程，指定时段未发现重叠日程。`;}
