import {withExecutionPermission} from '../core/execution-permissions.mjs';
import {AppError,requireValue} from '../core/errors.mjs';
import {PHONE_BUDGETS} from './phone-budgets.mjs';
import {normalizePhoneUseObservation,mapPhoneUseOcr} from './phoneuse-state.mjs';
import {phoneAppRecord} from './phone-apps.mjs';
import {validSession} from '../remote/display-commands.mjs';

// Background-display backend (docs/display-backend-protocol.md). It implements the
// same driver surface as PhoneUseDriver so the observation, authorization and
// receipt pipeline stay one code path; only the transport and the display differ.
// Every observation is bound to one display session/generation, every effect is
// sent with the observation it was planned from, and an effect whose receipt is
// lost is reported as unknown, never re-sent. There is no fallback to the main
// screen: when the backend is not ready the call fails and the task pauses.
const PACKAGE=/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;
const normalize=value=>String(value).normalize('NFKC').toLowerCase().replace(/\s+/g,'');
const textResult=value=>({content:[{type:'text',text:JSON.stringify(value)}]});
const TRANSIENT_READS=new Set(['NO_ACTIVE_WINDOW','TREE_TIMEOUT','OBSERVATION_INCONSISTENT','FRAME_UNAVAILABLE']);
const NOT_READY={
 shizuku_not_running:'Shizuku 没有运行。请在手机上打开 Shizuku 重新启动它。',
 shizuku_permission_required:'Boujoy 还没有获得 Shizuku 授权。请在手机 Boujoy 里点“授权 Shizuku”。',
 user_service_unavailable:'手机上的后台显示服务没有启动。请打开手机 Boujoy 检查后台执行状态。',
 executor_service_disabled:'“Boujoy 后台执行”无障碍服务没有开启。请在手机无障碍设置里亲手开启。',
 display_unsupported:'这台手机暂时无法建立后台显示。',
 locked:'手机已锁屏，后台执行暂停；解锁后再继续。'
};
const PRECHECK={
 LOCALLY_PAUSED:['phone_control_paused','手机端已暂停或停止，这次没有动手机。'],
 EXPIRED:['action_cancelled','命令到达手机时已过期，这次没有动手机。'],
 EXECUTOR_UNAVAILABLE:['display_backend_unavailable','手机后台执行服务不可用，这次没有动手机。'],
 SESSION_STALE:['stale_observation','后台显示已重建，请重新观察后再操作。'],
 STALE_OBSERVATION:['stale_observation','手机画面已更新，请重新观察后再操作。'],
 WINDOW_CHANGED:['stale_observation','后台显示上的窗口已变化，请重新观察后再操作。'],
 TARGET_MISSING:['phone_target_missing','目标控件已不在后台显示上，请重新观察。'],
 PROTECTED_INPUT:['user_only_step','密码和验证内容由用户本人输入。'],
 UNSUPPORTED_ON_DISPLAY:['phone_capability_unavailable','后台显示不支持这个系统动作。'],
 LOCKED:['phone_control_paused','手机已锁屏，后台执行暂停。'],
 NO_ACTIVE_WINDOW:['phone_target_missing','后台显示上暂时没有应用窗口（应用可能把页面开到了别处），手机已尝试拉回；这与熄屏锁屏无关。请重新读取，仍为空就再 open_app 目标应用。'],
 APP_IN_USE_ON_MAIN:['phone_app_in_use','这个应用正开在主屏上，后台执行不会把它从用户面前拿走。请告诉用户：先在主屏退出这个应用，或者改为主屏执行。']
};

function notSent(code,message,extra={}){return Object.assign(new AppError(code,message,409),{dispatchState:'not_sent',...extra});}

