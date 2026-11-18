const $=s=>document.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icon=n=>`<img class="icon" src="/icons/${n}.svg" alt="">`;
const button=(action,label,glyph,extra='')=>`<button type="button" class="icon-button" data-action="${action}" aria-label="${esc(label)}" title="${esc(label)}" ${extra}>${icon(glyph)}</button>`;
const STATUS={expired:'已超时',needs_input:'请补充一句需求',queued:'正在排队',running:'正在处理',waiting_consent:'等待你的授权',waiting_setup:'需要连接模型',waiting_approval:'有一步需要确认',waiting_children:'正在协作',completed:'已完成',ready_for_user:'等你接手',blocked:'暂时未完成',failed:'暂时未能完成',cancelled:'已停止',paused:'已暂停',interrupted:'等待续接',unknown_result:'需要核实结果',needs_review:'需要查看结果'};
const ACTIVE=['queued','running','waiting_approval','waiting_children'];
const ATTENTION=['expired','needs_input','waiting_approval','waiting_consent','waiting_setup','blocked','unknown_result','interrupted','needs_review','ready_for_user'];
const KINDS={general:'通用对话',food:'外卖比价',shopping:'购物比价',travel:'出行安排',booking:'预约办事',work:'工作任务',reminder:'本地提醒'};
const BOT_COLORS=['violet','amber','green','blue','pink','coral','teal','silver','gold','sky','orchid','lime'];
const BOT_COLOR_NAMES={violet:'紫晶',amber:'暖橙',green:'翠绿',blue:'海蓝',pink:'莓粉',coral:'珊瑚红',teal:'湖绿',silver:'银灰',gold:'柠黄',sky:'天青',orchid:'兰紫',lime:'青柠'};
const DEFAULT_BOT_COLORS={concierge:'violet',life:'amber',shopping:'green',travel:'blue',work:'pink'};
function botColor(r){if(BOT_COLORS.includes(r?.botColor))return r.botColor;if(DEFAULT_BOT_COLORS[r?.id])return DEFAULT_BOT_COLORS[r.id];return BOT_COLORS[Array.from(r?.id||'').reduce((n,c)=>(n*31+c.charCodeAt(0))>>>0,0)%BOT_COLORS.length];}
// A new bot gets a color no visible bot is using yet, so the sidebar can tell them apart.
function nextBotColor(){const used=new Set((state?.roles||[]).filter(r=>!r.hidden&&!r.deletedAt).map(botColor)),free=BOT_COLORS.filter(c=>!used.has(c));const pool=free.length?free:BOT_COLORS,n=new Uint32Array(1);crypto.getRandomValues(n);return pool[n[0]%pool.length];}
const TOOLS={python_run:'处理本机数据',document_create:'生成文档',artifact_read:'读取本次附件',phone_prepare_payment:'准备付款交接',connector_list:'查看已连接工具',connector_call:'调用已连接工具',workflow_list:'查找做事方法',workflow_read:'读取做事方法',workflow_draft:'整理做事方法',workflow_use:'应用做事方法',task_context:'了解当前任务',memory_context:'查找相关记忆',memory_propose:'整理值得保留的经验',browser_open:'打开网页',browser_read:'读取页面',browser_action:'操作网页',phone_use:'操作手机',phone_status:'检查手机连接',phone_apps:'查找手机应用',phone_open_app:'打开手机应用',phone_search:'搜索本次餐品',phone_observe:'查看手机页面',phone_action:'操作手机',quote_record:'记录商品价格',quote_compare:'比较购买条件',artifact_write:'整理交付文件',artifact_list:'查看任务文件',delegate_task:'交接给其他助理',delegation_status:'查看协作进展',finish_task:'核验处理结果'};
let sessionRefresh=null;
let state=null,health=null,detail=null,csrf='',selectedRole='concierge',selectedId=null,online=false,refreshVersion=0,composerKey='',sending=new Set(),panel='',search='',historyFilter='current',memoryData=null,navigationVersion=0;
let phoneSetup={pending:null,paired:null,devices:[],status:null};
const fileDrafts=new Map();let fileReading=0;
// Keep unsent text local across a reload; sending still requires an explicit submit.
class LocalDrafts extends Map {
  constructor(storage){super();this.storage=storage;try{const rows=JSON.parse(storage.getItem('boujoy.drafts.v1')||'[]');if(Array.isArray(rows))for(const row of rows.slice(-100)){if(Array.isArray(row)&&typeof row[0]==='string'&&typeof row[1]==='string'&&row[0].length<=160&&row[1].length<=100000)super.set(row[0],row[1]);}}catch{}}
  persist(){try{this.storage.setItem('boujoy.drafts.v1',JSON.stringify([...this].filter(([,v])=>v).slice(-100)));}catch{}}
  set(key,value){super.set(key,value);this.persist();return this;}
  delete(key){const removed=super.delete(key);this.persist();return removed;}
  clear(){super.clear();this.persist();}
}
const drafts=new LocalDrafts(localStorage),prefs=new Map(),pendingSends=new Map(),taskControlsPending=new Set();let eventSource;
const SEND_RECEIPTS_KEY='boujoy.pending-sends.v1';
let voiceRecording=null,voicePending=false,voiceStarting=false,speechPlayback=null,speechVersion=0;
let selections={};try{selections=JSON.parse(localStorage.getItem('boujoy.chat-selection')||'{}');}catch{}
function toast(text){$('#toast').textContent=text;$('#toast').classList.add('visible');clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('#toast').classList.remove('visible'),4500);}
async function refreshSession(){
  if(!sessionRefresh)sessionRefresh=api('/session',undefined,false).then(value=>{csrf=value.csrf;}).finally(()=>{sessionRefresh=null;});
  return sessionRefresh;
}
async function api(endpoint,body,retry=true){
  const response=await fetch('/api'+endpoint,{method:body===undefined?'GET':'POST',signal:AbortSignal.timeout(body===undefined?10000:30000),headers:body===undefined?{}:{'Content-Type':'application/json','X-Boujoy-CSRF':csrf},body:body===undefined?undefined:JSON.stringify(body)});
  const value=await response.json();
  if(retry&&endpoint!=='/session'&&(response.status===401||response.status===403&&value.error?.code==='csrf')){await refreshSession();return api(endpoint,body,false);}
  if(!response.ok){const e=new Error(value.error?.message||'操作未完成');e.code=value.error?.code;throw e;}return value;
}

const role=id=>state?.roles.find(r=>r.id===id)||state?.roles[0];
const privateTask=t=>!t.groupId&&!t.groupContext&&!t.parentId&&!String(t.conversationId||'').startsWith('group:');
const latest=id=>state?.tasks.filter(t=>t.roleId===id&&!t.archived&&privateTask(t)).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))[0];
const clock=at=>at?new Date(at).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}):'';
const date=at=>at?new Date(at).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}):'—';
function stamp(at){if(!at)return '';return new Date(at).toLocaleDateString('en-CA')===new Date().toLocaleDateString('en-CA')?clock(at):new Date(at).toLocaleDateString('zh-CN',{month:'numeric',day:'numeric'});}
function robotMood(status){
  if(!online)return 'offline';
  if(ATTENTION.includes(status))return 'attention';
  if(status==='failed')return 'error';
  if(status==='completed')return 'done';
  if(ACTIVE.includes(status))return 'working';
  if(status==='paused'||status==='cancelled')return 'rest';
  return 'idle';
}
function robotImage(mood){return `<canvas class="robot-image robot-canvas" data-robot="head" width="64" height="64" aria-hidden="true"></canvas>`;}
function avatar(id,{large=false,status}={}){
  const color=botColor(role(id)),mood=robotMood(status);
  if(large)return `<div class="robot-welcome bot-color-${color}" data-bot-id="${esc(id)}" data-robot-state="${mood}"><button type="button" class="robot-hero" data-robot-hit aria-label="和${esc(role(id).name)}打个招呼">${robotImage(mood)}</button></div>`;
  return `<span data-bot-id="${esc(id)}" class="role-avatar robot-avatar bot-color-${color} ${ATTENTION.includes(status)?'attention':ACTIVE.includes(status)?'active':''}" data-robot-state="${mood}">${robotImage(mood,{head:true})}</span>`;
}
function robotCompanion(t,status){
  if(!online)return '<div class="conversation-notice" role="status">连接已中断，正在重连…</div>';
  if(['queued','running','waiting_children'].includes(t.status))return `<div class="generation-indicator" role="status" aria-live="polite"><span class="generation-ring" aria-hidden="true" style="animation-delay:-${Math.round(performance.now()%1050)}ms"></span><span class="generation-label">${esc(status||STATUS[t.status])}</span></div>`;
  if(['completed','waiting_approval','waiting_consent','waiting_setup','unknown_result'].includes(t.status))return '';
  const answer=conversationView(t).messages.at(-1);
  const reason=String(t.blockedReason||'').trim();
  const alreadyShown=answer?.role==='assistant'&&normalizeMessage(answer.content).includes(normalizeMessage(reason));
  const note=reason&&!alreadyShown&&!(t.status==='ready_for_user'&&answer?.role==='assistant')?reason:'';
  if(['blocked','needs_input'].includes(t.status)&&answer?.role==='assistant'&&!note)return '';
  return `<div class="conversation-notice ${['failed','needs_review','interrupted'].includes(t.status)?'needs-attention':''}" role="status"><span>${esc(status||STATUS[t.status])}</span>${note?`<p>${esc(note)}</p>`:''}</div>`;
}
function statusTag(status){return `<span class="status-pill ${ACTIVE.includes(status)?'active':ATTENTION.includes(status)?'attention':status==='failed'?'error':''}">${esc(STATUS[status]||status)}</span>`;}
function rememberSelection(){selections[selectedRole]=selectedId||'new';try{localStorage.setItem('boujoy.chat-selection',JSON.stringify(selections));}catch{}}
function currentKey(){return selectedId||'new-'+selectedRole;}
function choose(id,{fresh=false}={}){
  saveDraft();cancelRecording();navigationVersion++;
  selectedRole=id;selectedId=fresh?null:selections[id]==='new'?null:state.tasks.find(t=>t.id===selections[id]&&t.roleId===id&&!t.archived&&privateTask(t))?.id||latest(id)?.id||null;
  if(fresh)rememberSelection();setSidebarOpen(false);updateSend();const hash='#role/'+id;if(location.hash===hash)refresh(true).catch(e=>toast(e.message));else location.hash=hash;
}
function parseRoute(){const [type,id]=(location.hash.slice(1)||'role/concierge').split('/');if(type==='task'){const t=state.tasks.find(t=>t.id===id);if(t&&privateTask(t)){selectedRole=t.roleId;selectedId=t.id;rememberSelection();return;}}if(type==='role'&&role(id)?.id===id){if(selectedRole!==id)selectedId=null;selectedRole=id;selectedId=selections[id]==='new'?null:state.tasks.find(t=>t.id===selections[id]&&t.roleId===id&&!t.archived&&privateTask(t))?.id||latest(id)?.id||null;}else{selectedRole=role(selectedRole).id;selectedId=latest(selectedRole)?.id||null;}}
// What each bot is doing, shown as the dot beside its name (and read out by screen readers).
// Only statuses the user can act on get a dot, and only while recent; a finished
// task the user has not looked at yet gets a quiet dot until they open that bot.
const ACTION_NEEDED=['waiting_approval','waiting_consent','waiting_setup','needs_input','ready_for_user','unknown_result'];
let seenRoles={};try{seenRoles=JSON.parse(localStorage.getItem('boujoy.seen-roles.v1')||'{}')||{};}catch{}
function markRoleSeen(id,t=latest(id)){if(!t||seenRoles[id]===t.updatedAt)return;seenRoles[id]=t.updatedAt;try{localStorage.setItem('boujoy.seen-roles.v1',JSON.stringify(seenRoles));}catch{}}
function relativeTime(iso,at=Date.now()){const t=Date.parse(iso);if(!Number.isFinite(t))return '';const m=Math.floor((at-t)/60000);if(m<1)return '刚刚';if(m<60)return m+' 分钟';const h=Math.floor(m/60);if(h<24)return h+' 小时';const d=new Date(t),today=new Date(at);const days=Math.round((new Date(today.getFullYear(),today.getMonth(),today.getDate())-new Date(d.getFullYear(),d.getMonth(),d.getDate()))/86400000);if(days===1)return '昨天';if(days<7)return days+' 天';return `${d.getMonth()+1}/${d.getDate()}`;}
function roleActivity(r,at=Date.now()){
  const t=latest(r.id);if(!t)return {state:'',line:r.description||'',time:''};
  const time=relativeTime(t.updatedAt,at),recent=at-Date.parse(t.updatedAt)<3*86400000;
  if((ACTION_NEEDED.includes(t.status)||t.status==='waiting_approval')&&recent)return {state:'attention',line:STATUS[t.status],time};
  if(ACTIVE.includes(t.status))return {state:'working',line:STATUS[t.status]||'正在处理',time:''};
  const unread=r.id!==selectedRole&&seenRoles[r.id]&&seenRoles[r.id]<t.updatedAt;
  return {state:unread?'unread':'',line:String(t.preview||t.title||'').replace(/\s+/g,' ').trim().slice(0,80),time};
}
function renderSidebar(){
  const roles=state.roles.filter(r=>!r.hidden);
  $('#role-count').textContent=roles.length;
  // The first time a bot is listed, what it already finished counts as seen.
  for(const r of roles)if(!seenRoles[r.id]||r.id===selectedRole)markRoleSeen(r.id);
  const navMarkup=roles.map(r=>{const t=latest(r.id),a=roleActivity(r);return `<a class="role-row bot-color-${botColor(r)} ${r.id===selectedRole?'selected':''} ${a.state?'is-'+a.state:''}" href="#role/${r.id}" data-action="choose-role" data-id="${r.id}" aria-label="${esc(r.name)}${a.state==='working'?'，正在处理':a.state==='attention'?'，'+esc(a.line):a.state==='unread'?'，有新结果':''}" title="${esc(r.name)}" ${r.id===selectedRole?'aria-current="page"':''}>${avatar(r.id,{status:t?.status})}<span class="role-name">${esc(r.name)}</span>${a.state?'<span class="role-dot" aria-hidden="true"></span>':''}</a>`;}).join('');
  if($('#role-nav')._markup!==navMarkup){$('#role-nav')._markup=navMarkup;$('#role-nav').innerHTML=navMarkup;}
  $('#memory-count').textContent=health?.memory.pending||'';$('#routine-count').textContent=(state.routines.filter(r=>r.enabled).length+(state.watches||[]).filter(w=>w.status==='active').length)||'';$('#connection-label').textContent=online?'这台 Mac · 已连接':'连接中断 · 正在重连';
}
// Conversation presentation: original messages remain available in the collapsed process.
function normalizeMessage(text){return String(text||'').trim().replace(/\s+/g,' ');}
function conversationEvents(t){
  return (t.events||[]).filter(e=>!['model_timing','tool_timing','turn'].includes(e.type)&&!(e.type==='tool'&&e.tool==='finish_task'));
}
function conversationView(t){
  const turns=[];let turn=null;
  // The conversation can span several execution tasks; show all of its turns.
  for(const m of t.conversation?.messages||t.messages||[]){
    if(m.role==='user'&&m.watchNotice){turn={user:null,replies:[]};turns.push(turn);}
    else if(m.role==='user'){turn={user:m,replies:[]};turns.push(turn);}
    else if(m.role==='assistant'&&String(m.content||'').trim()){
      if(!turn){turn={user:null,replies:[]};turns.push(turn);}
      turn.replies.push(m);
    }
  }
  if(!turn&&t.result){turn={user:null,replies:[]};turns.push(turn);}
  const generating=['queued','running','waiting_approval','waiting_children'].includes(t.status);
  // An older task opened directly must not paste its result under a later turn of the conversation.
  const ownTurn=!turn?.user?.taskId||turn.user.taskId===t.id;
  if(turn&&ownTurn&&t.result&&!generating&&normalizeMessage(turn.replies.at(-1)?.content)!==normalizeMessage(t.result)){
    turn.replies.push({role:'assistant',content:t.result,at:t.completedAt||t.updatedAt});
  }
  const messages=[],process=[];
  turns.forEach((item,index)=>{
    if(item.user)messages.push({...item.user,turn:index});
    const pending=index===turns.length-1&&generating;
    let replies=item.replies;
    // In a tool-free conversational turn, finish_task is bookkeeping, not a reply.
    // Legacy messages lack a source tag; identify the report by its tool interval.
    const start=item.user?.at,end=turns[index+1]?.user?.at;
    const events=(t.events||[]).filter(e=>start&&e.at>=start&&(!end||e.at<end));
    const finish=events.find(e=>e.type==='tool'&&e.tool==='finish_task');
    const finishEnd=events.find(e=>e.type==='tool_timing'&&e.tool==='finish_task'&&e.at>=finish?.at);
    const onlyConversation=t.kind==='general'&&!events.some(e=>e.type==='tool'&&e.tool!=='finish_task');
    const reportReplies=onlyConversation&&finish&&finishEnd?replies.filter(m=>m.at>=finish.at&&m.at<=finishEnd.at&&/^用户(?:只是|仅|询问)/.test(String(m.content||''))):[];
    if(reportReplies.length&&replies.some(m=>!reportReplies.includes(m)))replies=replies.filter(m=>!reportReplies.includes(m));
    let final=pending?null:replies.at(-1);
    // A third-person task report ("用户只是闲聊……") is bookkeeping: when the
    // turn has a real reply, that reply is the answer and the report folds away.
    if(final&&isReportNote(final.content)){const real=replies.filter(m=>!isReportNote(m.content)).at(-1);if(real)final=real;}
    // Earlier replies in the same turn that say something real stay visible, in
    // order; short "我先看看……" step notes and near-repeats fold into this turn's process.
    const shown=[];
    for(const reply of replies){
      if(reply===final||pending||!final)continue;
      if(isReportNote(reply.content)||!substantial(reply.content)||similarReply(reply.content,final.content)||shown.some(m=>similarReply(m.content,reply.content)))continue;
      shown.push(reply);
    }
    for(const reply of replies)if(shown.includes(reply)||reply===final)messages.push({...reply,turn:index});
    for(const reply of replies){
      if(reply===final||shown.includes(reply)||final&&normalizeMessage(reply.content)===normalizeMessage(final.content))continue;
      if(!process.some(p=>p.turn===index&&normalizeMessage(p.content)===normalizeMessage(reply.content)))process.push({...reply,turn:index});
    }
  });
  return {messages,process};
}
// What was actually done in a turn, in order: Boujoy's own tools and the Harness's native
// ones (commands, files, searches, subagents). Repeats are folded; shown under 处理过程.
const NATIVE_TOOLS={bash:'运行命令',read:'读取文件',write:'写入文件',edit:'修改文件',str_replace_editor:'修改文件',glob:'查找文件',grep:'搜索内容',web_search:'搜索网页',web_fetch:'打开网页',subagent:'派出子任务',subagent_fork:'派出子任务',send_message:'给子任务留言',interrupt_agent:'叫停子任务',list_agents:'查看子任务',todo_write:'更新待办',skill:'使用技能',workflow:'运行工作流',read_image:'查看图片',job_list:'查看后台作业',job_output:'读取作业输出',job_kill:'结束后台作业',working_directory:'切换工作目录',ask_user:'向你提问'};
function stepLabel(e){
  if(e.type==='harness_tool'){const name=String(e.tool||'').replace(/^mcp__personal__/,'');return (NATIVE_TOOLS[name]||TOOLS[name]||name)+(e.detail?'：'+e.detail:'');}
  const actions={tap:'点按',type:'输入',swipe:'滑动',back:'返回',long_press:'长按',read:'读取',list:'列出',find:'查找',write:'写入',save:'保存',attach:'附加',deliver:'交付'};
  return (TOOLS[e.tool]||e.tool)+(e.action&&actions[e.action]?'（'+actions[e.action]+'）':'');
}
function turnSteps(t,view,turn){
  const users=view.messages.filter(m=>m.role==='user'&&m.at),start=users.find(m=>m.turn===turn)?.at,end=users.find(m=>m.turn>turn)?.at;
  if(!start)return [];
  const rows=[];
  for(const e of t.events||[]){
    if(e.at<start||end&&e.at>=end)continue;
    const native=e.type==='harness_tool'&&e.phase==='tool/call'&&!String(e.tool||'').startsWith('mcp__personal__');
    if(!native&&!(e.type==='tool'&&e.tool&&!['finish_task','task_context'].includes(e.tool)))continue;
    const label=stepLabel(e),last=rows.at(-1);
    if(last?.label===label)last.count++;else rows.push({label,count:1,native});
  }
  return rows.slice(-60);
}
function childrenMarkup(t){
  const rows=(t.harnessChildren||[]).filter(row=>row&&row.id);if(!rows.length)return '';
  const words={running:'进行中',completed:'已完成',failed:'未完成',interrupted:'已中断'};
  return `<div class="process-children" aria-label="子任务">${rows.map(row=>`<span class="child-chip is-${esc(row.status||'running')}"><i aria-hidden="true"></i>${esc(row.label||'子任务')}<small>${words[row.status]||''}</small></span>`).join('')}</div>`;
}
function stepsMarkup(steps){
  if(!steps.length)return '';
  return `<ol class="process-steps">${steps.map(s=>`<li${s.native?' class="native"':''}><span>${esc(s.label)}</span>${s.count>1?`<small>×${s.count}</small>`:''}</li>`).join('')}</ol>`;
}
const REPORT_NOTE=/^(?:用户(?:只是|仅|询问|是在|在问|想|要求|问|让我|请我|希望|说)|已(?:向用户|回复用户|告知用户|回答用户))/;
function isReportNote(text){return REPORT_NOTE.test(normalizeMessage(text));}
function substantial(text){const v=normalizeMessage(text);return v.length>=60||/\n/.test(String(text||'').trim());}
function similarReply(a,b){const x=normalizeMessage(a),y=normalizeMessage(b);if(!x||!y)return false;return x===y||x.includes(y)||y.includes(x)||x.slice(0,14)===y.slice(0,14);}

