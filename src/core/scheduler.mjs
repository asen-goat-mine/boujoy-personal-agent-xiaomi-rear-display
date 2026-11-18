import {randomUUID} from 'node:crypto';
import {requireValue,shortText} from './errors.mjs';
import {createTaskContract,requestHash} from './task-contract.mjs';
import {watchTaskInput,WATCH_RETRY_MS} from './watches.mjs';
import {groupReminderAvailable,bindGroupReminderTask} from './group-reminders.mjs';

const iso=value=>new Date(value).toISOString();
function zoneFormatter(timezone){
  try{return new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});}
  catch{requireValue(false,'时区必须是有效的 IANA 时区，例如 Asia/Shanghai');}
}
function parts(formatter,at){return Object.fromEntries(formatter.formatToParts(new Date(at)).filter(p=>p.type!=='literal').map(p=>[p.type,Number(p.value)]));}
function localTimestamp(p){return Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute);}
function localCandidates(formatter,p){
  const target=localTimestamp(p);let guess=target;
  for(let n=0;n<4;n++)guess+=target-localTimestamp(parts(formatter,guess));
  // Repeated DST minutes have two valid instants; nonexistent local minutes have none.
  const candidates=[];
  for(let shift=-180;shift<=180;shift+=15){const at=guess+shift*60000;if(localTimestamp(parts(formatter,at))===target)candidates.push(at);}
  return [...new Set(candidates)].sort((a,b)=>a-b);
}
export function nextScheduled({time,timezone='Asia/Shanghai',kind='daily',weekdays=[]},after=new Date()){
  requireValue(/^([01]\d|2[0-3]):[0-5]\d$/.test(time),'时间格式必须为 HH:mm');
  requireValue(kind==='daily'||kind==='weekly','重复安排类型无效');
  if(kind==='weekly')requireValue(Array.isArray(weekdays)&&weekdays.length>0&&weekdays.every(d=>Number.isInteger(d)&&d>=1&&d<=7),'每周日期用 1（周一）至 7（周日）');
  const formatter=zoneFormatter(timezone),local=parts(formatter,after.getTime()),[hour,minute]=time.split(':').map(Number);
  for(let day=0;day<370;day++){
    const calendar=new Date(Date.UTC(local.year,local.month-1,local.day+day));
    const weekday=calendar.getUTCDay()||7;if(kind==='weekly'&&!weekdays.includes(weekday))continue;
    const date={year:calendar.getUTCFullYear(),month:calendar.getUTCMonth()+1,day:calendar.getUTCDate(),hour,minute};
    // A repeated local clock minute fires once (the earlier offset), not twice.
    const next=localCandidates(formatter,date)[0];if(next!==undefined&&next>after.getTime())return iso(next);
  }
  requireValue(false,'没有找到下一次有效执行时间');
}
export function nextDaily(hhmm,after=new Date(),timezone='Asia/Shanghai'){return nextScheduled({time:hhmm,timezone,kind:'daily'},after);}

