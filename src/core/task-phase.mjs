// A short, real description of where a task is, for the phone's rear-screen
// panel. It is derived from recorded events only: no percentages, no guesses.
const TOOLS={python_run:'处理本机数据',document_create:'生成文档',artifact_read:'读取附件',connector_list:'查看已连接工具',connector_call:'调用已连接工具',workflow_use:'应用做事方法',memory_context:'查找相关记忆',browser_open:'打开网页',browser_read:'读取页面',browser_action:'操作网页',phone_use:'操作手机',phone_status:'检查手机连接',phone_apps:'查找手机应用',phone_open_app:'打开手机应用',phone_observe:'查看手机页面',phone_action:'操作手机',phone_capabilities:'检查手机能力',web_search:'搜索网页',web_fetch:'打开网页',artifact_write:'整理交付文件',delegate_task:'交接给其他助理',finish_task:'核验处理结果'};
const PHONE_ACTIONS={open_app:'打开应用',read:'读取画面',tap:'点按',long_press:'长按',type:'输入文字',swipe:'滑动',scroll:'滚动',back:'返回',search:'搜索',set_value:'调整数值'};
const STATUS={queued:'排队中',waiting_approval:'等待你确认',waiting_children:'等待子任务',blocked:'需要你处理',completed:'已完成',failed:'未完成',cancelled:'已取消',interrupted:'已中断'};
const MODEL_EVENTS=new Set(['model_timing','reasoning','turn','harness_session']);
const TOOL_EVENTS=new Set(['tool','phone_tool_result','tool_error']);

function toolLabel(event){
 const tool=String(event.tool||'').replace(/^mcp__personal__/,'');
 const base=TOOLS[tool]||'使用工具';
 if((tool==='phone_use'||tool==='phone_action')&&PHONE_ACTIONS[event.action])return `${base}：${PHONE_ACTIONS[event.action]}`;
 return base;
}

// note: the assistant's own latest short line for this run (what it said it is doing,
// e.g. “正在打开淘宝搜纸巾”). When it is recent it is the best description there is;
// otherwise the phase falls back to the recorded step.
function spoken(note,now){
 if(!note||typeof note.text!=='string'||typeof note.at!=='string')return null;
 const age=now-Date.parse(note.at);if(!Number.isFinite(age)||age<-5000||age>90000)return null;
 const line=note.text.split(/\n+/).map(row=>row.replace(/[*_`#>]+/g,'').replace(/\s+/g,' ').trim()).filter(Boolean).at(-1);
 if(!line)return null;
 const chars=[...line];
 return {phase:chars.length>36?chars.slice(0,35).join('')+'…':line,phaseAt:note.at};
}
export function taskPhase(task,{note=null,now=Date.now()}={}){
 if(!task||typeof task!=='object')return null;
 if(task.status!=='running'){
  const label=STATUS[task.status];
  return label?{phase:label,phaseAt:task.updatedAt||null}:null;
 }
 const said=spoken(note,now);if(said)return said;
 const events=Array.isArray(task.events)?task.events:[];
 for(let index=events.length-1;index>=0&&index>=events.length-200;index--){
  const event=events[index];if(!event||typeof event.at!=='string')continue;
  if(event.type==='tool_error')return {phase:'遇到问题，正在调整',phaseAt:event.at};
  if(TOOL_EVENTS.has(event.type)&&event.tool)return {phase:toolLabel(event),phaseAt:event.at};
  if(event.type==='harness_tool'&&event.phase==='tool/call'&&event.tool)return {phase:toolLabel(event),phaseAt:event.at};
  if(MODEL_EVENTS.has(event.type))return {phase:'正在思考',phaseAt:event.at};
 }
 return {phase:'正在处理',phaseAt:task.runStartedAt||task.updatedAt||null};
}
