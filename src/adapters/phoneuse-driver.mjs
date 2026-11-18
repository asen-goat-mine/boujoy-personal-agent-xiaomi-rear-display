import {withExecutionPermission} from '../core/execution-permissions.mjs';
import {PHONE_BUDGETS} from './phone-budgets.mjs';
import {NAVIGATION_PROOF_BUDGET_MS,PhoneUseClient,unwrapPhoneUseMcp} from './phoneuse-client.mjs';
import {normalizePhoneUseObservation,mapPhoneUseOcr} from './phoneuse-state.mjs';
import {phoneAppRecord} from './phone-apps.mjs';
import {AppError,requireValue} from '../core/errors.mjs';

const PACKAGE=/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;
const normalize=value=>String(value).normalize('NFKC').toLowerCase().replace(/\s+/g,'');
const textResult=value=>({content:[{type:'text',text:JSON.stringify(value)}]});
// TREE_TIMEOUT: a very large screen (12306's train list, ~540 nodes) can miss the
// accessibility dump deadline while the page is still settling. Nothing was acted on;
// a tree-only read retries once, a general read falls back to screenshot + OCR.
const TRANSIENT_OBSERVATION=new Set(['OBSERVATION_INCONSISTENT','NO_ACTIVE_WINDOW','SCREENSHOT_RATE_LIMITED','TREE_TIMEOUT']);
const WINDOW_READ_FAILURES=new Set(['NO_ACTIVE_WINDOW','WINDOW_MISMATCH','TREE_TIMEOUT']);
function windowReadFailure(error){return error?.code==='phoneuse_error'&&error.phoneuseReasonsComplete===true&&['complete','failed'].includes(error.phoneuseObservationStatus)&&Array.isArray(error.phoneuseReasons)&&error.phoneuseReasons.length>0&&error.phoneuseReasons.every(reason=>WINDOW_READ_FAILURES.has(reason));}
const observationStopped=()=>Object.assign(new AppError('cancelled','任务已停止',409),{dispatchState:'not_sent'});
const observationTimeout=()=>Object.assign(new AppError('rpc_timeout','Phone Use 读取等待超时',409),{dispatchState:'not_sent'});
function retryableObservation(error){
 return error?.code==='phoneuse_error'&&error.phoneuseReasonsComplete===true&&['complete','failed'].includes(error.phoneuseObservationStatus)&&Array.isArray(error.phoneuseReasons)&&error.phoneuseReasons.length>0&&error.phoneuseReasons.every(reason=>TRANSIENT_OBSERVATION.has(reason));
}
function waitForObservation(ms,signal){
 if(signal.aborted)return Promise.reject(observationStopped());
 return new Promise((resolve,reject)=>{
  const finish=(fn,value)=>{clearTimeout(timer);signal.removeEventListener('abort',onAbort);fn(value);};
  const onAbort=()=>finish(reject,observationStopped());
  const timer=setTimeout(()=>finish(resolve),ms);signal.addEventListener('abort',onAbort,{once:true});
 });
}
// A single deadline covers startup, both reads and the recovery wait. The
// linked signal stops recovery even when an underlying transport settles late.
function boundedObservation(work,{signal,timeout}){
 if(signal?.aborted)return Promise.reject(observationStopped());
 const controller=new AbortController();
 return new Promise((resolve,reject)=>{
  let done=false;
  const finish=(fn,value)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',onAbort);fn(value);};
  const stop=error=>{controller.abort();finish(reject,error);};
  const onAbort=()=>stop(observationStopped());
  const timer=setTimeout(()=>stop(observationTimeout()),timeout);signal?.addEventListener('abort',onAbort,{once:true});
  Promise.resolve().then(()=>work(controller.signal)).then(value=>finish(resolve,value),error=>finish(reject,error));
 });
}

