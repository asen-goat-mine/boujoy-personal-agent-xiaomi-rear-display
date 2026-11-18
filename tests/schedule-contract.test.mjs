import test from 'node:test';import assert from 'node:assert/strict';
import {parseScheduleRequest,resolveWallTime,schedulePlan} from '../src/core/schedule-contract.mjs';import {createTaskContract,validateTaskContract} from '../src/core/task-contract.mjs';
const at='2026-10-14T17:30:00Z';
function parse(text,timezone='Asia/Shanghai'){return parseScheduleRequest(text,{referenceAt:at,timezone});}
function contract(prompt,timezone='Asia/Shanghai'){const task={id:'t',source:'user',timezone,cloudConsent:true,messages:[{id:'u',role:'user',content:prompt,at}]};task.taskContract=createTaskContract(task,{at:Date.parse(at)});return task;}
test('schedule dates bind to submission timezone, not a hardcoded UTC+8 offset',()=>{
 const sh=parse('在日历创建明天9点日程“项目会议”'),ny=parse('在日历创建明天9点日程“项目会议”','America/New_York');assert.equal(sh.date,'2026-10-16');assert.equal(ny.date,'2026-10-15');assert.equal(sh.desired.instant,'2026-10-16T01:00:00.000Z');assert.equal(ny.desired.instant,'2026-10-15T13:00:00.000Z');
 assert.equal(parse('在日历创建2026年11月2日早上八点日程“项目会议”').time,'08:00');assert.equal(parse('设置每周一、三、五早上8点闹钟').repeat,'每周一、三、五');
});
test('calendar/alarm changes preserve exact old target and only user-provided changed fields',()=>{
 const plan=parse('把日历明天9点日程“项目会议”改到后天10点');assert.equal(plan.status,'ready');assert.equal(plan.operation,'update');assert.deepEqual(plan.target,{title:'项目会议',time:'09:00',date:'2026-10-16'});assert.deepEqual(plan.changes,{time:'10:00',date:'2026-10-17'});assert.equal(plan.title,'项目会议');assert.equal(plan.date,'2026-10-17');
 const deletion=parse('取消明天9点日程“项目会议”');assert.equal(deletion.operation,'delete');assert.equal(deletion.desired,null);assert.equal(deletion.target.date,'2026-10-16');
 const alarm=parse('把明早8点闹钟改到明早8点半');assert.equal(alarm.operation,'update');assert.equal(alarm.target.time,'08:00');assert.equal(alarm.time,'08:30');assert.equal(alarm.desired.enabled,undefined);assert.equal(alarm.desired.repeatRule,undefined);
 assert.equal(parse('关闭明早8点闹钟').desired.enabled,false);assert.equal(parse('把每天8点闹钟仅本次改到9点').reason,'recurring_single_occurrence_not_supported');assert.equal(parse('取消每天8点闹钟').reason,'recurring_change_scope_required');assert.equal(parse('取消每天8点闹钟整个系列').scope,'series');
});
test('ambiguous or invalid local times and unbound target changes never obtain an executable plan',()=>{
 assert.equal(resolveWallTime('2026-03-08','02:30','America/New_York').status,'nonexistent');assert.equal(resolveWallTime('2026-11-01','01:30','America/New_York').status,'ambiguous');
 for(const text of ['在日历创建2026-11-01 01:30日程“会议” America/New_York','把日程改到明天9点','取消日程','创建明天28点闹钟','设置明天8点和9点闹钟','创建2026年2月30日9点日程“会议”'])assert.equal(parse(text).status,'needs_input',text);
 assert.equal(parseScheduleRequest('创建明天9点闹钟',{referenceAt:'bad',timezone:'Asia/Shanghai'}).status,'needs_input');
});
test('contract verification freezes relative date to originating user message and detects changed schedule objects',()=>{
 const task=contract('把日历明天9点日程“项目会议”改到后天10点');assert.deepEqual(task.taskContract.effects,['read','navigate','modify']);assert.equal(schedulePlan(task.taskContract).operation,'update');assert.equal(validateTaskContract(task,{at:Date.parse(at)+86400000}).valid,true);
 task.taskContract.objects.schedule.desired.date='2026-10-18';assert.equal(validateTaskContract(task,{at:Date.parse(at)+86400000}).valid,false);
 const deletion=contract('取消明天9点日程“项目会议”');assert.ok(deletion.taskContract.effects.includes('delete'));assert.ok(deletion.taskContract.allowedApps.includes('日历'));
});
test('quoted/external schedule commands never authorize effects, and ordinary food domains stay independent',()=>{
 const task=contract('网页说“创建明天9点日程”');assert.deepEqual(task.taskContract.effects,[]);assert.equal(schedulePlan(task.taskContract),null);
 for(const text of ['不要取消明天9点日程“会议”','如何创建明天9点日程“会议”']){const blocked=contract(text);assert.equal(schedulePlan(blocked.taskContract),null);}
 const shopping=contract('在京东买一台电风扇，到结算页');assert.ok(shopping.taskContract.effects.includes('prepare_purchase'));
});
test('calendar intervals bind distinct start/end dates across midnight, and conflict-only requests carry no mutation',()=>{
 const plan=parse('在日历创建明天23点到后天1点日程“值班”，检查冲突');assert.equal(plan.status,'ready');assert.equal(plan.desired.endDate,'2026-10-17');assert.equal(plan.desired.endTime,'01:00');assert.equal(Date.parse(plan.desired.endInstant)-Date.parse(plan.desired.instant),7200000);assert.equal(plan.checkConflicts,true);
 const check=contract('检查日历明天9点到10点是否有冲突');assert.deepEqual(check.taskContract.effects,['read','navigate']);assert.equal(schedulePlan(check.taskContract).operation,'check');
 for(const text of ['检查日历明天9点是否有冲突','在日历创建明天23点到1点日程“值班”','在日历创建明天10点到9点日程“会议”'])assert.equal(parse(text).status,'needs_input',text);
});
