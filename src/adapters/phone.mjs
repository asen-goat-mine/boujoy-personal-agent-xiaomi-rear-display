import {ANDROID_PACKAGE,BACKGROUND_SUPPORTED} from '../distribution.mjs';
import {returnAfterCompletion} from './phone-completion-return.mjs';
import {DisplayDriver} from './display-driver.mjs';
import {validSession} from '../remote/display-commands.mjs';
import {PHONE_BUDGETS} from './phone-budgets.mjs';
import {usbDebugWarning} from './phone-overlays.mjs';
import {purchaseFlow} from './phone-purchase-flow.mjs';
import {assertExecutionPermission,withExecutionPermission} from '../core/execution-permissions.mjs';
import {classifyQueryAction,queryGrant as validateQueryGrant} from './phone-query.mjs';
import {classifyPreparationAction} from './phone-preparation.mjs';
import {generalForeground,classifyGeneralAction} from './phone-general-navigation.mjs';
import {nativeState} from './phone-purchase-navigation.mjs';
import {controllerReturnAuthority} from './phone-controller-return.mjs';
import {nativeWindowConflict} from './phone-window-identity.mjs';
import {PhoneApps,phoneAppRecord} from './phone-apps.mjs';
import {PhoneUseDriver} from './phoneuse-driver.mjs';
import {classifyPhoneUseAction,phoneUseCanObserve,phoneUseGrant,phoneUseObservationDecision} from './phone-use.mjs';
import {systemSurface,rangeControl,rangePercent} from './phone-system.mjs';
import {verifyCheckout} from '../core/checkout.mjs';
import {paymentSubmissionTarget,inspectPaymentHandoff} from '../core/payment-handoff.mjs';
import {phoneFingerprint,samePhoneTarget,sameNavigationTarget,samePhoneContext} from './phone-observation.mjs';
import {recognizePhoneImage,sameTextTarget,sameNativeTextTarget,sameText} from './phone-ocr.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { ROOT,DATA } from '../config.mjs';
import { LineRPC } from './rpc.mjs';
import { AppError, requireValue } from '../core/errors.mjs';
import { PLATFORMS } from '../core/compare.mjs';
import {commercePlatform,platformPackageMatches} from '../core/commerce-platforms.mjs';
// Screen stability is separate from reaching a requested page. OCR/native layout
// confirms actionable content; unrelated bitmap animation must not cause endless
// reads. A timed-out idle wait needs three samples instead of the normal two.
const STABILITY_BUDGET_MS=8000,STABILITY_SAMPLES=5,QUERY_OBSERVATION_BUDGET_MS=6000,FRESH_ACTION_FRAME_MS=8000;
const waitFor=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function resultData(result){
  for(const item of result?.content||[]){if(item.type==='text'){try{const parsed=JSON.parse(item.text);if(parsed.ok&&parsed.result)return parsed.result;}catch{}}}
  return null;
}
function materialText(ocr){
  if(!ocr||!Number.isFinite(ocr.width)||!Number.isFinite(ocr.height))return [];
  return (ocr.lines||[]).filter(line=>Array.isArray(line.bounds)&&line.bounds[1]>=ocr.height*.04&&line.bounds[3]<=ocr.height*.95).map(line=>({...line,text:line.text.replace(/\s+/g,'')})).sort((a,b)=>a.bounds[1]-b.bounds[1]||a.bounds[0]-b.bounds[0]);
}
function sameMaterialText(a,b){
  if(!a||!b||a.width!==b.width||a.height!==b.height)return false;
  const before=materialText(a),remaining=[...materialText(b)];
  return before.length>0&&before.length===remaining.length&&before.every(line=>{const index=remaining.findIndex(next=>line.text===next.text&&line.bounds.every((n,i)=>Math.abs(n-next.bounds[i])<=3));if(index<0)return false;remaining.splice(index,1);return true;});
}
function imageHash(image){
  const item=image?.content?.find(c=>c.type==='image'&&typeof c.data==='string'&&c.data.length);
  return item?createHash('sha256').update(item.data).digest('hex'):null;
}
function nativeBarriers(tree){
  const state=resultData(tree);return String(state?.tree||'').split('\n').filter(line=>/Dialog|PopupWindow|AlertDialog|password/i.test(line)).map(line=>line.trim()).join('\n');
}
function sameNativeScreen(a,b){
  return samePhoneContext(a,b)&&nativeBarriers(a)===nativeBarriers(b);
}
function interactionState(tree){
  return String(resultData(tree)?.tree||'').split('\n').filter(line=>/\b(?:editable|focused|checked|unchecked|selected)\b/.test(line)&&!line.includes('offscreen')).map(line=>line.trim()).sort().join('\n');
}
function sameStableFrame(a,b){
  if(!a?.aligned||!b?.aligned||!sameNativeScreen(a.tree,b.tree)||interactionState(a.tree)!==interactionState(b.tree))return false;
  const readable=materialText(a.ocr).length&&materialText(b.ocr).length;
  const sameImage=!!a.imageHash&&a.imageHash===b.imageHash;
  return readable?sameMaterialText(a.ocr,b.ocr):sameImage;
}
const SAFE_HEADER_NAV=/^(?:外卖|搜索|搜索栏|搜索框|返回|取消)$/;
function headerTargets(frame){
  const state=resultData(frame?.tree),ocr=frame?.ocr;
  if(!ocr||!state||nativeBarriers(frame.tree)||!PLATFORMS.some(profile=>platformPackageMatches(profile.id,state.windowPkg))||!String(state.foreground).includes(state.windowPkg))return [];
  const labels=materialText(ocr);
  if(labels.some(line=>/^(?:确认订单|提交订单|收银台|收货地址|选择收货地址|管理收货地址|收货信息|支付方式|支付密码|设置支付密码|安全验证|身份验证|登录|验证码|输入验证码|短信验证码|授权|同意)$/.test(line.text)))return [];
  return labels.filter(line=>line.bounds[3]<=ocr.height*.2&&SAFE_HEADER_NAV.test(line.text));
}
function stableNavigationTargets(a,b){
  if(!a?.aligned||!b?.aligned||!sameNativeScreen(a.tree,b.tree)||a.ocr?.width!==b.ocr?.width||a.ocr?.height!==b.ocr?.height)return [];
  const old=headerTargets(a);
  return headerTargets(b).filter(line=>old.some(previous=>previous.text===line.text&&previous.bounds.every((n,i)=>Math.abs(n-line.bounds[i])<=3)));
}
function busyFrame(frame){
  return materialText(frame?.ocr).some(line=>/^(?:加载中[.…]*|正在加载[.…]*|请稍[候等][.…]*|刷新中[.…]*|Loading[.…]*)$/i.test(line.text));
}
// The phone pauses Agent control for several reasons; say which one instead of
// always claiming the user took over. Only the phone itself can resume.
const PAUSE_REASONS={screen_off:'手机灭屏或锁屏后自动暂停了操作',explicit_stop:'你在手机上点了停止',explicit_takeover:'你在手机上接管了操作',notification_stop:'你从手机通知栏点了停止',new_binding:'手机刚重新连接，默认先暂停'};
export function phonePauseMessage(control){
  const why=PAUSE_REASONS[control?.reason]||(control?.reason&&control.reason!=='unspecified'?'手机端暂停了操作':'手机控制一直处于暂停状态（可能是之前留下的）');
  return `${why}，所以这次没有动手机。点亮并解锁手机后，在 Boujoy App 里点「继续」或直接从手机发这条任务，就会交还控制，无需重新配对或授权。`;
}
function returnWindowKey(native){
  const {deviceId,serviceInstanceId,windowId,packageName}=native||{};
  const win=native?.windows?.find(w=>w.display_id===(native.display?.id??0)&&w.window_id===windowId);
  if(!deviceId||!serviceInstanceId||!Number.isSafeInteger(windowId)||!packageName||win?.type!==1||
     !(win.active||win.focused)||nativeWindowConflict(native))return null;
  return JSON.stringify([deviceId,serviceInstanceId,windowId,packageName]);
}

function visibleControlStates(native){
  const controls=(native?.elements||[]).filter(node=>node.visible&&node.checkable&&!node.password&&(node.text||node.description))
    .slice(0,32).map(node=>({label:(node.text||node.description).slice(0,180),checked:node.checked,enabled:node.enabled}));
  return controls.length?{controls}:{};
}

