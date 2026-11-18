// Watchdog: an outside check on whether a running task is making progress.
// Inspired by the DeepSeek Harness Super-agent Watchdog session, but rule-based
// (no extra model calls). A "nudge" is delivered to the model inside its next
// tool result; a "stop" ends the run honestly instead of letting it burn the
// deadline and request budget. It never retries or performs an action itself.
const READ_TOOLS=new Set(['phone_observe','phone_status','phone_capabilities','browser_read','task_context','task_history']);
export const WATCHDOG_LIMITS={readNudge:5,readStop:9,sameNudge:3,sameStop:5,errorNudge:3,errorStop:5,stallMs:6*60000,progressNudge:30,renudgeAfter:4};
const MESSAGES={
  repeat_read:'你已连续多次只读取页面而没有操作。直接根据当前画面执行下一步；如果确实做不下去，用 finish_task(blocked) 一句话说明卡在哪里。',
  same_call:'你在重复同一个调用且参数完全相同，结果不会变。换一种做法（换目标、滚动、返回、换应用），或停下说明。',
  error_loop:'同一个错误已经出现多次。不要再用同样方式重试；换方法，或用 finish_task(blocked) 说明具体缺口和用户下一步。',
  no_progress:'本轮已调用很多次工具但还没有完成任何实际操作。确认目标是否明确、方法是否可行；不可行就如实停下说明。',
  stalled:'任务长时间没有任何进展，已由看门狗停下。'
};
// What the user sees when the watchdog stops a run.
export const WATCHDOG_USER_MESSAGES={
  repeat_read:'我在同一个页面反复查看但没能推进，先停下了。你看下手机当前页面，告诉我下一步或换个说法。',
  same_call:'我在重复同一个操作但没有效果，先停下了。可以换个说法，或告诉我具体要点哪里。',
  error_loop:'同一个问题反复出错，先停下了；最后的错误在「处理过程」里。',
  stalled:'这一轮长时间没有进展，已停下。回复「继续」我接着做。'
};
const isRead=event=>READ_TOOLS.has(event.tool)||event.tool==='phone_use'&&event.action==='read';

export function watchdogCheck(task,{now=Date.now(),actions=[],limits=WATCHDOG_LIMITS}={}){
  if(!task||!['running','waiting_approval'].includes(task.status))return {level:'ok'};
  const since=task.runStartedAt||'';const events=(task.events||[]).filter(event=>!since||event.at>=since);
  // User interjections, handoff notices and UI status events are not progress.
  // Count real model/tool activity, including the initial run boundary when a
  // hung request never produced its first event.
  const progress=events.filter(event=>['tool','tool_timing','tool_error','model_timing','turn','agent_job','harness_tool'].includes(event.type));
  const latestMessage=(task.messages||[]).filter(message=>message.role==='assistant'&&(!since||message.at>=since)).at(-1)?.at;
  const progressedAt=Math.max(...[since,progress.at(-1)?.at,latestMessage,...(task.harnessChildren||[]).map(row=>row.updatedAt)].map(value=>Date.parse(value)).filter(Number.isFinite));
  if(task.status==='running'&&Number.isFinite(progressedAt)&&now-progressedAt>limits.stallMs)return {level:'stop',code:'stalled',message:MESSAGES.stalled};
  const calls=events.filter(event=>event.type==='tool'&&event.tool!=='finish_task');
  const trailing=predicate=>{let n=0;for(let i=calls.length-1;i>=0&&predicate(calls[i],i);i--)n++;return n;};
  const reads=trailing(isRead);
  // Identical repeats only matter for tools that act on the phone, browser or web;
  // delegation and history calls are idempotent by design.
  const acting=call=>/^(?:phone_|browser_|web_|shop_flow$)/.test(call?.tool||'');
  // Repeating a scroll is useful while it reveals new content. A new capture
  // ID, clock tick, failed gesture, or a previously seen page is not progress.
  const advancing=new Set(),seen=new Set();let previousHash=null;
  for(const event of events){
    if(event.type!=='phone_tool_result'||event.outcome!=='returned'||!/^[a-f0-9]{64}$/.test(event.visibleContentHash||''))continue;
    const call=[...calls].reverse().find(call=>call.at<=event.at);
    if(previousHash&&event.visibleContentHash!==previousHash&&!seen.has(event.visibleContentHash)&&call&&['phone_use','phone_action'].includes(call.tool)&&['scroll','swipe'].includes(call.action)&&event.action===call.action)advancing.add(call);
    seen.add(event.visibleContentHash);previousHash=event.visibleContentHash;
  }
  const sig=calls.at(-1)?.sig,same=sig&&acting(calls.at(-1))&&!isRead(calls.at(-1))?trailing(call=>call.sig===sig&&!advancing.has(call)):0;
  // Pair each call with the error it produced (if any); a run of the same
  // failure with nothing succeeding in between is a loop.
  const outcomes=calls.map((call,index)=>{const end=calls[index+1]?.at;const error=events.find(event=>event.type==='tool_error'&&event.at>=call.at&&(!end||event.at<end));return error?`${error.tool||call.tool}:${error.code}`:null;});
  const key=outcomes.at(-1);let errors=0;if(key)for(let i=outcomes.length-1;i>=0&&outcomes[i]===key;i--)errors++;
  const stop=reads>=limits.readStop?'repeat_read':same>=limits.sameStop?'same_call':errors>=limits.errorStop?'error_loop':null;
  // Twice the stop count of the very same loop is not exploration any more: with
  // no per-run request cap this is what keeps a stuck run from spending all day.
  const hard=reads>=limits.readStop*2||same>=limits.sameStop*2||errors>=limits.errorStop*2;
  if(stop)return {level:'stop',code:stop,message:MESSAGES[stop],...(hard?{hard:true}:{})};
  const done=actions.some(action=>action.taskId===task.id&&action.status==='completed'&&(!since||String(action.finishedAt||'')>=since));
  const nudge=reads>=limits.readNudge?'repeat_read':same>=limits.sameNudge?'same_call':errors>=limits.errorNudge?'error_loop':calls.length>=limits.progressNudge&&!done?'no_progress':null;
  if(!nudge)return {level:'ok'};
  // Do not repeat the same nudge on every call; give the model a few steps to react.
  const given=events.filter(event=>event.type==='watchdog'&&event.code===nudge).at(-1);
  if(given&&calls.filter(call=>call.at>given.at).length<limits.renudgeAfter)return {level:'ok'};
  return {level:'nudge',code:nudge,message:MESSAGES[nudge]};
}