// Adapt the pinned protocol to Boujoy's existing observation/authorization
// pipeline. Native snapshot references stay local and are passed explicitly
// from the final fresh capture; no shared "last screen" can authorize input.
export class PhoneUseDriver {
 constructor({client=new PhoneUseClient(),clock=Date.now}={}){this.client=client;this.clock=clock;this.catalogs=new Map();}
 async request(...args){return withExecutionPermission(this.executionStore,['phone'],null,()=>this.client.call(...args));}
 async capture(deviceId,{mode='both',signal,timeout=6000,screenshotFallback=false}={}){
  requireValue(Number.isFinite(timeout)&&timeout>0,'读取超时必须为正数');
  const budget=Math.max(1,Math.min(20000,timeout)),deadline=performance.now()+budget;
  return boundedObservation(async captureSignal=>{
   let captureMode=mode,windowFailure=null;
   for(let attempt=0;attempt<2;attempt++){
    if(captureSignal.aborted)throw observationStopped();
    const remaining=Math.floor(deadline-performance.now());if(remaining<=0)throw observationTimeout();
    const nativeBudget=Math.max(1,remaining-100);
    let raw;
    try{raw=await this.request(deviceId,'observe',{mode:captureMode,output:'legacy',compact:false,include_details:true,diagnostics:true,max_dimension:1440,stable_wait_ms:attempt?Math.min(150,nativeBudget):0,max_attempts:screenshotFallback?1:2,timeout_ms:nativeBudget},{signal:captureSignal,timeout:remaining});}
    catch(error){
     if(!attempt&&screenshotFallback&&mode==='both'&&!captureSignal.aborted&&windowReadFailure(error)&&deadline-performance.now()>100){captureMode='screenshot';windowFailure=error.phoneuseReasons[0];continue;}
     if(attempt||captureSignal.aborted||!retryableObservation(error)||deadline-performance.now()<=300)throw error;
     await waitForObservation(300,captureSignal);continue;
    }
    if(captureSignal.aborted)throw observationStopped();if(performance.now()>=deadline)throw observationTimeout();
    let frame;
    try{frame=normalizePhoneUseObservation(raw,{requireTree:captureMode!=='screenshot',requireScreenshot:captureMode!=='tree',now:this.clock()});}
    catch(error){
     // Some app screens (NetEase Music after a popup, in-app web views) return
     // a screenshot with a window tree that fails validation. For general
     // navigation, fall back to screenshot + OCR once instead of failing every
     // read; the malformed tree itself is never used.
     if(!attempt&&screenshotFallback&&mode==='both'&&captureMode==='both'&&!captureSignal.aborted&&['phoneuse_invalid_observation','phoneuse_incomplete_observation'].includes(error.code)&&error.message!=='Phone Use 缺少真实原生控件类型'&&deadline-performance.now()>100){captureMode='screenshot';windowFailure={code:error.code,message:error.message};continue;}
     // A transitional accessibility snapshot can omit one class. Recollect
     // once; never fill in a guessed class or use the malformed snapshot.
     if(attempt||captureSignal.aborted||error.code!=='phoneuse_invalid_observation'||error.message!=='Phone Use 缺少真实原生控件类型'||deadline-performance.now()<=300)throw error;
     await waitForObservation(300,captureSignal);continue;
    }
    requireValue(frame.native.deviceId===deviceId,'手机身份已变化，请重新连接','stale_observation');
    if(windowFailure){frame.screenshotOnly=true;frame.windowFailure=windowFailure;}
    return frame;
   }
  },{signal,timeout:budget});
 }
 recognize(image,mapping,recognize){return Promise.resolve(recognize(image)).then(ocr=>mapPhoneUseOcr(ocr,mapping));}
 async status(deviceId,{paused=false}={}){
  if(!deviceId)return {enabled:true,backend:'phoneuse',connected:false,reason:'尚未完成 Phone Use 配对'};
  try{
   const raw=await this.request(deviceId,'get_status',{}, {timeout:4000});
   const state=unwrapPhoneUseMcp(raw);
   requireValue(state.device_id===deviceId,'手机状态身份不匹配','phoneuse_device_mismatch');
   if(paused){
    const pending=await this.client.pendingSummary?.(),pendingCount=pending?.requests?.filter(request=>request.deviceId===deviceId).length||0;
    return {enabled:true,backend:'phoneuse',connected:true,result:textResult({connected:true,listening:false,paused:true,link:'paused',backend:'phoneuse',deviceId,pendingCount})};
   }
   const capabilities=unwrapPhoneUseMcp(await this.request(deviceId,'get_capabilities',{}, {timeout:4000}));
   const pending=await this.client.pendingSummary?.(),pendingCount=pending?.requests?.filter(request=>request.deviceId===deviceId).length||0;
   const ready=state.stopped===false&&capabilities.accessibility===true&&capabilities.screen_on===true&&capabilities.locked===false;
   const result={connected:true,listening:state.stopped===false,link:pendingCount?'needs_reconcile':ready?'ready':'not_ready',backend:'phoneuse',deviceId,pendingCount,accessibility:capabilities.accessibility===true,screenOn:capabilities.screen_on===true,locked:capabilities.locked===true};
   return {enabled:true,backend:'phoneuse',connected:true,result:textResult(result)};
  }catch(error){return {enabled:true,backend:'phoneuse',connected:false,reason:error.message};}
 }
 async capabilities(deviceId){
  const value=unwrapPhoneUseMcp(await this.request(deviceId,'get_capabilities',{}, {timeout:4000}));
  requireValue(value.device_id===deviceId&&typeof value.service_instance_id==='string','手机能力返回缺少设备身份','phoneuse_invalid_result');
  return {backend:'phoneuse',deviceId,serviceInstanceId:value.service_instance_id,accessibility:value.accessibility===true,screenOn:value.screen_on===true,locked:value.locked===true,androidApi:value.android_api,
   protocolActions:['tap','long_press','swipe','scroll','input_text','back','home','recents','launch_app'],
   semanticActions:['open_app','read','search','tap','long_press','type','scroll','back','home','recents','set_value'],textModes:Array.isArray(value.text_modes)?value.text_modes.filter(mode=>['insert','replace'].includes(mode)):[],
   requiresTaskContract:true,protectedInput:'user_only',unavailableReason:value.unavailable_reason||null};
 }
 async catalog(deviceId){
  const cached=this.catalogs.get(deviceId),age=cached?this.clock()-cached.at:Infinity;
  if(age>=0&&age<600000)return {...cached,cached:true};
  const result=unwrapPhoneUseMcp(await this.request(deviceId,'list_apps',{}, {timeout:6000}));
  requireValue(Array.isArray(result.apps)&&result.apps.length<=50000,'无法读取无线手机应用目录','app_catalog_unavailable');
  const rows=new Map();
  for(const item of result.apps){if(typeof item?.package_name==='string'&&item.package_name.length<=255&&PACKAGE.test(item.package_name))rows.set(item.package_name,phoneAppRecord(item.package_name,item.label));}
  const catalog={apps:[...rows.values()],at:this.clock(),cached:false};this.catalogs.set(deviceId,catalog);return catalog;
 }
 info(catalog){return {source:'phoneuse',cached:catalog.cached,stale:false,observedAt:new Date(catalog.at).toISOString(),ageMs:Math.max(0,this.clock()-catalog.at),reason:catalog.cached?'recent_verified_catalog':'fresh_phoneuse'};}
 async listApps(deviceId,query='',{limit=10}={}){
  requireValue(typeof query==='string'&&query.length<=120,'应用查询应为不超过 120 字符的名称或包名');
  let catalog=await this.catalog(deviceId);const term=normalize(query.trim());
  const match=()=>catalog.apps.map(app=>{const aliases=app.aliases.map(normalize),pkg=normalize(app.packageName);return {app,score:!term?1:pkg===term?1000:aliases.includes(term)?900:aliases.some(a=>a.startsWith(term))?700:aliases.some(a=>a.includes(term))?600:pkg.includes(term)?400:0};}).filter(row=>row.score>0).sort((a,b)=>b.score-a.score||a.app.packageName.localeCompare(b.app.packageName));
  let rows=match();
  if(!rows.length&&catalog.cached){this.catalogs.delete(deviceId);catalog=await this.catalog(deviceId);rows=match();}
  return {...this.info(catalog),query:query.trim(),apps:rows.slice(0,Math.min(Math.max(limit,1),300)).map(row=>row.app),totalInstalled:catalog.apps.length,totalMatched:rows.length,truncated:rows.length>Math.min(Math.max(limit,1),300)};
 }
 async resolveApp(deviceId,packageName){
  requireValue(typeof packageName==='string'&&PACKAGE.test(packageName),'应用包名无效');
  let catalog=await this.catalog(deviceId),app=catalog.apps.find(a=>a.packageName===packageName);
  if(!app&&catalog.cached){this.catalogs.delete(deviceId);catalog=await this.catalog(deviceId);app=catalog.apps.find(a=>a.packageName===packageName);}
  if(!app)throw new AppError('app_not_installed','当前手机应用目录中没有这个应用。',404);
  return {...app,...this.info(catalog)};
 }
 async effect(deviceId,tool,args,options){
  const raw=await this.request(deviceId,tool,args,options),parsed=unwrapPhoneUseMcp(raw),result=parsed.request||parsed;
  if(result.state==='executed'&&result.action_executed===true)return raw;
  if(['failed','cancelled'].includes(result.state)&&result.action_executed===false){
   const nativeCode=result.error?.code||parsed.error?.code;
   const code=typeof nativeCode==='string'&&/^[A-Z][A-Z0-9_]{0,127}$/.test(nativeCode)?nativeCode:null;
   const error=new AppError('action_cancelled',`手机拒绝了本次动作${code?'（'+code+'）':''}，确认尚未执行；请根据原因和最新页面决定下一步。`,409);
   Object.assign(error,{dispatchState:'not_sent',...(code?{phoneuseCode:code}:{}),...(result.request_id?{requestId:result.request_id}:{}),deviceId});throw error;
  }
  throw new AppError('outcome_unknown','手机动作结果尚未确认，暂不重复执行。',409);
 }
 async reconcileNavigation(deviceId,requestId,{signal,timeout=this.client.navigationRecoveryTimeout??NAVIGATION_PROOF_BUDGET_MS}={}){
  requireValue(Number.isFinite(timeout)&&timeout>0,'导航核实超时必须为正数');
  const budget=Math.min(timeout,NAVIGATION_PROOF_BUDGET_MS),deadline=performance.now()+budget;
  return boundedObservation(async recoverySignal=>{
   for(let attempt=0;attempt<2;attempt++){
    if(recoverySignal.aborted)throw observationStopped();
    const remaining=Math.floor(deadline-performance.now());if(remaining<=0)throw observationTimeout();
    let result;
    try{result=await this.client.reconcileNavigation(requestId,{deviceId,signal:recoverySignal,timeout:remaining,capture:settings=>this.capture(deviceId,{...settings,mode:'tree'})});}
    catch(error){
     if(attempt||recoverySignal.aborted||!retryableObservation(error)||deadline-performance.now()<=300)throw error;
     await waitForObservation(300,recoverySignal);continue;
    }
    if(recoverySignal.aborted)throw observationStopped();
    // Only recollect a transient, not-yet-visible target. Identity changes,
    // active requests, transport failures and business effects stay blocked.
    if(attempt||result.resolved||result.outcome!=='navigation_not_observed'||deadline-performance.now()<=300)return result;
    await waitForObservation(300,recoverySignal);
   }
  },{signal,timeout:budget});
 }
 async call(deviceId,name,args={},timeout=PHONE_BUDGETS.action,{signal,native,requestId,controller}={}){
  if(name==='ui_tree')return (await this.capture(deviceId,{mode:'tree',signal,timeout})).tree;
  if(name==='screenshot')return (await this.capture(deviceId,{mode:'screenshot',signal,timeout})).image;
  if(name==='status')return (await this.status(deviceId)).result;
  if(signal?.aborted)throw new AppError('action_cancelled','任务已停止，动作未发送到手机',409);
  if(name==='open_app'){
   requireValue(typeof args.packageName==='string'&&PACKAGE.test(args.packageName),'应用包名无效');
   try{return await this.effect(deviceId,'launch_app',{package_name:args.packageName},{signal,timeout:Math.min(timeout,PHONE_BUDGETS.launch),controller,captureController:options=>this.capture(deviceId,{...options,mode:'tree'})});}
   catch(error){
    if(error.code!=='outcome_unknown'||error.dispatchState==='not_sent'||!error.requestId||error.deviceId!==deviceId)throw error;
    // Reconcile the original request from an actual bound foreground. This is
    // navigation evidence, not an executed native receipt and never a replay.
    let verified;try{verified=await this.reconcileNavigation(deviceId,error.requestId,{signal});}catch{throw error;}
    if(!verified.resolved||verified.outcome!=='navigation_observed')throw error;
    return textResult({navigationObserved:true,nativeOutcome:'unknown',requestId:error.requestId,resolution:verified.resolution});
   }
  }
  requireValue(native&&native.deviceId===deviceId&&typeof native.observationId==='string'&&typeof native.serviceInstanceId==='string','手机画面已过期，请重新观察','stale_observation');
  const common={observation_id:native.observationId,expected_window_id:native.windowId,service_instance_id:native.serviceInstanceId};
  let tool,fields;
  if(name==='tap'||name==='long_press'){
   // Preserve the exact verified physical point. Picking a containing parent
   // node could click a different button in a WebView or an overlapping window.
   requireValue(Number.isFinite(args.x)&&Number.isFinite(args.y),'坐标无效');
   tool=name;fields={x:args.x,y:args.y};
   if(name==='long_press'){
    const candidates=(native.elements||[]).filter(node=>node.visible===true&&node.enabled===true&&!node.password&&node.actions?.includes('long_press')&&Array.isArray(node.bounds)&&args.x>=node.bounds[0]&&args.x<node.bounds[2]&&args.y>=node.bounds[1]&&args.y<node.bounds[3]);
    requireValue(candidates.length===1,'没有唯一支持原生长按的目标，不使用坐标长按','stale_observation');fields={element_id:candidates[0].element_id};
   }
  }else if(name==='type'){
   const editors=(native.elements||[]).filter(node=>node.visible===true&&node.enabled===true&&node.focused===true&&node.editable===true&&node.password!==true&&node.actions?.includes('set_text'));
   const secret=(native.elements||[]).some(node=>node.visible===true&&node.focused===true&&node.password===true);
   if(secret)throw Object.assign(new AppError('user_only_step','密码和验证内容由用户本人输入',409),{dispatchState:'not_sent'});
   if(editors.length!==1)throw Object.assign(new AppError('phone_input_unavailable','改用无线输入服务定位当前输入框',409),{dispatchState:'not_sent'});
   requireValue(typeof args.text==='string'&&args.text.length<=4000&&['insert','replace'].includes(args.mode),'输入内容或模式无效');
   tool='input_text';fields={element_id:editors[0].element_id,text:args.text,mode:args.mode};
  }else if(name==='range_step'){
   requireValue(['forward','backward'].includes(args.direction),'调节方向无效');
   const node=(native.elements||[]).find(item=>item.element_id===args.elementId);
   requireValue(node?.visible===true&&node.enabled===true&&!node.password&&node.actions?.includes('scroll_'+args.direction)&&Array.isArray(node.range)&&node.range.length===4&&node.range.every(Number.isFinite),'滑块缺少可核实范围或原生增减能力','phone_capability_unavailable');
   tool='scroll';fields={element_id:node.element_id,direction:args.direction};
  }else if(name==='key'&&['back','home','recents'].includes(args.key)){tool=args.key;fields={};
  }else if(name==='swipe'){
   requireValue(['x1','y1','x2','y2'].every(key=>Number.isFinite(args[key])),'滑动坐标无效');
   tool='swipe';fields={points:[{x:args.x1,y:args.y1},{x:args.x2,y:args.y2}],duration_ms:args.durationMs||500};
  }else throw new AppError('invalid_action','Phone Use 不支持这个动作');
  return this.effect(deviceId,tool,{...common,...fields,...(requestId?{request_id:requestId}:{})},{signal,timeout:Math.min(timeout,PHONE_BUDGETS.action),freshObservation:true,controller,controllerFrame:native});
 }
 async close(){this.catalogs.clear();await this.client.close();}
}