export class Phone {
  constructor(store,{recognize=recognizePhoneImage,wait=waitFor,clock=Date.now,phoneUse=null,phoneUseFactory=()=>new PhoneUseDriver({clock})}={}){this.recognize=recognize;this.wait=wait;this.clock=clock;this.store=store;this.apps=new PhoneApps();this.phoneUseFactory=phoneUseFactory;this.phoneUseDriver=phoneUse||phoneUseFactory();this.displayUse=BACKGROUND_SUPPORTED?new DisplayDriver({clock,backend:()=>this.displayBackend||null,fallbackClient:()=>this.phoneUseDriver?.client,taskId:()=>this.lease}):null;this.bindPhoneUse();this.rpc=null;this.lease=null;this.observation=null;this.actionBaseline=null;}
  // The active native driver. In background mode the same pipeline talks to the
  // phone's own background display; the Phone Use client keeps transport/pairing.
  get phoneUse(){return this.isBackground()?this.displayUse:this.phoneUseDriver;}
  set phoneUse(driver){this.phoneUseDriver=driver;}
  isBackground(){return BACKGROUND_SUPPORTED&&this.store.data.settings?.phoneBackend==='phoneuse'&&this.store.data.settings?.phoneExecutionMode==='background';}
  bindPhoneUse(){this.phoneUseDriver.executionStore=this.store;if(this.displayUse)this.displayUse.executionStore=this.store;if(this.phoneUseDriver.client)this.phoneUseDriver.client.onTransportMetrics=row=>{if(this.lease)this.store.event?.(this.lease,'phone_transport','手机云通道耗时',row);};}
  isPhoneUse(){return this.store.data.settings?.phoneBackend==='phoneuse';}
  assertRemoteAvailable(){if(!BACKGROUND_SUPPORTED&&this.store.data.settings?.phoneExecutionMode==='background'){const error=new AppError('background_not_supported','此发行版仅支持主屏 Phone Use，请在设置中选择主屏操作。',409);error.dispatchState='not_sent';throw error;}if(this.remoteMaintenance){const error=new AppError('remote_connection_maintenance','远程连接正在维护或恢复，手机操作已暂停；不会回退到局域网连接。',503);error.dispatchState='not_sent';throw error;}}
  assertRemoteDataAvailable(){
    this.assertRemoteAvailable();
    if(this.isPhoneUse()&&this.phoneUse.client?.remoteTransport&&this.remoteControlState?.()?.paused===true){
      const error=new AppError('phone_control_paused',phonePauseMessage(this.remoteControlState?.()),409);error.dispatchState='not_sent';throw error;
    }
  }
  phoneUseDevice(){
    this.assertRemoteDataAvailable();
    if(!this.store.data.settings.phoneEnabled)throw new AppError('phone_not_connected','手机接入尚未启用；可先处理电脑任务。',503);
    const id=this.store.data.settings.phoneUseDeviceId;requireValue(typeof id==='string'&&id.length>0,'请先在手机设置中完成 Phone Use 配对','phone_not_connected');return id;
  }
  async withinBudget(run,{signal,deadline}){
    if(signal?.aborted)throw new AppError('cancelled','任务已停止',409);
    const remaining=deadline-this.clock();if(remaining<=0)throw new AppError('screen_unstable','手机画面尚未稳定，请重新观察',409);
    let timer,onAbort;const stop=new Promise((_,reject)=>{timer=setTimeout(()=>reject(new AppError('screen_unstable','手机画面尚未稳定，请重新观察',409)),remaining);if(signal){onAbort=()=>reject(new AppError('cancelled','任务已停止',409));signal.addEventListener('abort',onAbort,{once:true});}});
    try{return await Promise.race([Promise.resolve().then(run),stop]);}finally{clearTimeout(timer);if(onAbort)signal.removeEventListener('abort',onAbort);}
  }
  async captureStableFrame(taskId,options){
    this.assertRemoteAvailable();
    if(this.isPhoneUse()){
      const initial=options.initialCapture,age=this.clock()-initial?.at;
      const t0=this.clock(),reused=initial&&Number.isFinite(age)&&age>=0&&age<=5000;
      const frame=reused?initial:await this.withinBudget(()=>this.phoneUse.capture(this.phoneUseDevice(),{signal:options.signal,timeout:Math.max(1,options.deadline-this.clock()),screenshotFallback:options.screenshotFallback===true}),options);
      const t1=this.clock();
      const ocr=await this.withinBudget(()=>this.phoneUse.recognize(frame.image,frame.mapping,this.recognize),options);
      // Per-read timing (no page content): phone read incl. transport and retries, then local OCR.
      const timing={captureMs:reused?0:t1-t0,ocrMs:this.clock()-t1,...(Number.isSafeInteger(frame.readAttempts)?{readAttempts:frame.readAttempts}:{}),...(frame.native?.display?.id>0?{backend:'display'}:{})};
      return {taskId,timing,at:this.clock(),tree:frame.tree,image:frame.image,mapping:frame.mapping||null,ocr,native:frame.native||null,hash:frame.screenshotOnly?imageHash(frame.image):phoneFingerprint(frame.tree),imageHash:imageHash(frame.image),screenshotOnly:frame.screenshotOnly===true,windowFailure:frame.windowFailure,aligned:true};
    }
    const read=(name,args)=>this.withinBudget(()=>this.call(name,args,Math.max(1,options.deadline-this.clock())),options);
    // Read-only RPCs can overlap. The next sample and pre-action fresh guard
    // recheck native context; an ad's tree mutations are not page transitions.
    const [tree,image]=await Promise.all([read('ui_tree',{display:'main'}),read('screenshot',{display:'main'})]);
    const ocr=await this.withinBudget(()=>this.recognize(image),options);
    return {taskId,at:this.clock(),tree,image,ocr,hash:phoneFingerprint(tree),imageHash:imageHash(image),aligned:true};
  }
  observationResult(frame,{taskId,meta={},actionable=true}={}){
    assertExecutionPermission(this.store,'phone');
    if(frame?.timing&&!meta.timing)meta={...meta,timing:frame.timing};
    const id=actionable?'screen-'+randomUUID().slice(0,8):undefined,connectorTelemetry=this.remoteDeviceTelemetry?.()??null;
    if(actionable)this.observation={id,taskId,connectorTelemetry,screenshotOnly:frame.screenshotOnly===true,at:this.clock(),mapping:frame.mapping||null,native:frame.native||null,hash:frame.hash,tree:frame.tree,ocr:frame.ocr,imageHash:frame.imageHash,aligned:true,stability:meta.stability,stabilityScope:meta.stabilityScope,stableTargetIds:meta.stableTargetIds||[],queryGrant:frame.queryGrant?{...frame.queryGrant}:null,phoneUseGrant:frame.phoneUseGrant?{...frame.phoneUseGrant}:null,stabilityMeta:{...meta}};
    else this.observation=null;
    const session=frame?.native?.displaySession;
    const background=this.isBackground(),bound=background&&validSession(session)&&frame?.native?.display?.id===session.displayId;
    const displayContext=background?{display:'background',backend:'display',displayId:bound?session.displayId:null,displaySession:bound?{sessionId:session.sessionId,generation:session.generation,displayId:session.displayId}:null}:{display:'main'};
    return {meta,content:[{type:'text',text:JSON.stringify({...(id?{observationId:id,...(meta.stabilityScope==='general'?visibleControlStates(frame?.native):{})}:{}),connectorTelemetry,...displayContext,untrustedContent:true,coordinateSpace:'physical pixels; use textTargetId for recognized labels, never rescale from a preview',pointTap:'没有文字的位置（输入框、图标、×）可用 tap 的 x,y：截图上的相对位置，0–1000，左上角 0,0、右下角 1000,1000',screenSize:frame?.ocr?{width:frame.ocr.width,height:frame.ocr.height}:null,textTargets:actionable?(meta.stabilityScope==='navigation'?(frame?.ocr?.lines||[]).filter(line=>meta.stableTargetIds.includes(line.id)):frame?.ocr?.lines||[]):[],...meta})},...(frame?.tree?.content||[]),...(frame?.image?.content||[])]};
  }
  async observeStable(taskId,{signal,afterAction=false}={}){
    this.acquire(taskId);const baseline=afterAction?this.actionBaseline:null;
    const cache=this.observation;const previousFull=!afterAction&&cache?.taskId===taskId&&cache.stability==='stable'&&cache.stabilityScope==='full'&&this.clock()-cache.at>=0&&this.clock()-cache.at<=15000?cache:null;
    this.actionBaseline=null;this.observation=null;
    const started=this.clock(),deadline=started+(this.isPhoneUse()&&this.phoneUse.client?.remoteTransport?16000:STABILITY_BUDGET_MS),options={signal,deadline};let idle=null,previous=previousFull,last=null,consecutive=previousFull?1:0,attempts=0,reason='screen_changing',failureCode=null;
    try{
      if(afterAction&&!this.isPhoneUse()){const result=await this.withinBudget(()=>this.settle(Math.min(1200,deadline-this.clock())),options);idle=resultData(result)?.settled===true;}
      const needed=idle===false?3:2;
      for(;attempts<STABILITY_SAMPLES;){
        if(previous&&attempts)await this.withinBudget(()=>this.wait(idle===false?260:160),options);
        last=await this.captureStableFrame(taskId,options);attempts++;
        const busy=busyFrame(last);consecutive=!busy&&last.aligned?(sameStableFrame(previous,last)?consecutive+1:1):0;
        reason=busy?'screen_loading':last.aligned?'screen_changing':'capture_changed';
        if(consecutive>=needed){
          const unchanged=!!baseline&&sameStableFrame({...baseline,aligned:true},last);
          const meta={stability:unchanged?'uncertain':'stable',stabilityScope:'full',attempts,elapsedMs:this.clock()-started,...(idle!==null?{idleSettled:idle}:{}),...(baseline?{changedSinceAction:!unchanged}:{}),...(unchanged?{reason:'action_screen_unchanged',requiresFreshObservation:true}:{})};
          return this.observationResult(last,{taskId,meta,actionable:!unchanged});
        }
        // A moving advertisement can keep the entire page changing forever.
        // Only repeatedly observed header navigation can proceed in this case;
        // product, transaction and arbitrary coordinate targets remain blocked.
        const navigation=!busy&&last.aligned?stableNavigationTargets(previous,last):[];
        if(navigation.length){
          const meta={stability:'stable',stabilityScope:'navigation',stableTargetIds:navigation.map(line=>line.id),attempts,elapsedMs:this.clock()-started,...(idle!==null?{idleSettled:idle}:{}),requiresFullObservationFor:'products,quotes,cart,checkout',...(baseline?{changedSinceAction:!sameStableFrame({...baseline,aligned:true},last)}:{})};
          return this.observationResult(last,{taskId,meta});
        }
        previous=last;
      }
    }catch(error){if(['cancelled','phone_control_paused'].includes(error.code))throw error;reason=error.code==='screen_unstable'?'stability_timeout':'observation_failed';failureCode=/^[A-Za-z0-9_]{1,80}$/.test(error.phoneuseCode||error.code||'')?(error.phoneuseCode||error.code):'observation_failed';}
    const meta={stability:'uncertain',attempts,elapsedMs:this.clock()-started,reason,...(failureCode?{failureCode}:{}),...(idle!==null?{idleSettled:idle}:{}),requiresFreshObservation:true};
    return this.observationResult(last,{taskId,meta,actionable:false});
  }
  async observeAfterAction(taskId,{signal}={}){return this.observeStable(taskId,{signal,afterAction:true});}
  async observeQuery(taskId,inputGrant,{signal,afterAction=false}={}){
    // A query observation is fresh, not a full-page/price/checkout verification.
    // Its permission comes only from the caller's authenticated task grant.
    const grant=validateQueryGrant(inputGrant);requireValue(grant,'本任务尚未授权手机查询','query_scope_changed');
    this.acquire(taskId);const baseline=afterAction?this.actionBaseline:null;this.actionBaseline=null;this.observation=null;
    const started=this.clock(),options={signal,deadline:started+(this.isPhoneUse()&&this.phoneUse.client?.remoteTransport?12000:QUERY_OBSERVATION_BUDGET_MS)};let last=null,attempts=0,reason='query_observation_failed',failureCode=null;
    try{
      for(let attempt=0;attempt<2;attempt++){
        if(attempt)await this.withinBudget(()=>this.wait(160),options);
        last=await this.captureStableFrame(taskId,options);attempts++;
        const candidate={...last,id:'query-surface',taskId,at:this.clock()},scope=!nativeBarriers(last.tree)&&materialText(last.ocr).length&&classifyQueryAction(taskId,{observationId:candidate.id,action:'back'},candidate,grant);
        if(!scope){reason='query_scope_changed';last=null;break;}
        if(busyFrame(last)){reason='screen_loading';continue;}
        const unchanged=!!baseline&&sameStableFrame({...baseline,aligned:true},last);
        if(unchanged){reason='action_screen_unchanged';continue;}
        last.queryGrant={...grant};
        const meta={stability:'fresh',stabilityScope:'query',queryActionsOnly:true,attempts,elapsedMs:this.clock()-started,requiresFullObservationFor:'quotes,cart,checkout',...(baseline?{changedSinceAction:true}:{})};
        if(signal?.aborted)throw new AppError('cancelled','任务已停止',409);
        return this.observationResult(last,{taskId,meta});
      }
    }catch(error){if(error.code==='cancelled')throw error;reason=error.code==='screen_unstable'?'query_observation_timeout':'query_observation_failed';failureCode=/^[A-Za-z0-9_]{1,80}$/.test(error.phoneuseCode||error.code||'')?(error.phoneuseCode||error.code):'observation_failed';}
    // Do not forward checkout/account/foreign app content under a query grant.
    if(signal?.aborted)throw new AppError('cancelled','任务已停止',409);
    const meta={stability:'uncertain',stabilityScope:'query',queryActionsOnly:true,attempts,elapsedMs:this.clock()-started,reason,...(failureCode?{failureCode}:{}),requiresFreshObservation:true};
    this.store.event?.(taskId,'phone_read_unavailable','商品查询页面尚不可用',{reason,failureCode,attempts,elapsedMs:this.clock()-started,transport:this.isPhoneUse()&&this.phoneUse.client?.remoteTransport?'cloud_relay':'local'});
    return this.observationResult(last,{taskId,meta,actionable:false});
  }
  rememberReturnWindow(taskId,grant,key){
    const returnWindow={key,at:this.clock()};
    this.returnWindows??=new Map();this.returnWindows.set(grant.packageName,returnWindow);
    if(this.returnWindows.size>32)this.returnWindows.delete(this.returnWindows.keys().next().value);
    this.store.updateTask?.(taskId,t=>{if(t.phoneUseScope?.mode==='general'&&t.phoneUseScope.packageName===grant.packageName)t.phoneUseScope.returnWindow=returnWindow;});
  }
  async observeGeneral(taskId,grant,{signal,afterAction=false,initialCapture=null}={}){
    // Return one current frame for the model to interpret. Reading never taps
    // a foreign dialog or launches an app behind the action ledger.
    requireValue(grant?.mode==='general'&&grant.taskId===taskId,'本任务尚未授权操作这个应用','phone_use_scope_changed');
    this.acquire(taskId);const baseline=afterAction?this.actionBaseline:null;this.actionBaseline=null;this.observation=null;
    const started=this.clock(),options={signal,screenshotFallback:true,initialCapture:afterAction?null:initialCapture,deadline:started+(this.isPhoneUse()&&this.phoneUse.client?.remoteTransport?12000:QUERY_OBSERVATION_BUDGET_MS)};let last=null,attempts=0,reason='general_observation_failed',failureCode=null,foreground=null;
    try{
        last=await this.captureStableFrame(taskId,options);attempts++;
        foreground=generalForeground(last);
        const client=this.phoneUse?.client;
        const confined=client?.controllerNavigation?.taskId===taskId||this.store.data.tasks?.find(row=>row.id===taskId)?.events?.some(event=>event.type==='phone_controller_return');
        const contradicted=confined&&nativeWindowConflict(last.native);
        client?.limitControllerNavigation?.(taskId,contradicted?null:foreground,last.native?.serviceInstanceId);
        if(confined&&client?.controllerNavigation?.taskId!==taskId){
          return this.observationResult(null,{taskId,meta:{stability:'uncertain',stabilityScope:'general',reason:'controller_context_changed',requiresFreshObservation:true},actionable:false});
        }
        // The task's own tap may open a related app (Settings → Device Care, a
        // share sheet, a mini-program). Follow it instead of yanking the user back;
        // the home screen and Boujoy itself are not followed. Payment and
        // verification screens are still handed to the user by the caller.
        const key=returnWindowKey(last.native);
        if(afterAction&&!baseline?.returnOnly&&baseline?.native?.deviceId===last.native?.deviceId&&baseline?.native?.serviceInstanceId===last.native?.serviceInstanceId&&baseline?.native?.packageName===grant.packageName&&foreground!==grant.packageName&&key){
          this.rememberReturnWindow(taskId,grant,key);
        }
        if(afterAction&&!baseline?.returnOnly&&foreground&&foreground!==grant.packageName&&!(grant.followedPackages||[]).includes(foreground)&&!/launcher/i.test(foreground)&&foreground!==ANDROID_PACKAGE){
          grant.followedPackages=[...new Set([...(grant.followedPackages||[]),foreground])].slice(-6);
          this.store.updateTask?.(taskId,t=>{if(t.phoneUseScope?.mode==='general'&&t.phoneUseScope.packageName===grant.packageName)t.phoneUseScope.followedPackages=grant.followedPackages;});
          this.store.event?.(taskId,'phone_recovery','跟随进入关联应用',{recovery:'follow_app',packageName:foreground});
        }
        if(grant.decisionOwner==='harness'&&foreground){grant.followedPackages=[...new Set([...(grant.followedPackages||[]),foreground])];}
        if(foreground!==grant.packageName&&!(grant.followedPackages||[]).includes(foreground)){
          reason='outside_task_scope';
          const prior=this.returnWindows?.get(grant.packageName)||this.store.data.tasks?.findLast(t=>t.phoneUseScope?.packageName===grant.packageName&&t.phoneUseScope.returnWindow?.key===key)?.phoneUseScope.returnWindow;
          const task=this.store.task?.(taskId),user=task?.messages?.findLast(m=>m.role==='user'&&!m.externalContent&&!m.external_content&&!m.interjection);
          const named=task&&!task.parentId&&(task.source||'user')==='user'&&user?.content?.match(/[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+/g)?.includes(foreground);
          const namedVisited=named&&this.store.data.tasks?.some(t=>t.phoneUseScope?.packageName===grant.packageName&&t.phoneUseScope.followedPackages?.includes(foreground));
          if(key&&!nativeBarriers(last.tree)&&((prior?.key===key&&this.clock()>=prior.at&&this.clock()-prior.at<1800000)||namedVisited)){
            if(namedVisited)this.rememberReturnWindow(taskId,grant,key);
            // Only supply a bound Back action. Neither the auxiliary window's text
            // nor its picture is exposed under the parent's grant.
            const native={...last.native,elements:[]};
            const result=this.observationResult({at:last.at,native,tree:null,ocr:null,image:null},{taskId,meta:{stability:'fresh',stabilityScope:'general',returnOnly:true,permittedActions:['back'],recovery:'仍在已核实的子窗口，文字和图片未提供，不代表页面空白。可以继续返回，每次按返回后的新观察确认是否回到目标应用。'}});
            this.observation.returnOnly=true;
            return result;
          }
          last=null;
        }
        if(last){
        const unchanged=!!baseline&&sameStableFrame({...baseline,aligned:true},last);
        last.generalGrant={...grant};
        if(signal?.aborted)throw new AppError('cancelled','任务已停止',409);
        return this.observationResult(last,{taskId,meta:{stability:'fresh',stabilityScope:'general',app:grant.appName,foregroundPackage:foreground,...(last.screenshotOnly?{observationMode:'screenshot_ocr',windowFailure:last.windowFailure,recovery:'原生窗口读取失败，已返回本次截图和 OCR。根据截图判断是否需要返回或关闭弹层，不要机械重读；付款、验证码及未知动作仍须停下核实。'}:{}),screenLoading:busyFrame(last),attempts,elapsedMs:this.clock()-started,...(baseline?{changedSinceAction:!unchanged}:{})}});
        }
    }catch(error){if(['cancelled','phone_control_paused','execution_disabled','execution_revoked','outcome_unknown','outcome_pending'].includes(error.code)||['PAIRING_REVOKED','ACCESSIBILITY_UNAVAILABLE','DEVICE_MISMATCH','SERVICE_INSTANCE_MISMATCH'].includes(error.phoneuseCode))throw error;reason=error.code==='screen_unstable'?'general_observation_timeout':'general_observation_failed';failureCode=/^[A-Za-z0-9_]{1,80}$/.test(error.phoneuseCode||error.code||'')?(error.phoneuseCode||error.code):'observation_failed';}
    if(signal?.aborted)throw new AppError('cancelled','任务已停止',409);
    this.store.event?.(taskId,'phone_read_unavailable','当前手机页面尚不可用',{reason,failureCode,attempts,elapsedMs:this.clock()-started,...(foreground?{foregroundPackage:foreground}: {})});
    return this.observationResult(null,{taskId,meta:{stability:'uncertain',stabilityScope:'general',reason,...(foreground?{foregroundPackage:foreground}:{}),...(failureCode?{failureCode,recovery:'未获得可靠窗口身份，当前画面和是否存在弹窗均未核实。'}:{}),...(reason==='outside_task_scope'?{recovery:`前台不是${grant.appName}；用 phone_use open_app 重新打开${grant.appName}后继续。`}:{}),attempts,elapsedMs:this.clock()-started,requiresFreshObservation:true},actionable:false});
  }
  async observePurchase(taskId,grant,{signal,afterAction=false}={}){
    requireValue(grant?.taskId===taskId&&grant.goal==='checkout'&&grant.payment==='user','本任务没有购买准备范围','preparation_scope_changed');
    this.acquire(taskId);this.observation=null;this.actionBaseline=null;
    const started=this.clock(),options={signal,deadline:started+(this.phoneUse.client?.remoteTransport?12000:QUERY_OBSERVATION_BUDGET_MS)};
    let last=null,failureCode=null,reason='purchase_observation_failed';
    try{
      for(let attempt=0;attempt<2;attempt++){
        if(attempt)await this.withinBudget(()=>this.wait(160),options);
        last=await this.captureStableFrame(taskId,options);
        const state=nativeState(last);
        if(state?.display==='main'&&usbDebugWarning(last.ocr))return this.observationResult(last,{taskId,meta:{stability:'fresh',stabilityScope:'purchase',systemOverlay:'samsung_usb_notice',permittedActions:['back'],recovery:'使用 phone_use(action=back) 关闭当前支付安全提示；不要点击关闭或变更USB调试设置。',attempts:attempt+1,elapsedMs:this.clock()-started}});
        if(state?.display!=='main'||!platformPackageMatches(grant.platform,state.windowPkg)||!(state.foreground===state.windowPkg||state.foreground?.startsWith(state.windowPkg+'/'))){reason='outside_task_scope';last=null;break;}
        if(busyFrame(last)){reason='screen_loading';continue;}
        if(signal?.aborted)throw new AppError('cancelled','任务已停止',409);
        return this.observationResult(last,{taskId,meta:{stability:'fresh',stabilityScope:'purchase',purchaseFlow:purchaseFlow(last.ocr),attempts:attempt+1,elapsedMs:this.clock()-started,requiresFullObservationFor:'quotes,checkout',purchaseBrowsingOnly:true}});
      }
    }catch(error){if(['cancelled','phone_control_paused'].includes(error.code))throw error;failureCode=/^[A-Za-z0-9_]{1,80}$/.test(error.phoneuseCode||error.code||'')?(error.phoneuseCode||error.code):'observation_failed';}
    this.store.event?.(taskId,'phone_read_unavailable','购买准备页面尚不可用',{reason,failureCode,elapsedMs:this.clock()-started});
    return this.observationResult(null,{taskId,meta:{stability:'uncertain',stabilityScope:'purchase',reason,...(failureCode?{failureCode}:{}),...(reason==='outside_task_scope'?{recovery:'前台已离开本次购物应用；重新打开本次平台后观察。未知的打开请求先核实，不重复发送。'}:{}),requiresFreshObservation:true},actionable:false});
  }
  async observeQueryAfterAction(taskId,grant,{signal}={}){return this.observeQuery(taskId,grant,{signal,afterAction:true});}
  async listApps(query,options){this.assertRemoteAvailable();if(!this.isPhoneUse())return this.apps.list(query);const deviceId=this.phoneUseDevice(),result=await this.phoneUse.listApps(deviceId,query,options),catalog=this.phoneUse.catalogs?.get(deviceId);if(catalog?.apps?.length)await this.apps.save?.({version:1,observedAt:new Date(catalog.at).toISOString(),deviceId,source:'cloud_relay',packages:catalog.apps.map(app=>app.packageName)});return result;}
  async resolveApp(packageName){this.assertRemoteAvailable();return this.isPhoneUse()?this.phoneUse.resolveApp(this.phoneUseDevice(),packageName):this.apps.resolve(packageName);}
  async openPackage(taskId,packageName,{signal}={}){
    requireValue(/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(packageName),'应用包名无效');
    this.acquire(taskId);this.phoneUse?.client?.limitControllerNavigation?.(taskId,packageName);this.observation=null;this.actionBaseline=null;
    return this.call('open_app',{packageName,display:'main'},45000,{signal,effect:true,controllerOperation:'launch'});
  }
  async captureForOpen(taskId,{signal}={}){
    if(!this.isPhoneUse())return null;
    this.acquire(taskId);
    const frame=await this.phoneUse.capture(this.phoneUseDevice(),{signal,timeout:this.isBackground()?6000:this.phoneUse.client?.remoteTransport?12000:6000,screenshotFallback:true});
    // A rejected native tree may still leave a real, identity-bound screenshot.
    // Require its independently checked window before using it to decide a launch.
    if(frame.screenshotOnly)requireValue(nativeState(frame),'Phone Use 缺少可靠截图窗口身份','phoneuse_invalid_observation');
    return frame;
  }
  async observeUse(taskId,grant,{signal,afterAction=false,initialCapture=null}={}){
    this.acquire(taskId);const baseline=afterAction?this.actionBaseline:null;this.actionBaseline=null;this.observation=null;
    const budget=this.isPhoneUse()&&this.phoneUse.client?.remoteTransport?12000:QUERY_OBSERVATION_BUDGET_MS;
    const started=this.clock(),options={signal,deadline:started+budget};let last=null,reason='phone_use_scope_changed',failureCode=null,attempts=0,scope={};
    const checkScope=tree=>{const decision=phoneUseObservationDecision(taskId,tree,grant);if(!decision.allowed){const {allowed,...details}=decision;reason=details.reason;scope=details;}return decision.allowed;};
    try{
      for(let attempt=0;attempt<2;attempt++){
        if(attempt)await this.withinBudget(()=>this.wait(160),options);
        let tree,image,ocr,native=null;
        if(this.isPhoneUse()){
          // Native Phone Use returns one atomic, identity-bound tree+image.
          // Inspect its package/surface locally before OCR or any model output;
          // a rejected frame is never persisted or exposed as task content.
          const supplied=attempt===0&&initialCapture&&Number.isFinite(initialCapture.at)&&this.clock()-initialCapture.at>=0&&this.clock()-initialCapture.at<=5000?initialCapture:null;
          const capture=supplied||await this.withinBudget(()=>this.phoneUse.capture(this.phoneUseDevice(),{signal,timeout:Math.max(1,options.deadline-this.clock())}),options);
          tree=capture.tree;native=capture.native||null;if(!checkScope(tree))break;
          image=capture.image;ocr=await this.withinBudget(()=>this.phoneUse.recognize(image,capture.mapping,this.recognize),options);
        }else{
          tree=await this.withinBudget(()=>this.call('ui_tree',{display:'main'},Math.max(1,options.deadline-this.clock()),{signal}),options);
          if(!checkScope(tree))break;
          image=await this.withinBudget(()=>this.call('screenshot',{display:'main'}),options);
          ocr=await this.withinBudget(()=>this.recognize(image),options);
        }
        attempts++;
        const frame={taskId,at:this.clock(),tree,image,ocr,native,hash:phoneFingerprint(tree),imageHash:imageHash(image),aligned:true,phoneUseGrant:{...grant}};
        const candidate={...frame,id:'scope-probe',stability:'fresh',stabilityScope:'phone_use'};
        if(!classifyPhoneUseAction(taskId,{observationId:candidate.id,action:'back'},candidate,grant)){reason='phone_use_scope_changed';break;}
        last=frame;if(busyFrame(frame)){reason='screen_loading';continue;}
        if(baseline&&sameStableFrame({...baseline,aligned:true},frame)){reason='action_screen_unchanged';continue;}
        if(signal?.aborted)throw new AppError('cancelled','任务已停止',409);
        return this.observationResult(frame,{taskId,meta:{stability:'fresh',stabilityScope:'phone_use',readNavigationOnly:grant.mode!=='task_effects',attempts,elapsedMs:this.clock()-started,...(baseline?{changedSinceAction:true}:{})}});
      }
    }catch(error){if(error.code==='cancelled')throw error;failureCode=/^[A-Za-z0-9_]{1,80}$/.test(error.phoneuseCode||error.code||'')?(error.phoneuseCode||error.code):'observation_failed';reason=error.code==='screen_unstable'?'observation_timeout':'phone_use_observation_failed';}
    if(signal?.aborted)throw new AppError('cancelled','任务已停止',409);
    this.store.event?.(taskId,'phone_read_unavailable','当前手机页面尚不可用',{...scope,reason,failureCode,attempts,elapsedMs:this.clock()-started,transport:this.isPhoneUse()&&this.phoneUse.client?.remoteTransport?'cloud_relay':'local'});
    return this.observationResult(null,{taskId,meta:{stability:'uncertain',stabilityScope:'phone_use',...scope,reason,...(failureCode?{failureCode}:{}),recovery:reason==='assistant_chat_foreground'?'聊天界面不影响连接；重新打开任务目标 App 后继续读取。':reason==='outside_task_scope'?'请使用已安装应用目录打开任务目标 App；不要猜图标或读取其他应用。':reason==='foreign_window_overlay'?'其他应用窗口覆盖了目标页面，待覆盖窗口消失后重新观察。':undefined,attempts,elapsedMs:this.clock()-started,requiresFreshObservation:true},actionable:false});
  }
  async start(){
    this.assertRemoteAvailable();
    if(!this.store.data.settings.phoneEnabled)throw new AppError('phone_not_connected','手机接入尚未启用；可先处理电脑任务。',503);
    if(this.isPhoneUse()){this.phoneUseDevice();return this.phoneUse.client.start();}
    if(this.rpc&&!this.rpc.dead)return this.rpc;
    if(this.starting)return this.starting;
    this.starting=(async()=>{
      const entry=path.join(ROOT,'vendor/pony/packages/mcp/dist/cli.js');requireValue(fs.existsSync(entry),'手机执行组件未构建');
      const relay=this.store.data.settings.ponyRelay;
      if(relay==='http://127.0.0.1:18792'&&!this.relay){
        this.relay=spawn(process.execPath,['--import',path.join(ROOT,'vendor/pony/node_modules/tsx/dist/loader.mjs'),path.join(ROOT,'vendor/pony/relay/src/index.ts')],{cwd:ROOT,env:{PATH:process.env.PATH,HOME:process.env.HOME,HOST:'127.0.0.1',PORT:'18792'},stdio:'ignore'});this.relay.on('error',()=>{this.relay=null;});this.relay.on('exit',()=>{this.relay=null;});
        let ready=false;for(let n=0;n<30;n++){try{await fetch(relay,{signal:AbortSignal.timeout(500)});ready=true;break;}catch{await new Promise(r=>setTimeout(r,100));}}requireValue(ready,'手机私有中继启动失败');
      }
      this.rpc=new LineRPC(process.execPath,[entry,'--listen','--relay',relay,'--client','Boujoy Personal Agent','--state',path.join(DATA,'phone/pairing.json')],{env:{PATH:process.env.PATH,HOME:process.env.HOME},cwd:ROOT});
      await this.rpc.request('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'boujoy',version:'0.1.0'}});this.rpc.notify('notifications/initialized');return this.rpc;
    })();try{return await this.starting;}finally{this.starting=null;}
  }
  async call(name,args={},timeout=PHONE_BUDGETS.call,{signal,effect=false,native,controllerOperation}={}){return withExecutionPermission(this.store,['phone'],this.lease,async()=>{this.assertRemoteAvailable();if(effect&&signal?.aborted)throw new AppError('action_cancelled','任务已停止，动作未发送到手机',409);if(this.isPhoneUse()){const deviceId=this.phoneUseDevice();const controller=controllerOperation?controllerReturnAuthority(this,deviceId,controllerOperation,args.packageName||native?.packageName,signal):null;return this.phoneUse.call(deviceId,name,args,timeout,{signal,native,controller});}const rpc=await this.start();if(effect&&signal?.aborted)throw new AppError('action_cancelled','任务已停止，动作未发送到手机',409);assertExecutionPermission(this.store,'phone');const out=await rpc.request('tools/call',{name,arguments:args},timeout);if(out.isError)throw new AppError('phone_error',out.content?.filter(c=>c.type==='text').map(c=>c.text).join('\n')||'手机操作未完成',409);return out;});}
  async status(){this.assertRemoteAvailable();const connectorTelemetry=this.remoteDeviceTelemetry?.()??null;if(!this.store.data.settings.phoneEnabled)return {enabled:false,connected:false,device:'Android',...(this.isBackground()?{backend:'display'}:{}),connectorTelemetry};try{if(this.isPhoneUse())return {...await this.phoneUse.status(this.store.data.settings.phoneUseDeviceId,{paused:this.remoteControlState?.()?.paused===true}),connectorTelemetry};const result=await this.call('status');return {enabled:true,result,connectorTelemetry};}catch(e){return {enabled:true,connected:false,reason:e.message,...(this.isBackground()?{backend:'display'}:{}),connectorTelemetry};}}
  async capabilities(){this.assertRemoteAvailable();if(this.isPhoneUse())return this.phoneUse.capabilities(this.phoneUseDevice());return {backend:'pony',semanticActions:['open_app','read','search','tap','type','scroll','back'],requiresTaskContract:true,protectedInput:'user_only'};}
  async systemNavigate(taskId,action,{signal}={}){
    // Home and recents act on the main screen, which belongs to the user in background mode.
    if(this.isBackground())throw Object.assign(new AppError('phone_capability_unavailable','后台显示执行不使用主页和最近任务，以免影响你正在用的主屏；请直接打开目标应用。',409),{dispatchState:'not_sent'});
    requireValue(this.isPhoneUse()&&['home','recents'].includes(action),'当前执行端不支持此系统导航','phone_capability_unavailable');this.acquire(taskId);
    let phase='not_sent';try{
    const before=await this.phoneUse.capture(this.phoneUseDevice(),{mode:'tree',signal,timeout:6000});
    this.observation=null;this.actionBaseline=null;
    phase='unknown';
    await this.phoneUse.call(this.phoneUseDevice(),'key',{key:action},PHONE_BUDGETS.action,{signal,native:before.native});
    phase='executed';
    const after=await this.phoneUse.capture(this.phoneUseDevice(),{mode:'tree',signal,timeout:6000});
    const same=after.native.deviceId===before.native.deviceId&&after.native.serviceInstanceId===before.native.serviceInstanceId;
    return {observationId:'system-'+randomUUID(),taskId,action,verified:same&&systemSurface(after.native,action),observedAt:after.at,deviceId:after.native.deviceId,serviceInstanceId:after.native.serviceInstanceId,packageName:after.native.packageName,nativeObservationId:after.native.observationId,reason:same?'native_surface_check':'service_changed',untrustedContent:true};
    }catch(error){error.dispatchState=phase;throw error;}
  }
  async setRangeValue(taskId,{field,value},{signal}={}){
    requireValue(this.isPhoneUse()&&['brightness','volume'].includes(field)&&Number.isInteger(value)&&value>=0&&value<=100,'当前执行端不支持此数值设置','phone_capability_unavailable');this.acquire(taskId);
    this.observation=null;this.actionBaseline=null;const deviceId=this.phoneUseDevice(),deadline=this.clock()+10000;
    let steps=0;try{let frame=await this.phoneUse.capture(deviceId,{mode:'tree',signal,timeout:Math.max(1,deadline-this.clock())}),node=rangeControl(frame.native,field);
    requireValue(node&&frame.native.packageName==='com.android.settings','设置页没有唯一且可读取真实范围的滑块','phone_capability_unavailable');
    const instance=frame.native.serviceInstanceId,window=frame.native.windowId,range=node.range.slice(0,3),original=rangePercent(node);
    while(rangePercent(node)!==value&&steps<12&&this.clock()<deadline){
      const before=rangePercent(node),direction=before<value?'forward':'backward';
      requireValue(node.actions.includes('scroll_'+direction),'此滑块不提供原生逐级调节，不能使用坐标猜百分比','phone_capability_unavailable');
      await this.phoneUse.call(deviceId,'range_step',{elementId:node.element_id,direction},Math.max(1,deadline-this.clock()),{signal,native:frame.native});steps++;
      frame=await this.phoneUse.capture(deviceId,{mode:'tree',signal,timeout:Math.max(1,deadline-this.clock())});const fresh=rangeControl(frame.native,field);
      requireValue(frame.native.serviceInstanceId===instance&&frame.native.windowId===window&&frame.native.packageName==='com.android.settings'&&fresh&&JSON.stringify(fresh.range.slice(0,3))===JSON.stringify(range),'数值设置现场已变化，停止后续调节','phone_range_changed');
      const after=rangePercent(fresh);node=fresh;
      if(after===before||direction==='forward'&&(after<before||after>value)||direction==='backward'&&(after>before||after<value))break;
    }
    return {observationId:'range-'+randomUUID(),taskId,action:'set_value',field,target:value,actual:rangePercent(node),original,steps,verified:rangePercent(node)===value,observedAt:frame.at,deviceId,serviceInstanceId:instance,nativeObservationId:frame.native.observationId,range:node.range,untrustedContent:true};
    }catch(error){error.executedSteps=steps;throw error;}
  }
  async preparePayment(taskId,{plan,claimed,onDispatch,requestId},{signal}={}){
    requireValue(this.isPhoneUse(),'进入付款页需要可核实的原生执行端','phone_capability_unavailable');this.acquire(taskId);
    const old=this.observation;verifyCheckout({observation:old,taskId,evidence:[old?.id],plan,claimed});
    const frame=await this.phoneUse.capture(this.phoneUseDevice(),{mode:'both',signal,timeout:6000});
    requireValue(frame.native?.treePartial!==true,'结算页仍在变化，尚未提交订单','checkout_changed');
    const ocr=await this.phoneUse.recognize(frame.image,frame.mapping,this.recognize);
    const fresh={...old,at:this.clock(),tree:frame.tree,ocr,hash:phoneFingerprint(frame.tree),imageHash:imageHash(frame.image),aligned:true};
    requireValue(sameStableFrame(old,fresh),'结算页面发生变化，尚未提交订单','checkout_changed');
    const facts=verifyCheckout({observation:fresh,taskId,evidence:[old.id],plan,claimed}),target=paymentSubmissionTarget({native:frame.native,ocr,facts});
    if(signal?.aborted)throw new AppError('action_cancelled','任务已停止，尚未提交订单',409);
    this.observation=null;this.actionBaseline=null;let dispatched=false,executed=false;
    try{
      await onDispatch?.({nativeObservationId:frame.native.observationId,deviceId:frame.native.deviceId,serviceInstanceId:frame.native.serviceInstanceId,facts});dispatched=true;
      await this.phoneUse.call(this.phoneUseDevice(),'tap',{x:target.x,y:target.y},PHONE_BUDGETS.action,{signal,native:frame.native,requestId});executed=true;
      const after=await this.phoneUse.capture(this.phoneUseDevice(),{mode:'tree',signal,timeout:6000});
      const proof=after.native.serviceInstanceId===frame.native.serviceInstanceId?inspectPaymentHandoff(after.native,facts):{verified:false,paymentStatus:'unverified',orderCreated:'unverified',reason:'service_changed',credentialBoundary:false};
      return {...proof,observationId:'payment-'+randomUUID(),observedAt:after.at,taskId,submission:'executed',item:facts.item,quantity:facts.quantity,totalFen:facts.totalFen};
    }catch(error){error.paymentDispatched=dispatched;error.paymentExecution=executed?'executed':dispatched?'unknown':'not_sent';throw error;}
  }
  async devices({refresh=false}={}){this.assertRemoteAvailable();return this.phoneUse.client.listDevices({refresh});}
  async reconcileNavigation(requestId,{signal,timeout}={}){
    requireValue(this.isPhoneUse(),'当前执行端不支持导航对账','reconcile_unavailable');
    return this.phoneUse.reconcileNavigation(this.phoneUseDevice(),requestId,{signal,timeout});
  }
  async setRemoteTransport(transport){
    requireValue(!this.lease,'手机任务仍持有操作现场，暂不切换传输','phone_transport_busy');
    const result=await this.phoneUse.client.setRemoteTransport(transport);this.remoteTransport=transport;
    this.observation=null;this.actionBaseline=null;return result;
  }
  async pair({backend='pony',address,deviceId,confirmPairing=false}={}){
    this.assertRemoteAvailable();
    if(backend==='pony'){requireValue(!this.isPhoneUse(),'请从手机设置选择需要连接的执行端');return this.call('pair',{waitMs:0});}
    requireValue(backend==='phoneuse','不支持这个手机执行端');
    requireValue(!this.lease,'手机正在执行任务，请完成后再配对','phone_busy');
    const result=await this.phoneUse.client.connect({address,deviceId,confirmPairing});
    if(result.status==='paired'){
      requireValue(typeof result.device_id==='string'&&result.device_id.length>0,'配对没有返回手机身份');
      this.store.transaction(s=>{s.settings.phoneBackend='phoneuse';s.settings.phoneUseDeviceId=result.device_id;s.settings.phoneEnabled=true;});
      this.rpc?.close();this.relay?.kill('SIGTERM');this.rpc=null;this.relay=null;this.observation=null;this.actionBaseline=null;
    }
    return result;
  }
  acquire(taskId){assertExecutionPermission(this.store,'phone');this.assertRemoteAvailable();if(this.lease&&this.lease!==taskId)throw new AppError('phone_busy','另一任务正在使用手机',409);this.lease=taskId;}
  async returnAfterCompletion(taskId,options){return returnAfterCompletion(this,taskId,options);}
  recordBackgroundHandoff(taskId,result){
    const handed=result?.handed===true,closed=result?.closed===true;
    const text=handed?'手机上已留好页面，点通知或背屏的“在主屏接手”即可继续。'
      :result?.state==='taken'?'页面已交到手机主屏。'
      :closed?'后台显示已关闭，需要时请在手机上重新打开应用。'
      :result?.dispatchState==='not_sent'?'后台页面交接未完成，命令未发送到手机。'
      :'后台页面交接结果未确认，未自动重试或关闭页面。';
    try{this.store.event?.(taskId,'phone_handoff',text,{handed,closed,state:result?.state??null,reason:result?.reason??'unconfirmed',dispatchState:result?.dispatchState??null});}catch{}
  }
  release(taskId){
    if(this.lease!==taskId)return;
    this.phoneUse?.client?.limitControllerNavigation?.(null,null);this.lease=null;this.observation=null;this.actionBaseline=null;
    if(!this.displayUse?.session)return;
    const task=this.store.task?.(taskId);
    if(this.isBackground()&&task?.status==='ready_for_user'){
      void this.displayUse.handoffSession({taskId,title:task.title,summary:task.report?.summary||task.result})
        .then(result=>this.recordBackgroundHandoff(taskId,result))
        .catch(error=>this.recordBackgroundHandoff(taskId,{handed:false,closed:false,reason:error.code||'handoff_failed',dispatchState:error.dispatchState}));
    }else void this.displayUse.closeSession();
  }
  async observe(taskId){
    if(this.isPhoneUse()){
      this.acquire(taskId);this.actionBaseline=null;
      const frame=await this.captureStableFrame(taskId,{deadline:this.clock()+STABILITY_BUDGET_MS});
      return this.observationResult(frame,{taskId});
    }
    this.acquire(taskId);this.actionBaseline=null;const tree=await this.call('ui_tree',{display:'main'});const image=await this.call('screenshot',{display:'main'});
    const ocr=await this.recognize(image);
    const observation={id:'screen-'+randomUUID().slice(0,8),taskId,at:Date.now(),hash:phoneFingerprint(tree),tree,ocr,imageHash:imageHash(image),aligned:true};this.observation=observation;
    return {content:[{type:'text',text:JSON.stringify({observationId:observation.id,display:'main',untrustedContent:true,coordinateSpace:'physical pixels; use textTargetId for recognized labels, never rescale from a preview',pointTap:'没有文字的位置（输入框、图标、×）可用 tap 的 x,y：截图上的相对位置，0–1000，左上角 0,0、右下角 1000,1000',screenSize:ocr?{width:ocr.width,height:ocr.height}:null,textTargets:ocr?.lines||[]})},...(tree.content||[]),...(image.content||[])]};
  }
  assertActionScope(taskId,args,{currentActionId=null}={}){
    const old=this.observation;
    if(old?.stabilityScope==='phone_use'){
      requireValue(!!classifyPhoneUseAction(taskId,args,old,old.phoneUseGrant,this.store.data.actions?.filter(action=>action.taskId===taskId&&action.id!==currentActionId)||[]),'当前动作不符合本轮任务的对象、内容或效果范围','phone_use_scope_changed');
      return;
    }
    if(old?.stabilityScope==='query'){
      requireValue(!!classifyQueryAction(taskId,args,old,old.queryGrant),'当前观察只允许本任务已授权的普通查询动作；商品交易、其他输入或结算请重新读取完整画面','query_scope_changed');
      return;
    }
    if(old?.stabilityScope!=='navigation')return;
    requireValue(old.taskId===taskId&&old.id===args.observationId&&args.action==='tap'&&typeof args.textTargetId==='string'&&old.stableTargetIds.includes(args.textTargetId),'当前观察只允许稳定的顶部导航文字；商品、输入或结算操作请重新读取完整画面','navigation_only');
  }
  queryAction(taskId,args,grant){
    const old=this.observation;
    if(old?.stabilityScope==='query'&&(grant?.platform!==old.queryGrant?.platform||grant?.query!==old.queryGrant?.query))return null;
    if(['navigation','query'].includes(old?.stabilityScope)){try{this.assertActionScope(taskId,args);}catch{return null;}}
    return classifyQueryAction(taskId,args,old,old?.stabilityScope==='query'?old.queryGrant:grant);
  }
  async act(taskId,args,{queryGrant=null,preparationGrant=null,useGrant=null,purchaseNavigation=false,signal,currentActionId=null}={}){
    if(signal?.aborted)throw new AppError('action_cancelled','任务已停止，动作未发送到手机',409);
    this.acquire(taskId);const initialArgs={...args};const old=this.observation;
    requireValue(old&&old.taskId===taskId&&old.id===args.observationId&&Date.now()-old.at<180000,'手机画面已过期，请重新观察');
    if(!purchaseNavigation)this.assertActionScope(taskId,args,{currentActionId});
    const scopedQuery=!purchaseNavigation&&old.stabilityScope==='query',scopedUse=old.stabilityScope==='phone_use';
    const effectiveUseGrant=scopedUse?old.phoneUseGrant:useGrant;
    if(scopedUse&&useGrant)requireValue(useGrant.taskId===old.phoneUseGrant.taskId&&useGrant.packageName===old.phoneUseGrant.packageName&&useGrant.sourceMessageId===old.phoneUseGrant.sourceMessageId&&useGrant.contractId===old.phoneUseGrant.contractId&&useGrant.contractRevision===old.phoneUseGrant.contractRevision,'应用任务范围已变化','phone_use_scope_changed');
    if(scopedQuery&&queryGrant)requireValue(queryGrant.platform===old.queryGrant.platform&&queryGrant.query===old.queryGrant.query,'查询授权与当前观察不一致，请重新观察','query_scope_changed');
    const effectiveQueryGrant=scopedQuery?old.queryGrant:queryGrant;
    const needsVisual=!(this.isPhoneUse()&&args.action==='back'&&effectiveUseGrant?.mode==='read_navigation')&&(!!args.textTargetId||scopedQuery||!!effectiveQueryGrant||!!preparationGrant||!!effectiveUseGrant);
    let tree,visual,native;
    // The native action carries observation_id, expected_window_id and the
    // service instance, so the phone itself rejects a changed window. A frame
    // the model saw moments ago does not need a second cloud round trip.
    const recent=this.isPhoneUse()&&(scopedUse||purchaseNavigation)&&old.native?.observationId&&this.clock()-old.at>=0&&this.clock()-old.at<=FRESH_ACTION_FRAME_MS;
    if(recent){tree=old.tree;native=old.native;visual=needsVisual?{ocr:old.ocr,hash:old.imageHash}:null;}
    else if(this.isPhoneUse()){
      try{
        const capture=await this.phoneUse.capture(this.phoneUseDevice(),{mode:needsVisual?'both':'tree',signal,timeout:this.phoneUse.client?.remoteTransport?12000:6000});
        tree=capture.tree;native=capture.native;
        visual=needsVisual?{ocr:await this.phoneUse.recognize(capture.image,capture.mapping,this.recognize),hash:imageHash(capture.image)}:null;
      }catch(error){
        // No input call has occurred. A fresh-read failure must never become
        // an unknown sent action or acquire a replay/receipt requirement.
        error.dispatchState='not_sent';throw error;
      }
    }else [tree,visual]=await Promise.all([this.call('ui_tree',{display:'main'}),needsVisual?this.call('screenshot',{display:'main'}).then(async image=>({ocr:await this.recognize(image),hash:imageHash(image)})):null]);
    let currentOcr=needsVisual?visual?.ocr:old.ocr,currentTargetId=args.textTargetId,currentImageHash=needsVisual?visual?.hash:old.imageHash;
    if(args.textTargetId){
      requireValue(['tap','long_press'].includes(args.action),'文字目标只用于点击或长按');
      const target=old.ocr?.lines.find(n=>n.id===args.textTargetId);requireValue(target,'文字目标不存在，请重新观察');
      const current=visual?.ocr;
      currentOcr=current;
      args={...args,...target.center};
      const sameLabel=current&&old.ocr.width===current.width&&old.ocr.height===current.height&&current.lines.find(n=>sameText(n.text,target.text)&&n.bounds.every((v,i)=>Math.abs(v-target.bounds[i])<=3));
      currentTargetId=sameLabel?.id;
      requireValue(sameLabel&&(sameTextTarget(old.ocr,current,target)||sameNavigationTarget(old.tree,tree,args)||preparationGrant&&(()=>{const before=classifyPreparationAction(taskId,initialArgs,old,preparationGrant),after=classifyPreparationAction(taskId,{...initialArgs,...(currentTargetId?{textTargetId:currentTargetId}:{})},{...old,tree,ocr:currentOcr},preparationGrant);return before&&after&&JSON.stringify(before)===JSON.stringify(after);})()),'手机文字、价格或弹窗发生变化，请重新观察');
    }
    requireValue(args.textTargetId||scopedQuery||scopedUse||preparationGrant?sameNativeScreen(old.tree,tree):samePhoneTarget(old.tree,tree,args),'手机目标控件、页面或屏幕尺寸发生变化，请重新观察');
    if(effectiveQueryGrant&&!classifyQueryAction(taskId,{...args,textTargetId:currentTargetId},{...old,tree,ocr:currentOcr},effectiveQueryGrant))throw new AppError('query_scope_changed','页面已离开本次自动查询范围，请重新观察',409);
    if(preparationGrant&&!classifyPreparationAction(taskId,{...initialArgs,...(currentTargetId?{textTargetId:currentTargetId}:{})},{...old,tree,ocr:currentOcr},preparationGrant))throw new AppError('preparation_scope_changed','当前餐品、数量或结算条件已离开本次备餐范围，请重新观察',409);
    if(effectiveUseGrant&&!classifyPhoneUseAction(taskId,{...initialArgs,...(currentTargetId?{textTargetId:currentTargetId}:{})},{...old,tree,ocr:currentOcr},effectiveUseGrant,this.store.data.actions?.filter(action=>action.taskId===taskId&&action.id!==currentActionId)||[]))throw new AppError('phone_use_scope_changed','页面或输入已离开本轮应用操作范围',409);
    if(signal?.aborted)throw new AppError('action_cancelled','任务已停止，动作未发送到手机',409);
    // The screen read is an await boundary. Recheck the live task before
    // dispatch, not only the grant that was captured with the earlier frame.
    if(effectiveUseGrant){
      const live=this.store.data.tasks?.find(task=>task.id===taskId);
      if(live){
        // Broker journals this exact attempt before entering Phone.act. Its own
        // executing row must not look like an unrelated unresolved graph step.
        // This read-only view never changes the journal or hides unknown rows.
        const ownAttempt=this.store.data.actions?.find(row=>row.id===currentActionId&&row.taskId===taskId&&row.tool==='phone_action'&&row.status==='executing'&&row.authorization==='phone_use_scope'&&row.observationId===old.id&&row.phoneOperation===initialArgs.action);
        const scopeStore=ownAttempt?Object.assign(Object.create(this.store),{data:{...this.store.data,actions:this.store.data.actions.filter(row=>row!==ownAttempt)}}):this.store;
        const renewed=phoneUseGrant(live,effectiveUseGrant,{store:scopeStore});
        requireValue(renewed&&['running','waiting_approval'].includes(live.status)&&renewed.sourceMessageId===effectiveUseGrant.sourceMessageId&&renewed.contractId===effectiveUseGrant.contractId&&renewed.contractRevision===effectiveUseGrant.contractRevision&&JSON.stringify(renewed.effectPlan)===JSON.stringify(effectiveUseGrant.effectPlan),'任务授权在读取期间已变化，动作未发送','phone_use_scope_changed');
      }
    }
    try{assertExecutionPermission(this.store,'phone');}catch(error){error.dispatchState='not_sent';throw error;}
    let command;
    if(['tap','long_press'].includes(args.action)){for(const k of ['x','y'])requireValue(Number.isFinite(args[k])&&args[k]>=0&&args[k]<=10000,'坐标无效');command=[args.action,{x:args.x,y:args.y}];}
    else if(args.action==='type'){requireValue(typeof args.text==='string'&&args.text.length<=4000,'输入过长');requireValue(args.inputMode===undefined||['insert','replace'].includes(args.inputMode),'输入模式无效');command=['type',{text:args.text,mode:args.inputMode||'insert'}];}
    else if(args.action==='back')command=['key',{key:'back'}];
    else if(args.action==='swipe'){for(const k of ['x1','y1','x2','y2'])requireValue(Number.isFinite(args[k])&&args[k]>=0&&args[k]<=10000,'坐标无效');command=['swipe',{x1:args.x1,y1:args.y1,x2:args.x2,y2:args.y2,durationMs:500}];}
    else throw new AppError('invalid_action','不支持该手机动作');
    if(signal?.aborted)throw new AppError('action_cancelled','任务已停止，动作未发送到手机',409);
    this.actionBaseline={...old,tree,hash:phoneFingerprint(tree),ocr:currentOcr,imageHash:currentImageHash};this.observation=null;
    if(['tap','long_press'].includes(args.action))this.lastTap={x:args.x,y:args.y,at:this.clock()};
    try{return await this.call(command[0],{...command[1],display:'main'},45000,{signal,effect:true,native});}
    catch(error){
      try{
        if(error.code==='phone_input_unavailable'&&args.action==='type'&&this.ime)return await this.typeWithIme(args,native,signal);
        throw error;
      }catch(failure){
        if(args.action==='type'&&failure.dispatchState==='not_sent'&&!signal?.aborted)this.observation=old;
        throw failure;
      }
    }
  }
  async actGeneral(taskId,args,{signal}={}){
    try{assertExecutionPermission(this.store,'phone');}catch(error){error.dispatchState='not_sent';throw error;}
    this.acquire(taskId);const old=this.observation;
    requireValue(old?.taskId===taskId&&old.id===args.observationId,'请先读取当前手机页面','phone_observation_required');
    if(old.returnOnly)requireValue(args.action==='back','此子窗口只允许返回','phone_use_scope_changed');
    const target=args.textTargetId?old.ocr?.lines.find(line=>line.id===args.textTargetId):null;
    let dispatchNative=old.native;
    if(target){
      // OCR coordinates have no native element binding. Recheck the target just
      // before dispatch so a vanished label cannot click the page beneath it.
      let fresh=null;
      const sameWindow=frame=>old.native&&frame?.native?.deviceId===old.native.deviceId&&frame.native.serviceInstanceId===old.native.serviceInstanceId&&frame.native.windowId===old.native.windowId&&frame.native.packageName===old.native.packageName&&!nativeWindowConflict(frame.native);
      // Background display: when the label has its own accessibility control, re-read
      // only the structure (no picture, no text recognition) and compare that control.
      // It is the same check, a fraction of the time. Anything unclear takes the full read.
      if(this.isBackground()&&old.native&&!old.screenshotOnly&&sameNativeTextTarget(old.native,old.native,target)){
        try{
          const quick=await this.phoneUse.capture(this.phoneUseDevice(),{mode:'tree',signal,timeout:4000});
          if(sameWindow(quick)&&sameNativeTextTarget(old.native,quick.native,target))fresh={native:quick.native,verified:true};
        }catch(error){if(signal?.aborted||['cancelled','action_cancelled','phone_control_paused'].includes(error.code)){error.dispatchState='not_sent';throw error;}}
      }
      // A background-display read goes through the relay and takes longer than a main-screen read.
      if(!fresh)try{fresh=await this.captureStableFrame(taskId,{signal,screenshotFallback:true,deadline:this.clock()+(this.isBackground()?14000:6000)});}
      catch(error){error.dispatchState='not_sent';throw error;}
      const sameContext=fresh.verified||(old.native?sameWindow(fresh):samePhoneContext(old.tree,fresh.tree));
      if(!sameContext||!(fresh.verified||sameTextTarget(old.ocr,fresh.ocr,target)||sameNativeTextTarget(old.native,fresh.native,target)))throw Object.assign(new AppError('action_cancelled','点击目标已变化，未点击。',409),{dispatchState:'not_sent',phoneuseCode:'STALE_ELEMENT'});
      dispatchNative=fresh.native;
    }
    if(target)args={...args,...target.center};
    const commands={tap:['tap',{x:args.x,y:args.y}],long_press:['long_press',{x:args.x,y:args.y}],type:['type',{text:args.text,mode:args.inputMode||'replace'}],back:['key',{key:'back'}],swipe:['swipe',{x1:args.x1,y1:args.y1,x2:args.x2,y2:args.y2,durationMs:400}]};
    const command=commands[args.action];requireValue(command,'不支持该手机动作');
    if(signal?.aborted)throw new AppError('action_cancelled','任务已停止',409);
    // Background display: tell the driver where the last tap landed, to pick the field it focused.
    if(args.action==='type'&&this.isBackground()&&this.lastTap&&this.clock()-this.lastTap.at<120000)command[1]={...command[1],nearX:this.lastTap.x,nearY:this.lastTap.y};
    this.actionBaseline=old;this.observation=null;
    if(['tap','long_press'].includes(args.action))this.lastTap={x:args.x,y:args.y,at:this.clock()};
    const observed=resultData(old.tree);
    const foreground=old.native?.packageName;
    const onTarget=foreground&&observed?.display==='main'&&observed.windowPkg===foreground&&(observed.foreground===foreground||observed.foreground?.startsWith(foreground+'/'));
    const controllerOperation=onTarget?classifyGeneralAction(taskId,args,old,this.store.task?.(taskId)?.phoneUseScope)?.kind:null;
    try{return await this.call(command[0],{...command[1],display:'main'},12000,{signal,effect:true,native:dispatchNative,controllerOperation});}
    catch(error){
      // The background display never borrows the main-screen keyboard; keep the driver's specific reason.
      if(error.code==='phone_input_unavailable'&&args.action==='type'&&this.ime&&!this.isBackground())return this.typeWithIme(args,old.native,signal);
      throw error;
    }
  }
  async typeWithIme(args,native,signal){
    this.assertRemoteAvailable();
    // The phone's input method types into whatever is focused on the main screen.
    // It must never be used for an app running on the background display.
    if(this.isBackground())throw Object.assign(new AppError('phone_input_unavailable','后台显示上没有可直接写入的输入框，不会改用主屏输入法。',409),{dispatchState:'not_sent'});
    const request=async mode=>{
      const client=this.phoneUse?.client;
      if(client?.pendingSummary){
        const pending=await client.pendingSummary(),deviceId=this.phoneUseDevice();
        if(client.active?.has(deviceId)||pending.requests.some(row=>row.deviceId===deviceId)){
          throw Object.assign(new AppError('outcome_pending','设备有未决动作，不能改用另一输入通道',409),{dispatchState:'not_sent'});
        }
      }
      if(signal?.aborted)throw Object.assign(new AppError('cancelled','输入已停止',409),{dispatchState:'not_sent'});
      return this.ime.request({text:args.text,mode,packageName:native?.packageName});
    };
    let result=await request(args.inputMode||'insert');
    // Selecting old text can fail in fields like WeChat's empty chat bar. These
    // diagnostics mean nothing was committed, so inserting once is safe.
    if(result.status==='failed'&&(args.inputMode||'replace')==='replace'&&['prepare_exception','prepare_timeout','editor_changed_before_commit'].includes(result.diagnostic)&&!signal?.aborted){
      this.store.event?.(this.lease,'phone_recovery','改用直接插入重试输入',{recovery:'ime_insert_retry',diagnostic:result.diagnostic});
      result=await request('insert');
    }
    if(result.status==='typed')return {content:[{type:'text',text:JSON.stringify({ok:true,result:{input:'wireless_editor',verified:true,requiresVerification:false}})}]};
    const notSent=['password','unfocused','permission'].includes(result.status)||result.status==='failed'&&['invalid_request','service_unavailable','control_paused','focus_missing','protected_input','editor_changed_before_commit','prepare_timeout','prepare_exception'].includes(result.diagnostic);
    if(!notSent)throw Object.assign(new AppError('outcome_unknown','手机已收到输入，但没有确认写入结果；先核对原输入，不能再次输入。',409),{dispatchState:'unknown',requestId:result.id,...(result.diagnostic?{inputDiagnostic:result.diagnostic}:{})});
    const messages={password:'这是密码或验证码框，只能由你本人输入',unfocused:'没有点中可输入的位置，请先点一下输入框再继续',permission:'请在手机 Boujoy 的连接设置中启用「Boujoy 无线输入」，之后无需连接数据线',failed:'输入法没有把文字写进去'};
    throw Object.assign(new AppError(result.status==='password'?'user_only_step':'phone_input_unavailable',messages[result.status]||'没能输入',409),{dispatchState:'not_sent',...(result.diagnostic?{inputDiagnostic:result.diagnostic}:{})});
  }
  async settle(timeoutMs=1200){return this.call('wait_idle',{timeoutMs:Math.max(500,Math.min(1200,timeoutMs)),display:'main'},Math.max(1500,timeoutMs+300));}
  async resolvePlatformApp(platform,{request=''}={}){
    const profile=commercePlatform(platform);requireValue(profile,'平台未配置');
    const directory=await this.listApps(profile.names.at(-1));
    requireValue(directory&&directory.stale!==true&&Array.isArray(directory.apps),'手机应用目录尚未核实','phone_app_directory_unavailable');
    const installed=directory.apps.filter(app=>profile.packages.includes(app.packageName));
    const preferred=profile.packages.map(pkg=>({pkg,label:phoneAppRecord(pkg).label})).filter(app=>request.includes(app.label)).sort((a,b)=>b.label.length-a.label.length)[0]?.pkg||profile.packages[0];
    const selected=installed.find(app=>app.packageName===preferred)||installed.length===1&&installed[0];
    requireValue(selected,'手机上没有已核实的本平台应用','app_not_installed');
    return {...selected,directorySource:directory.source,directoryCached:directory.cached===true};
  }
  async openApp(taskId,platform,{signal}={}){
    this.acquire(taskId);const p=PLATFORMS.find(x=>x.id===platform);requireValue(p,'平台未配置');
    const request=(this.store.task?.(taskId)?.messages||[]).filter(message=>message.role==='user').at(-1)?.content||'';
    const selected=await this.resolvePlatformApp(platform,{request});
    if(signal?.aborted)throw new AppError('action_cancelled','任务已停止，打开应用未发送',409);
    this.observation=null;this.actionBaseline=null;return this.call('open_app',{packageName:selected.packageName,display:'main'},45000,{signal,effect:true});
  }
  async close(){this.rpc?.close();this.relay?.kill('SIGTERM');await Promise.allSettled([this.displayUse?.close()]);await this.phoneUseDriver.close();this.phoneUseDriver=this.phoneUseFactory();this.bindPhoneUse();if(this.remoteTransport)await this.phoneUseDriver.client.setRemoteTransport(this.remoteTransport);this.rpc=null;this.relay=null;this.lease=null;this.observation=null;this.actionBaseline=null;}
}
