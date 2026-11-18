// Fusion phase 2, step 1: 持续跟进. A watch re-checks one thing on a schedule,
// read-only, and speaks up only when the result changes or the user's condition
// is met. Each check is an ordinary engine task with source 'watch'.
import {randomUUID} from 'node:crypto';
import {requireValue,shortText} from './errors.mjs';

export const WATCH_DEFAULT_MINUTES=60,WATCH_MIN_MINUTES=15,WATCH_MAX_MINUTES=1440;
export const WATCH_DEFAULT_DAYS=7,WATCH_MAX_DAYS=30,WATCH_MAX_ACTIVE=20,WATCH_MAX_FAILURES=3;
export const WATCH_RETRY_MS=15*60000,WATCH_CHECK_SECONDS=240;
const iso=value=>new Date(value).toISOString();

// A watch is only created when the user asked for ongoing follow-up in their own
// words. This is a safety gate on a standing background job, not intent parsing:
// the model still decides what to watch and how.
const FOLLOW_UP=/盯|跟进|跟踪|追踪|关注一下|留意|看着点|有(?:变化|更新|动静)|降到|降价|低于|高于|涨到|到货|签收|送达|(?:到了|变了|有了|降了|出来了|上架了?|发货了?)(?:就|的话)?(?:告诉|通知|提醒|叫)我|通知我|每(?:隔)?\s*\d*\s*(?:分钟|小时)|watch|track|monitor|notify me|keep an eye|let me know (?:when|if)/i;
export function userAskedToWatch(task){
  return (task?.messages||[]).some(m=>m.role==='user'&&!m.externalContent&&!m.external_content&&FOLLOW_UP.test(String(m.content||'')));
}

export function createWatch(task,args,{at=Date.now(),activeCount=0}={}){
  requireValue(task&&(task.source||'user')==='user'&&!task.parentId,'只有你直接发起的对话可以创建跟进','watch_not_allowed');
  requireValue(userAskedToWatch(task),'你原话里没有要求持续跟进或提醒，没有创建跟进','watch_not_requested');
  requireValue(activeCount<WATCH_MAX_ACTIVE,`进行中的跟进已达 ${WATCH_MAX_ACTIVE} 个，请先取消不需要的`,'watch_limit');
  const kind=args.kind||'web';requireValue(['web','phone'].includes(kind),'跟进方式只能是 web 或 phone');
  const app=kind==='phone'?shortText(args.app,'手机应用',40):null;
  const intervalMinutes=args.intervalMinutes??WATCH_DEFAULT_MINUTES;
  requireValue(Number.isInteger(intervalMinutes)&&intervalMinutes>=WATCH_MIN_MINUTES&&intervalMinutes<=WATCH_MAX_MINUTES,`检查间隔应为 ${WATCH_MIN_MINUTES} 至 ${WATCH_MAX_MINUTES} 分钟`);
  const days=args.days??WATCH_DEFAULT_DAYS;
  requireValue(Number.isFinite(days)&&days>0&&days<=WATCH_MAX_DAYS,`跟进期限应为 1 至 ${WATCH_MAX_DAYS} 天`);
  const optional=(value,label,max)=>value===undefined||value===null||value===''?null:shortText(value,label,max);
  const message=(task.messages||[]).filter(m=>m.role==='user'&&!m.interjection).at(-1);
  return {
    id:randomUUID(),conversationId:task.conversationId||task.id,originTaskId:task.id,sourceMessageId:message?.id||null,roleId:task.roleId||'concierge',
    goal:shortText(args.goal,'跟进目标',300),condition:optional(args.condition,'通知条件',200),
    check:{kind,app,hint:optional(args.hint,'查看方法',300)},
    intervalMinutes,createdAt:iso(at),expiresAt:iso(at+days*86400000),nextAt:iso(at+intervalMinutes*60000),
    lastDigest:optional(args.baseline,'当前状态',200),lastSummary:optional(args.baselineSummary,'当前状态说明',500),lastCheckedAt:args.baseline?iso(at):null,
    status:'active',failures:0,checks:0,history:[]
  };
}

export function watchTaskInput(watch,{at=Date.now()}={}){
  const where=watch.check.kind==='phone'?`在手机「${watch.check.app}」里查看。`:'用 web_search / web_fetch 查。';
  const prompt=[`持续跟进检查：${watch.goal}`,watch.condition?`通知条件：${watch.condition}`:'',where,watch.check.hint?`查看方法：${watch.check.hint}`:''].filter(Boolean).join('\n');
  return {prompt,roleId:watch.roleId,kind:'general',cloudConsent:true,memoryConsent:false,source:'watch',watchId:watch.id,conversationId:watch.id,phoneQuery:null,maxRunSeconds:WATCH_CHECK_SECONDS,submittedAt:iso(at)};
}

// Context the check task's model gets: the previous result, as data only.
export function watchContext(watch){
  return {goal:watch.goal,condition:watch.condition,kind:watch.check.kind,app:watch.check.app,previousDigest:watch.lastDigest,previousSummary:watch.lastSummary,previousCheckedAt:watch.lastCheckedAt,
    rules:'只读：只看、搜索、滚动、返回；不点发送、下单、确认收货、评价、关注、删除或开关。看完必须调用 watch_report：digest 写一个能和上次直接比较的简短状态（如「运输中·到达杭州」或「¥829」），summary 用一两句话说明，met 表示通知条件是否已满足（没有条件时填 false）：只有确实是目标本身才算，配件、手机壳、贴膜、周边、求购、租赁、回收、明显问题件都不算；拿不准就填 false 并在 summary 里说明。看不到就如实写在 summary 里并把 digest 留空。'};
}

const normal=value=>String(value||'').normalize('NFKC').replace(/\s+/g,'').toLowerCase();
// Decide what one check means. Returns the watch patch and an optional notice.
export function applyWatchReport(watch,{digest,summary,met},{at=Date.now()}={}){
  const seen=typeof digest==='string'&&digest.trim()?digest.trim().slice(0,200):null;
  const text=String(summary||'').trim().slice(0,500);
  const patch={lastCheckedAt:iso(at),checks:(watch.checks||0)+1};
  if(!seen)return {patch:{...patch,failures:(watch.failures||0)+1},notice:null,outcome:'unreadable'};
  const first=!watch.lastDigest,changed=!first&&normal(seen)!==normal(watch.lastDigest);
  Object.assign(patch,{lastDigest:seen,lastSummary:text||seen,failures:0});
  if(met===true){
    patch.status='done';patch.endedAt=iso(at);
    return {patch,notice:`跟进有结果了：${text||seen}\n（目标「${watch.goal}」已达成，这条跟进到此结束。）`,outcome:'met'};
  }
  // With a condition ("到600以下告诉我") the user asked to hear only when it is
  // met; other movements are recorded but stay silent.
  if(changed&&watch.condition)return {patch,notice:null,outcome:'changed_quiet'};
  if(changed)return {patch,notice:`跟进有变化：${text||seen}\n（上次：${watch.lastSummary||watch.lastDigest}）`,outcome:'changed'};
  return {patch,notice:null,outcome:first?'baseline':'unchanged'};
}

export function watchSummary(watch){
  const {id,goal,condition,check,intervalMinutes,expiresAt,nextAt,lastDigest,lastSummary,lastCheckedAt,status,failures,checks,lastSkip}=watch;
  return {id,goal,condition,kind:check.kind,app:check.app,intervalMinutes,expiresAt,nextAt,lastDigest,lastSummary,lastCheckedAt,status,failures,checks,lastSkip:lastSkip||null};
}