// Files in the chat: what you attached sits under your message; what a turn produced
// sits under that turn's answer. Photos, video and audio play inline; others download.
const IMAGE_FILE=/\.(?:png|jpe?g|webp|gif|svg)$/i,VIDEO_FILE=/\.(?:mp4|m4v|mov|webm)$/i,AUDIO_FILE=/\.(?:mp3|m4a|wav|ogg|webm)$/i;
function placeFiles(t,view){
  const byMessage=new Map(),byTurn=new Map(),unplaced=[],materials=[];
  const userIds=new Set(view.messages.filter(m=>m.role==='user').flatMap(m=>[m.id,m.clientRequestId].filter(Boolean)));
  const starts=view.messages.filter(m=>m.role==='user'&&m.at).map(m=>({turn:m.turn,at:m.at}));
  for(const a of t.conversationArtifacts||t.artifacts||[]){
    if(a.kind==='speech')continue;if(a.kind==='input'&&a.importedFrom){materials.push(a);continue;}
    if(a.kind==='input'&&!a.importedFrom&&userIds.has(a.sourceMessageId)){byMessage.set(a.sourceMessageId,[...(byMessage.get(a.sourceMessageId)||[]),a]);continue;}
    const at=a.createdAt||'',turn=starts.filter(s=>s.at<=at).at(-1)?.turn;
    if(turn===undefined||!view.messages.some(m=>m.turn===turn&&m.role==='assistant'))unplaced.push(a);else byTurn.set(turn,[...(byTurn.get(turn)||[]),a]);
  }
  return {byMessage,byTurn,unplaced,materials};
}
function mediaMarkup(a){
  const src=`/api/artifacts/${encodeURIComponent(a.id)}?inline=1`,name=esc(a.name),mime=String(a.mime||'');
  const download=`<a class="media-download" href="/api/artifacts/${encodeURIComponent(a.id)}" download aria-label="下载 ${name}">${icon('download')}</a>`;
  if(/^image\//.test(mime)||IMAGE_FILE.test(a.name||''))return `<figure class="media-card" data-artifact-id="${esc(a.id)}"><a href="${src}" target="_blank" rel="noopener"><img src="${src}" alt="${name}" loading="lazy" decoding="async"></a><figcaption><span>${name}</span>${download}</figcaption></figure>`;
  if(/^video\//.test(mime)||VIDEO_FILE.test(a.name||''))return `<figure class="media-card" data-artifact-id="${esc(a.id)}"><video src="${src}" controls preload="metadata" playsinline></video><figcaption><span>${name}</span>${download}</figcaption></figure>`;
  if(/^audio\//.test(mime)||AUDIO_FILE.test(a.name||''))return `<figure class="media-card audio" data-artifact-id="${esc(a.id)}"><audio src="${src}" controls preload="metadata"></audio><figcaption><span>${name}</span>${download}</figcaption></figure>`;
  if(mime==='application/pdf'||/\.pdf$/i.test(a.name||''))return `<div class="file-row">${icon('file-text')}<a class="file-open" href="${src}" target="_blank" rel="noopener">${name}</a><a href="/api/artifacts/${encodeURIComponent(a.id)}" download aria-label="下载 ${name}">${icon('download')}</a></div>`;
  return `<a class="file-row" href="/api/artifacts/${encodeURIComponent(a.id)}" download>${icon('file-text')}<span>${name}</span>${icon('download')}</a>`;
}
// Only text and explicit safe links are rendered; model output cannot add HTML or remote media.
function messageMarkup(text){
  function safeLink(url){return /^(https?:\/\/[^\s<>"'\\]+|\/api\/artifacts\/[\w-]+)$/.test(url)&&!/[\u0000-\u001f\u007f]/.test(url);}
  function inline(value,depth=0,allowLinks=true){
    if(depth>3)return esc(value);
    const pattern=allowLinks?/`([^`\n]+)`|\*\*([^*\n]+)\*\*|\[([^\]\n]+)\]\(((?:[^\s()]|\([^\s()]*\))+)\)|(https?:\/\/[^\s<>"'`]+)/g:/`([^`\n]+)`|\*\*([^*\n]+)\*\*/g;
    let out='',start=0,match;
    while((match=pattern.exec(value))){
      out+=esc(value.slice(start,match.index));
      if(match[1]!==undefined)out+='<code>'+esc(match[1])+'</code>';
      else if(match[2]!==undefined)out+='<strong>'+inline(match[2],depth+1,allowLinks)+'</strong>';
      else{
        let url=match[4]||match[5],tail='';
        if(match[5]){const end=url.match(/[.,;:!?，。；：！？\]]+$/);if(end){tail=end[0];url=url.slice(0,-tail.length);}while(url.endsWith(')')&&(url.match(/\)/g)||[]).length>(url.match(/\(/g)||[]).length){tail=')'+tail;url=url.slice(0,-1);}}
        const label=match[3]===undefined?esc(url):inline(match[3],depth+1,false);
        out+=safeLink(url)?`<a href="${esc(url)}"${url.startsWith('http')?' target="_blank" rel="noopener noreferrer"':''}>${label}</a>`+esc(tail):esc(match[0]);
      }
      start=pattern.lastIndex;
    }
    return out+esc(value.slice(start));
  }
  function cells(line){
    const row=[];let cell='',code=false,separator=false;
    for(let i=0;i<line.length;i++){
      const c=line[i];if(c==='\\'&&line[i+1]==='|'){cell+='|';i++;continue;}
      if(c==='`')code=!code;
      if(c==='|'&&!code){row.push(cell.trim());cell='';separator=true;}else cell+=c;
    }
    row.push(cell.trim());if(!separator)return null;
    if(!row[0])row.shift();if(!row.at(-1))row.pop();return row;
  }
  // Reading layout: short "标签：" leads are set off, a bold-only line is a small heading,
  // and each labelled line starts its own paragraph so long answers scan easily.
  // Nothing is dropped or shortened; only spacing and emphasis change.
  const LEAD=/^([一-龥A-Za-z][一-龥A-Za-z（）()·、 ]{1,11}?)([：:])(?!\/)(?=\s*\S)/;
  const leadInline=v=>{const m=v.match(LEAD);if(!m||/[，。！？,.!?]/.test(m[1])||/^https?$/i.test(m[1]))return inline(v);return '<span class="lead">'+esc(m[1])+m[2]+'</span>'+inline(v.slice(m[0].length));};
  const lines=String(text||'').replace(/\r\n?/g,'\n').split('\n'),out=[];let paragraph=[],list=[],kind='',start=1,quote=[];
  const flushParagraph=()=>{if(paragraph.length)out.push('<p>'+paragraph.map((v,i)=>i?inline(v):leadInline(v)).join('<br>')+'</p>');paragraph=[];};
  const flushList=()=>{if(list.length)out.push(`<${kind}${kind==='ol'?` start="${start}"`:''}>`+list.map(v=>`<li${v.nested?' class="nested"':''}>`+leadInline(v.text)+v.more.map(m=>'<br>'+inline(m)).join('')+'</li>').join('')+`</${kind}>`);list=[];kind='';};
  const flushQuote=()=>{if(quote.length)out.push('<blockquote>'+quote.map(v=>inline(v)).join('<br>')+'</blockquote>');quote=[];};
  const flush=()=>{flushParagraph();flushList();flushQuote();};
  for(let i=0;i<lines.length;i++){
    const line=lines[i],fence=line.match(/^\s*(`{3,}|~{3,})[^`]*$/);
    if(fence){flush();const code=[],marker=fence[1],closing=new RegExp('^\\s*'+marker[0]+'{'+marker.length+',}\\s*$');while(i+1<lines.length&&!closing.test(lines[i+1]))code.push(lines[++i]);if(i+1<lines.length)i++;out.push('<pre tabindex="0" aria-label="代码"><code>'+esc(code.join('\n'))+'</code></pre>');continue;}
    const header=cells(line),separator=i+1<lines.length?cells(lines[i+1]):null;
    if(header&&separator&&header.length===separator.length&&separator.every(c=>/^:?-{3,}:?$/.test(c))){
      flush();i++;const rows=[];while(i+1<lines.length){const row=cells(lines[i+1]);if(!row||row.length!==header.length)break;rows.push(row);i++;}
      out.push('<div class="message-table" tabindex="0" role="region" aria-label="表格，可横向滚动"><table><thead><tr>'+header.map(c=>'<th scope="col">'+inline(c)+'</th>').join('')+'</tr></thead><tbody>'+rows.map(row=>'<tr>'+row.map(c=>'<td>'+inline(c)+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>');continue;
    }
    const heading=line.match(/^(#{1,6})\s+(.+)$/),bullet=line.match(/^(\s*)[-*+•]\s+(.+)$/),number=line.match(/^(\s*)(\d+)[.)、]\s*(.+)$/),boldLine=line.match(/^\s*\*\*([^*\n]{1,40})\*\*\s*[：:]?\s*$/),rule=/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line),q=line.match(/^\s*>\s?(.*)$/);
    if(heading){flush();out.push(heading[1].length<=2?'<h3>'+inline(heading[2])+'</h3>':'<h4>'+inline(heading[2])+'</h4>');}
    else if(rule){flush();out.push('<hr>');}
    else if(q){flushParagraph();flushList();quote.push(q[1]);}
    else if(boldLine&&!list.length){flush();out.push('<h4><strong>'+inline(boldLine[1])+'</strong></h4>');}
    else if(bullet||number&&(number[3].length>0)){flushParagraph();flushQuote();const indent=(bullet?bullet[1]:number[1]).replace(/\t/g,'  ').length,next=number?'ol':'ul';
      if(indent>=2&&list.length){list.push({text:number?number[2]+'. '+number[3]:bullet[2],nested:true,more:[]});continue;}
      if(kind&&kind!==next)flushList();if(!list.length)start=number?Number(number[2]):1;kind=next;list.push({text:number?number[3]:bullet[2],nested:false,more:[]});}
    else if(!line.trim())flush();
    else if(list.length&&/^\s{2,}\S/.test(line))list.at(-1).more.push(line.trim());
    else{flushList();flushQuote();if(paragraph.length&&LEAD.test(line))flushParagraph();paragraph.push(line);}
  }
  flush();return out.join('');
}
// DeepSeek's thinking chain, folded above the reply it led to (like DSH). Live while
// the model thinks; it folds itself once the answer starts unless you opened it.
const thinkingClosed=new Set();
function thinkingMarkup(text,{key,live=false,open=false,auto=false}){
  const body=String(text||'').trim();if(!body)return '';
  const chars=Array.from(body.replace(/\s+/g,'')).length;
  return `<details class="thinking${live?' live':''}" data-thinking="${esc(key)}"${auto?' data-auto="1"':''}${open?' open':''}><summary>${icon('chevron-right')}<span>${live?'思考中':'思考过程'}</span><small>${chars>=1000?(chars/1000).toFixed(1)+'k':chars} 字</small>${live?'<i class="thinking-dot" aria-hidden="true"></i>':''}</summary><div class="thinking-body">${messageMarkup(body)}</div></details>`;
}
if(typeof document!=='undefined')document.addEventListener('click',e=>{const summary=e.target.closest?.('details.thinking>summary');if(!summary)return;const d=summary.parentElement,key=d.dataset.thinking;if(d.open)thinkingClosed.add(key);else{thinkingClosed.delete(key);delete d.dataset.auto;}});
// A streaming draft is typed out smoothly between server updates instead of jumping
// by whole chunks; a reset or edit (target no longer extends what is shown) snaps.
let draftTarget='',draftTimer=0,draftTaskId=null;
function typeDraft(text){
  if(!detail)return;
  if(draftTaskId!==detail.id){clearInterval(draftTimer);draftTimer=0;draftTaskId=detail.id;}
  draftTarget=text;
  const shown=String(detail.liveDraft||'');
  if(!text||!text.startsWith(shown)||matchMedia('(prefers-reduced-motion: reduce)').matches){clearInterval(draftTimer);draftTimer=0;detail.liveDraft=text;renderTimeline();return;}
  if(draftTimer)return;
  const owner=draftTaskId;
  draftTimer=setInterval(()=>{
    if(!detail||detail.id!==owner){clearInterval(draftTimer);draftTimer=0;return;}
    const now=String(detail.liveDraft||'');
    if(!draftTarget.startsWith(now)||now.length>=draftTarget.length){detail.liveDraft=draftTarget;clearInterval(draftTimer);draftTimer=0;renderTimeline();return;}
    const step=Math.max(2,Math.ceil((draftTarget.length-now.length)/5));
    detail.liveDraft=Array.from(draftTarget).slice(0,Array.from(now).length+step).join('');renderTimeline();
  },40);
}
// Completed replies are shown in full immediately. Only real execution has a progress indicator.
function prepareAnswerReveal(){}
function paintAnswerReveals(){}
function approvals(t){return state.approvals.filter(a=>a.taskId===t.id).map(a=>`<section class="inline-card approval"><div class="card-label">${icon('circle-help')}需要你的确认 · ${clock(a.expiresAt)} 前有效</div><h3>${esc(a.summary)}</h3><details class="log-details"><summary>${icon('chevron-right')}查看这一步的具体内容</summary><pre>${esc(JSON.stringify(a.args,null,2))}</pre></details><div class="button-row"><button class="primary" data-action="approve" data-id="${a.id}">允许这次操作</button><button data-action="deny" data-id="${a.id}">拒绝</button></div></section>`).join('');}
function comparisons(t){return (t.comparisons||[]).map(g=>`<section class="inline-card"><h3>查到的价格</h3><div class="quotes-wrap"><table><thead><tr><th>平台 / 商品</th><th>条件</th><th>价格</th></tr></thead><tbody>${g.rows.map(q=>`<tr><td>${esc(state.platforms.find(p=>p.id===q.platform)?.name)}<small>${esc(q.item)} · ${esc(q.merchant)}</small></td><td>${esc(q.spec)} × ${q.quantity}<small>${esc(q.conditions)}${q.eta?' · '+esc(q.eta):''}</small></td><td><strong>¥${((q.final?q.totalFen:q.estimatedFen??q.itemsFen)/100).toFixed(2)}</strong><small>${q.stale?'价格已过期':q.final?'结算价':q.estimatedFen!=null?'预估到手 · 未核实结算':'商品价 · 未核实结算'} · ${clock(q.observedAt)}</small>${q.unknownFees?.length?'<small>待核实：'+q.unknownFees.map(k=>({packagingFen:'包装费',deliveryFen:'配送费',serviceFen:'服务费',discountFen:'优惠',paidBenefitFen:'付费权益'}[k])).join('、')+'</small>':''}</td></tr>`).join('')}</tbody></table></div><p class="quote-note">${g.comparable?'同条件可比':g.rows.length===1?'单个平台的报价':'当前条件不能直接比较'} · ${esc(g.note)}</p></section>`).join('');}
function renderTimeline(){
  const el=$('#timeline');const nearBottom=el.scrollHeight-el.scrollTop-el.clientHeight<100;const oldTop=el.scrollTop;const openLogs=renderTimeline.lastId===detail?.id&&!!$('#activity-log')?.open;const r=role(selectedRole);
  const presentation=JSON.stringify({role:r,online,task:detail&&{id:detail.id,status:detail.status,kind:detail.kind,view:conversationView(detail),draft:ACTIVE.includes(detail.status)?detail.liveDraft||'':'',thinking:ACTIVE.includes(detail.status)?detail.liveThinking||'':'',activity:(detail.events||[]).filter(e=>e.type==='tool').at(-1)?.tool,blockedReason:detail.blockedReason,checkout:!!detail.checkout,artifacts:detail.conversationArtifacts||detail.artifacts,comparisons:detail.comparisons,children:detail.children,events:conversationEvents(detail)},approvals:state.approvals.filter(a=>a.taskId===detail?.id),children:state.tasks.filter(t=>detail?.children?.includes(t.id)).map(t=>({id:t.id,roleId:t.roleId,title:t.title,status:t.status})),platforms:state.platforms,pending:pendingSend()?.text||''});
  if(renderTimeline.presentation===presentation)return;renderTimeline.presentation=presentation;
  const pending=pendingSend();
  if(!detail&&pending){renderTimeline.lastId=null;el.innerHTML=`<div class="transcript">${pendingSendMarkup(pending)}${robotCompanion({id:'pending',roleId:r.id,status:'queued',events:[]},'正在发送…')}</div>`;el.scrollTop=el.scrollHeight;return;}
  if(!detail){renderTimeline.lastId=null;el.innerHTML=`<div class="empty-chat">${avatar(r.id,{large:true})}<h2>${r.id==='concierge'?'有什么交给我？':'和'+esc(r.name)+'聊聊'}</h2></div>`;return;}
  const t=detail,view=conversationView(t),files=placeFiles(t,view),userFilesMarkup=m=>(files.byMessage.get(m.clientRequestId)||files.byMessage.get(m.id)||[]).map(mediaMarkup).join(''),turnFilesMarkup=turn=>(files.byTurn.get(turn)||[]).map(mediaMarkup).join(''),unplacedFilesMarkup=()=>files.unplaced.map(mediaMarkup).join(''),visibleEvents=conversationEvents(t),openTurns=new Set(renderTimeline.lastId===t.id?Array.from(el.querySelectorAll?.('details.turn-process[open]')||[]).map(d=>d.dataset.turn):[]);const openThinking=new Set(renderTimeline.lastId===t.id?Array.from(el.querySelectorAll?.('details.thinking[open]:not([data-auto])')||[]).map(d=>d.dataset.thinking):[]);prepareAnswerReveal(t,view);const stored=pending&&view.messages.some(m=>m.role==='user'&&(pending.requestId&&m.clientRequestId===pending.requestId||normalizeMessage(m.content)===normalizeMessage(pending.text)&&Date.parse(m.at||0)>=pending.at-120000));if(stored)optimisticSend=null;const pendingMarkup=pending&&!stored?pendingSendMarkup(pending):'';const messages=view.messages.map((m,index)=>{const speechId=m.id||(m.content===t.result?'result':null),speechTask=m.taskId||t.id;const lastTurn=view.messages.at(-1)?.turn,turnProcess=view.process.filter(p=>p.turn===m.turn),steps=view.messages[index+1]?.turn!==m.turn?turnSteps(t,view,m.turn):[],endsTurn=view.messages[index+1]?.turn!==m.turn&&m.turn!==lastTurn&&(turnProcess.length||steps.length),nextSame=view.messages[index+1]?.role==='assistant'&&m.role==='assistant'&&view.messages[index+1]?.turn===m.turn,prevSame=view.messages[index-1]?.role==='assistant'&&m.role==='assistant'&&view.messages[index-1]?.turn===m.turn;return `<article ${m.role==='assistant'?`data-answer-key="${esc(t.id+':'+index)}"`:''} class="message ${m.role==='user'?'user':'assistant'}${nextSame?' continues':''}${prevSame?' continued':''}${m.outcome&&m.outcome!=='ready_for_user'?' outcome-note':''}" aria-label="${m.role==='user'?'你':esc(r.name)}">${m.role==='assistant'&&m.thinking?thinkingMarkup(m.thinking,{key:'m:'+(m.id||index),open:openThinking.has('m:'+(m.id||index))}):''}<div class="bubble">${messageMarkup(m.content)}</div>${m.role==='user'?userFilesMarkup(m):''}${m.role==='assistant'&&!nextSame&&speechId&&!ACTIVE.includes(t.status)?button('speak-message','朗读这条回答','volume-2',`data-task="${esc(speechTask)}" data-id="${esc(speechId)}"`):''}</article>${view.messages[index+1]?.turn!==m.turn?turnFilesMarkup(m.turn):''}${endsTurn?`<details class="log-details conversation-process turn-process" data-turn="${m.turn}" ${openTurns.has(String(m.turn))?'open':''}><summary>${icon('chevron-right')}处理过程</summary><div class="process-content">${stepsMarkup(steps)}${turnProcess.map((p,i)=>`<div class="process-message">${p.thinking?thinkingMarkup(p.thinking,{key:'p:'+(p.id||m.turn+':'+i),open:openThinking.has('p:'+(p.id||m.turn+':'+i))}):''}${messageMarkup(p.content)}</div>`).join('')}</div></details>`:''}`;}).join('');
  const draftText=ACTIVE.includes(t.status)?String(t.liveDraft||'').trim():'';
  const liveThinking=ACTIVE.includes(t.status)?String(t.liveThinking||''):'',liveKey='live:'+t.id,liveOpen=openThinking.has(liveKey),liveAuto=!liveOpen&&!draftText&&!thinkingClosed.has(liveKey);
  const result=draftText&&normalizeMessage(draftText)!==normalizeMessage(view.messages.at(-1)?.content)?`<article class="message assistant draft" aria-live="polite" aria-label="${esc(r.name)}正在回复"><div class="bubble">${messageMarkup(draftText).replace(/(<\/(?:p|li|h3)>(?:<\/[uo]l>)?)$/,'<span class="draft-caret" aria-hidden="true"></span>$1')}</div></article>`:'';
  const activity=(t.events||[]).filter(e=>e.type==='tool'||e.type==='harness_tool'&&e.phase==='tool/call'&&!String(e.tool||'').startsWith('mcp__personal__')).at(-1);const status=t.status==='running'?(t.phoneQueuedAt?'排队等手机：上一个手机任务做完就开始':activity?.type==='harness_tool'?stepLabel(activity).slice(0,60):TOOLS[activity?.tool]||'正在处理…'):t.status==='ready_for_user'&&t.checkout?'请在手机上确认付款':STATUS[t.status];
  const markup=`<div class="transcript">${messages}${pendingMarkup}${liveThinking?`<div class="live-thinking">${thinkingMarkup(liveThinking,{key:liveKey,live:true,open:liveOpen||liveAuto,auto:liveAuto})}</div>`:''}${result}${ACTIVE.includes(t.status)?childrenMarkup(t):''}${pendingMarkup&&!['queued','running','waiting_children'].includes(t.status)?robotCompanion({status:'queued'},'正在发送…'):robotCompanion(t,status)}${approvals(t)}${t.status==='waiting_consent'?`<div class="inline-card"><h3>使用 DeepSeek 处理</h3><p>会将本次对话和执行结果发送至 DeepSeek。选择记住后，后续新对话不再询问，可在设置中关闭。</p><div class="button-row"><button class="primary" data-action="grant-model" data-id="${t.id}" data-remember="true">允许并记住</button><button data-action="grant-model" data-id="${t.id}">仅允许本次</button></div></div>`:''}${t.status==='waiting_setup'?`<div class="inline-card">${normalizeMessage(view.messages.at(-1)?.content).includes('先连接模型，再继续这段对话。')?'':'<p>先连接模型，再继续这段对话。</p>'}<button data-action="model-key">连接 DeepSeek</button></div>`:''}${t.status==='unknown_result'?`<div class="inline-card approval"><h3>先核实这一步是否成功</h3><p>请在原应用检查结果，避免重复下单或发送。</p><button data-action="reconcile" data-id="${t.id}">记录核实结果</button></div>`:''}${comparisons(t)}${unplacedFilesMarkup()}${files.materials.length?`<details class="log-details"><summary>${icon('chevron-right')}读取的材料 · ${files.materials.length} 个</summary>${files.materials.map(mediaMarkup).join('')}</details>`:''}${t.children?.length?`<div class="inline-card"><h3>助理协作</h3>${t.children.map(id=>{const c=state.tasks.find(x=>x.id===id);return c?`<a class="history-row" href="#task/${id}"><div><strong>${esc(role(c.roleId).name)}</strong><small>${esc(c.title)}</small></div>${statusTag(c.status)}</a>`:'';}).join('')}</div>`:''}${(()=>{const lastTurn=view.messages.at(-1)?.turn;const own=view.process.filter(p=>p.turn===lastTurn||p.turn>lastTurn||lastTurn===undefined);view.lastProcess=own;return own.length||visibleEvents.length;})()?`<details id="activity-log" class="log-details conversation-process" ${openLogs?'open':''}><summary>${icon('chevron-right')}处理过程</summary><div class="process-content">${view.lastProcess.map((m,i)=>`<div class="process-message">${m.thinking?thinkingMarkup(m.thinking,{key:'p:'+(m.id||'last:'+i),open:openThinking.has('p:'+(m.id||'last:'+i))}):''}${messageMarkup(m.content)}</div>`).join('')}${visibleEvents.slice(-40).map(e=>`<div class="event-row"><span>${esc(e.type==='tool'?TOOLS[e.tool]||e.text:e.text)}</span><time>${clock(e.at)}</time></div>`).join('')}</div></details>`:''}</div>`;
  const current=el.firstElementChild;
  if(current?.classList.contains('transcript')&&renderTimeline.lastId===t.id){
    // Keep unchanged message nodes in place so reading, text selection and local
    // table/code scroll positions survive progress arriving below the answer.
    const template=document.createElement('template');template.innerHTML=markup;
    const available=Array.from(current.children),next=Array.from(template.content.firstElementChild.children).map(node=>{
      const index=available.findIndex(old=>old.outerHTML===node.outerHTML);
      return index<0?node:available.splice(index,1)[0];
    });
    for(const obsolete of available)obsolete.remove();
    let cursor=current.firstElementChild;
    for(const node of next){if(node!==cursor)current.insertBefore(node,cursor);cursor=node.nextElementSibling;}
  }else el.innerHTML=markup;
  for(const body of el.querySelectorAll?.('details.thinking.live[open] .thinking-body')||[])body.scrollTop=body.scrollHeight;
  paintAnswerReveals();
  if(nearBottom||renderTimeline.lastId!==t.id)el.scrollTop=el.scrollHeight;else el.scrollTop=oldTop;renderTimeline.lastId=t.id;
}
// What you just sent shows at once, before the server round trip and state refresh.
// It is display only: it disappears when the stored message arrives (matched by the
// send receipt), and on failure the draft is restored as before.
var optimisticSend=null;
function pendingSend(){const o=optimisticSend;if(o&&Date.now()-o.at>120000){optimisticSend=null;return null;}return o&&(o.key===currentKey()||o.taskId&&o.taskId===selectedId)?o:null;}
function pendingSendMarkup(o){return `<article class="message user pending-send" aria-label="你（发送中）"><div class="bubble">${messageMarkup(o.text)}</div>${o.files?.length?`<div class="pending-files">${o.files.map(name=>`<span>${icon('paperclip')}${esc(name)}</span>`).join('')}</div>`:''}</article>`;}
function setPendingSend(value){optimisticSend=value;renderTimeline();const el=$('#timeline');if(el)el.scrollTop=el.scrollHeight;}
function updatePendingSend(key,fields){if(optimisticSend?.key===key)Object.assign(optimisticSend,fields);}
function clearPendingSend(key){if(optimisticSend?.key===key){optimisticSend=null;renderTimeline();}}
function chatPreferences(key=currentKey()){
  return {...{kind:detail?.kind||({shopping:'shopping',travel:'travel',work:'work'}[selectedRole]||'general'),cloudConsent:detail?detail.cloudConsent===true:state.settings.chatCloudConsent===true,memoryConsent:detail?detail.memoryConsent===true:state.settings.chatMemoryConsent===true,memoryMode:detail?.memoryMode||state.settings.chatMemoryMode||'default'},...(prefs.get(key)||{})};
}
function renderComposer(force=false){
  const key=currentKey();const r=role(selectedRole);
  if(force||composerKey!==key||!composerIsCurrent($('#composer'))){composerKey=key;$('#composer-container').innerHTML=`<div class="composer-wrap bot-color-${botColor(r)}"><form id="composer" class="composer" data-form="chat" data-draft-key="${esc(key)}" data-task-id="${esc(selectedId||'')}" data-role-id="${esc(selectedRole)}" data-navigation="${navigationVersion}" data-route="${esc(location.hash)}"><label class="sr-only" for="message-input">发消息给${esc(r.name)}</label><div id="composer-files" class="composer-files"></div><input id="attachment-picker" type="file" multiple class="sr-only" aria-label="选择附件"><textarea id="message-input" name="message" rows="${selectedId?1:2}" maxlength="60000" aria-label="发消息给${esc(r.name)}"${selectedId?` placeholder="给 ${esc(r.name)} 发消息"`:''}>${esc(drafts.get(key)||'')}</textarea><div class="composer-bottom"><div id="send-controls"></div></div></form></div>`;}
  renderDraftFiles();updateSend();fitComposer();
}
// In a conversation the box starts one line tall and grows with the text.
function fitComposer(){const el=$('#message-input');if(!el)return;if(!selectedId||!detail){el.style.height='';return;}el.style.height='auto';el.style.height=Math.min(el.scrollHeight,200)+'px';}
function updateSend(){
  const form=$('#composer');if(!form)return;const current=composerIsCurrent(form),running=current&&detail&&ACTIVE.includes(detail.status),stopping=taskControlsPending.has(form.dataset.taskId);
  const text=form.elements.message.value.trim();
  const record=button('voice-record',voiceStarting?'等待麦克风':voicePending?'正在转成文字':voiceRecording?'结束录音':'语音输入',voiceRecording?'square':'mic',!current||voicePending||voiceStarting?'disabled':'');
  const stop=running?`<button class="send-button stop-button" type="button" data-action="stop-task" data-id="${esc(form.dataset.taskId)}" aria-label="停止处理" title="停止处理" ${stopping?'disabled':''}>${icon('square')}</button>`:'';
  const send=!running||text?`<button class="send-button" type="submit" aria-label="${running?'补充给正在进行的任务':'发送消息'}" title="${running?'不打断当前任务，助理会在下一步看到你的补充':'发送消息'}" ${!current||!text||sending.has(currentKey())||stopping||fileReading||voiceStarting||voiceRecording||voicePending?'disabled':''}>${icon('arrow-up')}</button>`:'';
  const controls=$('#send-controls'),markup=button('attach-file','添加附件',selectedId&&detail?'plus':'paperclip',!current||fileReading||sending.has(currentKey())?'disabled':'')+record+stop+send;
  if(controls._markup!==markup){controls._markup=markup;controls.innerHTML=markup;}
}
function renderDraftFiles(){const el=$('#composer-files'),key=$('#composer')?.dataset.draftKey;if(!el||!key)return;el.innerHTML=(fileDrafts.get(key)||[]).map(file=>`<div class="draft-file">${file.preview?(/^video\//.test(file.mime)?`<video class="draft-thumb" src="${esc(file.preview)}" muted playsinline preload="metadata"></video>`:`<img class="draft-thumb" src="${esc(file.preview)}" alt="">`):''}<span title="${esc(file.name)}">${esc(file.name)}</span><small>${Math.ceil(file.size/1024)} KB</small>${button('remove-attachment','移除 '+file.name,'x',`data-id="${file.id}" data-draft-key="${esc(key)}"`)}</div>`).join('');}
async function addDraftFiles(files,key=$('#composer')?.dataset.draftKey){
  if(!key||fileReading||sending.has(key))return;const previous=fileDrafts.get(key)||[],selected=Array.from(files);if(!selected.length)return;
  if(previous.length+selected.length>FILE_LIMITS.count)throw Error(`每条消息最多 ${FILE_LIMITS.count} 个附件`);let total=previous.reduce((n,f)=>n+f.size,0);
  for(const file of selected){total+=file.size;const video=String(file.type).startsWith('video/');if(!file.size||file.size>(video?FILE_LIMITS.video:FILE_LIMITS.other)||total>FILE_LIMITS.total)throw Error('附件太大：视频最多 500 MB，其他文件最多 50 MB，一条合计最多 600 MB');}
  fileReading++;updateSend();try{for(const file of selected){
    const mime=file.type||'application/octet-stream',preview=/^(image|video)\//.test(mime)&&typeof URL.createObjectURL==='function'&&typeof Blob!=='undefined'&&file instanceof Blob?URL.createObjectURL(file):'';let row;
    // Small files ride inside the message; large ones and videos stream to the Mac first.
    if(file.size<=3.5*1024*1024&&!mime.startsWith('video/')){const bytes=new Uint8Array(await file.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));row={id:crypto.randomUUID(),name:file.name,mime,size:bytes.length,base64:btoa(binary),preview};}
    else{const up=await uploadFile(file);row={id:crypto.randomUUID(),name:file.name,mime:up.mime,size:file.size,uploadId:up.uploadId,preview};}
    fileDrafts.set(key,[...(fileDrafts.get(key)||[]),row]);
    if($('#composer')?.dataset.draftKey===key)renderDraftFiles();
  }}finally{fileReading--;updateSend();}
}
// Files go straight to the Mac as they are picked (raw upload, no base64); the
// message then refers to them. Photos and videos show a preview before sending.
const FILE_LIMITS={count:10,video:500*1024*1024,other:50*1024*1024,total:600*1024*1024};
async function uploadFile(file,retry=true){
  const mime=file.type||'application/octet-stream',response=await fetch(`/api/uploads?name=${encodeURIComponent(file.name)}&mime=${encodeURIComponent(mime)}`,{method:'POST',headers:{'Content-Type':'application/octet-stream','X-Boujoy-CSRF':csrf},body:file});
  const value=await response.json().catch(()=>({}));
  if(retry&&(response.status===401||response.status===403&&value.error?.code==='csrf')){await refreshSession();return uploadFile(file,false);}
  if(!response.ok)throw Error(value.error?.message||'上传没有完成');return {...value,mime};
}
async function recordVoice(){
  if(voiceRecording){voiceRecording.recorder.stop();return;}
  if(voicePending||voiceStarting)return;const key=currentKey();voiceStarting=true;updateSend();try{const status=await api('/voice/status');if(!status.transcriptionReady)throw Error('本机语音模型尚未准备');
  if(!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder)throw Error('当前窗口不能录音，请使用 Boujoy 桌面窗口');
  const stream=await navigator.mediaDevices.getUserMedia({audio:true,video:false}),mime=['audio/webm;codecs=opus','audio/mp4','audio/ogg;codecs=opus'].find(type=>MediaRecorder.isTypeSupported(type));
  if(document.hidden||currentKey()!==key){stream.getTracks().forEach(track=>track.stop());return;}
  let recorder;try{recorder=new MediaRecorder(stream,mime?{mimeType:mime}:{});}catch(error){stream.getTracks().forEach(track=>track.stop());throw error;}const record={key,stream,recorder,chunks:[],bytes:0,cancelled:false,timer:null};voiceRecording=record;
  recorder.ondataavailable=e=>{if(e.data.size){record.chunks.push(e.data);record.bytes+=e.data.size;if(record.bytes>8*1024*1024){record.cancelled=true;recorder.stop();toast('录音超过大小限制，请缩短到两分钟以内');}}};
  recorder.onerror=()=>{record.cancelled=true;clearTimeout(record.timer);stream.getTracks().forEach(track=>track.stop());if(voiceRecording===record)voiceRecording=null;updateSend();toast('录音中断，请检查麦克风权限后重试');};
  recorder.onstop=async()=>{clearTimeout(record.timer);stream.getTracks().forEach(track=>track.stop());if(voiceRecording===record)voiceRecording=null;updateSend();if(record.cancelled)return;voicePending=true;updateSend();try{const blob=new Blob(record.chunks,{type:recorder.mimeType}),bytes=new Uint8Array(await blob.arrayBuffer()),hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));const result=await api('/voice/transcribe',{bytesBase64:btoa(binary),sha256:hash,mime:blob.type,language:'zh'});if(!result.text.trim()){toast('没有识别到清楚的语音，可以再说一次');return;}const previous=drafts.get(key)||'',text=previous+(previous?'\n':'')+result.text;drafts.set(key,text);if(currentKey()===key){$('#message-input').value=text;saveDraft();$('#message-input').focus();}toast(currentKey()===key?'文字已填好，可以修改后发送':'语音文字已保存到原对话草稿');}catch(error){toast(error.message);}finally{voicePending=false;updateSend();}};
  try{recorder.start(1000);}catch(error){stream.getTracks().forEach(track=>track.stop());voiceRecording=null;throw error;}record.timer=setTimeout(()=>{if(recorder.state==='recording')recorder.stop();},115000);updateSend();toast('正在录音，再点一次结束');}finally{voiceStarting=false;updateSend();}
}
async function speakMessage(el){
  const version=++speechVersion,key=el.dataset.task+':'+el.dataset.id;
  if(speechPlayback?.key===key){speechPlayback.audio.pause();speechPlayback=null;return;}
  speechPlayback?.audio.pause();speechPlayback=null;
  const artifact=await api('/tasks/'+el.dataset.task+'/messages/'+el.dataset.id+'/speech',{});
  if(version!==speechVersion||document.hidden)return;
  const audio=new Audio('/api/artifacts/'+artifact.id+'?play=1');speechPlayback={key,audio};
  audio.onended=()=>{if(speechPlayback?.audio===audio)speechPlayback=null;};
  try{await audio.play();}catch(error){if(speechPlayback?.audio===audio)speechPlayback=null;throw error;}
}
function syncSidebarAccessibility(){
  const mobile=matchMedia('(max-width:650px)').matches,open=mobile&&document.body.classList.contains('sidebar-open');
  $('#sidebar').inert=mobile&&!open;$('#sidebar').setAttribute('aria-hidden',String(mobile&&!open));
  $('#chat').inert=open;$('#sidebar-backdrop').inert=!open;
  const toggle=$('[data-action="show-sidebar"]');if(toggle)toggle.setAttribute('aria-expanded',String(open));
}
function setSidebarOpen(open){
  const wasOpen=document.body.classList.contains('sidebar-open');
  document.body.classList.toggle('sidebar-open',!!open&&matchMedia('(max-width:650px)').matches);syncSidebarAccessibility();
  if(open&&document.body.classList.contains('sidebar-open'))$('[data-action="close-sidebar"]')?.focus();
  else if(wasOpen)$('[data-action="show-sidebar"]')?.focus();
}
// A floating pill names the bot you are talking to and, while it works, what it is doing.
function headerPill(r){
  const t=detail&&detail.roleId===r.id?detail:null,waiting=t&&ACTION_NEEDED.includes(t.status),working=t&&!waiting&&ACTIVE.includes(t.status);
  return `<button type="button" class="chat-pill bot-color-${botColor(r)} ${working?'is-working':waiting?'is-attention':''}" data-robot-hit aria-label="${esc(r.name)}${working||waiting?'，'+esc(STATUS[t.status]):''}">${avatar(r.id,{status:t?.status})}<span class="chat-pill-name">${esc(r.name)}</span>${working||waiting?`<span class="chat-pill-status">· ${esc(STATUS[t.status])}</span>`:''}</button>`;
}
function renderHeader(){
  const r=role(selectedRole);$('#chat').setAttribute('aria-label',r.name+'的对话');
  const pill=typeof headerPill==='function'?headerPill(r):'';
  const markup=`<div class="chat-identity"><button class="icon-button mobile-menu" data-action="show-sidebar" aria-controls="sidebar" aria-expanded="false" aria-label="显示助理列表">${icon('menu')}</button><span class="mobile-role-name">${esc(r.name)}</span></div>${pill}<nav class="chat-actions" aria-label="对话操作"><button type="button" class="chat-history" data-action="history">${icon('history')}<span>对话记录</span></button>${button('new-chat','新对话','square-pen')}${button('edit-role','助理设置','ellipsis',`data-id="${esc(r.id)}"`)}</nav>`;
  const el=$('#chat-header');if(el._markup!==markup){el._markup=markup;el.innerHTML=markup;}syncSidebarAccessibility();
}
function render(force=false){if(!state)return;renderSidebar();renderHeader();renderTimeline();renderComposer(force);}
async function refresh(force=false){
  const ticket=++refreshVersion,nav=navigationVersion,route=location.hash;const current=()=>ticket===refreshVersion&&nav===navigationVersion&&route===location.hash;
  try{
    const next=await api('/state');if(!current())return;state=next;online=true;parseRoute();updateSend();
    const id=selectedId;const nextDetail=id?await api('/tasks/'+id):null;if(!current())return;detail=nextDetail;render(force);
  }catch(error){if(current())throw error;}
}
function openSheet(title,html,{wide=false,key=''}={}){panel=key;$('#sheet-title').textContent=title;$('#sheet-body').innerHTML=html;$('#sheet').classList.toggle('wide',wide);if(!$('#sheet').open)$('#sheet').showModal();}
function closeSheet(){$('#sheet').close();panel='';}
function empty(text,glyph='message-circle'){return `<div class="empty-panel">${icon(glyph)}${esc(text)}</div>`;}
function roleForm(r){
  const color=r?botColor(r):nextBotColor();
  openSheet(r?'编辑助理':'新建助理',`<form data-form="role" data-id="${esc(r?.id||'')}"><div class="bot-appearance-preview bot-color-${color}" id="bot-appearance-preview"><div class="bot-preview-sprite">${robotImage('idle')}</div><div><strong>${esc(r?.name||'新伙伴')}</strong></div></div>${r?`<fieldset class="bot-color-field"><legend>机器人配色</legend><div class="bot-color-options">${BOT_COLORS.map(c=>`<label class="bot-color-option bot-color-${c}"><input type="radio" name="botColor" value="${c}" ${c===color?'checked':''}><span class="bot-color-choice">${robotImage('idle')}<span>${BOT_COLOR_NAMES[c]}</span></span></label>`).join('')}</div></fieldset>`:`<input type="hidden" name="botColor" value="${color}">`}<label class="field">名字<input name="name" maxlength="40" value="${esc(r?.name)}" placeholder="给助理起个名字" required></label><label class="field">主要负责什么<input name="description" maxlength="240" value="${esc(r?.description)}" placeholder="一句话描述它的职责" required></label><label class="field">做事方式<textarea name="instruction" maxlength="4000" required placeholder="例如：先核实信息，简洁汇报进度，遇到重要选择先问我。">${esc(r?.instruction)}</textarea></label>${r?botExtras(r):''}<button class="primary" type="submit">${r?'保存助理':'创建助理'}</button>${r&&r.id!=='concierge'?`<button type="button" class="danger" data-action="delete-role" data-id="${esc(r.id)}">删除助理</button>`:''}</form>`);
}
// A bot's daily brief and the things it remembers about you (editable here).
function botExtras(r){const b=r.brief||{};return `<fieldset class="bot-extra"><legend>每日简报</legend><label class="check-row"><input type="checkbox" name="briefEnabled" ${b.enabled?'checked':''}> 每天给我一份简报</label><label class="field">时间<input type="time" name="briefTime" value="${esc(b.time||'08:30')}"></label>${b.enabled&&b.nextAt?`<p class="sheet-intro">下次：${date(b.nextAt)}</p>`:''}<button type="button" data-action="brief-now" data-id="${esc(r.id)}">现在出一份简报</button></fieldset><fieldset class="bot-extra"><legend>它记住的事（${(r.notes||[]).length}）</legend>${(r.notes||[]).length?`<ul class="bot-notes">${r.notes.map(n=>`<li><span>${esc(n.text)}</span><button type="button" class="icon-button" data-action="forget-note" data-id="${esc(r.id)}" data-note="${esc(n.id)}" aria-label="删掉这条">${icon('x')}</button></li>`).join('')}</ul>`:'<p class="sheet-intro">还没有。对它说“记住我……”就会记下。</p>'}</fieldset>`;}
// 工作台: what every bot is doing now.
async function showWorkbench(){const {bots}=await api('/workbench');const label={busy:'忙碌中',waiting:'等你处理',idle:'空闲'};openSheet('工作台',`<p class="sheet-intro">每个助理现在在做什么、挂着哪些事。</p><div class="panel-list">${bots.map(b=>`<div class="list-card workbench-card bot-color-${esc(b.botColor||'violet')}"><div class="list-card-top"><h3>${esc(b.name)}</h3><span class="status-pill ${b.state==='busy'?'active':b.state==='waiting'?'attention':''}">${label[b.state]}</span></div><p>${esc(b.description||'')}</p>${b.running.length?`<p><strong>正在做：</strong>${b.running.map(t=>`<a href="#task/${t.id}" data-action="open-task" data-id="${t.id}">${esc(t.title)}</a>`).join('、')}</p>`:''}${b.waiting.length?`<p><strong>等你：</strong>${b.waiting.map(t=>`<a href="#task/${t.id}" data-action="open-task" data-id="${t.id}">${esc(t.title)}</a>`).join('、')}</p>`:''}<p class="workbench-stats">跟进 ${b.watches} · 例行 ${b.routines} · 记住 ${b.notes} 条 · ${b.brief?.enabled?'简报 每天 '+esc(b.brief.time):'未开简报'}${b.lastActivity?' · 最近：'+esc(b.lastActivity.title):''}</p><div class="button-row"><button data-action="search-role" data-id="${b.id}">打开对话</button><button data-action="brief-now" data-id="${b.id}">现在出简报</button><button data-action="edit-role" data-id="${b.id}">设置</button></div></div>`).join('')}</div>`,{key:'workbench'});}
function routineForm(r){
  const zone=r?.timezone||state?.settings?.timezone||Intl.DateTimeFormat().resolvedOptions().timeZone,day=r?.nextAt?new Date(r.nextAt).toLocaleDateString('en-CA',{timeZone:zone}):'';
  openSheet(r?'编辑例行事务':'新建例行事务',`<form data-form="routine" data-id="${esc(r?.id||'')}"><label class="field">名称<input name="name" value="${esc(r?.name)}" placeholder="例如：晚间待办回顾" maxlength="120" required></label><label class="field">交代的事<textarea name="prompt" required>${esc(r?.prompt)}</textarea></label><div class="form-row"><label class="field">交给谁<select name="roleId">${state.roles.filter(x=>!x.hidden).map(x=>`<option value="${x.id}" ${x.id===(r?.roleId||selectedRole)?'selected':''}>${esc(x.name)}</option>`).join('')}</select></label><label class="field">如何处理<select name="taskKind"><option value="reminder" ${r?.taskKind!=='general'?'selected':''}>本地提醒</option><option value="general" ${r?.taskKind==='general'?'selected':''}>创建助理任务</option></select></label></div><div class="form-row"><label class="field">重复<select name="kind">${[['daily','每天'],['weekly','每周'],['once','仅一次']].map(([v,n])=>`<option value="${v}" ${(r?.kind||'daily')===v?'selected':''}>${n}</option>`).join('')}</select></label><label class="field">时间<input name="time" type="time" value="${esc(r?.time||'09:00')}" required></label></div><div class="weekday-picker" aria-label="每周执行日期">${['一','二','三','四','五','六','日'].map((d,i)=>`<label><input type="checkbox" name="weekdays" value="${i+1}" ${(r?.weekdays||[1,2,3,4,5]).includes(i+1)?'checked':''}>周${d}</label>`).join('')}</div><label class="field">时区<input name="timezone" value="${esc(zone)}" required></label><label class="field">单次日期<input name="date" type="date" value="${day}"><small>仅一次时填写；按上面的时区执行。</small></label><label class="field">错过多久后跳过（分钟）<input name="windowMinutes" type="number" min="1" max="1440" value="${Math.round((r?.executionWindowSeconds||300)/60)}" required></label><label class="toggle-row">允许此安排到点使用 DeepSeek<input type="checkbox" name="cloudConsent" ${r?.cloudConsent?'checked':''}></label><label class="toggle-row">使用相关记忆<input type="checkbox" name="memoryConsent" ${r?.memoryConsent?'checked':''}></label><p class="notice">授权只用于这个安排的任务内容。暂停、删除或修改内容后，旧执行范围会撤销。</p><button class="primary">保存安排</button></form>`);
}
function zonedOnce(date,time,zone){
  const target=Date.parse(date+'T'+time+':00Z');if(!Number.isFinite(target))throw Error('请选择有效日期和时间');
  const f=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  const stamp=at=>{const p=Object.fromEntries(f.formatToParts(new Date(at)).map(x=>[x.type,x.value]));return Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute);};
  let guess=target;for(let i=0;i<4;i++)guess+=target-stamp(guess);
  const candidates=[];for(let shift=-180;shift<=180;shift+=15){const at=guess+shift*60000;if(stamp(at)===target)candidates.push(at);}
  if(!candidates.length)throw Error('这个时区在该日没有这一分钟，请换一个时间');return new Date(Math.min(...candidates)).toISOString();
}
function showSearch(){search='';openSheet('搜索',`<label class="field"><input id="search" type="search" placeholder="搜索对话、文件或安排" aria-label="搜索对话、文件或安排" autocomplete="off"></label><div id="search-results"></div>`,{key:'search'});renderSearch();$('#search').focus({preventScroll:true});}
async function renderSearch(){
  const q=search.trim(),out=$('#search-results');if(!out)return;
  if(!q){out.innerHTML=state.roles.filter(r=>!r.hidden).map(r=>`<a class="search-bot" href="#role/${r.id}" data-action="search-role" data-id="${r.id}">${avatar(r.id)}<strong>${esc(r.name)}</strong></a>`).join('');return;}
  try{const {results}=await api('/search?q='+encodeURIComponent(q));if(search.trim()!==q||!out.isConnected)return;out.innerHTML=results.map(r=>{const action=r.type==='role'?'search-role':r.type==='routine'?'edit-routine':'open-task',id=r.type==='role'||r.type==='routine'?r.id:r.taskId;return `<a class="search-result" href="#" data-action="${action}" data-id="${esc(id)}"><strong>${esc(r.title)}</strong><small>${esc(r.snippet)}</small></a>`;}).join('')||empty('没有找到相关内容','search');}catch(e){if(out.isConnected&&search.trim()===q)out.innerHTML=empty(e.message,'search');}
}
function conversationRows(roleId,{archived=false}={}){const groups=new Map();for(const t of state.tasks.filter(t=>t.roleId===roleId&&privateTask(t)&&!!t.archived===archived)){const key=t.conversationId||t.id,group=groups.get(key);if(!group)groups.set(key,{first:t,latest:t});else{if(t.createdAt<group.first.createdAt)group.first=t;if(t.updatedAt>group.latest.updatedAt)group.latest=t;}}return [...groups.values()].map(({first,latest})=>({...latest,title:first.title})).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));}
// Inspect a group execution without selecting it as a private conversation.
let inspectedTaskId=null;
async function showTaskInspection(id){
 const task=await api('/tasks/'+encodeURIComponent(id));inspectedTaskId=id;
 const answers=[...new Set((task.messages||[]).filter(m=>m.role==='assistant'&&typeof m.content==='string'&&m.content.trim()).map(m=>m.content))];
 const answer=answers.length?answers.join('\n\n---\n\n'):task.result||task.blockedReason||'暂时还没有结果';
 const files=(task.artifacts||[]).filter(a=>a.kind!=='speech').map(mediaMarkup).join('');
 openSheet('任务详情',`<p class="sheet-intro">${esc(role(task.roleId).name)} · ${esc(STATUS[task.status]||task.status)}</p><h3>${esc(task.title)}</h3><div class="bubble assistant">${messageMarkup(typeof answer==='string'?answer:JSON.stringify(answer))}</div>${files}${approvals(task)}<button data-action="inspect-task" data-id="${esc(id)}">刷新进度</button>`,{key:'task-inspection',wide:true});
}
function showHistory(){const rows=conversationRows(selectedRole,{archived:historyFilter==='archive'});openSheet(role(selectedRole).name+'的对话',`<div class="tabs"><button class="${historyFilter==='current'?'active':''}" data-action="history-filter" data-filter="current">当前对话</button><button class="${historyFilter==='archive'?'active':''}" data-action="history-filter" data-filter="archive">已归档</button></div>${rows.map(t=>`<div class="history-row"><a href="#task/${t.id}" data-action="open-task" data-id="${t.id}"><strong>${esc(t.title)}</strong><small>${date(t.updatedAt)} · ${esc(STATUS[t.status])}</small></a>${button('archive',t.archived?'恢复对话':'归档对话',t.archived?'history':'archive',`data-id="${t.id}" data-archived="${t.archived?'false':'true'}"`)}</div>`).join('')||empty('还没有这类对话','history')}`,{key:'history'});}
function showRoutines(){openSheet('例行事务',`<p class="sheet-intro">把需要反复惦记的事，交给助理。</p><button data-action="new-routine" class="primary">新建例行事务</button><div class="panel-list">${state.routines.map(r=>`<div class="list-card"><div class="list-card-top"><h3>${esc(r.name)}</h3><span class="status-pill">${r.enabled?'已启用':'已暂停'}</span></div><p>${esc(r.prompt)}<br>${esc(role(r.roleId).name)} · ${r.kind==='daily'?'每天 '+esc(r.time):r.kind==='weekly'?'每周 '+esc((r.weekdays||[]).join('、'))+' · '+esc(r.time):'仅一次'} · ${esc(r.timezone||'Asia/Shanghai')}<br>下次：${r.enabled?date(r.nextAt):'—'}</p><div class="button-row"><button data-action="toggle-routine" data-id="${r.id}">${r.enabled?'暂停':'启用'}</button><button data-action="edit-routine" data-id="${r.id}">编辑</button><button data-action="run-routine" data-id="${r.id}">现在运行</button><button class="danger" data-action="delete-routine" data-id="${r.id}">删除</button></div>${r.history?.length?`<p><a href="#task/${r.history.at(-1).taskId}" data-action="open-task" data-id="${r.history.at(-1).taskId}">查看最近一次运行</a></p>`:''}</div>`).join('')}</div>${!state.routines.length?empty('还没有例行事务','clock'):''}${watchSection()}`,{key:'routines'});}
// 持续跟进: created by the assistant when you ask it to keep an eye on something.
function watchSection(){const rows=state.watches||[];if(!rows.length)return '';return `<h3 class="sheet-subhead">跟进中</h3><div class="panel-list">${rows.map(w=>`<div class="list-card"><div class="list-card-top"><h3>${esc(w.goal)}</h3><span class="status-pill">${w.status==='active'?'跟进中':'已暂停'}</span></div><p>${w.condition?'条件：'+esc(w.condition)+'<br>':''}${w.kind==='phone'?'手机 · '+esc(w.app||''):'网页'} · 每 ${w.intervalMinutes} 分钟 · ${date(w.expiresAt)} 结束<br>上次：${w.lastSummary?esc(w.lastSummary):'还没检查'}${w.lastCheckedAt?'（'+date(w.lastCheckedAt)+'）':''}<br>下次：${w.status==='active'?date(w.nextAt):'—'}${w.lastSkip?'（手机暂时不可用，稍后重试）':''}</p><div class="button-row"><button data-action="toggle-watch" data-id="${w.id}">${w.status==='active'?'暂停':'恢复'}</button><button class="danger" data-action="delete-watch" data-id="${w.id}">取消跟进</button></div></div>`).join('')}</div>`;}
async function showMemory(){const [status,list,personal]=await Promise.all([api('/memory/status'),api('/memory/proposals'),api('/memory/personal')]);memoryData={status,proposals:list.proposals,personal:personal.items};if(health)health.memory=status;renderSidebar();openSheet('专用记忆',`<p class="sheet-intro">沿用 Bok 的安静自动：普通偏好逐步积累，在相关任务中使用。你可以随时撤回理解。</p><div class="connection-row">${icon('book-open')}<div>${status.connected?'已连接 · '+status.cards+' 张有效知识卡':'暂未连接'}<small>${status.connected?'本地检索 · 文件修改后即时生效':esc(status.reason)}</small></div><span class="status-pill">${list.proposals.length} 条待确认</span></div><form data-form="memory-search"><label class="field">查找记忆<input name="query" placeholder="例如：外卖比价时要核对什么" required></label><button>查找</button></form><div id="memory-results"></div><div class="settings-section"><h3>已经记住</h3>${personal.items.filter(p=>p.effective).map(p=>`<div class="list-card"><p>${esc(p.statement)}</p><div class="button-row"><span class="status-pill">${p.epistemic_status==='learned'?'自动理解':'已确认'}</span><button data-action="reject-understanding" data-id="${p.id}">不再使用</button></div></div>`).join('')||'<p class="notice">有依据的日常偏好会逐步出现在这里。</p>'}</div><div class="settings-section"><h3>需要你确认</h3>${personal.items.filter(p=>['explicit','hypothesis','contradicted'].includes(p.epistemic_status)).map(p=>`<div class="list-card"><p>${esc(p.statement)}</p><div class="button-row"><button data-action="confirm-understanding" data-id="${p.id}">确认并用于 Boujoy</button><button data-action="reject-understanding" data-id="${p.id}">不保存</button></div></div>`).join('')}</div><div class="settings-section"><h3>知识候选</h3>${list.proposals.map(p=>`<div class="list-card"><h3>${esc(p.title)}</h3><p>${esc(p.summary)}</p>${p.existing.length?'<p>这会更新已有的同主题记忆。</p>':''}<div class="button-row"><button class="primary" data-action="accept-memory" data-id="${p.id}">确认保存</button><button data-action="reject-memory" data-id="${p.id}">不保存</button></div></div>`).join('')||'<p class="notice">目前没有需要审核的知识候选。普通低风险偏好会自动进入上方“已经记住”。</p>'}</div><details class="log-details"><summary>${icon('chevron-right')}文件夹位置</summary><p class="path-text">${esc(status.root||'')}</p></details>`,{wide:true,key:'memory'});}
async function showSettings(){health=await api('/health');const h=health;openSheet('设置',`<section class="settings-section"><h3>当前助理</h3><div class="settings-actions"><button data-action="workspace">${icon('monitor')}执行状态</button><button data-action="history">${icon('history')}对话记录</button><button data-action="new-chat">${icon('plus')}新对话</button><button data-action="role-settings">${icon('more-horizontal')}助理设置</button></div></section><section class="settings-section"><h3>连接</h3><div class="connection-row">${icon('message-circle')}<div>DeepSeek<small>${h.credentials.deepseek?'凭证已保存在本机钥匙串':'尚未配置模型凭证'}</small></div><button data-action="model-key">${h.credentials.deepseek?'更新':'连接'}</button></div><div class="connection-row">${icon('monitor')}<div>执行引擎<small>DeepSeek Harness ${esc(h.harness.version||'未找到')}</small></div><button data-action="probe">检查连接</button></div><div class="connection-row">${icon('book-open')}<div>专用知识库<small>${h.memory.connected?h.memory.cards+' 张有效知识卡 · 本地文件夹':esc(h.memory.reason)}</small></div><button data-action="memory">管理</button></div><div class="connection-row">${icon('smartphone')}<div>${esc(phoneName())}<small>${state.settings.phoneEnabled?(state.settings.phoneBackend==='phoneuse'?'无线接入已启用':'旧接入已启用'):'尚未启用手机接入'}</small></div><button data-action="phone">查看</button></div></section><section class="settings-section"><div class="connection-row">${icon('globe')}<div>异地连接<small>用手机联系这台 Mac</small></div><button data-action="remote">管理</button></div></section><section class="settings-section"><h3>执行权限</h3><label class="toggle-row">独立进展监督<input type="checkbox" data-setting="modelWatchdogEnabled" ${state.settings.modelWatchdogEnabled!==false?'checked':''}></label><label class="toggle-row">浏览器执行<input type="checkbox" data-setting="browserEnabled" ${state.settings.browserEnabled!==false?'checked':''}></label><label class="toggle-row">本机文件与计算<input type="checkbox" data-setting="filesEnabled" ${state.settings.filesEnabled!==false?'checked':''}></label><label class="toggle-row">手机执行<input type="checkbox" data-setting="phoneEnabled" ${state.settings.phoneEnabled?'checked':''}></label><p class="notice">关闭会暂停正在使用该能力的任务；重新开启后，由你决定何时继续。</p></section><section class="settings-section"><h3>常驻运行</h3><label class="toggle-row">连接云后，供电时保持 Mac 运行<input type="checkbox" data-setting="keepAwakeOnAC" ${state.settings.keepAwakeOnAC!==false?'checked':''}></label><p class="notice">允许显示器熄灭。合盖、手动休眠、断电或关机仍会使助理离线。</p></section><section class="settings-section"><h3>新对话的默认设置</h3><form data-form="chat-defaults"><label class="toggle-row">新对话自动使用 DeepSeek<input type="checkbox" name="chatCloudConsent" ${state.settings.chatCloudConsent?'checked':''}></label><p class="notice">开启后，新对话及执行结果会发送至 DeepSeek，不再逐次询问。关闭后恢复新对话授权；已有对话的授权不受影响，保存不会启动已有任务。记忆设置同时应用到当前对话；自动提炼会将本轮消息与少量相关理解发给 DeepSeek。</p><label class="toggle-row">自动记住并使用相关偏好<input type="checkbox" name="chatMemoryConsent" ${state.settings.chatMemoryConsent?'checked':''}></label><label class="field">记忆保存方式<select name="chatMemoryMode"><option value="default" ${state.settings.chatMemoryMode!=='do_not_remember'?'selected':''}>安静自动</option><option value="do_not_remember" ${state.settings.chatMemoryMode==='do_not_remember'?'selected':''}>不加入记忆</option></select></label><button>保存对话设置</button></form></section><section class="settings-section"><h3>思考方式</h3><label class="field">每一步先想多少<select data-setting-select="modelReasoning">${(state.settings.modelReasoningOptions||[]).map(o=>`<option value="${esc(o.value)}" ${state.settings.modelReasoning===o.value?'selected':''}>${esc(o.label)} · ${esc(o.description)}</option>`).join('')}</select></label><p class="notice">电脑与手机共用此设置，对下一次开始的任务生效，当前任务保持原档位。档位不改变工具能力或任务总时长。</p></section><section class="settings-section"><h3>记忆与用量</h3><label class="toggle-row">启用记忆学习<input type="checkbox" data-setting="memoryEnabled" ${state.settings.memoryEnabled?'checked':''}></label><form data-form="limits"><label class="field">每日最多模型请求<input type="number" name="dailyModelRequests" min="0" max="100000" value="${state.modelBudget?.limit??200}" required><small>推理与记忆处理合计；0 暂停云请求。这是请求数上限，不是人民币费用上限。</small></label><p class="notice">今天 ${state.modelBudget?.used||0} / ${state.modelBudget?.limit??200} 次 · ${esc(state.modelBudget?.timezone||'Asia/Shanghai')}${state.modelBudget?.exhausted?' · 今日额度已用完':''}${state.modelBudget?.unattributedLegacyRequests?'。另有 '+state.modelBudget.unattributedLegacyRequests+' 次旧累计记录没有日期，未冒充今日用量':''}。</p><div class="form-row"><label class="field">单轮最多模型请求（0 为不限）<input type="number" name="maxModelRequests" min="0" max="100000" value="${state.settings.maxModelRequests}" required></label><label class="field">单次最长执行（分钟，0 为不限）<input type="number" name="maxTaskMinutes" min="0" max="100000" value="${state.settings.maxTaskMinutes}" required></label></div><button>保存限制</button></form><p class="notice">累计 ${state.usage.requests} 次模型请求，包含失败请求。${(state.usage.measuredRequests||state.usage.partialUsageRequests)?`已记录的 token 小计（缺失部分未计入）：输入 ${state.usage.inputTokens||0}、输出 ${state.usage.outputTokens||0} token。`:""}${(state.usage.partialUsageRequests||state.usage.unavailableUsageRequests)?"部分请求用量缺失或不完整。":""}实际费用以供应商账单为准。</p></section><section class="settings-section"><h3>我的空间</h3><div class="button-row"><button data-action="memory">记忆</button><button data-action="routines">例行事务</button><button data-action="manage-roles">管理全部助理</button><button data-action="invite-roles">邀请助理协作</button><button data-action="connectors">外部工具</button><button data-action="workflows">做事方法</button><button data-action="event-rules">事件触发</button><button data-action="monitors">数据监控</button><button data-action="image-retention">截图留存</button></div></section>`,{key:'settings'});renderSidebar();}
let eventRuleRows=[];
async function showImageRetention(){const r=await api('/image-retention');openSheet('截图留存',`<form data-form="image-retention"><label class="field">任务结束后保留截图（小时）<input name="hours" type="number" min="1" max="168" required value="${r.hours}"></label><label class="field">故障排查临时延长<select name="diagnosticDays"><option value="keep">保留当前设置</option><option value="0">取消延长</option><option value="1">从现在起 1 天</option><option value="3">从现在起 3 天</option><option value="7">从现在起 7 天</option></select></label><p class="notice">${r.diagnosticUntil&&Date.parse(r.diagnosticUntil)>Date.now()?'失败任务的截图保留至 '+date(r.diagnosticUntil)+'。':'未启用临时延长。'}待付款、暂停、结果未核实的任务继续保留。上传文件和交付文件不受影响；无法确认来源的旧缓存保留。</p>${r.recoveryPaused||r.pendingReceiptProtected?'<p class="notice">'+(r.recoveryPaused?'恢复保护中，暂不清理。':'仍有手机操作回执待核实，暂不清理。')+'</p>':''}<button class="primary">保存</button></form>`,{key:'image-retention'});}
async function showEventRules(){const {rules}=await api('/event-rules');eventRuleRows=rules;openSheet('事件触发',`<p class="sheet-intro">收到已连接服务的事件后，执行你预先交代的固定任务。</p><button data-action="new-event-rule">添加规则</button>${rules.map(r=>`<div class="connection-row"><div><strong>${esc(r.name)}</strong><small>${r.enabled?'已启用':'已暂停'} · ${esc(r.eventType)}</small></div><button data-action="edit-event-rule" data-id="${esc(r.id)}">编辑</button>${r.enabled?`<button data-action="pause-event-rule" data-id="${esc(r.id)}">暂停</button>`:''}<button data-action="remove-event-rule" data-id="${esc(r.id)}">删除</button></div>`).join('')}`,{key:'event-rules'});}
function eventRuleForm(rule){openSheet(rule?'编辑事件规则':'添加事件规则',`<form data-form="event-rule" data-id="${esc(rule?.id||'')}"><label class="field">名称<input name="name" value="${esc(rule?.name)}" required maxlength="120"></label><label class="field">收到什么事件<input name="eventType" value="${esc(rule?.eventType)}" required placeholder="例如 calendar.changed"></label><label class="field">收到后做什么<textarea name="prompt" required>${esc(rule?.prompt)}</textarea></label>${eventConditionFields(rule)}<label class="field">处理方式<select name="kind"><option value="reminder" ${rule?.kind!=='general'?'selected':''}>本机提醒</option><option value="general" ${rule?.kind==='general'?'selected':''}>交给助理执行</option></select></label><label class="toggle-row">启用规则<input type="checkbox" name="enabled" ${rule?.enabled!==false?'checked':''}></label><label class="toggle-row">允许这条规则使用 DeepSeek<input type="checkbox" name="cloudConsent" ${rule?.authorization?.cloudConsent?'checked':''}></label><label class="toggle-row">使用相关记忆<input type="checkbox" name="memoryConsent" ${rule?.authorization?.memoryConsent?'checked':''}></label><details class="log-details"><summary>${icon('chevron-right')}事件数据</summary><label class="toggle-row">允许模型读取下面指定的事件字段<input type="checkbox" name="includePayload" ${rule?.authorization?.includePayload?'checked':''}></label><label class="field">字段名（逗号分隔）<input name="payloadFields" value="${esc((rule?.payloadFields||[]).join(','))}" placeholder="例如 title, changedAt"></label></details><button class="primary">保存规则</button></form>`,{key:'event-rules'});}
function eventConditionFields(rule){const c=rule?.condition;return `<label class="field">什么时候触发<select name="conditionOperator"><option value="">每次收到有效事件</option>${[['changed','数值或内容发生变化'],['decreased','数值降低'],['below','低于指定数值'],['equals','变成指定值']].map(([v,n])=>`<option value="${v}" ${c?.operator===v?'selected':''}>${n}</option>`).join('')}</select></label><div class="form-row"><label class="field">判断字段<input name="conditionField" value="${esc(c?.field||'')}" placeholder="例如 price"></label><label class="field">指定值<input name="conditionValue" value="${esc(c?.value===undefined?'':JSON.stringify(c.value))}" placeholder="低于 / 等于时填写"></label></div><p class="notice">有条件时，首次读取只建立基准；之后数值没变就不打扰你。</p>`;}
function eventConditionInput(fields){if(!fields.conditionOperator)return null;let value;if(['below','equals'].includes(fields.conditionOperator)){try{value=JSON.parse(fields.conditionValue);}catch{value=fields.conditionValue;}if(fields.conditionOperator==='below'&&typeof value!=='number')throw Error('低于条件需要具体数字');}return {field:fields.conditionField.trim(),operator:fields.conditionOperator,...(value===undefined?{}:{value}),fireOnFirst:false};}
let monitorRows=[];
const monitorOutcomes={baseline_initialized:'已建立基准',unchanged:'内容未变',condition_matched:'满足条件，已触发',condition_not_met:'尚未满足条件',accepted:'已接收',expired:'上次事件已过期',unconditional:'已触发'};
async function showMonitors(){const [{monitors},{rules}]=await Promise.all([api('/monitors'),api('/event-rules')]);monitorRows=monitors;eventRuleRows=rules;openSheet('数据监控',`<p class="sheet-intro">定时读取你连接的数据来源，符合事件规则时再提醒或处理。</p><button data-action="new-monitor">连接数据来源</button>${monitors.map(m=>{const r=rules.find(r=>r.id===m.ruleId),valid=r?.enabled&&r.authorization?.id===m.authorizationId;return `<div class="list-card"><strong>${esc(m.name)}</strong><p class="notice">${!valid?'规则已变更或暂停，请重新保存来源':!m.enabled?'已暂停':m.lastError?'读取未完成，会按间隔重试':esc(monitorOutcomes[m.lastOutcome]||'等待首次读取')} · 每 ${m.intervalSeconds} 秒<br>${esc(m.url)}${m.lastAt?'<br>最近检查：'+date(m.lastAt):''}</p><div class="button-row"><button data-action="edit-monitor" data-id="${m.id}">编辑</button><button data-action="poll-monitor" data-id="${m.id}" ${!valid||!m.enabled?'disabled':''}>检查一次</button><button data-action="remove-monitor" data-id="${m.id}">删除</button></div></div>`;}).join('')}`,{key:'monitors'});}
async function monitorForm(row,ruleId){const {rules}=await api('/event-rules'),active=rules.filter(r=>r.enabled&&r.authorization&&!r.authorization.revokedAt);if(!active.length){toast('请先保存并启用一条事件规则');return showEventRules();}openSheet(row?'编辑数据来源':'连接数据来源',`<form data-form="monitor" data-id="${esc(row?.id||'')}"><label class="field">名称<input name="name" required maxlength="120" value="${esc(row?.name||'')}"></label><label class="field">使用规则<select name="ruleId">${active.map(r=>`<option value="${r.id}" ${r.id===(row?.ruleId||ruleId)?'selected':''}>${esc(r.name)}</option>`).join('')}</select></label><label class="field">数据接口地址<input type="url" name="url" required value="${esc(row?.url||'')}" placeholder="https://你的服务/data"></label><label class="field">读取字段<input name="fields" required value="${esc((row?.fields||[]).join(','))}" placeholder="例如 price, status"></label><label class="field">检查间隔（秒）<input type="number" name="intervalSeconds" min="30" max="86400" value="${row?.intervalSeconds||300}" required></label><label class="field">来源访问凭证<input type="password" name="authToken" autocomplete="new-password" ${row?'':'required'} placeholder="${row?'留空保留已保存的凭证':'Bearer Token'}"></label><label class="toggle-row">启用监控<input type="checkbox" name="enabled" ${row?.enabled!==false?'checked':''}></label><details class="log-details"><summary>${icon('chevron-right')}本机来源</summary><label class="toggle-row">允许读取这台 Mac 的 127.0.0.1 服务<input type="checkbox" name="allowLocal" ${row?.allowLocal?'checked':''}></label></details><p class="notice">只读取指定的 JSON 字段；凭证保存在本机钥匙串。是否发送给 DeepSeek 由对应规则决定。</p><button class="primary">保存来源</button></form>`,{key:'monitors'});}
function showEventSetup(created){openSheet('规则已保存',`<p class="sheet-intro">把本机接入文件交给事件来源。收到有效签名事件才会触发；单纯保存不会执行任务。</p><button data-action="new-monitor" data-rule="${created.rule.id}">连接数据来源</button><button id="save-event-config">保存高级接入文件</button><p class="notice">文件包含该规则的签名凭证，请仅用于你自己的事件来源。</p>`,{key:'event-rules'});$('#save-event-config').onclick=()=>{const config={version:1,ruleId:created.rule.id,eventType:created.rule.eventType,url:location.origin+'/events/ingest/'+created.rule.id,signingKey:created.signingKey,...created.signing},u=URL.createObjectURL(new Blob([JSON.stringify(config)],{type:'application/json'})),a=document.createElement('a');a.href=u;a.download='boujoy-event-'+created.rule.id+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(u),1000);};}
async function showWorkflows(){
 const {workflows}=await api('/workflows');openSheet('做事方法',`<p class="sheet-intro">从实际任务中提炼的方法，保存在专用 Markdown 知识库。每次执行仍以你当前交代的事为准。</p>${workflows.map(w=>`<div class="connection-row"><div><strong>${esc(w.name)}</strong><small>${w.status==='verified'?'已通过不同参数的样本核验':'草稿 · 尚未通过换参核验'} · ${w.verifiedSamples} 个样本</small></div><button data-action="workflow-detail" data-id="${esc(w.id)}">查看</button></div>`).join('')||empty('还没有保存的做事方法','book-open')}`,{key:'workflows'});
}
async function showWorkflowDetail(id){const w=await api('/workflows/'+id),d=w.definition;openSheet(w.name,`<p class="sheet-intro">${esc(d.description)}</p><p class="notice">${w.status==='verified'?'已有换参数的实际结果证明；执行时仍需核实当前页面。':'尚未通过换参数核验，不会当作稳定流程。'}</p><section class="settings-section"><h3>需要的信息</h3>${d.parameters.map(p=>`<p>${esc(p.description)}</p>`).join('')}</section><ol>${d.steps.map(step=>`<li><p>${esc(step.instruction)}</p><small>${esc(step.postconditions.join('；'))}</small></li>`).join('')}</ol>`,{key:'workflows'});}
let connectorDiscovery=null;
async function showConnectors(){
 const {connections}=await api('/connectors');
 openSheet('外部工具',`<p class="sheet-intro">连接你使用的服务，选择助理可以调用的工具。凭证只保存在这台 Mac 的钥匙串中。</p>${connections.map(c=>`<div class="connection-row"><div><strong>${esc(c.name)}</strong><small>${c.tools.length} 个已选工具${c.credential?' · 已保存凭证':''}</small></div><button data-action="connector-discover" data-id="${esc(c.id)}">选择工具</button><button data-action="connector-remove" data-id="${esc(c.id)}">移除</button></div>`).join('')}<details class="log-details"><summary>${icon('chevron-right')}添加连接</summary><form data-form="connector"><label class="field">名称<input name="name" minlength="2" maxlength="80" required placeholder="例如：我的日历"></label><label class="field">MCP 服务地址<input name="url" type="url" required placeholder="https://服务地址/mcp"></label><label class="field">访问令牌（服务需要时填写）<input name="token" type="password" autocomplete="off"></label><label class="toggle-row">这是已安装的本机服务<input type="checkbox" name="allowLocal"></label><button>连接服务</button></form></details>`,{key:'connectors'});
}
async function chooseConnectorTools(id){
 const {connections}=await api('/connectors'),connection=connections.find(c=>c.id===id),{tools}=await api('/connectors/'+id+'/discover',{});connectorDiscovery={id,tools};
 openSheet(connection.name,`<form data-form="connector-tools" data-id="${esc(id)}">${tools.map((t,i)=>{const selected=connection.tools.find(x=>x.name===t.name&&x.schemaHash===t.schemaHash);return `<section class="settings-section"><label class="toggle-row">${esc(t.name)}<input type="checkbox" name="tool" value="${i}" ${selected?'checked':''}></label><p class="notice">${esc(t.description)}</p>${t.readOnlyHint?`<label class="toggle-row">你明确要求使用时自动读取<input type="checkbox" name="autoRead" value="${i}" ${selected?.autoRead?'checked':''}></label>`:'<p class="notice">执行前显示具体内容，由你确认。</p>'}</section>`;}).join('')}<button class="primary">保存选择</button></form>`,{key:'connectors'});
}
async function showRemote(){
  const r=await api('/remote/status'),connected=r.connection?.dataConnected&&r.connection?.controlConnected;
  const delivery=r.notificationDelivery,notificationStates={posted:'已提交手机系统通知',permission_denied:'手机尚未允许通知',deferred_quiet:'手机免打扰中，等待补发',retry:'等待补发',pending:'等待投递'},deliveryHtml=delivery?.rows?.length?`<details class="log-details"><summary>${icon('chevron-right')}手机通知</summary>${delivery.rows.slice(-10).map(n=>`<p class="notice">${esc(state.tasks.find(t=>t.id===n.taskId)?.title||'任务结果')} · ${esc(notificationStates[n.status]||'状态待核实')}</p>`).join('')}<p class="notice">${date(delivery.receivedAt)} 收到手机回执；系统接收不代表你已阅读。</p></details>`:'';
  openSheet('异地连接',`<div class="connection-row">${icon('smartphone')}<div>${r.configured?(connected?'手机在线':r.deviceBound?'手机暂未连上':'等待绑定手机'):'尚未连接云中继'}<small>${r.deviceBound?(r.control.paused?'手机由你使用':'助理可以执行手机任务'):'首次绑定后，从手机 Boujoy 直接发消息'}</small></div></div>${r.error?'<p class="notice">连接未能启动，请检查中继和本机凭证。</p>':''}${r.identity?.maintenanceState==='failed'?'<p class="notice">连接证书维护未完成，手机控制已暂停。</p>':''}${r.configured?`<div class="button-row">${r.deviceBound?'<button data-action="remote-pause">接管手机</button><button data-action="remote-revoke-confirm">撤销手机绑定</button>':'<button class="primary" data-action="remote-pair">绑定手机</button>'}<button data-action="remote">刷新状态</button></div><div id="remote-pairing"></div>`:''}<details class="log-details"><summary>${icon('chevron-right')}连接设置</summary>${r.identity?.expiresAt?`<p class="notice">连接证书有效至 ${esc(date(r.identity.expiresAt))}${r.identity.needsMaintenance?'，将在空闲时续期。':'，由这台 Mac 自动维护。'}</p>`:''}<form data-form="remote-configure"><label class="field">已部署的中继地址<input name="relayUrl" type="url" placeholder="wss://你的中继域名/v1/tunnel" value="${esc(r.relayUrl||'')}" required></label><button>保存连接</button></form></details>${deliveryHtml}<p class="notice">${state.settings.backgroundSupported&&state.settings.phoneExecutionMode==='background'?'手机后台显示运行时主屏可以熄屏锁定；后台能力和权限必须就绪。':'主屏执行时手机需要联网并解锁。'}Mac 需要在线。手机接管后，只有明确发送新任务或继续才会恢复操作。</p>`,{key:'remote'});
}
async function showRemotePair(){
  const {binding,qr}=await api('/remote/pair',{});if(panel!=='remote')return;
  const region=$('#remote-pairing');region.innerHTML=`<div class="remote-pair"><img src="${esc(qr)}" alt="手机绑定二维码" width="280" height="280"><p>在手机 Boujoy 中扫描，或导入绑定文件。</p><button type="button" id="download-binding">保存绑定文件</button><small>此码和文件只用于你的手机，${clock(binding.expiresAt)} 到期。</small></div>`;
  $('#download-binding').onclick=()=>{const u=URL.createObjectURL(new Blob([JSON.stringify(binding)],{type:'application/json'})),a=document.createElement('a');a.href=u;a.download='boujoy-bind.json';a.click();setTimeout(()=>URL.revokeObjectURL(u),1000);};
  setTimeout(()=>{if(region.isConnected)region.innerHTML='<p class="notice">绑定码已到期，请重新生成。</p>';},Math.max(1,binding.expiresAt-Date.now()));
}
function phoneSetupMarkup(){
  const {pending,paired,devices,status}=phoneSetup;
  const selectedDevice=state.settings.phoneUseDeviceId,current=devices.find(d=>d.device_id===selectedDevice),address=pending?.address||paired?.address||current?.address||'';
  const enabled=state.settings.phoneEnabled===true,wireless=state.settings.phoneBackend==='phoneuse';
  const pairedDevice=!!selectedDevice&&(current?.paired===true||paired?.device_id===selectedDevice);
  let summary=enabled?(wireless?'无线接入已启用':'旧接入已启用'):'尚未启用手机接入';
  if(enabled&&wireless){
    if(!selectedDevice)summary='尚未完成 Phone Use 配对';
    else if(status?.connected===true)summary='无线手机已连接';
    else if(status?.connected===false)summary=pairedDevice?'已配对 · 手机暂未连接':'尚未完成 Phone Use 配对';
  }
  const pairing=pending?`<section class="settings-section"><h3>核对安全码</h3><p class="sheet-intro"><strong>${esc(pending.verification_code)}</strong></p><p class="notice">请核对手机与电脑上的全部八位数字，一致后在手机上允许连接，再点下面的按钮。</p><button class="primary" data-action="confirm-phone-pair">安全码一致，且已在手机允许</button><button data-action="restart-phone-pair">重新输入地址</button></section>`:'';
  return `<div class="connection-row">${icon('smartphone')}<div>${esc(phoneName())}<small>${esc(summary)}</small></div></div>${pairedDevice&&paired?.device_id===selectedDevice?'<p class="notice">已完成配对。后续任务会检查手机当前状态后再操作。</p>':''}${pairing}${pending?'':`<section class="settings-section"><h3>Phone Use 无线连接</h3><form data-form="phone-connect"><label class="field">手机 HTTPS 地址<input name="address" type="url" value="${esc(address)}" placeholder="https://手机地址:8443" autocomplete="off" required></label><p class="notice">输入手机执行端显示的 HTTPS 地址。首次连接需要核对安全码，等待核对时不会切换当前接入。</p><button class="primary">${enabled?'连接无线手机':'连接手机'}</button></form></section>`}${enabled&&wireless?executionModeMarkup(status):''}${enabled?'<section class="settings-section"><button data-action="disable-phone">停用当前手机接入</button></section>':''}`;
}
// Background display: the task runs on the phone's own hidden display and the
// main screen stays with the user. Readiness comes from the phone's own report.
function executionModeMarkup(status){
  if(state.settings.backgroundSupported!==true)return '<section class="settings-section"><h3>执行方式</h3><p>Phone Use · 主屏执行</p><p class="notice">使用你选择并完成配对的 Android 手机，执行时保持主屏亮着并解锁。</p></section>';
  const background=state.settings.phoneExecutionMode==='background';
  let detail={};try{detail=JSON.parse(status?.result?.content?.[0]?.text||'{}');}catch{}
  const reasons={shizuku_not_running:'Shizuku 没有运行',shizuku_permission_required:'还没有授权 Shizuku',user_service_unavailable:'后台显示服务没有启动',executor_service_disabled:'“Boujoy 后台执行”无障碍服务没有开启',display_unsupported:'这台手机暂时无法建立后台显示',locked:'手机已锁屏'};
  const readiness=!background?'':detail.backend==='display'?(detail.connected?'后台执行已就绪'+(detail.rear?.available?' · 背屏可显示进度':''):'未就绪：'+(reasons[detail.reason]||status?.reason||'等待手机报告')):'正在读取手机状态';
  return `<section class="settings-section"><h3>执行方式</h3><div class="settings-actions"><button data-action="phone-mode-main"${background?'':' class="primary" aria-pressed="true"'}>主屏执行</button><button data-action="phone-mode-background"${background?' class="primary" aria-pressed="true"':''}>后台显示执行</button></div><p class="notice">${background?'任务在手机的独立后台显示里运行，主屏留给你用。后台不可用时任务会暂停，不会改到主屏操作。':'任务直接操作手机主屏。'}</p>${readiness?`<p class="notice">${esc(readiness)}</p>`:''}</section>`;
}
// The phone's own name once paired; never a fixed model.
function phoneName(){const name=state?.settings?.phoneDeviceName;return typeof name==='string'&&name.trim()?name.trim():'Android 手机';}
function renderPhoneSetup(){openSheet('手机接入',phoneSetupMarkup(),{key:'phone'});}
async function showPhoneSetup(){
  renderPhoneSetup();
  const wireless=state.settings.phoneBackend==='phoneuse'&&state.settings.phoneEnabled;
  const [devices,status]=await Promise.allSettled([api('/phone/devices'),wireless?api('/phone/status'):Promise.resolve(null)]);
  phoneSetup.devices=devices.status==='fulfilled'?devices.value.devices||[]:[];
  phoneSetup.status=status.status==='fulfilled'?status.value:null;
  if(panel==='phone')renderPhoneSetup();
}
async function connectPhoneSetup(address){
  phoneSetup.pending=null;phoneSetup.paired=null;
  const result=await api('/phone/pair',{backend:'phoneuse',address,confirmPairing:false});
  acceptPhonePairResult(result,address);
}
function acceptPhonePairResult(result,address){
  if(result.status==='pending'&&/^\d{8}$/.test(result.verification_code||'')&&result.device_id){
    phoneSetup.pending={device_id:result.device_id,address:result.address||address,verification_code:result.verification_code};phoneSetup.paired=null;
  }else if(result.status==='paired'&&result.device_id){
    phoneSetup.pending=null;phoneSetup.paired={device_id:result.device_id,address:result.address||address};phoneSetup.status=null;
  }else throw Error('手机没有返回有效配对状态，请重新连接。');
  if(panel==='phone')renderPhoneSetup();
}
async function confirmPhoneSetup(){
  const pending=phoneSetup.pending;if(!pending)throw Error('请先连接手机并核对本次安全码。');
  const result=await api('/phone/pair',{backend:'phoneuse',address:pending.address,deviceId:pending.device_id,confirmPairing:true});
  acceptPhonePairResult(result,pending.address);await refresh();if(panel==='phone')renderPhoneSetup();
}
function showWorkspace(){const t=detail;openSheet('执行状态',`<div class="connection-row">${icon('monitor')}<div>这台 Mac<small>${online?'本地服务在线':'连接中断'}</small></div></div><div class="connection-row">${icon('smartphone')}<div>${esc(phoneName())}<small>${state.settings.phoneEnabled?'接入已启用，真机状态需检查':'尚未接入'}</small></div></div>${t?`<div class="settings-section"><h3>当前对话</h3><p class="sheet-intro">${esc(t.title)}<br>${esc(STATUS[t.status])} · ${t.requests} 次模型请求</p><div class="button-row">${ACTIVE.includes(t.status)?`<button data-action="pause-task" data-id="${t.id}">暂停处理</button><button class="danger" data-action="stop-task" data-id="${t.id}">停止</button>`:''}<button data-action="archive" data-id="${t.id}" data-archived="${!t.archived}">${t.archived?'恢复对话':'归档对话'}</button></div></div>`:'<p class="notice">开始一段对话后，这里显示真实的执行状态。</p>'}`,{key:'workspace'});}
async function grantModelConsent(id,remember=false){
  if(remember){
    await api('/settings',{chatCloudConsent:true});
    state.settings.chatCloudConsent=true;
    toast('已记住：后续新对话自动使用 DeepSeek，可在设置中关闭。');
  }
  await api('/tasks/'+id+'/continue',{cloudConsent:true});
  prefs.delete(id);composerKey='';
}
async function action(el){
  const a=el.dataset.action,id=el.dataset.id;
  if(a==='attach-file'){if(composerIsCurrent($('#composer')))$('#attachment-picker').click();return;}
  if(a==='remove-attachment'){const key=el.dataset.draftKey;if(!key||sending.has(key))return;fileDrafts.set(key,(fileDrafts.get(key)||[]).filter(f=>f.id!==id));renderDraftFiles();return;}
  if(a==='voice-record'){if(voiceRecording||composerIsCurrent($('#composer')))return recordVoice();return;}
  if(a==='speak-message')return speakMessage(el);
  if(a==='reload')return location.reload();
  if(a==='close-sheet')return closeSheet();
  if(a==='show-sidebar')return setSidebarOpen(true);
  if(a==='close-sidebar')return setSidebarOpen(false);
  if(a==='search')return showSearch();
  if(a==='search-role'){closeSheet();return choose(id);}
  if(a==='choose-role'){if(id===selectedRole){setSidebarOpen(false);return;}return choose(id);}
  if(a==='new-chat'){closeSheet();choose(selectedRole,{fresh:true});return;}
  if(a==='history')return showHistory();
  if(a==='history-filter'){historyFilter=el.dataset.filter;return showHistory();}
  if(a==='inspect-task')return showTaskInspection(id);
  if(a==='open-task'){const task=await api('/tasks/'+encodeURIComponent(id));if(!privateTask(task))return showTaskInspection(id);closeSheet();location.hash='task/'+id;return;}
  if(a==='workbench')return showWorkbench();
  if(a==='brief-now'){const out=await api('/roles/'+id+'/brief',{});closeSheet();await refresh();if(out.taskId)location.hash='task/'+out.taskId;return;}
  if(a==='forget-note'){await api('/roles/'+id,{forgetNote:el.dataset.note});await refresh();return roleForm(state.roles.find(r=>r.id===id));}
  if(a==='routines')return showRoutines();if(a==='memory')return showMemory();if(a==='settings')return showSettings();if(a==='workspace')return showWorkspace();
  if(a==='role-settings'){const r=role(selectedRole);return openSheet(r.name,`<p class="sheet-intro">${esc(r.description)}</p><div class="button-row"><button data-action="edit-role" data-id="${r.id}">编辑助理</button><button data-action="copy-role" data-id="${r.id}">复制助理</button>${r.id!=='concierge'?`<button data-action="hide-role" data-id="${r.id}">隐藏助理</button><button class="danger" data-action="delete-role" data-id="${r.id}">删除助理</button>`:''}</div><p class="notice">隐藏助理会保留历史对话，正在处理的任务不会因此停止。</p>`);}
  if(a==='invite-roles'){const roster=state.roles.filter(r=>!r.hidden&&!r.deletedAt),counts=new Map();for(const r of roster)counts.set(r.name,(counts.get(r.name)||0)+1);return openSheet('邀请助理协作',`<form data-form="invite-roles"><p class="sheet-intro">选择至少两位助理，一起处理这段对话中的目标。</p>${roster.map(r=>`<label class="toggle-row">${esc(r.name)}${counts.get(r.name)>1?'（重名，请先改名）':''}<input type="checkbox" name="roleIds" value="${esc(r.id)}" ${counts.get(r.name)>1?'disabled':''}></label>`).join('')}<p class="notice">选择会加入草稿，写好要求后发送。每位助理的进度与结果会显示在当前对话。</p><button class="primary">加入草稿</button></form>`,{key:'invite-roles'});}
  if(a==='manage-roles')return openSheet('全部助理',state.roles.map(r=>`<div class="connection-row">${avatar(r.id)}<div>${esc(r.name)}<small>${r.deletedAt?'已删除 · 历史对话保留':r.hidden?'已隐藏':esc(r.description)}</small></div>${r.deletedAt?`<button data-action="restore-role" data-id="${r.id}">恢复</button>`:`<button data-action="edit-role" data-id="${r.id}">编辑</button>${r.id!=='concierge'?`<button data-action="hide-role" data-id="${r.id}">${r.hidden?'显示':'隐藏'}</button><button data-action="delete-role" data-id="${r.id}">删除</button>`:''}`}</div>`).join(''));
  if(a==='delete-role')return openSheet('删除助理',`<p class="sheet-intro">删除「${esc(role(id).name)}」并暂停它的任务和安排。历史对话保留，可在全部助理中恢复。</p><button class="danger" data-action="confirm-delete-role" data-id="${esc(id)}">删除助理</button>`);
  if(a==='confirm-delete-role'){await api('/roles/'+id,{remove:true});closeSheet();await refresh();if(id===selectedRole)choose('concierge');return;}
  if(a==='restore-role'){await api('/roles/'+id,{restore:true});await refresh();return action({dataset:{action:'manage-roles'}});}
  if(a==='new-role')return roleForm();if(a==='edit-role')return roleForm(role(id));
  if(a==='copy-role'){await api('/roles/'+id,{copy:true});closeSheet();}
  if(a==='hide-role'){await api('/roles/'+id,{hidden:!role(id).hidden});closeSheet();if(id===selectedRole)selectedRole='concierge';location.hash='role/'+selectedRole;}
  if(a==='new-routine')return routineForm();if(a==='edit-routine')return routineForm(state.routines.find(r=>r.id===id));
  if(a==='toggle-routine')await api('/routines/'+id,{enabled:!state.routines.find(r=>r.id===id).enabled});
  if(a==='run-routine'){const t=await api('/routines/'+id,{test:true});closeSheet();location.hash='task/'+t.id;}
  if(a==='delete-routine')return openSheet('删除例行事务',`<p class="sheet-intro">停止「${esc(state.routines.find(r=>r.id===id).name)}」的后续触发，已经产生的对话会保留。</p><button class="primary" data-action="confirm-delete-routine" data-id="${id}">删除这个安排</button>`);
  if(a==='toggle-watch'){const w=(state.watches||[]).find(w=>w.id===id);await api('/watches/'+id,{status:w?.status==='active'?'paused':'active'});await refresh();return showRoutines();}
  if(a==='delete-watch'){await api('/watches/'+id,{remove:true});await refresh();return showRoutines();}
  if(a==='confirm-delete-routine'){await api('/routines/'+id,{remove:true});await refresh();return showRoutines();}
  if(a==='approve'||a==='deny')await api('/approvals/'+id,{allow:a==='approve'});
  if(a==='pause-task'||a==='stop-task'){if(taskControlsPending.has(id))return;taskControlsPending.add(id);updateSend();try{await api('/tasks/'+id+'/'+(a==='pause-task'?'pause':'stop'),{});closeSheet();await refresh();}finally{taskControlsPending.delete(id);updateSend();}return;}
  if(a==='grant-model')await grantModelConsent(id,el.dataset.remember==='true');
  if(a==='archive'){await api('/tasks/'+id+'/archive',{archived:el.dataset.archived==='true'});if(id===selectedId&&el.dataset.archived==='true'){selectedId=null;rememberSelection();detail=null;location.hash='role/'+selectedRole;}if(panel==='workspace')closeSheet();}
  if(a==='reconcile')return openSheet('记录实际结果',`<form data-form="reconcile" data-id="${id}"><label class="field">在原应用核实到了什么？<textarea name="note" placeholder="例如：订单没有提交；或已经下单成功，不要重复。" required></textarea></label><button class="primary">保存核实结果</button></form>`);
  if(a==='model-key')return openSheet('连接 DeepSeek',`<p class="sheet-intro">密钥存入 macOS 钥匙串，保存后不会自动发起模型请求。</p><form data-form="key"><label class="field">API Key<input name="value" type="password" autocomplete="off" required></label><button class="primary">保存凭证</button></form>`);
  if(a==='probe'){toast('正在验证引擎连接…');await api('/diagnostics/harness',{});toast('引擎连接正常，没有调用付费模型。');}
  if(a==='phone')return showPhoneSetup();
  if(a==='image-retention')return showImageRetention();
  if(a==='event-rules')return showEventRules();
  if(a==='monitors')return showMonitors();
  if(a==='new-monitor')return monitorForm(null,el.dataset.rule);
  if(a==='edit-monitor')return monitorForm(monitorRows.find(m=>m.id===id));
  if(a==='poll-monitor'){const result=await api('/monitors/'+id+'/poll',{});toast(monitorOutcomes[result.outcome]||'检查完成');return showMonitors();}
  if(a==='remove-monitor'){await api('/monitors/'+id+'/remove',{});return showMonitors();}
  if(a==='new-event-rule')return eventRuleForm();
  if(a==='edit-event-rule')return eventRuleForm(eventRuleRows.find(r=>r.id===id));
  if(a==='pause-event-rule'){await api('/event-rules/'+id+'/revoke',{});return showEventRules();}
  if(a==='remove-event-rule'){await api('/event-rules/'+id+'/remove',{});return showEventRules();}
  if(a==='workflows')return showWorkflows();
  if(a==='workflow-detail')return showWorkflowDetail(id);
  if(a==='connectors')return showConnectors();
  if(a==='connector-discover')return chooseConnectorTools(id);
  if(a==='connector-remove'){await api('/connectors/'+id+'/remove',{});return showConnectors();}
  if(a==='remote')return showRemote();
  if(a==='remote-pair')return showRemotePair();
  if(a==='remote-pause'){await api('/remote/pause',{});return showRemote();}
  if(a==='remote-revoke-confirm')return openSheet('撤销手机绑定','<p class="sheet-intro">撤销后，此手机将不能读取对话或执行任务。重新连接需要再次绑定。</p><button class="danger" data-action="remote-revoke">撤销绑定</button>');
  if(a==='remote-revoke'){await api('/remote/revoke',{});return showRemote();}
  if(a==='confirm-phone-pair')return confirmPhoneSetup();
  if(a==='restart-phone-pair'){phoneSetup.pending=null;phoneSetup.paired=null;return renderPhoneSetup();}
  if(a==='phone-mode-main'||a==='phone-mode-background'){await api('/settings',{phoneExecutionMode:a==='phone-mode-background'?'background':'main'});await refresh();return showPhoneSetup();}
  if(a==='disable-phone'){await api('/settings',{phoneEnabled:false});phoneSetup.pending=null;phoneSetup.paired=null;closeSheet();}
  if(a==='confirm-understanding'||a==='reject-understanding'){await api('/memory/personal/review',{id,action:a==='confirm-understanding'?'confirm':'reject'});await showMemory();return;}
  if(a==='accept-memory'||a==='reject-memory'){const p=memoryData.proposals.find(p=>p.id===id);await api('/memory/proposals/'+id+'/review',{decision:a==='accept-memory'?'accept':'reject',expectedHash:p.hash,expectedTargetHash:p.existing.length===1?p.existing[0].hash:undefined});health=await api('/health');await showMemory();toast(a==='accept-memory'?'已保存到专用知识库':'这条理解未保存为正式记忆');}
  await refresh();if(panel==='routines')showRoutines();if(panel==='history')showHistory();if(panel==='task-inspection'&&inspectedTaskId)await showTaskInspection(inspectedTaskId);
}
function readSendReceipts(){
  try{
    const rows=JSON.parse(sessionStorage.getItem(SEND_RECEIPTS_KEY)||'[]');
    const keys=['id','digest','key','taskId','roleId'],name=value=>typeof value==='string'&&/^[\w-]{1,100}$/.test(value);
    if(!Array.isArray(rows)||rows.length>100||rows.some(r=>!r||Object.keys(r).some(k=>!keys.includes(k))||!name(r.roleId)||!(r.taskId===null||name(r.taskId))||r.key!==(r.taskId||'new-'+r.roleId)||!/^[-a-f0-9]{36}$/i.test(r.id)||!/^([a-f0-9]{64})$/.test(r.digest))||new Set(rows.map(r=>r.id)).size!==rows.length)throw Error('invalid receipt');
    return rows;
  }catch{throw Error('暂时无法读取发送凭据。草稿已保留，请恢复浏览器存储并核对历史后重试。');}
}
async function prepareSendReceipt(key,taskId,roleId,payload){
  if(key!==(taskId||'new-'+roleId)||payload.roleId!==roleId)throw Error('发送凭据与当前对话不一致，消息尚未发送。');
  // Authorization defaults can change after reload; they must not create a second
  // business request for the same pending text and attachments. The original id
  // still binds the server's accepted contract; lookup never grants new consent.
  const identity={key,roleId,kind:payload.kind||'general',prompt:payload.prompt,attachments:payload.attachments||[]};
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(identity))),digest=Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
  let rows=readSendReceipts();const existing=rows.find(r=>r.key===key&&r.digest===digest),receipt=existing||{id:crypto.randomUUID(),digest,key,taskId,roleId};
  if(existing&&(existing.roleId!==roleId||existing.taskId!==taskId))throw Error('发送凭据与当前对话不一致，消息尚未发送。');
  if(!existing){for(const previous of rows.filter(r=>r.key===key))await findReceivedSend(previous);rows=readSendReceipts();if(rows.length>=100)throw Error('有过多未确认的发送，请先核对历史对话。此次消息尚未发送。');rows.push(receipt);}
  try{sessionStorage.setItem(SEND_RECEIPTS_KEY,JSON.stringify(rows));}catch{throw Error('暂时无法保存发送凭据，此次消息尚未发送。请恢复浏览器存储后重试。');}
  pendingSends.set(key,receipt);return {receipt,reused:!!existing};
}
function clearSendReceipt(receipt){
  pendingSends.delete(receipt.key);
  try{const rows=readSendReceipts().filter(r=>r.id!==receipt.id);sessionStorage.setItem(SEND_RECEIPTS_KEY,JSON.stringify(rows));}
  catch{toast('消息已接收，但本机发送凭据暂未清理；再次发送相同内容时会先核对原结果。');}
}
async function findReceivedSend(receipt){
  const task=receipt.taskId?await api('/tasks/'+receipt.taskId):(await api('/state')).tasks.find(t=>t.clientRequestId===receipt.id);
  if(!task)return null;
  if(task.roleId!==receipt.roleId||receipt.taskId&&task.id!==receipt.taskId)throw Error('原发送记录与当前对话不一致，请先核对历史，未重新发送。');
  return !receipt.taskId||task.messages?.some(m=>m.clientRequestId===receipt.id)?task:null;
}
function composerIsCurrent(form){
  if(!form?.isConnected)return false;const {draftKey,taskId,roleId,navigation,route}=form.dataset;
  return !!draftKey&&draftKey===currentKey()&&taskId===(selectedId||'')&&roleId===selectedRole&&navigation===String(navigationVersion)&&route===location.hash&&(taskId?detail?.id===taskId:!detail);
}
function saveDraft(form=$('#composer')){
  if(!form?.isConnected||!form.dataset.draftKey)return;
  drafts.set(form.dataset.draftKey,form.elements.message.value);updateSend();
}
async function submitChat(form){
  if(voiceStarting||voiceRecording||voicePending){toast(voiceRecording?'请先结束录音，再确认文字发送':'语音正在准备，请稍候');return;}
  if(!form.isConnected||sending.has(form.dataset.draftKey)||fileReading)return;
  saveDraft(form);if(!composerIsCurrent(form)){toast('正在切换对话，草稿已保留，请稍候');return;}
  const key=form.dataset.draftKey,taskId=form.dataset.taskId||null,roleId=form.dataset.roleId,route=form.dataset.route,nav=Number(form.dataset.navigation);if(taskControlsPending.has(taskId))return;
  const submitted=form.elements.message.value,text=submitted.trim();if(!key||!text)return;saveDraft(form);const p=chatPreferences(key);
  if(p.memoryConsent&&!p.cloudConsent){toast('使用记忆需要同时允许本次对话使用 DeepSeek。');return;}
  const attachments=(fileDrafts.get(key)||[]).map(({name,mime,base64,uploadId})=>base64?{name,mime,base64}:{name,mime,uploadId});const payload={...p,prompt:text,roleId,...(attachments.length?{attachments}: {})};
  // Clear the submitted value before blur/change/SSE can save it under another conversation.
  sending.add(key);drafts.set(key,'');form.elements.message.value='';updateSend();
  if(typeof setPendingSend==='function')setPendingSend({key,taskId,text,at:Date.now(),files:attachments.map(a=>a.name)});
  if(!taskId)rememberSelection();
  let accepted=false;
  try{
    const {receipt,reused}=await prepareSendReceipt(key,taskId,roleId,payload);payload.clientRequestId=receipt.id;if(typeof updatePendingSend==='function')updatePendingSend(key,{requestId:receipt.id});
    const received=reused?await findReceivedSend(receipt):null;
    let task=received;
    if(!task){try{
      task=attachments.length?await api('/chat/submit',{...payload,conversationId:taskId||null}):taskId?await api('/tasks/'+taskId+'/message',{...payload,message:text}):await api('/tasks',payload);
    }catch(error){
      if(!['TypeError','TimeoutError','AbortError'].includes(error.name))throw error;
      // A missing HTTP response says nothing about whether the server accepted it.
      // Reconcile the same receipt before restoring the draft; never replay here.
      try{task=await findReceivedSend(receipt);}catch{}
      if(!task)throw Error('暂未确认消息是否接收，草稿已保留。重试时会先核对原记录。');
    }}
    accepted=true;if(typeof updatePendingSend==='function')updatePendingSend(key,{taskId:task.id,key:task.id});fileDrafts.delete(key);if(currentKey()===key)renderDraftFiles();
    clearSendReceipt(receipt);prefs.delete(key);
    const follow=nav===navigationVersion&&route===location.hash&&selectedRole===roleId&&(currentKey()===key||currentKey()===task.id);
    if(key!==task.id&&(follow||currentKey()!==key)){const nextDraft=drafts.get(key)||'';if(nextDraft&&!drafts.get(task.id))drafts.set(task.id,nextDraft);drafts.delete(key);}
    // A response arriving after navigation must not steal the other assistant's composer.
    if(follow){selectedId=task.id;rememberSelection();composerKey='';location.hash='task/'+task.id;await refresh(true);}
  }catch(error){
    if(!accepted&&typeof clearPendingSend==='function')clearPendingSend(key);
    if(!accepted&&!drafts.get(key)){
      drafts.set(key,submitted);const current=$('#composer');
      if(current?.dataset.draftKey===key&&!current.elements.message.value)current.elements.message.value=submitted;
    }
    throw error;
  }finally{sending.delete(key);updateSend();}
}
document.addEventListener('click',event=>{const el=event.target.closest('[data-action]');if(!el)return;event.preventDefault();if(el.disabled)return;el.disabled=true;Promise.resolve(action(el)).catch(e=>toast(e.message)).finally(()=>{el.disabled=false;});});
document.addEventListener('input',event=>{if(event.target.id==='message-input')fitComposer();if(event.target.closest('#composer'))saveDraft(event.target.closest('#composer'));if(event.target.name==='name'&&event.target.closest('[data-form=role]')){const name=$('#bot-appearance-preview strong');if(name)name.textContent=event.target.value||'新伙伴';}if(event.target.id==='search'){search=event.target.value;renderSearch();}});
document.addEventListener('change',event=>{if(event.target.dataset?.settingSelect){const key=event.target.dataset.settingSelect,value=event.target.value;api('/settings',{[key]:value}).then(()=>{state.settings[key]=value;toast('已保存');}).catch(error=>toast(error.message));return;}if(event.target.id==='attachment-picker'){const files=Array.from(event.target.files);event.target.value='';void addDraftFiles(files,event.target.closest('#composer')?.dataset.draftKey).catch(e=>toast(e.message));return;}if(event.target.name==='botColor'&&BOT_COLORS.includes(event.target.value)){const preview=$('#bot-appearance-preview');if(preview)preview.className='bot-appearance-preview bot-color-'+event.target.value;}if(event.target.closest('#composer'))saveDraft(event.target.closest('#composer'));if(event.target.dataset.setting)api('/settings',{[event.target.dataset.setting]:event.target.checked}).then(()=>refresh()).catch(e=>{event.target.checked=!event.target.checked;toast(e.message);});});
document.addEventListener('submit',async event=>{const form=event.target;if(!form.dataset.form)return;event.preventDefault();if(form.dataset.form==='chat'){try{await submitChat(form);}catch(e){toast(e.message);}return;}const submit=form.querySelector('button');if(submit?.disabled)return;if(submit)submit.disabled=true;const fields=Object.fromEntries(new FormData(form));try{
  if(form.dataset.form==='invite-roles'){const ids=new FormData(form).getAll('roleIds'),roster=ids.map(id=>state.roles.find(r=>r.id===id&&!r.hidden&&!r.deletedAt)).filter(Boolean);if(roster.length<2||roster.length>4)throw Error('请选择 2 至 4 位助理');const text=roster.map(r=>'@「'+r.name+'」').join(' ')+' '+(drafts.get(currentKey())||'');drafts.set(currentKey(),text);closeSheet();renderComposer(true);$('#message-input').focus();return;}
  if(form.dataset.form==='image-retention'){await api('/image-retention',{hours:Number(fields.hours),...(fields.diagnosticDays==='keep'?{}:{diagnosticUntil:fields.diagnosticDays==='0'?null:new Date(Date.now()+Number(fields.diagnosticDays)*86400000).toISOString()})});toast('截图留存已保存');return showImageRetention();}
  if(form.dataset.form==='monitor'){await api('/monitors',{...(form.dataset.id?{id:form.dataset.id}:{}),name:fields.name,ruleId:fields.ruleId,url:fields.url,fields:fields.fields.split(',').map(s=>s.trim()).filter(Boolean),intervalSeconds:Number(fields.intervalSeconds),allowLocal:form.elements.allowLocal.checked,enabled:form.elements.enabled.checked,...(fields.authToken?{authToken:fields.authToken}:{})});return showMonitors();}
  if(form.dataset.form==='phone-connect'){await connectPhoneSetup(fields.address);}
  if(form.dataset.form==='role'){if(form.dataset.id){fields.brief={enabled:fields.briefEnabled==='on',time:fields.briefTime||'08:30'};}delete fields.briefEnabled;delete fields.briefTime;const saved=await api('/roles'+(form.dataset.id?'/'+form.dataset.id:''),fields);closeSheet();await refresh();if(!form.dataset.id)choose(saved.id,{fresh:true});}
  if(form.dataset.form==='event-rule'){const input={name:fields.name,prompt:fields.prompt,eventType:fields.eventType,kind:fields.kind,condition:eventConditionInput(fields),enabled:form.elements.enabled.checked,cloudConsent:form.elements.cloudConsent.checked,memoryConsent:form.elements.memoryConsent.checked,includePayload:form.elements.includePayload.checked,payloadFields:fields.payloadFields.split(',').map(s=>s.trim()).filter(Boolean)};const result=await api('/event-rules'+(form.dataset.id?'/'+form.dataset.id:''),input);return form.dataset.id?showEventRules():showEventSetup(result);}
  if(form.dataset.form==='connector'){const c=await api('/connectors',{...fields,allowLocal:form.elements.allowLocal.checked});return chooseConnectorTools(c.id);}
  if(form.dataset.form==='connector-tools'){const selected=[...form.querySelectorAll('[name=tool]:checked')].map(el=>{const i=Number(el.value),t=connectorDiscovery.tools[i];return {name:t.name,schemaHash:t.schemaHash,autoRead:!!form.querySelector('[name=autoRead][value=\"'+i+'\"]:checked')};});await api('/connectors/'+form.dataset.id+'/select',{tools:selected});return showConnectors();}
  if(form.dataset.form==='remote-configure'){await api('/remote/configure',fields);await showRemote();}
  if(form.dataset.form==='routine'){fields.weekdays=new FormData(form).getAll('weekdays').map(Number);fields.executionWindowSeconds=Number(fields.windowMinutes)*60;fields.cloudConsent=fields.cloudConsent==='on';fields.memoryConsent=fields.memoryConsent==='on';if(fields.memoryConsent&&!fields.cloudConsent)throw Error('使用记忆需要允许此安排使用 DeepSeek');if(fields.kind==='once'){if(!fields.date)throw Error('请选择单次日期');fields.nextAt=zonedOnce(fields.date,fields.time,fields.timezone);}await api('/routines'+(form.dataset.id?'/'+form.dataset.id:''),fields);await refresh();showRoutines();}
  if(form.dataset.form==='reconcile'){await api('/tasks/'+form.dataset.id+'/reconcile',fields);closeSheet();}
  if(form.dataset.form==='key'){await api('/secrets',{name:'deepseek',value:fields.value});form.reset();closeSheet();health=await api('/health');toast('凭证已保存，可以继续对话。');}
  if(form.dataset.form==='chat-defaults'){if(fields.chatMemoryConsent&&!fields.chatCloudConsent)throw Error('使用相关记忆需要同时开启 DeepSeek。');await api('/settings',{chatCloudConsent:fields.chatCloudConsent==='on',chatMemoryConsent:fields.chatMemoryConsent==='on',chatMemoryMode:fields.chatMemoryMode,memoryTaskId:selectedId||undefined});toast('已保存，当前对话的记忆设置和新对话默认值已更新。');}
  if(form.dataset.form==='limits'){await api('/settings',{dailyModelRequests:Number(fields.dailyModelRequests),maxModelRequests:Number(fields.maxModelRequests),maxTaskMinutes:Number(fields.maxTaskMinutes)});toast('执行限制已保存');}
  if(form.dataset.form==='memory-search'){const result=await api('/memory/context',{query:fields.query});$('#memory-results').innerHTML=result.sources.length?result.sources.map((s,i)=>{const parts=result.context.split(/\n\n(?=\[)/);const excerpt=(parts[i]||'').replace(/^\[[^\n]*\]\n/,'').replace(/^# [^\n]*\n?/,'').trim();return `<article class="memory-result"><h3>${esc(s.title)}</h3><div>${messageMarkup(excerpt).replace(/^#{2,3} (.+)$/gm,'<strong>$1</strong>')}${s.truncated?'…':''}</div><footer>${esc(s.updated)}${s.truncated?' · 相关节选':''}<details><summary>来源文件</summary>${esc(s.path)}</details></footer></article>`;}).join(''):empty('没有找到匹配的有效记忆','search');}
  await refresh();if(form.dataset.form==='phone-connect'&&panel==='phone')renderPhoneSetup();
}catch(e){toast(e.message);}finally{if(submit)submit.disabled=false;}});
document.addEventListener('paste',event=>{if(event.target.id==='message-input'&&event.clipboardData?.files.length){event.preventDefault();void addDraftFiles(event.clipboardData.files,event.target.closest('#composer')?.dataset.draftKey).catch(e=>toast(e.message));}});
document.addEventListener('dragover',event=>{if(event.target.closest('#composer')&&Array.from(event.dataTransfer?.types||[]).includes('Files'))event.preventDefault();});
document.addEventListener('drop',event=>{if(event.target.closest('#composer')&&event.dataTransfer?.files.length){event.preventDefault();void addDraftFiles(event.dataTransfer.files,event.target.closest('#composer')?.dataset.draftKey).catch(e=>toast(e.message));}});
document.addEventListener('keydown',event=>{if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='k'){event.preventDefault();showSearch();}if(event.target.id==='message-input'&&event.key==='Enter'&&!event.shiftKey&&!event.isComposing&&event.keyCode!==229){event.preventDefault();$('#composer').requestSubmit();}});
$('#sidebar-backdrop').onclick=()=>setSidebarOpen(false);$('#sheet').addEventListener('close',()=>panel='');
window.addEventListener('hashchange',()=>{saveDraft();cancelRecording();navigationVersion++;setSidebarOpen(false);closeSheet();detail=null;composerKey='';updateSend();refresh(true).catch(e=>toast(e.message));});
function cancelRecording(){speechVersion++;if(voiceRecording){voiceRecording.cancelled=true;if(voiceRecording.recorder.state==='recording')voiceRecording.recorder.stop();voiceRecording.stream.getTracks().forEach(track=>track.stop());}speechPlayback?.audio.pause();speechPlayback=null;}
window.addEventListener('pagehide',cancelRecording);document.addEventListener('visibilitychange',()=>{if(document.hidden)cancelRecording();});
function startLiveUpdates(){
  let syncing=false,pending=false,timer=0,lastSync=Date.now();
  function disconnected(){online=false;renderSidebar();renderHeader();renderTimeline();}
  function schedule(){if(timer)return;timer=setTimeout(()=>{timer=0;void syncLatest();},140);}
  async function syncLatest(){
    if(document.hidden)return;
    if(syncing){pending=true;return;}
    syncing=true;
    try{await refresh();lastSync=Date.now();}catch{disconnected();}
    finally{syncing=false;if(pending){pending=false;schedule();}}
  }
  eventSource?.close();eventSource=new EventSource('/api/events');
  eventSource.onopen=schedule;
  eventSource.onmessage=event=>{
    // Streaming reply text arrives as small draft frames; paint it directly instead of refetching everything.
    let data=null;try{data=JSON.parse(event.data);}catch{}
    if(data?.type==='draft'){if(detail&&data.taskId===detail.id&&typeof data.text==='string'){if(typeof data.thinking==='string')detail.liveThinking=data.thinking;typeDraft(data.text);}return;}
    schedule();
  };
  eventSource.onerror=()=>{disconnected();schedule();};
  // SSE can silently stall while the final answer is already saved. Reconcile from
  // the authoritative snapshot; this only reads state, never resubmits a message.
  setInterval(()=>{if(!online||ACTIVE.includes(detail?.status)||Date.now()-lastSync>=15000)void syncLatest();},5000);
  window.addEventListener('online',schedule);
  window.addEventListener('focus',schedule);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)schedule();});
}

async function boot(){try{await refreshSession();await refresh(true);api('/health').then(h=>{health=h;renderSidebar();}).catch(()=>{});startLiveUpdates();}catch(e){$('#timeline').innerHTML=`<div class="empty-chat"><h2>暂时没有连上助理</h2><p>${esc(e.message)}</p><div class="suggestions"><button data-action="reload">重新连接</button></div></div>`;}}
document.addEventListener('click',e=>{if(e.target.closest('[data-action="reload"]'))location.reload();});
if(location.protocol==='file:')location.replace('http://127.0.0.1:18791/#role/concierge');else boot();

// Keep the off-canvas navigation out of the keyboard path and contain focus when open.
window.addEventListener('resize',()=>{if(!matchMedia('(max-width:650px)').matches)setSidebarOpen(false);else syncSidebarAccessibility();});
document.addEventListener('keydown',event=>{
  if(!document.body.classList.contains('sidebar-open')||$('#sheet').open)return;
  if(event.key==='Escape'){event.preventDefault();setSidebarOpen(false);return;}
  if(event.key!=='Tab')return;
  const items=Array.from($('#sidebar').querySelectorAll('a[href],button:not([disabled]),input:not([disabled])')).filter(el=>el.getClientRects().length);
  const first=items[0],last=items.at(-1),active=document.activeElement;
  if(event.shiftKey&&(active===first||!items.includes(active))){event.preventDefault();last?.focus();}
  else if(!event.shiftKey&&(active===last||!items.includes(active))){event.preventDefault();first?.focus();}
});
syncSidebarAccessibility();
