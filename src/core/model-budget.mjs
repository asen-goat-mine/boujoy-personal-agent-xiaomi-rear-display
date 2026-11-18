import {effectiveTimezone} from './timezone.mjs';
import {AppError,requireValue} from './errors.mjs';

export const DEFAULT_DAILY_MODEL_REQUESTS=200;
function configuration(state){
 const limit=state.settings?.dailyModelRequests??DEFAULT_DAILY_MODEL_REQUESTS,timezone=effectiveTimezone(state.settings);
 requireValue(Number.isSafeInteger(limit)&&limit>=0&&limit<=100000,'每日模型请求额度应为0至100000次');
 let format;try{format=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'});}catch{throw new AppError('budget_timezone_invalid','预算时区无效，未派发模型请求',409);}
 const day=at=>{const fields=Object.fromEntries(format.formatToParts(new Date(at)).filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));return `${fields.year}-${fields.month}-${fields.day}`;};return {limit,timezone,day};
}
function reservations(state,at){
 const rows=new Map((state.modelBudgetReservations||[]).map(r=>[r.id,r]));
 for(const task of state.tasks||[])for(const receipt of task.modelUsageReceipts||[]){if(rows.has(receipt.id))continue;rows.set(receipt.id,{id:receipt.id,source:'task',taskId:task.id,at:Number.isFinite(Date.parse(receipt.startedAt))?receipt.startedAt:null,units:1,...(!Number.isFinite(Date.parse(receipt.startedAt))?{originalTimeUnknown:true}:{})});}
 for(const receipt of state.memoryUsageReceipts||[]){if(rows.has(receipt.id))continue;rows.set(receipt.id,{id:receipt.id,source:'memory',at:Number.isFinite(Date.parse(receipt.startedAt))?receipt.startedAt:null,units:1,...(!Number.isFinite(Date.parse(receipt.startedAt))?{originalTimeUnknown:true}:{})});}
 // Older runtimes recorded only a cumulative request count. Keep that history
 // explicitly unattributed; it is not evidence of usage on a particular day.
 const represented=[...rows.values()].reduce((n,r)=>n+(r.units||1),0),legacy=Math.max(0,(state.usage?.requests||0)-represented);
 if(legacy)rows.set('legacy-unattributed',{id:'legacy-unattributed',source:'legacy',at:null,units:legacy+(rows.get('legacy-unattributed')?.units||0),originalTimeUnknown:true});
 return [...rows.values()];
}
export function modelBudgetStatus(state,{at=Date.now()}={}){
 requireValue(Number.isFinite(at),'预算时间无效');const {limit,timezone,day}=configuration(state),today=day(at),rows=reservations(state,at);
 const todays=rows.filter(r=>Number.isFinite(Date.parse(r.at))&&day(Date.parse(r.at))===today),used=todays.reduce((n,r)=>n+(r.units||1),0);
 // Find the actual next local-date boundary, including DST and non-hour offsets.
 let low=Math.floor(at/1000),high=low+36*3600;while(high-low>1){const mid=Math.floor((low+high)/2);if(day(mid*1000)===today)low=mid;else high=mid;}
 return {unit:'requests',timezone,day:today,limit,used,remaining:Math.max(0,limit-used),exhausted:used>=limit,nextResetAt:new Date(high*1000).toISOString(),accountingSince:state.modelBudgetAccountingSince||rows.filter(r=>Number.isFinite(Date.parse(r.at))).map(r=>r.at).sort()[0]||null,unattributedLegacyRequests:rows.filter(r=>r.originalTimeUnknown).reduce((n,r)=>n+(r.units||1),0),countsUnknownResponses:true};
}
// Caller must invoke this inside the SAME Store transaction that records the
// request receipt. Reservations are not refunded on timeout or unknown results.
export function reserveModelBudget(state,{id,source,taskId,at=Date.now()}={}){
 requireValue(typeof id==='string'&&id.length>0&&id.length<=128&&['task','memory','group_decision'].includes(source)&&Number.isFinite(at),'模型请求预算记录无效');
 if(source==='task')requireValue(typeof taskId==='string'&&taskId.length>0,'任务预算缺少任务编号');
 const rows=reservations(state,at),prior=rows.find(r=>r.id===id);
 if(prior){requireValue(prior.source===source&&(prior.taskId||null)===(taskId||null),'请求编号预算归属不一致');state.modelBudgetReservations=rows;return {...modelBudgetStatus(state,{at}),deduplicated:true};}
 const status=modelBudgetStatus(state,{at});if(status.exhausted)throw new AppError('daily_request_budget',`今日模型请求已达${status.limit}次额度；${status.timezone}下一天自动恢复，可在设置调整。`,429);
 rows.push({id,source,...(taskId?{taskId}:{}),at:new Date(at).toISOString(),units:1});state.modelBudgetReservations=rows;state.modelBudgetAccountingSince||=rows.filter(r=>Number.isFinite(Date.parse(r.at))).map(r=>r.at).sort()[0]||new Date(at).toISOString();
 return {...modelBudgetStatus(state,{at}),deduplicated:false};
}
