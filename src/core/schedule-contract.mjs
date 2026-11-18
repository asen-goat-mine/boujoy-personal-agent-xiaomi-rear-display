import {affirmativeInstructions} from './instruction-scope.mjs';
import {stripTopLevelRoleMentions} from './role-mentions.mjs';
// Natural-language schedule authority is derived from the user's exact request.
// A model may propose UI steps, but cannot supply a date, recurrence, target or
// changed field that is absent from this locally derived plan.
const compact=value=>String(value||'').replace(/\s+/g,'');
const DATE=/\b\d{4}-\d{2}-\d{2}\b|\d{4}年\d{1,2}月\d{1,2}[日号]|\d{1,2}月\d{1,2}[日号]|今天|明天|后天|明早|今晚|(?:本周|这周|下周|周|星期)[一二三四五六日天]/g;
const TIME=/(?:上午|下午|晚上|早上|早晨|中午|凌晨)?\s*(?:\d{1,2}|[零一二三四五六七八九十两]{1,3})(?::\d{2}|点(?:半|(?:\d{1,2}|[零一二三四五六七八九十两]{1,3})分)?)/g;
const QUOTES=/[“「"]([^”」"]{1,200})[”」"]/g;
const WEEKDAYS={'一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'日':7,'天':7};
const pad=value=>String(value).padStart(2,'0');
const dateString=p=>`${p.year}-${pad(p.month)}-${pad(p.day)}`;
function number(value){if(/^\d+$/.test(value))return Number(value);const digits={'零':0,'一':1,'二':2,'两':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9};if(value==='十')return 10;if(value.includes('十')){const [a,b]=value.split('十');return (a?digits[a]:1)*10+(b?digits[b]:0);}return digits[value];}
export function validTimeZone(value){try{return typeof value==='string'&&!!new Intl.DateTimeFormat('en',{timeZone:value}).resolvedOptions().timeZone;}catch{return false;}}
function formatter(timezone){return new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});}
function parts(at,zone){return Object.fromEntries(formatter(zone).formatToParts(new Date(at)).filter(part=>part.type!=='literal').map(part=>[part.type,Number(part.value)]));}
function calendarDate(p,days=0){const d=new Date(Date.UTC(p.year,p.month-1,p.day+days));return {year:d.getUTCFullYear(),month:d.getUTCMonth()+1,day:d.getUTCDate()};}
function validDate(p){const value=calendarDate(p);return value.year===p.year&&value.month===p.month&&value.day===p.day;}
export function resolveWallTime(date,time,timezone){
 if(!validTimeZone(timezone)||!/^\d{4}-\d{2}-\d{2}$/.test(date||'')||!/^([01]\d|2[0-3]):[0-5]\d$/.test(time||''))return {status:'invalid',instants:[]};
 const [year,month,day]=date.split('-').map(Number),[hour,minute]=time.split(':').map(Number);if(!validDate({year,month,day}))return {status:'invalid',instants:[]};
 const wall=Date.UTC(year,month-1,day,hour,minute),offsets=new Set();
 // Offsets around the date capture both sides of modern DST transitions.
 for(let shift=-36;shift<=36;shift+=3){const at=wall+shift*3600000,p=parts(at,timezone);offsets.add(Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute)-at);}
 const instants=[...offsets].map(offset=>wall-offset).filter(at=>{const p=parts(at,timezone);return p.year===year&&p.month===month&&p.day===day&&p.hour===hour&&p.minute===minute;}).sort((a,b)=>a-b);
 return {status:instants.length===1?'unique':instants.length>1?'ambiguous':'nonexistent',instants:instants.map(at=>new Date(at).toISOString())};
}
function timeValue(text){const m=compact(text).match(/^(上午|下午|晚上|早上|早晨|中午|凌晨)?(.+?)(?::(\d{2})|点(?:(半)|(.+?)分)?)$/);if(!m)return null;let hour=number(m[2]),minute=m[3]?Number(m[3]):m[4]?30:m[5]?number(m[5]):0;if(['上午','早上','早晨','晚上'].includes(m[1])&&hour===12)return null;if(['下午','晚上'].includes(m[1])&&hour<12)hour+=12;if(m[1]==='中午'&&hour<11)hour+=12;if(['凌晨','上午','早上','早晨'].includes(m[1])&&hour===12)hour=0;return Number.isInteger(hour)&&hour>=0&&hour<24&&Number.isInteger(minute)&&minute>=0&&minute<60?`${pad(hour)}:${pad(minute)}`:null;}
function recurrence(text){
 if(/每天|每日/.test(text))return {kind:'daily',weekdays:[]};
 const m=text.match(/每(?:周|星期)([一二三四五六日天](?:[、，,和及至到-]?[一二三四五六日天])*)/);if(!m)return null;
 let weekdays;if(/[至到-]/.test(m[1])){const pair=m[1].split(/[至到-]/).map(value=>WEEKDAYS[value]);if(pair.length!==2||!pair.every(Boolean)||pair[1]<pair[0])return {invalid:true};weekdays=Array.from({length:pair[1]-pair[0]+1},(_,i)=>pair[0]+i);}else weekdays=[...m[1]].filter(c=>WEEKDAYS[c]).map(c=>WEEKDAYS[c]);
 return {kind:'weekly',weekdays:[...new Set(weekdays)].sort()};
}
function dateValue(text,referenceAt,timezone){
 const local=parts(referenceAt,timezone);let date;
 if(/今天|今晚/.test(text))date=calendarDate(local);else if(/明天|明早/.test(text))date=calendarDate(local,1);else if(/后天/.test(text))date=calendarDate(local,2);
 else if(/^\d{4}-/.test(text)){const [year,month,day]=text.split('-').map(Number);date={year,month,day};}
 else if(/月/.test(text)){const m=text.match(/(?:(\d{4})年)?(\d{1,2})月(\d{1,2})[日号]/);date={year:m[1]?Number(m[1]):local.year,month:Number(m[2]),day:Number(m[3])};}
 else {const m=text.match(/(本周|这周|下周|周|星期)([一二三四五六日天])/);if(!m)return null;const current=new Date(Date.UTC(local.year,local.month-1,local.day)).getUTCDay()||7;date=calendarDate(local,WEEKDAYS[m[2]]-current+(m[1]==='下周'?7:0));}
 return date&&validDate(date)?dateString(date):null;
}
function descriptor(text,{referenceAt,timezone}){
 const clean=text.replace(QUOTES,'[标题]').replace(/每(?:周|星期)[一二三四五六日天、，,和及至到-]+/g,'');
 const dates=[...clean.matchAll(DATE)],times=[...clean.matchAll(TIME)],quotes=[...text.matchAll(QUOTES)],repeatRule=recurrence(text);if(dates.length>1||times.length>1||quotes.length>1||repeatRule?.invalid)return {error:'multiple_or_invalid_schedule_values'};
 const value={};if(quotes.length)value.title=quotes[0][1];if(times.length){value.time=timeValue((/今晚/.test(clean)&&!/(?:上午|下午|晚上|早上|早晨|中午|凌晨)/.test(times[0][0])?'晚上':'')+times[0][0]);if(!value.time)return {error:'invalid_time'};}
 if(dates.length){value.date=dateValue(dates[0][0],referenceAt,timezone);if(!value.date)return {error:'invalid_date'};}
 if(repeatRule)value.repeatRule=repeatRule;
 else if(/仅一次|不重复|单次/.test(text))value.repeatRule={kind:'once',weekdays:[]};
 return value;
}
function intervalDescriptor(text,options){
 const unquoted=text.replace(QUOTES,value=>' '.repeat(value.length)),times=[...unquoted.matchAll(TIME)];
 if(times.length!==2)return descriptor(text,options);
 const startEnd=times[0].index+times[0][0].length,between=unquoted.slice(startEnd,times[1].index),separator=between.match(/(?:到|至)/);
 if(!separator)return {error:'multiple_or_invalid_schedule_values'};
 const cut=startEnd+separator.index,titles=[...text.matchAll(QUOTES)].map(match=>match[0]).join(''),start=descriptor(text.slice(0,cut).replace(QUOTES,'')+titles,options),end=descriptor(text.slice(cut+1).replace(QUOTES,''),options);
 if(start.error||end.error||!start.time||!end.time)return {error:start.error||end.error||'schedule_interval_invalid'};
 return {...start,endTime:end.time,...(end.date||start.date?{endDate:end.date||start.date}:{})};
}
function repeatLabel(rule){return rule?.kind==='daily'?'每天':rule?.kind==='weekly'?'每周'+rule.weekdays.map(day=>'一二三四五六日'[day-1]).join('、'):null;}
// Local reminder authority is separate from a phone calendar mutation. Quoted
// role/group names are data; repeated mentions of the same date/time agree.
export function parseLocalReminderRequest(raw,{referenceAt=Date.now(),timezone='Asia/Shanghai'}={}){
 const text=affirmativeInstructions(stripTopLevelRoleMentions(raw)),instruction=text.replace(QUOTES,' ').replace(/https?:\/\/[^\s，。；]+/g,' ');
 if(/^(?:请)?(?:怎么|如何|解释|分析|介绍|讲讲|什么是|列出|查看|检查已有|查询已有)/.test(instruction.trim())||!/提醒/.test(instruction)||/每天|每日|每晚|每周|每月|每隔|定期|(?<!不)重复/.test(instruction))return null;
 const clocks=[...instruction.matchAll(TIME)];
 if(!/(?:创建|新建|设置|设个|设一个|安排|添加|写进|写入).{0,40}提醒|提醒(?:我|我们|一下)/.test(instruction)&&!clocks.some(m=>/^[，,\s]*提醒/.test(instruction.slice(m.index+m[0].length))))return null;
 const zones=[...instruction.matchAll(/(?:[A-Za-z_+-]+\/)+[A-Za-z_+-]+/g)].map(m=>m[0]);const utc=instruction.match(/(?:时区|timezone)[为是：:\s]*(UTC|GMT)\b/i);if(utc)zones.push(utc[1].toUpperCase());const zone=zones[0]||timezone;
 if(new Set(zones).size>1||!validTimeZone(zone))return null;
 const ref=typeof referenceAt==='number'?referenceAt:Date.parse(referenceAt);if(!Number.isFinite(ref))return null;
 const dates=[...new Set([...instruction.matchAll(DATE)].map(m=>dateValue(m[0],ref,zone)))],times=[...new Set(clocks.map(m=>timeValue((/今晚/.test(instruction)&&!/(?:上午|下午|晚上|早上|早晨|中午|凌晨)/.test(m[0])?'晚上':'')+m[0])))];
 if(dates.length>1||dates.includes(null)||times.length!==1||!times[0])return null;
 const date=dates[0]||dateString(parts(ref,zone)),resolved=resolveWallTime(date,times[0],zone);if(resolved.status!=='unique')return null;
 const named=text.match(/提醒[^。；\n]{0,40}?(?:名称|名为)(?:为|是)?[：:\s]*[“「"]([^”」"]{1,120})[”」"]/);
 return {kind:'once',at:resolved.instants[0],timezone:zone,...(named?{name:named[1]}:{})};
}
export function parseScheduleRequest(raw,{referenceAt=Date.now(),timezone='Asia/Shanghai'}={}){
 const text=affirmativeInstructions(raw);
 if(/^(?:怎么|如何|为什么|解释|分析|介绍|讲讲|什么是)/.test(text.trim()))return null;
 const instruction=text.replace(QUOTES,'[标题]').replace(/(?:日程|日历)(?:助手|助理|专职|机器人)/g,'[角色]');if(!/闹钟|日程|日历/.test(instruction))return null;
 const kind=/闹钟/.test(instruction)?'alarm':'calendar',failure=reason=>({schemaVersion:1,kind,status:'needs_input',reason});
 const zones=[...instruction.matchAll(/(?:[A-Za-z_+-]+\/)+[A-Za-z_+-]+/g)].map(m=>m[0]);if(new Set(zones).size>1)return failure('multiple_timezones');const zone=zones[0]||timezone;
 if(!validTimeZone(zone))return failure('invalid_timezone');
 const ref=typeof referenceAt==='number'?referenceAt:Date.parse(referenceAt);if(!Number.isFinite(ref))return failure('invalid_reference');
 const deleting=/(?:取消|删除|移除)/.test(instruction),editing=/(?:修改|更改|改为|改成|改到|调到|推迟到|提前到|关闭|开启)/.test(instruction),creating=/(?:设置|设个|设一个|设|创建|新建|添加|安排)/.test(instruction);
 const checking=/检查.{0,20}(?:冲突|空闲)|(?:日历|日程).{0,50}(?:是否|有没有|有无).{0,6}冲突/.test(instruction);
 const operation=deleting?'delete':editing?'update':creating?'create':checking?'check':'read';if(operation==='read')return null;
 if(deleting&&/(?:修改|改为|改成|改到|创建|新建|添加)/.test(instruction))return failure('multiple_schedule_operations');
 let before=text,after='';if(operation==='update'){
  const marker=/(?:修改为|修改成|更改为|更改成|改为|改成|改到|调到|推迟到|提前到)/.exec(text);if(marker){before=text.slice(0,marker.index);after=text.slice(marker.index+marker[0].length);}else if(!/关闭|开启/.test(instruction))return failure('missing_schedule_change');
 }
 const options={referenceAt:ref,timezone:zone},target=intervalDescriptor(before,options),changes=operation==='update'?intervalDescriptor(after,options):{};if(target.error||changes.error)return failure(target.error||changes.error);
 if(operation==='update'&&/关闭|开启/.test(instruction))changes.enabled=!/关闭/.test(instruction);
 const desired=['create','check'].includes(operation)?{...target}:operation==='update'?{...target,...changes}:null;
 if(kind==='calendar'&&(operation!=='check'&&!(operation==='create'?desired:target).title||!(operation==='create'?desired:target).date))return failure('calendar_title_and_date_required');
 if(kind==='alarm'&&!(operation==='create'?desired:target).time)return failure('alarm_time_required');
 if(desired&&!desired.time)return failure('schedule_time_required');
 if(operation==='update'&&!Object.keys(changes).length)return failure('missing_schedule_change');
 const scope=/整个系列|所有重复|整个重复/.test(instruction)?'series':/仅本次|这一次|本次/.test(instruction)?'single':null;
 if(operation!=='create'&&target.repeatRule?.kind!=='once'&&target.repeatRule&&!scope)return failure('recurring_change_scope_required');
 if(operation!=='create'&&target.repeatRule?.kind!=='once'&&target.repeatRule&&scope==='single')return failure('recurring_single_occurrence_not_supported');
 // Defaults apply only to a new entry. Updating a time does not authorize
 // enabling a disabled alarm or replacing the existing repetition rule.
 if(operation==='create'&&!desired.repeatRule)desired.repeatRule={kind:'once',weekdays:[]};
 if(operation==='create'&&kind==='alarm'&&desired.enabled===undefined)desired.enabled=true;
 if(desired?.date){const resolution=resolveWallTime(desired.date,desired.time,zone);if(resolution.status!=='unique')return failure('local_time_'+resolution.status);desired.instant=resolution.instants[0];if(operation==='create'&&Date.parse(desired.instant)<=ref)return failure('scheduled_time_in_past');}
 if(desired?.endTime){if(kind!=='calendar'||!desired.date||!desired.endDate)return failure('schedule_end_date_required');const end=resolveWallTime(desired.endDate,desired.endTime,zone);if(end.status!=='unique')return failure('local_end_time_'+end.status);desired.endInstant=end.instants[0];const duration=Date.parse(desired.endInstant)-Date.parse(desired.instant);if(duration<=0||duration>7*86400000)return failure('schedule_interval_invalid');}
 if((operation==='check'||checking)&&!desired?.endInstant)return failure('conflict_search_interval_required');
 const value=desired||target;return {schemaVersion:1,status:'ready',kind,operation,checkConflicts:checking,timezone:zone,timezoneExplicit:zones.length===1,referenceAt:new Date(ref).toISOString(),target:['create','check'].includes(operation)?null:target,desired,changes:operation==='update'?changes:null,scope:scope||'single',time:value.time||null,date:value.date||null,title:value.title||null,repeatRule:value.repeatRule||null,repeat:repeatLabel(value.repeatRule),dateRequired:!!value.date,when:text};
}
export function schedulePlan(contract){
 const plan=contract?.objects?.schedule;if(plan?.status!=='ready')return null;
 const required=plan.operation==='check'?'read':plan.operation==='create'?'create_schedule':plan.operation==='delete'?'delete':'modify';if(!contract.effects?.includes(required))return null;
 return structuredClone(plan);
}
