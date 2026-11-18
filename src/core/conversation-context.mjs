import {requireValue} from './errors.mjs';

const visible=task=>(task.messages||[]).flatMap((message,index)=>['user','assistant'].includes(message.role)&&typeof message.content==='string'?[{message,ref:`m${index+1}`,index}]:[]);
const boundary=(text,index)=>index>0&&index<text.length&&/[\uD800-\uDBFF]/.test(text[index-1])&&/[\uDC00-\uDFFF]/.test(text[index])?index-1:index;
function frame(row,limit){
 const {message,ref}=row,text=message.content;
 const base={ref,id:typeof message.id==='string'?message.id.slice(0,128):null,role:message.role,at:Number.isFinite(Date.parse(message.at))?message.at:null,externalContent:message.externalContent===true||message.external_content===true,totalChars:text.length};
 const full={...base,contentComplete:true,content:text};if(JSON.stringify(full).length<=limit)return full;
 // Exact excerpts, never a generated summary or a summary of a summary.
 const excerpt=count=>{const head=boundary(text,Math.floor(count/3)),tail=boundary(text,text.length-(count-head));return {...base,contentComplete:false,contentSegments:[{offset:0,text:text.slice(0,head)},{offset:tail,text:text.slice(tail)}]};};
 let low=0,high=text.length;while(low<high){const mid=Math.ceil((low+high)/2);if(JSON.stringify(excerpt(mid)).length<=limit)low=mid;else high=mid-1;}
 const result=excerpt(low);return JSON.stringify(result).length<=limit?result:null;
}
function omittedRanges(rows,selected){
 const ranges=[];for(const row of rows){if(selected.has(row.index))continue;const last=ranges.at(-1),n=row.index+1;if(last?.[1]===n-1)last[1]=n;else ranges.push([n,n]);}
 return {ranges:ranges.slice(0,32),rangesTruncated:ranges.length>32};
}
// One conversation can span several execution tasks (each new goal starts a
// task with a fresh contract and deadline). The model must still see the whole
// conversation, so history is read across the sibling tasks in order. Earlier
// turns are context only; the current task's contract still decides authority.
export function conversationSiblings(task,store){
 const key=task?.conversationId||task?.id,tasks=store?.data?.tasks||[];
 if(!key)return task?[task]:[];
 const rows=tasks.filter(row=>(row.conversationId||row.id)===key&&!row.parentId&&(row.source||'user')===(task.source||'user'));
 if(!rows.some(row=>row.id===task.id))rows.push(task);
 return rows.sort((a,b)=>String(a.createdAt).localeCompare(String(b.createdAt))||(a.id===task.id?1:b.id===task.id?-1:0));
}
export function conversationTranscript(task,store){
 const siblings=conversationSiblings(task,store);
 if(siblings.length<=1)return task;
 // A notice's title line (跟进：… / 例行：…) is stored as a user message but is not
 // the user's words; only its assistant reply enters the model's history.
 const earlier=siblings.filter(row=>row.id!==task.id).flatMap(row=>(row.messages||[]).filter(message=>!(message.watchNotice&&message.role==='user')).map(message=>({...message,taskId:row.id})));
 return {...task,messages:[...earlier,...(task.messages||[])]};
}
export function buildConversationContext(task,{maxChars=48000}={}){
 requireValue(Number.isSafeInteger(maxChars)&&maxChars>=12000&&maxChars<=96000,'对话上下文预算无效');
 const rows=visible(task),users=rows.filter(row=>row.message.role==='user'),selected=new Map();let used=0;
 const byId=id=>id&&rows.find(row=>row.message.id===id),source=task.taskContract?.source||{};
 const priority=[users.at(-1),byId(source.messageId),byId(source.originMessageId),users[0],...rows.slice(-12).reverse(),...users.slice().reverse(),...rows.slice().reverse()];
 for(const row of priority){
  if(!row||selected.has(row.index)||selected.size>=80)continue;
  const room=maxChars-2048-used;if(room<512)continue;
  const result=frame(row,Math.min(room,row.message.role==='user'?60000:8000));if(!result)continue;
  selected.set(row.index,result);used+=JSON.stringify(result).length+1;
 }
 const omitted=omittedRanges(rows,selected),messages=[...selected].sort(([a],[b])=>a-b).map(([,message])=>message);
 const data={schemaVersion:1,totalMessages:rows.length,includedMessages:messages.length,omittedMessages:rows.length-messages.length,omittedRanges:omitted.ranges,omittedRangesTruncated:omitted.rangesTruncated,messages};
 const text=JSON.stringify(data);
 requireValue(text.length<=maxChars,'对话上下文超过预算');
 return {text,data,stats:{budgetChars:maxChars,packedChars:text.length,totalMessages:rows.length,includedMessages:messages.length,omittedMessages:data.omittedMessages,excerptedMessages:messages.filter(row=>!row.contentComplete).length}};
}
export function readConversationHistory(task,args={}){
 requireValue(args&&typeof args==='object'&&!Array.isArray(args),'历史读取参数无效');
 const rows=visible(task),action=args.action;
 requireValue(['list','read'].includes(action),'历史读取操作无效');
 if(action==='read'){
  requireValue(Object.keys(args).every(key=>['action','messageRef','offset','maxChars'].includes(key)),'读取原文时不接受其他参数');
  requireValue(typeof args.messageRef==='string'&&/^m[1-9]\d{0,8}$/.test(args.messageRef),'消息编号无效');
  const row=rows.find(row=>row.ref===args.messageRef);requireValue(row,'此消息不在当前对话中');
  const offset=args.offset??0,maxChars=args.maxChars??6000,text=row.message.content;
  requireValue(Number.isSafeInteger(offset)&&offset>=0&&offset<=text.length&&Number.isSafeInteger(maxChars)&&maxChars>=1&&maxChars<=12000,'原文读取范围无效');
  const start=boundary(text,offset);let end=boundary(text,Math.min(text.length,start+maxChars));
  // A single UTF-16 unit cannot hold an astral character. Return it whole and
  // advance rather than looping forever at the same continuation offset.
  if(end===start&&start<text.length)end=Math.min(text.length,start+2);
  return {ref:row.ref,id:row.message.id||null,role:row.message.role,at:row.message.at||null,externalContent:row.message.externalContent===true||row.message.external_content===true,offset:start,totalChars:text.length,content:text.slice(start,end),nextOffset:end<text.length?end:null,authority:false};
 }
 requireValue(Object.keys(args).every(key=>['action','query','beforeRef'].includes(key)),'检索历史时不接受原文范围参数');
 requireValue(args.query===undefined||typeof args.query==='string'&&args.query.trim().length>0&&args.query.length<=200,'历史关键词无效');
 requireValue(args.beforeRef===undefined||typeof args.beforeRef==='string'&&/^m[1-9]\d{0,8}$/.test(args.beforeRef),'历史翻页编号无效');
 const before=args.beforeRef===undefined?Infinity:rows.find(row=>row.ref===args.beforeRef)?.index;requireValue(before!==undefined,'历史翻页编号不在当前对话中');
 const query=args.query?.trim().toLowerCase(),matches=rows.filter(row=>row.index<before&&(!query||row.message.content.toLowerCase().includes(query))),page=matches.slice(-20).reverse();
 return {totalMessages:rows.length,matchesBeforeCursor:matches.length,messages:page.map(row=>{const text=row.message.content,match=query?text.toLowerCase().indexOf(query):0,start=boundary(text,Math.max(0,match-60)),end=boundary(text,Math.min(text.length,start+240));return {ref:row.ref,id:row.message.id||null,role:row.message.role,at:row.message.at||null,externalContent:row.message.externalContent===true||row.message.external_content===true,totalChars:text.length,preview:text.slice(start,end),previewOffset:start};}),nextBeforeRef:matches.length>page.length?page.at(-1).ref:null,authority:false};
}
export function conversationUserRefs(task){
 const rows=visible(task).filter(row=>row.message.role==='user'),source=task.taskContract?.source||{},ids=new Set([source.messageId,source.originMessageId,rows[0]?.message.id].filter(id=>typeof id==='string'&&id));
 return rows.filter((row,index)=>ids.has(row.message.id)||index>=rows.length-6).map(row=>({id:row.message.id,ref:row.ref,content:row.message.content.slice(0,2000),contentComplete:row.message.content.length<=2000,externalContent:row.message.externalContent===true||row.message.external_content===true}));
}
export function taskTimeContext(task,{at=Date.now()}={}){
 requireValue(Number.isFinite(at),'当前时间无效');const configured=task.timezone||'Asia/Shanghai';let timezone=configured,format;
 const options={year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23',timeZoneName:'longOffset'};
 try{format=new Intl.DateTimeFormat('en-CA',{...options,timeZone:timezone});}catch{timezone='UTC';format=new Intl.DateTimeFormat('en-CA',{...options,timeZone:timezone});}
 const latest=visible(task).filter(row=>row.message.role==='user').at(-1)?.message;
 return {now:new Date(at).toISOString(),localNow:format.format(at),timezone,...(timezone!==configured?{configuredTimezoneInvalid:true}:{}),latestUserMessageAt:Number.isFinite(Date.parse(latest?.at))?latest.at:null,relativeTimeRule:'今天/明天等相对时间以对应用户消息的发送时间和时区解释；当前时间只用于检查是否过期，不把旧消息重新解释为今天。'};
}
// An earlier turn that stopped without a reply (phone paused, stopped, blocked)
// used to show only the user's message, so a resend looked ignored. Show why.
const ENDED=['paused','blocked','failed','expired','needs_review','interrupted','unknown_result','cancelled','ready_for_user'];
export function conversationMessages(row,current){
  const messages=(row.messages||[]).map(message=>({...message,taskId:row.id}));
  if(row.id===current?.id||!ENDED.includes(row.status))return messages;
  const last=messages.filter(m=>!m.interjection).at(-1),note=row.status==='ready_for_user'?row.result:row.blockedReason||row.result;
  if(last?.role==='assistant'||!note)return messages;
  return [...messages,{id:'outcome-'+row.id,role:'assistant',content:String(note).slice(0,2000),at:row.runFinishedAt||row.updatedAt,taskId:row.id,outcome:row.status}];
}

// Diagnostic facts only: task-local events, never a guessed cause from siblings.
export function taskExecutionSummary(task){
 const events=task.events||[],tools=events.filter(e=>e.type==='tool'),phone=tools.filter(e=>String(e.tool||'').startsWith('phone_'));
 const failure=events.filter(e=>['planning_error','tool_error','error'].includes(e.type)).at(-1);
 return {toolCalls:tools.length,phoneToolCalls:phone.length,lastTool:tools.at(-1)?.tool||null,...(failure?{lastFailure:{code:failure.code||'unrecorded',stage:failure.stage||failure.tool||'unrecorded',message:failure.text||'',at:failure.at},diagnosticNote:failure.code?'Only the recorded failure belongs to this task; do not infer another task’s cause.':'Detailed cause was not recorded. Do not infer an app failure from another task.'}:{})};
}
