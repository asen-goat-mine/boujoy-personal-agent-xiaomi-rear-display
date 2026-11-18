import {taskPhase} from './task-phase.mjs';

// A compact view of receipts, not a plan or an execution policy. A changed
// narration, a tool return, or a finished timer never completes a step here.
const ACTION_LABELS={tap:'已点按',long_press:'已长按',type:'已输入文字',swipe:'已滑动',scroll:'已滚动',back:'已返回'};
const WAITING_LABELS={queued:'等待执行',paused:'已暂停',stopped:'已停止',cancelled:'已取消',interrupted:'已中断',expired:'任务已到时限',failed:'任务未完成',unknown_result:'结果待核实',needs_review:'等待核实',waiting_approval:'等待你确认',waiting_consent:'等待你确认',waiting_setup:'等待设置',waiting_user:'等待你处理',needs_input:'等待你补充',ready_for_user:'等待你接手',blocked:'等待你处理'};
const RUNNING=new Set(['running','waiting_children']);
const SUCCEEDED=new Set(['completed','succeeded']);
const time=value=>typeof value==='string'&&value?Date.parse(value):NaN;
const validId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,96}$/.test(value);

function since(task){
 const run=time(task.runStartedAt);
 // A retry without its current run boundary cannot reuse an earlier receipt.
 if(task.status==='queued'&&task.attempt>0||task.attempt>1&&!Number.isFinite(run))return Infinity;
 const bounds=[run,time(task.timeline?.segmentStartedAt),time(task.createdAt)].filter(Number.isFinite);
 return bounds.length?Math.max(...bounds):Infinity;
}
function receiptLabel(action){
 if(action.executionStatus&&action.executionStatus!=='executed')return null;
 if(action.resultVerified===false)return null;
 if(action.tool==='phone_open_app')return '已打开应用';
 if(action.tool==='phone_action')return ACTION_LABELS[action.phoneOperation]||null;
 if(action.tool==='phone_system_navigation'&&action.resultVerified===true)return '已切换页面';
 if(action.tool==='phone_range_value'&&action.resultVerified===true)return '已调整数值';
 if(action.tool==='phone_schedule'&&action.verification==='verified')return '已核对日程';
 // Payment/order receipts can be completed but still await business verification.
 // They, unknown tools and arbitrary labels are deliberately not inferred here.
 return null;
}

export function taskProgress(task,{actions=[],note=null,now=Date.now()}={}){
 if(!task||typeof task!=='object'||!validId(task.id))return [];
 const boundary=since(task),at=Number.isFinite(now)?now:Date.now();
 const receipts=[];
 for(const action of Array.isArray(actions)?actions:[]){
  if(!action||action.taskId!==task.id||action.status!=='completed'||!validId(action.id))continue;
  const started=time(action.startedAt),finished=time(action.finishedAt);
  if(!Number.isFinite(started)||!Number.isFinite(finished)||started<boundary||finished<started||finished>at)continue;
  const label=receiptLabel(action);if(label)receipts.push({id:'action:'+action.id,label,state:'completed',finished,started});
 }
 receipts.sort((a,b)=>a.finished-b.finished||a.started-b.started||a.id.localeCompare(b.id));
 const completed=[],seen=new Set();
 for(const row of receipts){
  if(seen.has(row.id))continue;seen.add(row.id);
  if(completed.at(-1)?.label===row.label)completed[completed.length-1]=row;
  else completed.push(row);
 }
 const recent=completed.slice(-2).map(({id,label,state})=>({id,label,state}));
 let label,state;
 if(SUCCEEDED.has(task.status)){label='任务已完成';state='completed';}
 else if(RUNNING.has(task.status)){
  // The current line may reuse the same recent narration already shown in phase.
  // It never supplies a completion claim; old-attempt notes are not carried forward.
  const events=(Array.isArray(task.events)?task.events:[]).slice(-200).filter(event=>event&&time(event.at)>=boundary&&time(event.at)<=at);
  const currentNote=note&&time(note.at)>=boundary?note:null;
  const phase=taskPhase({...task,events},{note:currentNote,now:at});
  const narrated=typeof currentNote?.text==='string'&&currentNote.text.trim()&&phase?.phaseAt===currentNote.at;
  label=phase?.phase||'正在处理';state='running';
  // A returned result is no longer an operation in flight; wait for the next
  // recorded call instead of displaying a second spinner on the completed one.
  const last=events.at(-1);
  if(!narrated&&task.status==='running'&&(last?.type==='phone_tool_result'||last?.type==='harness_tool'&&last.phase==='tool/result'))label='正在处理下一步';
 }else{label=WAITING_LABELS[task.status]||'状态待核实';state='waiting';}
 return [...recent,{id:'current',label,state}];
}