function authorizationFor(r,input,at){
  if(input.cloudConsent!==true)return null;
  const message={id:randomUUID(),role:'user',content:r.prompt};
  const candidate=createTaskContract({id:r.id,source:'user',prompt:r.prompt,messages:[message],cloudConsent:true,memoryConsent:input.memoryConsent===true},{at});
  const expiresAt=input.authorizationExpiresAt||null;
  if(expiresAt)requireValue(Number.isFinite(Date.parse(expiresAt))&&Date.parse(expiresAt)>at,'例行授权期限必须在未来');
  return {id:randomUUID(),source:'routine_configuration',promptSha256:requestHash(r.prompt),approvedAt:iso(at),expiresAt,cloudConsent:true,memoryConsent:input.memoryConsent===true,effects:candidate.effects,allowedApps:candidate.allowedApps};
}
export function createRoutine(input,{at=Date.now()}={}){
  requireValue(['once','daily','weekly'].includes(input.kind),'请选择单次、每日或每周安排');
  const executionWindowSeconds=input.executionWindowSeconds??300;
  requireValue(Number.isInteger(executionWindowSeconds)&&executionWindowSeconds>=10&&executionWindowSeconds<=86400,'执行窗口应为 10 至 86400 秒');
  if(input.maxRunSeconds!==undefined&&input.maxRunSeconds!==null)requireValue(Number.isInteger(input.maxRunSeconds)&&input.maxRunSeconds>=10&&input.maxRunSeconds<=1200,'执行时限应为 10 至 1200 秒');
  if(input.cloudConsent!==undefined)requireValue(typeof input.cloudConsent==='boolean','云模型授权应为布尔值');
  if(input.memoryConsent!==undefined)requireValue(typeof input.memoryConsent==='boolean','记忆授权应为布尔值');
  const r={id:randomUUID(),name:shortText(input.name,'名称',120),prompt:shortText(input.prompt),roleId:input.roleId||'concierge',taskKind:input.taskKind||'general',kind:input.kind,time:input.time||'',timezone:input.timezone||'Asia/Shanghai',weekdays:[...new Set(input.weekdays||[])].sort(),executionWindowSeconds,maxRunSeconds:input.maxRunSeconds??null,enabled:input.enabled!==false,createdAt:iso(at),nextAt:null,lastAt:null,history:[],cloudConsent:input.cloudConsent===true,memoryConsent:input.memoryConsent===true&&input.cloudConsent===true,authorization:null,revision:1};
  zoneFormatter(r.timezone);requireValue(['general','reminder'].includes(r.taskKind),'事务类型无效');
  if(r.kind==='once'){requireValue(Number.isFinite(Date.parse(input.nextAt))&&Date.parse(input.nextAt)>at,'单次时间必须在未来');r.nextAt=iso(input.nextAt);}
  else r.nextAt=nextScheduled(r,new Date(at));
  r.authorization=authorizationFor(r,input,at);return r;
}
// Phase 2: a routine asked for in chat ("每天9点帮我看看小红书新私信") is created
// by the model, bound to that conversation, and reports back into it. Because the
// model wrote the routine prompt, it may only read and look around; anything
// that sends, buys or changes things is set up in the 例行事务 form instead.
const SCHEDULE_WORDS=/每天|每日|每晚|每早|每周|每星期|每个?工作日|每月|每隔|定时|定期|提醒我|到点|自动任务|自动(?:给|帮|替)|(?:明天|明早|后天|今晚|今天|周[一二三四五六日天]|星期[一二三四五六日天])[^。！？\n]{0,12}(?:\d{1,2}(?:[:：.点]\d{0,2})|[一二三四五六七八九十]+点)|(?:^|[^\d.])(?:[01]?\d|2[0-3])[:：.](?:[0-5]\d)(?![\d.])[^。！？\n]{0,4}(?:的时候|时|自动|准时|给我|帮我|叫我|提醒|点|买|下单)|(?:上午|中午|下午|晚上|早上|凌晨)\s*(?:\d{1,2}|[一二三四五六七八九十]+)\s*(?:[:：.点])|remind me|every\s+(?:day|morning|evening|night|week|monday|tuesday|wednesday|thursday|friday)|daily|weekly/i;
export function userAskedForRoutine(task){return (task?.messages||[]).some(m=>m.role==='user'&&!m.externalContent&&!m.external_content&&!m.interjection&&SCHEDULE_WORDS.test(String(m.content||'')));}
export function createChatRoutine(task,args,{at=Date.now(),timezone='Asia/Shanghai'}={}){
  requireValue(task&&(task.source||'user')==='user'&&!task.parentId,'只有你直接发起的对话可以创建例行事务','routine_not_allowed');
  requireValue(task.cloudConsent===true,'这个对话还没有允许使用 DeepSeek','routine_not_allowed');
  requireValue(userAskedForRoutine(task),'你原话里没有提到定时或重复安排，没有创建例行事务','routine_not_requested');
  const routine=createRoutine({name:args.name,prompt:args.prompt,roleId:task.roleId||'concierge',taskKind:args.taskKind==='reminder'?'reminder':'general',kind:args.kind,time:args.time,weekdays:args.weekdays,nextAt:args.at,timezone:args.timezone||timezone,cloudConsent:true,memoryConsent:false},{at});
  routine.taskKind=args.taskKind==='reminder'?'reminder':'general';
  if(routine.authorization){routine.authorization.effects=routine.authorization.effects.filter(effect=>['read','navigate'].includes(effect));routine.authorization.chatCreated=true;}
  Object.assign(routine,{conversationId:task.conversationId||task.id,originTaskId:task.id,createdFrom:'chat'});
  return routine;
}
export function updateRoutine(existing,input,{at=Date.now()}={}){
  const scheduleChanged=['kind','time','nextAt','timezone','weekdays'].some(key=>input[key]!==undefined);
  const scopeChanged=['prompt','roleId','taskKind'].some(key=>input[key]!==undefined&&input[key]!==existing[key]);
  const merged={...existing,...input};
  // Editing a scope never silently transfers authorization to a different job.
  if(scopeChanged&&input.cloudConsent===undefined){merged.cloudConsent=false;merged.memoryConsent=false;}
  if(!scopeChanged&&input.cloudConsent===undefined){merged.cloudConsent=existing.cloudConsent;merged.memoryConsent=input.memoryConsent??existing.memoryConsent;}
  const template=createRoutine({...merged,kind:merged.kind==='once'&&!scheduleChanged?'daily':merged.kind,time:merged.time||'00:00'},{at});
  let updated={...template,id:existing.id,createdAt:existing.createdAt,history:existing.history||[],lastAt:existing.lastAt,revision:(existing.revision||1)+1,...(existing.conversationId?{conversationId:existing.conversationId,originTaskId:existing.originTaskId,createdFrom:existing.createdFrom}:{}),...(existing.groupId?{groupId:existing.groupId,groupReminderAuthority:existing.groupReminderAuthority,groupReminderKey:existing.groupReminderKey}:{})};
  if(!scheduleChanged)updated={...updated,kind:existing.kind,nextAt:existing.nextAt};
  const authorizationChanged=scopeChanged||input.cloudConsent!==undefined||input.memoryConsent!==undefined||input.authorizationExpiresAt!==undefined;
  updated.authorization=authorizationChanged?authorizationFor(updated,{...merged,authorizationExpiresAt:input.authorizationExpiresAt??existing.authorization?.expiresAt},at):existing.authorization||null;
  if(typeof input.enabled==='boolean')updated.enabled=input.enabled;
  updated.pausedAt=input.enabled===false?iso(at):input.enabled===true?null:existing.pausedAt||null;
  if(updated.enabled&&input.enabled===true){if(updated.kind!=='once')updated.nextAt=nextScheduled(updated,new Date(at));else requireValue(updated.nextAt&&Date.parse(updated.nextAt)>at,'单次时间已过，请先编辑为未来时间');}
  return updated;
}
export function routineTaskInput(routine,{at=Date.now(),slot=routine.nextAt,sourceTest=false}={}){
  requireValue(routine&&typeof routine.id==='string','例行任务不存在');
  requireValue(!routine.groupId||!sourceTest,'群提醒将在原用户指定的时刻向原群送达','group_reminder_scope');
  const start=sourceTest?at:Date.parse(slot);
  requireValue(Number.isFinite(start),'例行时间无效');
  const deadline=start+(routine.executionWindowSeconds||300)*1000,auth=routine.authorization;
  const authorized=auth?.source==='routine_configuration'&&!auth.revokedAt&&auth.cloudConsent===true&&auth.promptSha256===requestHash(routine.prompt)&&(!auth.expiresAt||Date.parse(auth.expiresAt)>at);
  return {prompt:routine.prompt,roleId:routine.roleId,kind:routine.taskKind||'general',cloudConsent:authorized,memoryConsent:authorized&&auth.memoryConsent===true,source:'routine',routineId:routine.id,routineTest:sourceTest,routineAuthorization:authorized?structuredClone(auth):null,submittedAt:iso(start),deadlineAt:iso(deadline),...(routine.maxRunSeconds?{maxRunSeconds:routine.maxRunSeconds}:{})};
}
export class Scheduler {
  constructor(store,engine){this.store=store;this.engine=engine;}
  start(){this.timer=setInterval(()=>{try{this.tick();}catch(e){this.lastError=e.code||'schedule_failed';}},1000);this.timer.unref();}
  tick(at=Date.now()){
    if(this.store.data.schedulerPaused||this.store.data.recoveryFence?.required)return;
    const due=this.store.data.routines.filter(r=>r.enabled&&r.nextAt&&Date.parse(r.nextAt)<=at);
    for(const r of due){
      const slot=r.nextAt,occurrenceKey=`${r.id}:${slot}`;
      this.store.transaction(s=>{
        const current=s.routines.find(x=>x.id===r.id);if(!current?.enabled||current.nextAt!==slot)return;
        if(current.groupId&&!groupReminderAvailable(current,{data:s},{slot})){current.enabled=false;current.pausedAt=iso(at);current.pauseReason='群提醒来源、成员或群状态已变化，未送达';return;}
        const alreadyCreated=s.tasks.some(t=>t.routineOccurrenceKey===occurrenceKey)||(current.history||[]).some(h=>h.slot===slot);
        const deadline=Date.parse(slot)+(current.executionWindowSeconds||300)*1000;
        let history={at:iso(at),slot,occurrenceKey,status:alreadyCreated?'deduplicated':at>=deadline?'expired':'created'};
        if(!alreadyCreated&&at<deadline){
          const task=this.engine.newTask(routineTaskInput(current,{at,slot}));
          if(current.groupId)bindGroupReminderTask(s,current,task,{slot,at});
          task.routineOccurrenceKey=occurrenceKey;s.tasks.push(task);history={...history,taskId:task.id};
        }
        current.history=[...(current.history||[]),history].slice(-100);current.lastAt=iso(at);
        if(current.kind!=='once')current.nextAt=nextScheduled(current,new Date(at));else{current.enabled=false;current.nextAt=null;}
      });
    }
    const watched=this.tickWatches(at);this.tickBriefs(at);
    if(due.length||watched)this.engine.pump();
  }
  // Why a phone check cannot run right now; it is skipped and retried later, never
  // queued behind or interleaved with the user's own phone work.
  phoneBusy(at){
    const data=this.store.data;
    if(data.settings.phoneEnabled===false)return 'phone_disabled';
    if(this.engine.remoteControlState?.()?.paused===true)return 'phone_paused';
    if(data.tasks.some(t=>t.source!=='watch'&&['queued','running','waiting_approval'].includes(t.status)&&(t.phoneUseScope||t.remoteDeviceId)))return 'phone_busy';
    if(data.tasks.some(t=>t.source==='watch'&&['queued','running','waiting_approval'].includes(t.status)&&(data.watches||[]).find(w=>w.id===t.watchId)?.check?.kind==='phone'))return 'phone_busy';
    if((data.actions||[]).some(a=>['executing','unknown'].includes(a.status)&&a.tool?.startsWith('phone_')&&!a.resolution&&data.tasks.some(t=>t.id===a.taskId&&['queued','running','waiting_approval','waiting_children'].includes(t.status))))return 'phone_unverified';
    return null;
  }
  tickBriefs(at=Date.now()){
    const due=this.store.data.roles.filter(r=>r.brief?.enabled&&r.brief.nextAt&&Date.parse(r.brief.nextAt)<=at&&!r.hidden&&!r.deletedAt).map(r=>r.id);
    for(const id of due){
      let fire=false;
      this.store.transaction(s=>{const r=s.roles.find(x=>x.id===id);if(!r?.brief?.enabled||Date.parse(r.brief.nextAt)>at)return;
        // Too late (Mac asleep all morning): skip to the next day instead of a stale brief.
        fire=at-Date.parse(r.brief.nextAt)<6*3600000;
        r.brief.nextAt=nextScheduled({time:r.brief.time,timezone:r.brief.timezone||'Asia/Shanghai',kind:'daily'},new Date(at));});
      if(fire){try{this.engine.deliverBrief(id,{at});}catch(error){this.lastError=error.code||'brief_failed';}}
    }
  }
  tickWatches(at=Date.now()){
    if(this.store.data.settings.watchesEnabled===false)return 0;
    const due=(this.store.data.watches||[]).filter(w=>w.status==='active'&&Date.parse(w.nextAt)<=at);
    let created=0;const notices=[];
    for(const {id} of due){
      this.store.transaction(s=>{
        const watch=(s.watches||[]).find(w=>w.id===id);if(!watch||watch.status!=='active'||Date.parse(watch.nextAt)>at)return;
        if(Date.parse(watch.expiresAt)<=at){watch.status='expired';watch.endedAt=iso(at);notices.push([id,`「${watch.goal}」的跟进到期了，已停止。最后一次结果：${watch.lastSummary||'还没有查到'}`]);return;}
        const interval=watch.intervalMinutes*60000;
        if(s.tasks.some(t=>t.source==='watch'&&t.watchId===id&&['queued','running','waiting_approval'].includes(t.status))){watch.nextAt=iso(at+interval);return;}
        const busy=watch.check.kind==='phone'?this.phoneBusy(at):null;
        if(busy){watch.lastSkip={at:iso(at),reason:busy};watch.nextAt=iso(at+Math.min(WATCH_RETRY_MS,interval));return;}
        let task;
        // A check that cannot even be created (its assistant was removed, recovery
        // fence…) pauses the watch with the reason instead of failing every second.
        try{task=this.engine.newTask(watchTaskInput(watch,{at}));}
        catch(error){watch.status='paused';watch.pausedAt=iso(at);watch.pauseReason=String(error.message||error.code||'无法创建检查').slice(0,200);notices.push([id,`「${watch.goal}」的跟进暂停了：${watch.pauseReason}`]);return;}
        task.archived=true;s.tasks.push(task);
        watch.nextAt=iso(at+interval);watch.lastSkip=null;watch.lastTaskId=task.id;created++;
      });
    }
    for(const [id,text] of notices){try{this.engine.watchNotice(id,text);}catch(error){this.lastError=error.code||'watch_notice_failed';}}
    return created+notices.length;
  }
  stop(){clearInterval(this.timer);}
}
