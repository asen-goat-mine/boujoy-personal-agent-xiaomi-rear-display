import {randomUUID} from 'node:crypto';
import {PLATFORMS} from '../core/compare.mjs';

const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
function textData(result,predicate=()=>true){
  if(result?.isError)return null;
  for(const item of result?.content||[]){
    if(item.type!=='text'||typeof item.text!=='string')continue;
    try{const data=JSON.parse(item.text);if(object(data)&&predicate(data))return data;}catch{}
  }
  return null;
}
function nativeState(result){return textData(result,data=>data.ok===true&&object(data.result)&&typeof data.result.tree==='string')?.result||null;}
function matchesApp(native,packageName){
  return native?.display==='main'&&native.windowPkg===packageName&&typeof native.foreground==='string'&&
    (native.foreground===packageName||native.foreground.startsWith(packageName+'/'));
}
function failure(code){const error=new Error('Phone preflight could not verify readiness');error.code=code;return error;}
const FAILURES=new Set(['phone_busy','phone_not_connected','phone_disabled','phone_not_ready','foreground_mismatch','native_unavailable','screen_unstable','preflight_unavailable','unsupported_platform']);

// Read-only, local diagnostic. The caller must also exclude active task runs.
// Nothing from status, native trees, OCR or screenshots leaves this helper.
export async function preflightPhone(phone,{platform='taobao'}={}){
  const started=Date.now(),leaseId='preflight-'+randomUUID();
  const result={ready:false,connected:false,foreground:null,stabilityScope:null,stableTargetCount:0,elapsedMs:0,reason:'preflight_failed',modelRequests:0,actions:0};
  let acquired=false;
  try{
    const target=PLATFORMS.find(item=>item.id===platform);
    if(!target)throw failure('unsupported_platform');
    if(!phone||!['acquire','release','status','call','observeStable'].every(name=>typeof phone[name]==='function'))throw failure('preflight_unavailable');
    await phone.acquire(leaseId);acquired=true;
    const status=await phone.status();
    if(status?.enabled===false)throw failure('phone_disabled');
    const state=object(status?.result?.structuredContent)?status.result.structuredContent:textData(status?.result);
    result.connected=state?.connected===true;
    if(!result.connected)throw failure('phone_not_connected');
    if(state.link!=='ready'||state.listening!==true)throw failure('phone_not_ready');
    let foregroundBlocked=false,nativePending=null;
    const guardNative=raw=>{
      const native=nativeState(raw);
      if(!native)throw failure('native_unavailable');
      if(!matchesApp(native,target.packageName)){
        foregroundBlocked=true;result.foreground='other';throw failure('foreground_mismatch');
      }
      result.foreground=target.packageName;return raw;
    };
    // Gate before any capture. A foreign foreground must never be photographed.
    guardNative(await phone.call('ui_tree',{display:'main'},6000));
    // Keep the diagnostic observation in a scoped reader. Phone.observeStable
    // normally overlaps native/screenshot RPCs; every screenshot here must wait
    // for its frame's native check, including later samples after an app switch.
    const reader=Object.create(phone);
    reader.call=async(name,args={},timeout)=>{
      if(args.display!=='main')throw failure('preflight_unavailable');
      if(name==='ui_tree'){
        nativePending=Promise.resolve().then(()=>phone.call(name,args,timeout)).then(guardNative);
        return nativePending;
      }
      if(name==='screenshot'){
        if(!nativePending)throw failure('native_unavailable');
        const gate=nativePending;await gate;
        if(gate!==nativePending)throw failure('native_unavailable');
        nativePending=null;
        return phone.call(name,args,timeout);
      }
      throw failure('preflight_unavailable'); // no wait_idle, tap, type or launch
    };
    if(phone.isPhoneUse?.()){
      // The native wireless transport captures tree+image in one observation.
      // Retain this diagnostic's foreground gate before every such capture.
      reader.captureStableFrame=async(taskId,options)=>{
        guardNative(await phone.call('ui_tree',{display:'main'},Math.max(1,options.deadline-Date.now()),{signal:options.signal}));
        const frame=await phone.captureStableFrame(taskId,options);guardNative(frame.tree);return frame;
      };
    }
    const observed=await reader.observeStable(leaseId);
    if(foregroundBlocked)throw failure('foreground_mismatch');
    const meta=textData(observed,data=>Object.hasOwn(data,'stability'));
    const observation=reader.observation;
    if(!meta?.observationId||meta.stability!=='stable'||observation?.taskId!==leaseId||
      observation.id!==meta.observationId||observation.stability!=='stable')throw failure('screen_unstable');
    if(!matchesApp(nativeState(observation.tree),target.packageName)){
      result.foreground='other';throw failure('foreground_mismatch');
    }
    const scope=meta.stabilityScope;
    if(!['full','navigation'].includes(scope)||observation.stabilityScope!==scope)throw failure('screen_unstable');
    const targetIds=new Set((meta.textTargets||[]).filter(item=>object(item)&&typeof item.id==='string'&&item.id.length>0).map(item=>item.id));
    if(scope==='navigation'){
      const granted=new Set((meta.stableTargetIds||[]).filter(id=>typeof id==='string'&&id.length>0));
      const actual=new Set((observation.stableTargetIds||[]).filter(id=>typeof id==='string'&&id.length>0));
      result.stableTargetCount=[...targetIds].filter(id=>granted.has(id)&&actual.has(id)).length;
      if(!result.stableTargetCount)throw failure('screen_unstable');
    }else result.stableTargetCount=targetIds.size;
    result.stabilityScope=scope;result.ready=true;result.reason=scope==='navigation'?'navigation_ready':'ready';
  }catch(error){
    result.ready=false;result.stabilityScope=null;result.stableTargetCount=0;
    result.reason=FAILURES.has(error?.code)?error.code:'preflight_failed';
  }finally{
    if(acquired){
      try{await phone.release(leaseId);}catch{result.ready=false;result.stabilityScope=null;result.stableTargetCount=0;result.reason='preflight_failed';}
    }
    result.elapsedMs=Math.max(0,Date.now()-started);
  }
  return result;
}