// A missing/contradictory receipt is uncertainty, never proof that a page closed.
function safeCode(code,fallback){return typeof code==='string'&&/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(code)?code:fallback;}
function sessionFailure(error,fallback){
 const notSent=error?.dispatchState==='not_sent';
 return {closed:false,state:notSent?'failed':'unknown',reason:safeCode(error?.code,fallback),dispatchState:notSent?'not_sent':'unknown'};
}
function sessionReceiptFailure(result,fallback){
 const request=result?.request;
 if(request!==undefined){
  const proven=request?.state==='failed'&&request?.action_executed===false;
  // Session lifecycle success uses its own envelope, not an ordinary action receipt.
  return {closed:false,state:proven?'failed':'unknown',reason:safeCode(request?.error?.code,fallback),dispatchState:proven?'not_sent':'unknown'};
 }
 if(result?.error)return {closed:false,state:'unknown',reason:safeCode(result.error.code,fallback),dispatchState:'unknown'};
 return null;
}

export class DisplayDriver {
 // backend(): {request(op,args,{session,taskId,timeoutMs,signal}), telemetry()} supplied by RemoteService.
 constructor({backend=()=>null,fallbackClient=()=>null,clock=Date.now,taskId=()=>null}={}){
  Object.assign(this,{backend,fallbackClient,clock,taskId,session:null,halted:null,catalogs:new Map(),executionStore:null});
 }
 // Transport, pairing and device listing stay with the Phone Use client.
 get client(){return this.fallbackClient();}
 link(){
  const link=this.backend();
  if(!link)throw notSent('display_backend_unavailable','后台执行需要已连接的手机 Boujoy；当前没有可用的加密连接。');
  return link;
 }
 capability(){
  const value=this.link().telemetry?.();
  if(!value)throw notSent('display_backend_unavailable','手机还没有报告后台执行能力。请确认手机上是 Boujoy 1.0.31 或以上并已连接。');
  if(!value.ready)throw notSent('display_backend_unavailable',NOT_READY[value.reason]||NOT_READY.display_unsupported,{displayReason:value.reason||'display_unsupported'});
  return value;
 }
 async send(op,args={},{session=null,timeout=PHONE_BUDGETS.call,signal,taskId=this.taskId()}={}){
  if(signal?.aborted)throw notSent('action_cancelled','任务已停止，动作未发送到手机');
  const link=this.link();
  const run=()=>link.request(op,args,{session,taskId,timeoutMs:Math.max(500,Math.min(120000,timeout)),signal});
  return withExecutionPermission(this.executionStore,['phone'],null,run);
 }
 async ensureSession({signal,timeout=PHONE_BUDGETS.launch}={}){
  this.capability();
  if(this.session)return this.session;
  const result=await this.send('session_open',{},{signal,timeout});
  const session=result?.session;
  requireValue(validSession(session),'手机没有返回有效的后台显示会话','display_backend_unavailable');
  this.session={sessionId:session.sessionId,generation:session.generation,displayId:session.displayId,width:session.width,height:session.height};
  this.halted=null;return this.session;
 }
 forgetSession(){this.session=null;}
 async closeSession({taskId=this.taskId()}={}){
  const session=this.session;this.session=null;this.halted=null;this.catalogs.clear();
  if(!session)return {closed:false,state:'no_session',reason:'no_session',dispatchState:'not_sent'};
  try{
   const result=await this.send('session_close',{},{session,taskId,timeout:8000});
   const failure=sessionReceiptFailure(result,'close_unconfirmed');if(failure)return failure;
   return result?.closed===true?{closed:true,state:'closed',reason:'closed',dispatchState:'confirmed'}
    :{closed:false,state:'unknown',reason:'close_unconfirmed',dispatchState:'unknown'};
  }catch(error){return sessionFailure(error,'close_failed');}
 }
 sessionError(code){if(code==='SESSION_STALE')this.session=null;}
 supports(feature){try{return this.backend()?.telemetry?.()?.features?.includes(feature)===true;}catch{return false;}}
 // The Mac retires its session immediately. A failed/unknown handoff never causes
 // an automatic replay or close: the phone may already be holding the user's page.
 async handoffSession({taskId=this.taskId(),title='',summary=''}={}){
  const session=this.session;
  if(!session)return {handed:false,closed:false,state:'no_session',reason:'no_session',dispatchState:'not_sent'};
  if(!this.supports('session_handoff')){
   const closed=await this.closeSession({taskId});
   return {...closed,handed:false,reason:closed.closed?'unsupported':closed.reason,handoffSupported:false};
  }
  this.session=null;this.halted=null;this.catalogs.clear();
  const clip=(value,max)=>[...String(value||'').replace(/\s+/g,' ').trim()].slice(0,max).join('');
  try{
   if(typeof taskId!=='string'||!taskId.trim()||taskId.length>128)throw notSent('invalid_input','交接缺少有效的任务编号');
   const result=await this.send('session_handoff',{task_id:taskId,title:clip(title,40),summary:clip(summary,160)},{session,taskId,timeout:8000});
   const failure=sessionReceiptFailure(result,'handoff_unconfirmed');if(failure)return {handed:false,...failure};
   const state=result?.handoff?.state;
   if(!['pending','taken','dismissed','expired','failed'].includes(state))return {handed:false,closed:false,state:'unknown',reason:'handoff_unconfirmed',dispatchState:'unknown'};
   return {handed:state==='pending',closed:state==='dismissed'||state==='expired',state,
    reason:state==='failed'?safeCode(result?.handoff?.errorCode,'handoff_failed'):state,dispatchState:'confirmed'};
  }catch(error){return {handed:false,...sessionFailure(error,'handoff_failed')};}
 }
 async capture(deviceId,{mode='both',signal,timeout=6000,screenshotFallback=false}={}){
  requireValue(Number.isFinite(timeout)&&timeout>0,'读取超时必须为正数');
  const deadline=this.clock()+Math.max(1,Math.min(20000,timeout));
  let captureMode=mode,windowFailure=null;
  // A page that is still opening (no window yet, no frame yet) is waited for while the
  // budget lasts, instead of failing after two quick tries.
  for(let attempt=0;attempt<6;attempt++){
   const remaining=deadline-this.clock();if(remaining<=0)throw notSent('rpc_timeout','后台显示读取等待超时');
   const session=await this.ensureSession({signal,timeout:Math.max(remaining,PHONE_BUDGETS.read)});
   const result=await this.send('observe',{mode:captureMode,max_dimension:1440},{session,timeout:remaining,signal});
   const raw=result?.observation;
   if(!raw||raw.observation_status!=='complete'){
    const code=raw?.observation_status==='partial'?'OBSERVATION_INCONSISTENT':typeof raw?.error?.code==='string'?raw.error.code:typeof result?.error?.code==='string'?result.error.code:'OBSERVATION_FAILED';
    this.sessionError(code);
    if(code==='SESSION_STALE'&&attempt<2)continue;
    // Autoplaying feeds change the tree while it is walked, so a full read can keep
    // failing. After one retry, read the picture alone (as the main-screen path does
    // for such pages): the page is still seen through OCR and taps stay bound to the
    // same window, instead of the read failing outright.
    if(code==='OBSERVATION_INCONSISTENT'&&captureMode==='both'&&attempt>=1&&deadline-this.clock()>400){captureMode='screenshot';windowFailure={code:'tree_unstable',message:'页面在读取结构时持续变化，只读取了画面'};continue;}
    if(TRANSIENT_READS.has(code)&&attempt<5&&deadline-this.clock()>600){await new Promise(resolve=>setTimeout(resolve,350));continue;}
    if(PRECHECK[code])throw notSent(PRECHECK[code][0],PRECHECK[code][1],{phoneuseCode:code});
    throw notSent('phoneuse_error',`后台显示读取失败（${code}）`,{phoneuseCode:code});
   }
   let frame;
   try{frame=normalizePhoneUseObservation(raw,{requireTree:captureMode!=='screenshot',requireScreenshot:captureMode!=='tree',now:this.clock(),displaySession:session});}
   catch(error){
    if(error.code==='display_session_stale'){this.session=null;if(attempt<2)continue;throw notSent('stale_observation','后台显示已重建，请重新观察后再操作。');}
    if(screenshotFallback&&mode==='both'&&captureMode==='both'&&['phoneuse_invalid_observation','phoneuse_incomplete_observation'].includes(error.code)){captureMode='screenshot';windowFailure={code:error.code,message:error.message};continue;}
    throw error;
   }
   const bound=this.backend()?.deviceId?.();
   requireValue(bound&&frame.native.deviceId===bound,'手机身份已变化，请重新连接','stale_observation');
   if(windowFailure){frame.screenshotOnly=true;frame.windowFailure=windowFailure;}
   frame.readAttempts=attempt+1;
   return frame;
  }
  throw notSent('phoneuse_error','后台显示读取未完成');
 }
 recognize(image,mapping,recognize){return Promise.resolve(recognize(image)).then(ocr=>mapPhoneUseOcr(ocr,mapping));}
 async status(){
  const value=this.backend()?.telemetry?.()||null;
  if(!value)return {enabled:true,backend:'display',connected:false,reason:'手机还没有报告后台执行能力'};
  const result={connected:value.ready,listening:value.ready,link:value.ready?'ready':'not_ready',backend:'display',reason:value.reason,shizuku:value.shizuku,executorService:value.executorService,userService:value.userService,session:value.session,rear:value.rear};
  return {enabled:true,backend:'display',connected:value.ready,...(value.ready?{}:{reason:NOT_READY[value.reason]||NOT_READY.display_unsupported}),result:textResult(result)};
 }
 async capabilities(){
  const value=this.backend()?.telemetry?.()||null;
  return {backend:'display',deviceId:null,serviceInstanceId:null,accessibility:value?.executorService===true,screenOn:value?.ready===true,locked:value?.reason==='locked',displaySession:value?.session||null,rear:value?.rear||null,
   protocolActions:['tap','long_press','swipe','scroll','input_text','back','launch_app'],
   semanticActions:['open_app','read','search','tap','long_press','type','scroll','back','set_value'],textModes:['insert','replace'],
   requiresTaskContract:true,protectedInput:'user_only',unavailableReason:value?.ready?null:(value?.reason||'display_unsupported')};
 }
 async catalog(){
  const cached=this.catalogs.get('apps'),age=cached?this.clock()-cached.at:Infinity;
  if(age>=0&&age<600000)return {...cached,cached:true};
  this.capability();
  const result=await this.send('list_apps',{},{timeout:8000});
  requireValue(Array.isArray(result?.apps)&&result.apps.length<=50000,'无法读取手机应用目录','app_catalog_unavailable');
  const rows=new Map();
  for(const item of result.apps)if(typeof item?.package_name==='string'&&item.package_name.length<=255&&PACKAGE.test(item.package_name))rows.set(item.package_name,phoneAppRecord(item.package_name,item.label));
  const catalog={apps:[...rows.values()],at:this.clock(),cached:false};this.catalogs.set('apps',catalog);return catalog;
 }
 info(catalog){return {source:'display',cached:catalog.cached,stale:false,observedAt:new Date(catalog.at).toISOString(),ageMs:Math.max(0,this.clock()-catalog.at),reason:catalog.cached?'recent_verified_catalog':'fresh_display'};}
 async listApps(deviceId,query='',{limit=10}={}){
  requireValue(typeof query==='string'&&query.length<=120,'应用查询应为不超过 120 字符的名称或包名');
  let catalog=await this.catalog();const term=normalize(query.trim());
  const match=()=>catalog.apps.map(app=>{const aliases=app.aliases.map(normalize),pkg=normalize(app.packageName);return {app,score:!term?1:pkg===term?1000:aliases.includes(term)?900:aliases.some(a=>a.startsWith(term))?700:aliases.some(a=>a.includes(term))?600:pkg.includes(term)?400:0};}).filter(row=>row.score>0).sort((a,b)=>b.score-a.score||a.app.packageName.localeCompare(b.app.packageName));
  let rows=match();
  if(!rows.length&&catalog.cached){this.catalogs.clear();catalog=await this.catalog();rows=match();}
  const cap=Math.min(Math.max(limit,1),300);
  return {...this.info(catalog),query:query.trim(),apps:rows.slice(0,cap).map(row=>row.app),totalInstalled:catalog.apps.length,totalMatched:rows.length,truncated:rows.length>cap};
 }
 async resolveApp(deviceId,packageName){
  requireValue(typeof packageName==='string'&&PACKAGE.test(packageName),'应用包名无效');
  let catalog=await this.catalog(),app=catalog.apps.find(a=>a.packageName===packageName);
  if(!app&&catalog.cached){this.catalogs.clear();catalog=await this.catalog();app=catalog.apps.find(a=>a.packageName===packageName);}
  if(!app)throw new AppError('app_not_installed','当前手机应用目录中没有这个应用。',404);
  return {...app,...this.info(catalog)};
 }
 receipt(result,session){
  const request=result?.request||{};
  if(request.state==='executed'&&request.action_executed===true)return result;
  if(request.state==='failed'&&request.action_executed===false){
   const code=typeof request.error?.code==='string'&&/^[A-Z][A-Z0-9_]{0,127}$/.test(request.error.code)?request.error.code:null;
   this.sessionError(code);
   if(code&&PRECHECK[code])throw notSent(PRECHECK[code][0],PRECHECK[code][1],{phoneuseCode:code,requestId:request.request_id});
   throw notSent('action_cancelled',`手机拒绝了本次后台动作${code?'（'+code+'）':''}，确认尚未执行；请根据最新页面决定下一步。`,{...(code?{phoneuseCode:code}:{}),requestId:request.request_id});
  }
  throw Object.assign(new AppError('outcome_unknown','手机后台动作结果尚未确认，暂不重复执行。',409),{dispatchState:'unknown',requestId:request.request_id,session});
 }
 async effect(op,args,{session,signal,timeout}){
  if(this.halted)throw notSent('phone_display_mismatch',this.halted);
  const result=await this.send(op,args,{session,signal,timeout});
  return this.receipt(result,session);
 }
 async reconcileNavigation(){return {resolved:false,outcome:'navigation_not_observed',resolution:'display_backend'};}
 async call(deviceId,name,args={},timeout=PHONE_BUDGETS.action,{signal,native,requestId}={}){
  if(name==='ui_tree')return (await this.capture(deviceId,{mode:'tree',signal,timeout})).tree;
  if(name==='screenshot')return (await this.capture(deviceId,{mode:'screenshot',signal,timeout})).image;
  if(name==='status')return (await this.status()).result;
  if(signal?.aborted)throw notSent('action_cancelled','任务已停止，动作未发送到手机');
  if(name==='open_app'){
   requireValue(typeof args.packageName==='string'&&PACKAGE.test(args.packageName),'应用包名无效');
   if(this.halted)throw notSent('phone_display_mismatch',this.halted);
   const session=await this.ensureSession({signal});
   const result=await this.effect('launch_app',{package_name:args.packageName},{session,signal,timeout:Math.min(timeout,PHONE_BUDGETS.launch)});
   const landing=result.landing;
   if(!landing||landing.onSessionDisplay!==true||landing.displayId!==session.displayId){
    // The app's window has not shown up on the background display yet: a slow cold
    // start, a splash or permission page from another package, or the system opened
    // it somewhere else. Nothing is ever sent outside this display, so this is not a
    // stop: report the start as unconfirmed and let the caller read the display.
    throw Object.assign(new AppError('outcome_unknown','应用启动后还没有在后台显示里出现；先看后台显示当前画面，再决定等待还是重新打开。',409),{dispatchState:'unknown',requestId:result.request?.request_id,landingUnconfirmed:true});
   }
   return textResult({launched:true,packageName:args.packageName,display:'background',displayId:session.displayId,windowId:landing.windowId??null});
  }
  const bound=native?.displaySession;
  requireValue(native&&validSession(bound)&&typeof native.observationId==='string'&&typeof native.serviceInstanceId==='string','手机画面已过期，请重新观察','stale_observation');
  const session=this.session;
  if(!session||session.sessionId!==bound.sessionId||session.generation!==bound.generation||session.displayId!==bound.displayId)throw notSent('stale_observation','后台显示已重建，请重新观察后再操作。');
  const common={observation_id:native.observationId,expected_window_id:native.windowId,...(requestId?{request_id:requestId}:{})};
  const visible=node=>node.visible===true&&node.enabled===true&&!node.password;
  let op,fields;
  if(name==='tap'){
   requireValue(Number.isFinite(args.x)&&Number.isFinite(args.y),'坐标无效');
   op='tap';fields={x:Math.round(args.x),y:Math.round(args.y)};
  }else if(name==='long_press'){
   requireValue(Number.isFinite(args.x)&&Number.isFinite(args.y),'坐标无效');
   const candidates=(native.elements||[]).filter(node=>visible(node)&&node.actions?.includes('long_press')&&Array.isArray(node.bounds)&&args.x>=node.bounds[0]&&args.x<node.bounds[2]&&args.y>=node.bounds[1]&&args.y<node.bounds[3]);
   requireValue(candidates.length===1,'没有唯一支持原生长按的目标，不使用坐标长按','stale_observation');
   op='long_press';fields={element_id:candidates[0].element_id};
  }else if(name==='type'){
   const secret=(native.elements||[]).some(node=>node.visible===true&&node.focused===true&&node.password===true);
   if(secret)throw notSent('user_only_step','密码和验证内容由用户本人输入');
   // No IME here: the global input method belongs to the main screen. Text is written
   // straight into the field. The field is the focused one; when the app does not report
   // focus on a background display, it is the only field on the page, or the field the
   // last tap landed in.
   const fields_=(native.elements||[]).filter(node=>visible(node)&&node.editable===true&&node.actions?.includes('set_text')&&Array.isArray(node.bounds));
   let editors=fields_.filter(node=>node.focused===true);
   if(editors.length!==1&&fields_.length===1)editors=fields_;
   if(editors.length!==1&&Number.isFinite(args.nearX)&&Number.isFinite(args.nearY)){
    const hit=fields_.filter(node=>args.nearX>=node.bounds[0]&&args.nearX<=node.bounds[2]&&args.nearY>=node.bounds[1]&&args.nearY<=node.bounds[3]).sort((a,b)=>(a.bounds[2]-a.bounds[0])*(a.bounds[3]-a.bounds[1])-(b.bounds[2]-b.bounds[0])*(b.bounds[3]-b.bounds[1]));
    if(hit.length)editors=[hit[0]];
   }
   if(editors.length!==1)throw notSent('phone_input_unavailable',fields_.length?'后台显示上有多个输入框，不确定要写进哪一个；先点一下要输入的那个框，再输入。':'后台显示的这个页面没有可直接写入的输入框（应用没有提供）；先点一下输入位置再试，仍不行就如实告诉用户这一步需要他在主屏接手。');
   requireValue(typeof args.text==='string'&&args.text.length<=4000&&['insert','replace'].includes(args.mode),'输入内容或模式无效');
   op='input_text';fields={element_id:editors[0].element_id,text:args.text,mode:args.mode};
  }else if(name==='range_step'){
   requireValue(['forward','backward'].includes(args.direction),'调节方向无效');
   const node=(native.elements||[]).find(item=>item.element_id===args.elementId);
   requireValue(node&&visible(node)&&node.actions?.includes('scroll_'+args.direction),'滑块缺少原生调节能力','phone_capability_unavailable');
   op='scroll';fields={element_id:node.element_id,direction:args.direction};
  }else if(name==='key'&&args.key==='back'){op='back';fields={};
  }else if(name==='key'&&['home','recents'].includes(args.key)){
   throw notSent('phone_capability_unavailable','后台显示不支持主页和最近任务，避免影响你正在用的主屏。');
  }else if(name==='swipe'){
   requireValue(['x1','y1','x2','y2'].every(key=>Number.isFinite(args[key])),'滑动坐标无效');
   op='swipe';fields={points:[{x:Math.round(args.x1),y:Math.round(args.y1)},{x:Math.round(args.x2),y:Math.round(args.y2)}],duration_ms:args.durationMs||500};
  }else throw new AppError('invalid_action','后台显示不支持这个动作');
  return this.effect(op,{...common,...fields},{session,signal,timeout:Math.min(timeout,PHONE_BUDGETS.action)});
 }
 async close(){this.catalogs.clear();await this.closeSession();}
}
