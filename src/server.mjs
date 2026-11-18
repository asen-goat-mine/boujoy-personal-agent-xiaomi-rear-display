import {DISTRIBUTION,BUILD_IDENTITY,BIND_SCHEME,BACKGROUND_SUPPORTED} from './distribution.mjs';
import {reasoningSettings,REASONING_OPTIONS} from './core/reasoning-settings.mjs';
import {fileURLToPath} from 'node:url';
import {startSuccessor} from './core/respawn.mjs';
import {watchPetStatus} from './core/pet-status.mjs';
import {assertExecutionPermission,toolExecutionDomains} from './core/execution-permissions.mjs';
import {purchaseInterpreter} from './core/semantic-purchase.mjs';
import {removeBotRole} from './core/role-lifecycle.mjs';
import {withCrossEnd} from './core/cross-end.mjs';
import {groupTaskContext} from './core/groups.mjs';
import {syntheticTurnEnd} from './core/synthetic-turn-end.mjs';
import {modelRequestStats,modelErrorPreview} from './core/model-diagnostics.mjs';
import {createRole,chooseBotColor,distinctBotColors} from './core/roles.mjs';
import {LiveDrafts} from './core/live-draft.mjs';
import {webSearch,webFetch} from './tools/web.mjs';
import {DeepSeekTools} from './adapters/deepseek-tools.mjs';
import {conversationSiblings,conversationMessages} from './core/conversation-context.mjs';
import {effectiveTimezone,validTimezone} from './core/timezone.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID,randomBytes,randomInt,timingSafeEqual,createHash } from 'node:crypto';
import { once } from 'node:events';
import { ROOT,DATA,HOST,PORT,ORIGIN,prepareData } from './config.mjs';
import { AppError,requireValue,shortText,safeError,now } from './core/errors.mjs';
import { Store } from './core/store.mjs';
import { Engine } from './core/engine.mjs';
import { Approvals } from './core/approvals.mjs';
import { Scheduler,createRoutine,updateRoutine,routineTaskInput } from './core/scheduler.mjs';
import {watchSummary} from './core/watches.mjs';
import {pruneOldImages} from './core/model-context.mjs';
import {briefSettings,removeNote,workbench} from './core/bots.mjs';
import { compareQuotes,PLATFORMS } from './core/compare.mjs';
import { Secrets } from './adapters/secrets.mjs';
import {BokPersonalMemory,memoryClassifier,bokPersonalInstalled} from './adapters/bok-personal.mjs';
import { PersonalMemory } from './adapters/memory.mjs';
import { Browser } from './adapters/browser.mjs';
import { Phone } from './adapters/phone.mjs';
import {preflightPhone} from './adapters/phone-preflight.mjs';
import { HarnessRun,harnessVersion,harnessExtrasStatus,MAX_OUTPUT_TOKENS } from './adapters/harness.mjs';
import { Broker,TOOL_DEFINITIONS } from './tools/broker.mjs';
import {RemoteService} from './remote/service.mjs';
import {Connectors} from './adapters/connectors.mjs';
import {EventTriggers} from './core/event-triggers.mjs';
import {SignedEventMonitor} from './core/event-monitor.mjs';
import {reserveModelBudget,modelBudgetStatus} from './core/model-budget.mjs';
import {AnthropicUsageMeter,commitModelUsage,reserveMemoryUsage,commitMemoryUsage} from './core/model-usage.mjs';
import {LocalMessageUploads,receiveUpload} from './core/input-files.mjs';
import {MacPower} from './adapters/mac-power.mjs';
import {LocalVoiceService} from './adapters/voice.mjs';
import {ImageRetention} from './core/image-retention.mjs';
import {setExecutionPermissions,EXECUTION_DOMAINS} from './core/execution-permissions.mjs';

prepareData();process.umask(0o077);
const SERVER_FILE=fileURLToPath(import.meta.url);
const SERVER_STARTED_AT=new Date().toISOString();
const store=new Store(DATA);
// Once: bots that shared a color each get their own, so the sidebar tells them apart at a glance.
if(store.data.settings.botColorsDistinct!==1)store.transaction(s=>{distinctBotColors(s.roles);s.settings.botColorsDistinct=1;});
const secrets=new Secrets();const memory=new PersonalMemory();
// The Bok personal core is optional and not part of the public repository. Without it Boujoy runs on Markdown memory alone.
if(bokPersonalInstalled())memory.personal=new BokPersonalMemory({vault:memory.root,classify:memoryClassifier({secrets,onRequest:()=>reserveMemoryUsage(store),onUsage:(usage,id)=>commitMemoryUsage(store,id,usage)})});const browser=new Browser();const phone=new Phone(store);const approvals=new Approvals(store);
// Phone setup boundary: pairing is explicit and public responses never contain client credentials.
const phonePairings=new WeakSet();
export function phoneSetupAddress(value){
  requireValue(typeof value==='string'&&value.length<=1024,'请输入手机的 HTTPS 地址');
  const address=value.trim(),match=address.match(/^https:\/\/(\[[^\]\s]+\]|[^/?#:@\s]+)(?::(\d{1,5}))?\/?$/i);
  requireValue(match&&!address.includes('\\'),'手机地址必须是 HTTPS 主机地址，不能包含账号、路径或参数');
  let url;try{url=new URL(address);}catch{throw new AppError('invalid_input','手机地址无效');}
  requireValue(url.protocol==='https:'&&url.hostname&&(!match[2]||(Number(match[2])>0&&Number(match[2])<=65535)),'手机地址无效');
  return `https://${url.hostname}:${match[2]?Number(match[2]):8443}`;
}
export function phonePairRequest(data){
  requireValue(data&&typeof data==='object'&&!Array.isArray(data),'手机配对参数无效');
  requireValue(Object.keys(data).every(k=>['backend','address','deviceId','confirmPairing'].includes(k)),'手机配对包含不支持的参数');
  if(!Object.keys(data).length)return {};
  requireValue(['pony','phoneuse'].includes(data.backend),'请选择手机执行端');
  if(data.backend==='pony'){requireValue(Object.keys(data).length===1,'旧接入不接受无线配对参数');return {backend:'pony'};}
  requireValue(data.confirmPairing===undefined||typeof data.confirmPairing==='boolean','请明确是否已核对安全码');
  const request={backend:'phoneuse',address:phoneSetupAddress(data.address),confirmPairing:data.confirmPairing===true};
  if(data.deviceId!==undefined){requireValue(typeof data.deviceId==='string'&&/^[A-Za-z0-9._:-]{1,128}$/.test(data.deviceId),'手机身份无效');request.deviceId=data.deviceId;}
  requireValue(!request.confirmPairing||request.deviceId,'确认配对时需要本次手机身份');
  return request;
}
function phonePublicMetadata(value){
  const out={};
  for(const key of ['device_id','name','model','android_version','service_instance_id'])if(typeof value?.[key]==='string'&&value[key].length<=240)out[key]=value[key];
  if(typeof value?.is_emulator==='boolean')out.is_emulator=value.is_emulator;
  if(typeof value?.address==='string'){try{out.address=phoneSetupAddress(value.address);}catch{}}
  return out;
}
export function publicPhonePairResult(result,backend){
  if(backend!=='phoneuse')return result;
  requireValue(result&&['pending','paired'].includes(result.status),'手机没有返回有效配对状态');
  const out={...phonePublicMetadata(result),status:result.status};
  requireValue(typeof out.device_id==='string'&&/^[A-Za-z0-9._:-]{1,128}$/.test(out.device_id),'配对没有返回有效手机身份');
  if(out.status==='pending'){
    requireValue(typeof result.verification_code==='string'&&/^\d{8}$/.test(result.verification_code),'手机没有返回八位安全码');
    out.verification_code=result.verification_code;out.confirmation_required=result.confirmation_required!==false;
  }
  return out;
}
export const APP_VERSION=(()=>{try{const v=JSON.parse(fs.readFileSync(path.join(ROOT,'package.json'),'utf8')).version;return typeof v==='string'?v:'';}catch{return '';}})();
// The name shown for the phone is the paired device's own name, never a fixed model.
export function phoneDeviceLabel(settings){const name=settings?.phoneDeviceName;return typeof name==='string'&&name.trim()?name.trim().slice(0,60):'Android 手机';}
export function rememberPhoneDevice(store,result){
  try{
    const id=store.data.settings.phoneUseDeviceId;if(!id)return;
    const device=(Array.isArray(result?.devices)?result.devices:[]).find(d=>d?.device_id===id);
    const name=[device?.name,device?.model].find(v=>typeof v==='string'&&v.trim())?.trim().slice(0,60);
    if(name&&name!==store.data.settings.phoneDeviceName)store.transaction(s=>{s.settings.phoneDeviceName=name;});
  }catch{}
}
export function publicPhoneDevices(result){
  return {devices:(Array.isArray(result?.devices)?result.devices:[]).slice(0,64).filter(d=>typeof d?.device_id==='string'&&/^[A-Za-z0-9._:-]{1,128}$/.test(d.device_id)).map(d=>({...phonePublicMetadata(d),paired:d.paired===true,online:typeof d.online==='boolean'?d.online:null})),cached:true};
}
export function publicSettings(settings){
  settings={...settings,timezone:effectiveTimezone(settings),timezoneManual:settings.timezoneManual===true};
  const keys=['timezone','timezoneManual','modelReasoning','harnessPersistent','modelWatchdogEnabled','superagentEnabled','harnessExtras','watchesEnabled','routerEnabled','keepAwakeOnAC','maxConcurrent','dailyModelRequests','maxModelRequests','maxTaskMinutes','model','quiet','phoneEnabled','phoneBackend','phoneExecutionMode','phoneUseDeviceId','phoneDeviceName','ponyRelay','memoryEnabled','browserEnabled','filesEnabled','chatCloudConsent','chatMemoryConsent','chatMemoryMode'];
  return {...Object.fromEntries(keys.filter(key=>Object.hasOwn(settings,key)).map(key=>[key,settings[key]])),modelReasoning:reasoningSettings(settings).modelReasoning,modelReasoningOptions:REASONING_OPTIONS,distributionEdition:DISTRIBUTION.edition,backgroundSupported:BACKGROUND_SUPPORTED};
}
export async function pairPhoneSetup(phone,store,engine,data){
  const request=phonePairRequest(data);
  requireValue(!phonePairings.has(phone)&&engine.active.size===0&&!store.data.tasks.some(t=>['running','queued','waiting_approval','waiting_children'].includes(t.status)),'手机正在执行或配对，请完成后再更换连接','phone_busy');
  phonePairings.add(phone);
  try{return publicPhonePairResult(await phone.pair(request),request.backend);}finally{phonePairings.delete(phone);}
}
// End phone setup boundary.
function log(type,text){const filename=path.join(DATA,'logs/service.log');try{if(fs.existsSync(filename)&&fs.statSync(filename).size>2000000)fs.renameSync(filename,filename+'.1');fs.appendFileSync(filename,`${now()} [${type}] ${String(text).replace(/sk-[\w-]+/g,'[redacted]')}\n`,{mode:0o600});}catch{}}
const broker=new Broker({store,browser,phone,memory,approvals});
// Web tools use DeepSeek's official search and fetch (the same account key as the
// model). Only a task the user allowed to use DeepSeek sends anything there;
// otherwise, and when the official service fails, the keyless local path is used.
const deepseekTools=new DeepSeekTools({apiKey:()=>secrets.get('deepseek')});
const officialFor=(taskId,tool,work)=>{
  const task=taskId?store.task(taskId):null;if(!task?.cloudConsent)return null;
  return async(input,options)=>{const started=Date.now();try{const result=await work(input,options);store.event?.(taskId,'deepseek_tool','DeepSeek 官方工具',{tool,ok:true,elapsedMs:Date.now()-started});return result;}catch(error){store.event?.(taskId,'deepseek_tool','DeepSeek 官方工具',{tool,ok:false,code:error.code,elapsedMs:Date.now()-started});throw error;}};
};
broker.web={
  search:(args,{signal,taskId})=>webSearch(args,{signal,official:officialFor(taskId,'search',(input,options)=>deepseekTools.search(input,options))}),
  fetch:(args,{signal,taskId})=>webFetch(args,{signal,official:officialFor(taskId,'fetch',(input,options)=>deepseekTools.fetch(input,options))})
};
broker.deepseek=deepseekTools;const engine=new Engine({store,secrets,broker,memory,origin:ORIGIN,log});const scheduler=new Scheduler(store,engine);engine.interpretPurchase=purchaseInterpreter({origin:ORIGIN});
const groups=engine.groups;
const INLINE_TYPES=Object.fromEntries([['image/png','image/png'],['image/jpeg','image/jpeg'],['image/webp','image/webp'],['image/gif','image/gif'],['video/mp4','video/mp4'],['video/webm','video/webm'],['video/quicktime','video/quicktime'],['audio/mpeg','audio/mpeg'],['audio/mp4','audio/mp4'],['audio/wav','audio/wav'],['audio/webm','audio/webm'],['audio/ogg','audio/ogg'],['application/pdf','application/pdf'],['.png','image/png'],['.jpg','image/jpeg'],['.jpeg','image/jpeg'],['.webp','image/webp'],['.gif','image/gif'],['.mp4','video/mp4'],['.m4v','video/mp4'],['.webm','video/webm'],['.mov','video/quicktime'],['.mp3','audio/mpeg'],['.m4a','audio/mp4'],['.wav','audio/wav'],['.pdf','application/pdf'],['image/svg+xml','image/svg+xml'],['.svg','image/svg+xml']]);
const uploads=new Map(),localUploads=new LocalMessageUploads({engine,store,dataDir:DATA,uploads});
const voice=new LocalVoiceService({dataDir:DATA,store,deepseek:deepseekTools});broker.transcodeForAsr=(bytes,options)=>voice.toAsrAudio(bytes,options);
const remote=new RemoteService({dataDir:DATA,store,engine,phone,voice,log,removeRole:removeBot});
const power=new MacPower();
function syncPower(){return power.setEnabled(store.data.settings.keepAwakeOnAC!==false&&!store.data.recoveryFence?.required&&remote.status().configured);}
const connectors=new Connectors({dataDir:DATA,secrets,store,approvals});broker.connectors=connectors;
const eventTriggers=new EventTriggers({store,engine,secrets});
const eventMonitor=new SignedEventMonitor({store,secrets,eventTriggers,origin:ORIGIN});
const imageRetention=new ImageRetention({store,dataDir:DATA,engine});engine.imageRetention=imageRetention;
function removeBot(id){return removeBotRole({store,engine,eventTriggers},id);}
const sessions=new Map();const subscribers=new Set();const rate=new Map();
const liveDrafts=new LiveDrafts({publish:payload=>{const frame=`data: ${JSON.stringify(payload)}\n\n`;for(const res of subscribers)res.write(frame);}});engine.liveDrafts=liveDrafts;
function equal(a,b){if(typeof a!=='string'||typeof b!=='string')return false;const left=Buffer.from(a),right=Buffer.from(b);return left.length===right.length&&timingSafeEqual(left,right);}
function json(res,status,value){if(res.headersSent)return;res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));}
async function voiceRequest(req,res,operation){const controller=new AbortController(),cancel=()=>controller.abort();res.once('close',cancel);try{if(req.aborted)cancel();return await operation(controller.signal);}finally{res.off('close',cancel);}}
async function body(req,limit=1024*1024){let size=0;const chunks=[];for await(const c of req){size+=c.length;if(size>limit)throw new AppError('too_large','请求过大',413);chunks.push(c);}try{return JSON.parse(Buffer.concat(chunks).toString()||'{}');}catch{throw new AppError('invalid_json','请求格式无效');}}
function localRequest(req){
  if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress))throw new AppError('local_only','仅接受本机连接',403);
  if(![`${HOST}:${PORT}`,`localhost:${PORT}`].includes(req.headers.host))throw new AppError('invalid_host','访问地址不正确',403);
  if(req.headers.origin&&![ORIGIN,`http://localhost:${PORT}`].includes(req.headers.origin))throw new AppError('invalid_origin','访问来源不正确',403);
  if(req.headers['sec-fetch-site']==='cross-site')throw new AppError('invalid_origin','访问来源不正确',403);
}
function auth(req){
  const sid=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('boujoy_session='))?.slice(15);const session=sessions.get(sid);
  if(!session||session.expires<Date.now())throw new AppError('unauthorized','会话过期，请刷新页面',401);
  if(!['GET','HEAD'].includes(req.method)&&!equal(req.headers['x-boujoy-csrf'],session.csrf))throw new AppError('csrf','请求认证失败',403);
  return session;
}
function runtimeToken(req){const a=engine.tokens.get((req.headers.authorization||'').replace(/^Bearer /,''));if(!a)throw new AppError('runtime_unauthorized','任务执行凭证已失效',403);return a;}
function runtime(req,token){const key=token||(req.headers.authorization||'').replace(/^Bearer /,'');const a=engine.tokens.get(key);if(!a||a.controller.signal.aborted)throw new AppError('runtime_unauthorized','任务执行凭证已失效',403);if(!a.probe)engine.authorizeRuntime(a);return a;}
function localResumeInput(id,input={}){
  const task=store.task(id);if(!task.remoteDeviceId)return input;
  const live=remote.status();requireValue(live.control?.paused===false,'手机已暂停，请先在手机明确继续','phone_paused');
  requireValue(live.deviceTelemetry?.fresh&&live.deviceTelemetry.deviceId===task.remoteDeviceId&&live.connection?.dataConnected&&live.connection?.controlConnected,'手机状态尚未确认，请先恢复连接','phone_unavailable');
  return {...input,remoteDeviceId:task.remoteDeviceId,remoteControlEpoch:live.control.controlEpoch};
}
// The list view never reads these per-task bookkeeping fields; the task detail
// endpoint still returns them. With hundreds of tasks they made /api/state ~4 MB,
// refetched on every change event.
const LIST_OMIT=Object.fromEntries(['modelUsageReceipts','taskContract','timeline','contextStats','delegationGrant','phoneUseScope','crossEnd','semanticPurchase','phoneRecovery'].map(k=>[k,undefined]));
function snapshot(){return {revision:store.data.revision,roles:store.data.roles,tasks:store.data.tasks.filter(t=>t.source!=='watch').map(t=>({...t,groupId:groupTaskContext(t,store)?.groupId||null,preview:t.messages.at(-1)?.content?.slice(0,150)||t.result||t.prompt,messages:undefined,events:undefined,...LIST_OMIT})),routines:store.data.routines,watches:(store.data.watches||[]).filter(w=>['active','paused'].includes(w.status)).map(watchSummary),approvals:store.data.approvals.filter(a=>a.status==='pending'),artifacts:store.data.artifacts,settings:publicSettings(store.data.settings),usage:store.data.usage,modelBudget:modelBudgetStatus(store.data),platforms:PLATFORMS,memoryQueue:store.data.outbox.length,schedulerPaused:store.data.schedulerPaused};}
watchPetStatus(store,DATA);
store.on('change',({revision})=>{for(const res of subscribers)res.write(`data: ${JSON.stringify({revision})}\n\n`);});

// After finish_task the Harness turn should end without another paid model call
// and without killing the session (it is kept for the conversation's next task).

const MODEL_FIRST_BYTE_MS=35000;
// 0 (the default) leaves the number of model calls in one run to the model;
// the daily request ceiling still bounds spending.
function runRequestCapReached(a){const cap=store.data.settings.maxModelRequests;return Number.isSafeInteger(cap)&&cap>0&&a.requests>=cap;}
async function modelProxy(req,res,token){
  const ending=engine.tokens.get(token);
  if(ending?.softFinished){let stream=true;try{stream=(await body(req,24*1024*1024)).stream!==false;}catch{}return syntheticTurnEnd(res,stream);}
  const a=runtime(req,token);if(a.probe)throw new AppError('probe_no_inference','诊断不会调用付费模型',403);
  const t=store.task(a.taskId);requireValue(t.cloudConsent&&['running','waiting_approval'].includes(t.status),'本任务没有有效模型请求授权');
  if(runRequestCapReached(a)){store.event(t.id,'model_limit','本轮模型请求已达到上限',{code:'request_budget'});throw new AppError('request_budget','本轮模型请求已达到上限',429);}
  const data=await body(req,24*1024*1024);requireValue(data.model==='deepseek-flash','模型不在本次配置范围内');
  const key=await secrets.get('deepseek');if(!key)throw new AppError('missing_credential','模型凭证尚未配置',503);
  runtime(req,token);
  // Credential/body reads yield; reserve the request only after the final live
  // authorization check, with no await between the budget check and reservation.
  if(runRequestCapReached(a))throw new AppError('request_budget','本轮模型请求已达到上限',429);
  const requestNumber=a.requests+1,requestId=randomUUID();
  try{store.updateTask(t.id,(row,s)=>{reserveModelBudget(s,{id:requestId,source:'task',taskId:t.id});row.requests++;s.usage.requests++;row.modelUsageReceipts||=[];row.modelUsageReceipts.push({id:requestId,requestNumber,attempt:t.attempt,startedAt:now(),status:'pending'});});}catch(error){if(error.code==='daily_request_budget')store.event(t.id,'model_limit',error.message,{code:error.code});throw error;}a.requests=requestNumber;
  // Full mode passes the Harness's own output size through; a request without one gets the normal size instead of failing.
  if(!(Number.isSafeInteger(data.max_tokens)&&data.max_tokens>0))data.max_tokens=MAX_OUTPUT_TOKENS;
  // Full Harness mode keeps the last four screens so the model can compare steps.
  const prunedImages=store.data.settings.keepAllScreenshots===true?0:pruneOldImages(data,{keep:4});
  const requestBody=JSON.stringify(data),requestStats=modelRequestStats(data,requestBody);
  const errorChunks=[];let errorBytes=0;
  const started=Date.now();let firstByteMs=null,httpStatus=null,errorCode=null,usageMeter=null,transportComplete=false;
  const abort=new AbortController();const cancel=()=>abort.abort();a.controller.signal.addEventListener('abort',cancel,{once:true});res.on('close',cancel);
  // DeepSeek sometimes accepts a request and then sends nothing for minutes when it
  // is overloaded. With no first byte within 35 s the request is dropped, so
  // the Harness retries instead of the task looking frozen.
  // The same applies when a stream stops mid-way: no new chunk for 35 s drops it.
  let silent=false,firstByteTimer=setTimeout(()=>{silent=true;abort.abort();},MODEL_FIRST_BYTE_MS);
  const heard=()=>{clearTimeout(firstByteTimer);firstByteTimer=setTimeout(()=>{silent=true;abort.abort();},MODEL_FIRST_BYTE_MS);};
  try{
    // A connection that never opens (DNS, a dropped route, a connect timeout) has sent
    // nothing to the model, so it is tried again here before the Harness sees a failed
    // request. A request that reached DeepSeek is never repeated at this layer.
    let upstream;
    for(let connect=0;;connect++){
      try{upstream=await fetch('https://api.deepseek.com/anthropic/v1/messages',{method:'POST',headers:{'Content-Type':'application/json','x-api-key':key,'anthropic-version':'2023-06-01'},body:requestBody,signal:AbortSignal.any([a.controller.signal,abort.signal,AbortSignal.timeout(600000)])});break;}
      catch(error){
        const unopened=error?.name==='TypeError'&&['UND_ERR_CONNECT_TIMEOUT','ECONNREFUSED','ENOTFOUND','EAI_AGAIN','ENETUNREACH','EHOSTUNREACH','ECONNRESET','ETIMEDOUT'].includes(error.cause?.code);
        if(!unopened||connect>=2||a.controller.signal.aborted||abort.signal.aborted)throw error;
        heard();await new Promise(resolve=>setTimeout(resolve,400*(connect+1)));
      }
    }
    usageMeter=new AnthropicUsageMeter({contentType:upstream.headers.get('content-type')||'application/json'});
    httpStatus=upstream.status;if(!upstream.ok)errorCode='upstream_http';res.writeHead(upstream.status,{'Content-Type':upstream.headers.get('content-type')||'application/json','Cache-Control':'no-store'});
    const draft=upstream.ok&&/text\/event-stream/i.test(upstream.headers.get('content-type')||'')?liveDrafts.stream(t.id):null;
    // Keep-alive pings do not count as progress; real deltas (text, thinking, tool
    // input) and the message frames do.
    for await(const chunk of upstream.body){if(firstByteMs===null||!/^(?:\s*(?:event:\s*ping|data:\s*\{"type":\s*"ping"\}|:[^\n]*)\s*)+$/.test(Buffer.from(chunk).toString('utf8')))heard();if(!upstream.ok&&errorBytes<2048){const prefix=Buffer.from(chunk).subarray(0,2048-errorBytes);errorChunks.push(prefix);errorBytes+=prefix.length;}usageMeter.push(chunk);try{draft?.push(chunk);}catch{}if(firstByteMs===null)firstByteMs=Date.now()-started;if(!res.write(chunk))await once(res,'drain',{signal:AbortSignal.any([a.controller.signal,abort.signal])});}transportComplete=true;res.end();
  }catch(error){errorCode=silent?'upstream_silent':error.name==='AbortError'?'aborted':'request_failed';throw error;}finally{clearTimeout(firstByteTimer);
    // An overloaded or silent DeepSeek (5xx, 429, no first byte) did no work for the
    // task: it does not use up the turn's step budget, and the chat says what is going on.
    const upstreamBusy=httpStatus>=500||httpStatus===429||silent;
    if(upstreamBusy){a.requests=Math.max(0,a.requests-1);try{store.updateTask(t.id,row=>{row.requests=Math.max(0,(row.requests||0)-1);const last=(row.events||[]).findLast(e=>e.type==='model_busy');if(!last||Date.now()-Date.parse(last.at)>60000)row.events.push({id:randomUUID(),at:now(),type:'model_busy',text:'DeepSeek 暂时繁忙，正在自动重试',httpStatus:httpStatus||null});});}catch{}try{liveDrafts.update(t.id,'DeepSeek 暂时繁忙，正在自动重试…');}catch{}}
    if(httpStatus>=400)log('model_error',JSON.stringify({taskId:t.id,requestNumber,httpStatus,...requestStats,responsePreview:modelErrorPreview(Buffer.concat(errorChunks))}));a.controller.signal.removeEventListener('abort',cancel);res.off('close',cancel);commitModelUsage(store,t.id,requestId,(usageMeter||new AnthropicUsageMeter()).finish({transportComplete}));store.event(t.id,'model_timing','模型请求耗时',{requestNumber,attempt:t.attempt,durationMs:Date.now()-started,prunedImages,firstByteMs,httpStatus,errorCode,...requestStats});}
}
async function api(req,res,url){
  const pathname=url.pathname;
  if(pathname==='/api/session'&&req.method==='GET'){
    const sid=randomBytes(32).toString('hex');const session={csrf:randomBytes(32).toString('hex'),expires:Date.now()+86400000};
    for(const [key,s] of sessions)if(s.expires<Date.now())sessions.delete(key);if(sessions.size>128)sessions.delete(sessions.keys().next().value);sessions.set(sid,session);
    res.setHeader('Set-Cookie',`boujoy_session=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`);return json(res,200,{csrf:session.csrf});
  }
  auth(req);
  if(req.method==='GET'){
  if(pathname==='/api/groups')return json(res,200,{groups:groups.list({trustedLocal:true})});
    const groupRead=pathname.match(/^\/api\/groups\/([\w-]+)$/);if(groupRead)return json(res,200,groups.detail(groupRead[1],{trustedLocal:true}));
    if(pathname==='/api/image-retention')return json(res,200,imageRetention.status());
    if(pathname==='/api/voice/status')return json(res,200,voice.status());
    if(pathname==='/api/event-rules')return json(res,200,{rules:eventTriggers.list()});
    if(pathname==='/api/monitors')return json(res,200,{monitors:eventMonitor.list()});
    if(pathname==='/api/workflows')return json(res,200,{workflows:broker.workflows.list()});
    const workflowMatch=pathname.match(/^\/api\/workflows\/([a-f0-9-]{36})$/);if(workflowMatch){const row=broker.workflows.read(workflowMatch[1]);return json(res,200,{id:row.id,name:row.title,status:row.status,definition:row.definition,verifiedSamples:row.outcomes.filter(o=>o.verified).length});}
    if(pathname==='/api/connectors')return json(res,200,{connections:connectors.list()});
    if(pathname==='/api/remote/status')return json(res,200,remote.status());
    if(pathname==='/api/search'){const query=(url.searchParams.get('q')||'').trim().toLowerCase();requireValue(query.length>=1&&query.length<=200,'搜索词无效');const contains=value=>typeof value==='string'&&value.toLowerCase().includes(query);const results=[];for(const t of store.data.tasks){for(const message of t.messages||[])if(contains(message.content)){results.push({type:'message',id:message.id,taskId:t.id,title:t.title,snippet:message.content.slice(Math.max(0,message.content.toLowerCase().indexOf(query)-60),Math.max(0,message.content.toLowerCase().indexOf(query)-60)+240),at:message.at});if(results.length>=100)break;}if(results.length>=100)break;}for(const [type,rows] of [['role',store.data.roles],['routine',store.data.routines],['artifact',store.data.artifacts]])for(const row of rows)if(contains(row.name)||contains(row.prompt)||contains(row.description))results.push({type,id:row.id,taskId:row.taskId,title:row.name,snippet:row.prompt||row.description||row.name,at:row.createdAt});return json(res,200,{results:results.slice(0,100)});}
    if(pathname==='/api/memory/status')return json(res,200,await memory.health());
    if(pathname==='/api/memory/personal')return json(res,200,memory.personal?await memory.personal.list():{items:[],available:false});
    if(pathname==='/api/memory/proposals')return json(res,200,{proposals:memory.proposals()});
    if(pathname==='/api/state')return json(res,200,url.searchParams.get('view')==='roles'?{revision:store.data.revision,roles:store.data.roles,settings:publicSettings(store.data.settings),approvals:store.data.approvals.filter(a=>a.status==='pending')}:snapshot());
    if(pathname==='/api/workbench')return json(res,200,{bots:workbench(store)});
    if(pathname==='/api/health')return json(res,200,{app:DISTRIBUTION.productName,version:APP_VERSION,buildIdentity:BUILD_IDENTITY,pid:process.pid,startedAt:SERVER_STARTED_AT,harness:{version:harnessVersion(),connected:harnessVersion()==='0.2.1-alpha.2'},credentials:await secrets.status(),memory:await memory.health(),phone:{enabled:store.data.settings.phoneEnabled,device:phoneDeviceLabel(store.data.settings)},uptimeSeconds:Math.round(process.uptime()),storage:typeof store.writeSummary==='function'?store.writeSummary():null,localOnly:true,power:power.status(),execution:{phonePreflight:typeof preflightPhone==='function',stableObservation:typeof phone.observeStable==='function',phoneQueryObservation:typeof phone.observeQuery==='function',phoneUse:typeof phone.observeUse==='function',installedApps:typeof phone.listApps==='function',checkoutHandoff:TOOL_DEFINITIONS.find(t=>t.name==='finish_task').inputSchema.properties.outcome.enum.includes('ready_for_user')}});
    if(pathname==='/api/phone/status')return json(res,200,await phone.status());
    if(pathname==='/api/phone/devices'){const found=await phone.devices({refresh:false});rememberPhoneDevice(store,found);return json(res,200,publicPhoneDevices(found));}
    if(pathname==='/api/events'){
      res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','Connection':'keep-alive'});res.write('data: {}\n\n');subscribers.add(res);const timer=setInterval(()=>res.write(': keepalive\n\n'),15000);req.on('close',()=>{clearInterval(timer);subscribers.delete(res);});return;
    }
    let m=pathname.match(/^\/api\/tasks\/([\w-]+)$/);if(m){const t=store.task(m[1]),siblings=conversationSiblings(t,store);return json(res,200,{...t,liveDraft:engine.active.has(t.id)?liveDrafts.get(t.id)?.text||'':'',liveThinking:engine.active.has(t.id)?liveDrafts.get(t.id)?.thinking||'':'',comparisons:compareQuotes(t.quotes,{kind:t.kind}),artifacts:store.data.artifacts.filter(a=>a.taskId===t.id),conversationArtifacts:store.data.artifacts.filter(a=>siblings.some(row=>row.id===a.taskId)),conversation:{id:t.conversationId||t.id,taskIds:siblings.map(row=>row.id),latestTaskId:siblings.at(-1)?.id||t.id,messages:siblings.flatMap(row=>conversationMessages(row,t))}});}
    m=pathname.match(/^\/api\/artifacts\/([\w-]+)$/);if(m){const a=store.data.artifacts.find(a=>a.id===m[1]);if(!a)throw new AppError('not_found','文件不存在',404);const root=fs.realpathSync(path.join(DATA,'artifacts')),file=fs.realpathSync(path.resolve(DATA,'artifacts',a.path));requireValue(file.startsWith(root+path.sep)&&fs.statSync(file).isFile(),'文件路径无效');const play=url.searchParams.get('play')==='1'&&a.mime==='audio/wav'&&a.kind==='speech';if(play)requireValue(fs.statSync(file).size===a.size&&createHash('sha256').update(fs.readFileSync(file)).digest('hex')===a.sha256,'朗读文件已变化');
      // Photos, video, audio and PDF can be viewed in the chat: an allow-listed type, sandboxed, never sniffed.
      const view=url.searchParams.get('inline')==='1'?INLINE_TYPES[String(a.mime||'').toLowerCase()]||INLINE_TYPES[path.extname(a.name||'').toLowerCase()]:null;
      const type=play?'audio/wav':view||'application/octet-stream',size=fs.statSync(file).size,headers={'Content-Type':type,'Content-Disposition':`${play||view?'inline':'attachment'}; filename*=UTF-8''${encodeURIComponent(a.name)}`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':'sandbox; default-src \'none\'; img-src \'self\'; media-src \'self\'','Accept-Ranges':'bytes'};
      const range=/^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range||''));
      if(range&&(range[1]||range[2])){let start=range[1]?Number(range[1]):Math.max(0,size-Number(range[2])),end=range[1]&&range[2]?Math.min(Number(range[2]),size-1):size-1;if(!(start<=end&&start<size)){res.writeHead(416,{'Content-Range':`bytes */${size}`});return res.end();}res.writeHead(206,{...headers,'Content-Range':`bytes ${start}-${end}/${size}`,'Content-Length':end-start+1});return fs.createReadStream(file,{start,end}).on('error',()=>res.destroy()).pipe(res);}
      res.writeHead(200,{...headers,'Content-Length':size});return fs.createReadStream(file).on('error',()=>res.destroy()).pipe(res);}
    throw new AppError('not_found','接口不存在',404);
  }
  if(req.method!=='POST')throw new AppError('method','不支持此操作',405);
  if(pathname==='/api/image-retention')return json(res,200,imageRetention.configure(await body(req)));
  if(pathname==='/api/uploads'){return json(res,201,await receiveUpload(req,{dataDir:DATA,name:url.searchParams.get('name'),mime:url.searchParams.get('mime'),uploads}));}
  if(pathname==='/api/chat/submit'){const input=await body(req,12*1024*1024);return json(res,201,await withCrossEnd({endpoint:'mac'},()=>localUploads.submit(input),{resumeInput:localResumeInput}));}
  if(pathname==='/api/voice/transcribe'){const input=await body(req,12*1024*1024);return json(res,200,await voiceRequest(req,res,signal=>voice.transcribeUpload(input,{signal})));}
  const data=await body(req);
  for(const key of ['inputArtifacts','inputDigest','remoteDeviceId','remoteExpiresAt','remoteControlEpoch','eventRuleId','eventReceiptId','eventAuthorization','eventData','source','parentId','depth','routineId','routineTest','routineAuthorization','delegationGrant'])delete data[key];
  const groupControl=pathname.match(/^\/api\/groups\/([\w-]+)\/tasks\/([\w-]+)\/(pause|resume)$/);if(groupControl){const live=groupControl[3]==='resume'?localResumeInput(groupControl[2]):{};return json(res,200,await groups.control(groupControl[1],groupControl[2],groupControl[3],{trustedLocal:true,clientRequestId:data.clientRequestId,deviceId:live.remoteDeviceId,remoteControlEpoch:live.remoteControlEpoch}));}
  const groupArchive=pathname.match(/^\/api\/groups\/([\w-]+)\/archive$/);if(groupArchive)return json(res,200,groups.archive(groupArchive[1],data,{trustedLocal:true}));
  if(pathname==='/api/groups')return json(res,201,groups.create(data,{trustedLocal:true}));
  const groupWrite=pathname.match(/^\/api\/groups\/([\w-]+)\/(members|messages)$/);if(groupWrite){const [,id,action]=groupWrite;return json(res,action==='messages'?201:200,action==='members'?groups.members(id,data,{trustedLocal:true}):groups.send(id,{content:data.content,replyToMessageId:data.replyToMessageId,clientRequestId:data.clientRequestId,recipientRoleIds:data.recipientRoleIds,cloudConsent:data.cloudConsent===true,memoryConsent:data.cloudConsent===true&&store.data.settings.chatMemoryConsent===true,memoryMode:store.data.settings.chatMemoryMode==='do_not_remember'?'do_not_remember':'default'},{trustedLocal:true}));}
  const speechMatch=pathname.match(/^\/api\/tasks\/([\w-]+)\/messages\/([\w-]+)\/speech$/);if(speechMatch)return json(res,200,await voiceRequest(req,res,signal=>voice.synthesizeMessage(speechMatch[1],speechMatch[2],{signal})));
  if(pathname==='/api/event-rules')return json(res,201,await eventTriggers.registerRule(data));
  if(pathname==='/api/monitors')return json(res,201,await eventMonitor.configure(data));
  const monitorMatch=pathname.match(/^\/api\/monitors\/([a-f0-9-]{36})\/(poll|remove)$/);
  if(monitorMatch){const [,id,action]=monitorMatch;return json(res,200,action==='poll'?await eventMonitor.poll(id):await eventMonitor.remove(id));}
  const eventRuleMatch=pathname.match(/^\/api\/event-rules\/([a-f0-9-]{36})(?:\/(revoke|remove))?$/);
  if(eventRuleMatch){const [,id,action]=eventRuleMatch;if(action==='revoke')return json(res,200,await eventTriggers.revokeRule(id));if(action==='remove')return json(res,200,await eventTriggers.removeRule(id));return json(res,200,await eventTriggers.updateRule(id,data));}
  if(pathname==='/api/connectors')return json(res,201,await connectors.configure(data));
  const connectorMatch=pathname.match(/^\/api\/connectors\/([a-f0-9-]{36})\/(discover|select|remove)$/);
  if(connectorMatch){const [,id,action]=connectorMatch;if(action==='discover')return json(res,200,{tools:await connectors.discover(id)});if(action==='select')return json(res,200,await connectors.select(id,data));await connectors.remove(id);return json(res,200,{removed:true});}
  if(pathname==='/api/tasks')return json(res,201,withCrossEnd({endpoint:'mac'},()=>engine.create({...data,source:'user'})));
  if(pathname==='/api/remote/configure'){const result=await remote.configure(data);syncPower();return json(res,200,result);}
  if(pathname==='/api/remote/pair'){const binding=await remote.pairing();const {default:QRCode}=await import('qrcode');return json(res,200,{binding,qr:await QRCode.toDataURL(BIND_SCHEME+'://bind?data='+encodeURIComponent(JSON.stringify(binding)),{errorCorrectionLevel:'M',width:360,margin:2})});}
  if(pathname==='/api/remote/revoke')return json(res,200,await remote.revoke());
  if(pathname==='/api/remote/pause')return json(res,200,await remote.pause());
  if(pathname==='/api/phone/type'){
    requireValue(typeof data.packageName==='string'&&data.packageName.length<=255&&/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(data.packageName),'请指定当前输入框所属的应用','phone_input_unavailable');
    // Keep the bound phone's pause gate and exact foreground-editor check in
    // the existing typing path; a submitted/unknown receipt never triggers retry.
    return json(res,200,await phone.ime.request({text:data.text,mode:data.mode||'replace',packageName:data.packageName}));
  }
  let m=pathname.match(/^\/api\/tasks\/([\w-]+)\/(stop|pause|continue|message|reconcile|archive)$/);
  if(m){const [_,id,action]=m;
    if(action==='stop'||action==='pause')await engine.stop(id,{pause:action==='pause'});
    if(action==='message')return json(res,200,await withCrossEnd({endpoint:'mac'},()=>engine.message(id,data),{resumeInput:localResumeInput}));
    if(action==='continue'){
      const task=store.task(id),context=groupTaskContext(task,store);
      if(context){
        requireValue(task.status==='waiting_consent'&&data.cloudConsent===true&&Object.keys(data).every(key=>['cloudConsent','memoryConsent','clientRequestId'].includes(key)),'群任务请通过群任务入口续跑','group_control_required');
        const group=groups.detail(context.groupId,{trustedLocal:true});
        requireValue(group.members.some(member=>member.id===task.roleId&&member.available),'助理已离群或停用','group_member_unavailable');
        data.memoryConsent=store.data.settings.chatMemoryConsent===true;data.memoryMode=store.data.settings.chatMemoryMode==='do_not_remember'?'do_not_remember':'default';
      }
      await withCrossEnd({endpoint:'mac'},()=>engine.continue(id,localResumeInput(id,data)));
    }
    if(action==='reconcile')await engine.reconcile(id,data.note);
    if(action==='archive'){const siblings=conversationSiblings(store.task(id),store);requireValue(siblings.every(row=>!engine.active.has(row.id)),'先停止任务再归档');for(const row of siblings)store.updateTask(row.id,t=>{t.archived=data.archived!==false;});}
    return json(res,200,store.task(id));
  }
  m=pathname.match(/^\/api\/approvals\/([\w-]+)$/);if(m){requireValue(typeof data.allow==='boolean','请明确允许或拒绝');approvals.resolve(m[1],data.allow);return json(res,200,{resolved:true});}
  if(pathname==='/api/roles'){
    const role=createRole(data,store.data.roles);store.transaction(s=>s.roles.push(role));return json(res,201,role);
  }
  m=pathname.match(/^\/api\/roles\/([\w-]+)\/brief$/);if(m){const notice=engine.deliverBrief(m[1]);return json(res,201,{taskId:notice?.id||null,conversationId:notice?.conversationId||null});}
  m=pathname.match(/^\/api\/roles\/([\w-]+)$/);if(m){
    const existing=store.data.roles.find(r=>r.id===m[1]);requireValue(existing,'角色不存在');
    if(data.remove)return json(res,200,await removeBot(existing.id));
    let result;store.transaction(s=>{const r=s.roles.find(r=>r.id===m[1]);if(data.remove){r.deletedAt=now();r.hidden=true;for(const rule of s.routines.filter(rule=>rule.roleId===r.id)){rule.enabled=false;rule.pausedAt=now();rule.cloudConsent=false;rule.memoryConsent=false;rule.authorization=null;}}
    else if(data.restore){r.deletedAt=null;r.hidden=false;}
    // A copy keeps the job, never the original's notes about the user or its brief conversation.
    else if(data.copy){result={...r,id:randomUUID(),name:r.name+' 副本',botColor:chooseBotColor(undefined,s.roles),createdAt:now(),hidden:false,deletedAt:null,notes:[],brief:null,briefConversationId:null};s.roles.push(result);}
    else{requireValue(!r.deletedAt,'请先恢复这个助理');if(data.botColor!==undefined)r.botColor=chooseBotColor(data.botColor);if(data.name)r.name=shortText(data.name,'角色名',40);if(data.description)r.description=shortText(data.description,'职责',240);if(data.instruction)r.instruction=shortText(data.instruction,'角色说明',4000);if(typeof data.hidden==='boolean'){requireValue(r.id!=='concierge','总助理不能隐藏');r.hidden=data.hidden;}if(data.brief!==undefined)r.brief={...briefSettings(data.brief,{timezone:effectiveTimezone(s.settings)}),lastAt:r.brief?.lastAt||null};if(typeof data.forgetNote==='string')requireValue(removeNote(r,data.forgetNote),'没有找到这条记忆');}result||=r;});return json(res,200,result);
  }
  m=pathname.match(/^\/api\/watches\/([\w-]+)$/);if(m){
    // The user pauses, resumes or removes a 持续跟进 from the sidebar.
    let row=null;store.transaction(s=>{const watch=(s.watches||[]).find(w=>w.id===m[1]&&['active','paused'].includes(w.status));requireValue(watch,'跟进不存在或已结束');
      if(data.remove){watch.status='cancelled';watch.endedAt=new Date().toISOString();}
      else{requireValue(['active','paused'].includes(data.status),'跟进状态无效');watch.status=data.status;if(data.status==='active'){watch.failures=0;watch.pausedAt=null;watch.pauseReason=null;watch.nextAt=new Date(Date.now()+60000).toISOString();}else watch.pausedAt=new Date().toISOString();}
      row=watchSummary(watch);});
    return json(res,200,row);
  }
  if(pathname==='/api/routines'){
    const routine=createRoutine(data);requireValue(store.data.roles.some(r=>r.id===routine.roleId),'角色不存在');routine.taskKind=data.taskKind==='reminder'?'reminder':'general';store.transaction(s=>s.routines.push(routine));return json(res,201,routine);
  }
  m=pathname.match(/^\/api\/routines\/([\w-]+)$/);if(m){
    if(data.test){const r=store.data.routines.find(r=>r.id===m[1]);requireValue(r,'事务不存在');return json(res,201,engine.create(routineTaskInput(r,{sourceTest:true})));}
    const before=store.data.routines.find(r=>r.id===m[1]);requireValue(before,'事务不存在');if(data.remove||data.enabled===false||['prompt','roleId','taskKind','cloudConsent','memoryConsent','authorizationExpiresAt'].some(key=>Object.hasOwn(data,key)))await engine.revokeRoutineTasks(m[1]);
    store.transaction(s=>{const r=s.routines.find(r=>r.id===m[1]);requireValue(r,'事务不存在');if(data.remove){s.routines=s.routines.filter(r=>r.id!==m[1]);return;}if(data.roleId)requireValue(s.roles.some(role=>role.id===data.roleId&&!role.hidden),'助理不存在或已隐藏');if(data.taskKind)requireValue(['general','reminder'].includes(data.taskKind),'事务类型无效');Object.assign(r,updateRoutine(r,data));});return json(res,200,{saved:true});
  }
  if(pathname==='/api/settings'){
    for(const field of Object.values(EXECUTION_DOMAINS))if(Object.hasOwn(data,field))requireValue(typeof data[field]==='boolean','执行开关必须是布尔值');
    requireValue(!store.data.recoveryFence?.required||!Object.values(EXECUTION_DOMAINS).some(field=>data[field]===true),'恢复隔离尚未解除，不能开启执行权限','recovery_fenced');
    if(data.memoryTaskId){requireValue(typeof data.chatMemoryConsent==='boolean','缺少记忆设置');const target=store.task(shortText(data.memoryTaskId));store.updateTask(target.id,t=>{t.memoryConsent=data.chatMemoryConsent&&t.cloudConsent;t.memoryMode=data.chatMemoryMode==='do_not_remember'?'do_not_remember':'default';});}
    if(data.phoneExecutionMode!==undefined){requireValue(BACKGROUND_SUPPORTED||data.phoneExecutionMode!=='background','通用 Phone Use 版只支持主屏执行','background_not_supported');requireValue(['main','background'].includes(data.phoneExecutionMode),'手机执行方式无效');requireValue(!phone.lease&&!engine.active.size,'手机正在执行任务，结束后再切换执行方式','phone_busy');}
    const leavingBackground=data.phoneExecutionMode==='main'&&store.data.settings.phoneExecutionMode==='background';
    store.transaction(s=>{if(data.phoneExecutionMode!==undefined)s.settings.phoneExecutionMode=data.phoneExecutionMode;if(data.dailyModelRequests!==undefined){requireValue(Number.isSafeInteger(data.dailyModelRequests)&&data.dailyModelRequests>=0&&data.dailyModelRequests<=100000,'每日模型请求额度应为0至100000次');s.settings.dailyModelRequests=data.dailyModelRequests;}if(data.chatMemoryMode!==undefined){requireValue(['default','do_not_remember'].includes(data.chatMemoryMode),'记忆保存方式无效');s.settings.chatMemoryMode=data.chatMemoryMode;}if(data.modelReasoning!==undefined){requireValue(REASONING_OPTIONS.some(o=>o.value===data.modelReasoning),'推理强度应为 auto、off、low、high 或 max');s.settings.modelReasoning=data.modelReasoning;}if(data.timezone!==undefined){requireValue(data.timezone==='auto'||validTimezone(data.timezone),'时区无效，请填写如 America/Los_Angeles 的 IANA 时区或 auto');s.settings.timezoneManual=data.timezone!=='auto';if(data.timezone!=='auto')s.settings.timezone=data.timezone;}for(const field of ['quiet','keepAwakeOnAC','memoryEnabled','chatCloudConsent','chatMemoryConsent','harnessPersistent','modelWatchdogEnabled','superagentEnabled','watchesEnabled','routerEnabled'])if(typeof data[field]==='boolean')s.settings[field]=data[field];for(const field of ['maxConcurrent','maxModelRequests','maxTaskMinutes'])if(data[field]!==undefined){requireValue(Number.isSafeInteger(data[field])&&data[field]>=(['maxTaskMinutes','maxModelRequests'].includes(field)?0:1)&&data[field]<=100000,'数值超出范围');s.settings[field]=data[field];}});
    const permissions=Object.values(EXECUTION_DOMAINS).some(field=>Object.hasOwn(data,field))?await setExecutionPermissions({store,engine,phone,browser},data):null;if(data.keepAwakeOnAC!==undefined)syncPower();if(leavingBackground)void phone.displayUse?.closeSession();return json(res,200,{saved:true,...(permissions?{execution:permissions}:{})});
  }
  // Local, CSRF-protected restart so code updates can be loaded without a Terminal
  // trip. Refused while anything is executing; launchd (KeepAlive) starts the
  // service again within its throttle interval.
  if(pathname==='/api/service/restart'){
    requireValue(engine.active.size===0&&!store.data.tasks.some(t=>['running','queued','waiting_approval','waiting_children'].includes(t.status))&&![...(broker._localAgents?.jobs.values()||[])].some(j=>j.status==='running'),'还有任务或本机 Agent 在执行，暂不重启','service_busy');
    const own=startSuccessor(SERVER_FILE);log('service','restart requested from local UI'+(own?' (starting its own successor)':''));setTimeout(()=>process.exit(0),300).unref?.();return json(res,200,{restarting:true});
  }
  if(pathname==='/api/secrets'){const result=await secrets.set(data.name,data.value);return json(res,200,result);}
  if(pathname==='/api/memory/connect'){await memory.start();return json(res,200,await memory.health());}
  if(pathname==='/api/memory/context'){const query=shortText(data.query);const [knowledge,personal]=await Promise.all([memory.context(query),memory.personal?memory.personal.context(query):{context:''}]);return json(res,200,{...knowledge,personal,context:[personal.context,knowledge.context].filter(Boolean).join('\n\n')});}
  if(pathname==='/api/memory/personal/review'){requireValue(['confirm','reject'].includes(data.action),'记忆操作无效');requireValue(memory.personal,'这台电脑没有安装个人记忆核心','personal_memory_unavailable');return json(res,200,await memory.personal.call(data.action,{id:shortText(data.id)}));}
  m=pathname.match(/^\/api\/memory\/proposals\/(memory-[a-f0-9-]{36})\/review$/);
  if(m)return json(res,200,await memory.review(m[1],data));
  if(pathname==='/api/phone/preflight'){requireValue(engine.active.size===0&&!store.data.tasks.some(t=>['running','queued','waiting_approval'].includes(t.status)),'手机正在执行任务，不能同时预检');return json(res,200,await preflightPhone(phone,{platform:data.platform||'taobao'}));}
  if(pathname==='/api/phone/pair')return json(res,200,await pairPhoneSetup(phone,store,engine,data));
  if(pathname==='/api/diagnostics/harness'){
    const token=randomBytes(32).toString('hex');const id='probe-'+randomUUID();const controller=new AbortController();engine.tokens.set(token,{taskId:id,controller,probe:true});
    const run=new HarnessRun({task:{id},profile:'sdk',role:null,token,origin:ORIGIN,onLog:text=>log('probe',text.replaceAll(token,'[runtime-token]'))});
    try{const info=await run.start({probe:true});return json(res,200,{connected:true,info,extras:{active:!!run.extrasActive,...harnessExtrasStatus()},modelRequests:0});}finally{await run.dispose();engine.tokens.delete(token);}
  }
  throw new AppError('not_found','接口不存在',404);
}

const server=http.createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');res.setHeader('Permissions-Policy','camera=(), microphone=(self), geolocation=()');
  try{
    localRequest(req);const url=new URL(req.url,ORIGIN);
    const eventMatch=url.pathname.match(/^\/events\/ingest\/([a-f0-9-]{36})$/);
    if(eventMatch){requireValue(req.method==='POST','事件入口只接受 POST');const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;requireValue(size<=32768,'事件正文过大');chunks.push(chunk);}return json(res,200,await eventTriggers.receive({ruleId:eventMatch[1],rawBody:Buffer.concat(chunks),headers:{timestamp:req.headers['x-boujoy-event-time'],nonce:req.headers['x-boujoy-event-nonce'],signature:req.headers['x-boujoy-event-signature']}}));}
    if(url.pathname.startsWith('/internal/')){
      const match=url.pathname.match(/^\/internal\/model\/([a-f0-9]{64})\/v1\/messages$/);if(match&&req.method==='POST')return await modelProxy(req,res,match[1]);
      // Tool listing and its version check also serve a parked (between-task)
      // Harness session; executing a tool still requires a live, authorized task.
      if(req.method==='POST'&&['/internal/tools/version','/internal/tools/list'].includes(url.pathname)){
        const parked=runtimeToken(req);
        if(url.pathname==='/internal/tools/version')return json(res,200,{version:parked.catalogVersion||0});
        parked.syncedVersion=parked.catalogVersion||0;const task=parked.probe?null:store.task(parked.taskId);return json(res,200,{tools:parked.probe?TOOL_DEFINITIONS:broker.catalog(task)});
      }
      const active=runtime(req);
      if(req.method==='POST'&&url.pathname==='/internal/harness/native-authorize'){
        requireValue(!active.probe,'诊断不能执行工具');const b=await body(req);
        if(active.controller.signal.aborted||runtime(req)!==active)throw new AppError('cancelled','任务已停止',409);
        requireValue(typeof b.tool==='string'&&b.tool.length<200,'工具名无效');assertExecutionPermission(store,toolExecutionDomains(b.tool));
        store.event(active.taskId,'tool','原生工具：'+b.tool,{tool:b.tool,native:true});return json(res,200,{allowed:true});
      }
      if(req.method==='POST'&&url.pathname==='/internal/harness/guidance'){requireValue(!active.probe,'诊断不能读取任务');return json(res,200,broker.runtimeGuidance(active.taskId));}
      if(req.method==='POST'&&url.pathname==='/internal/harness/approval'){
        requireValue(!active.probe,'诊断不能请求操作确认');const b=await body(req);requireValue(typeof b.tool==='string'&&typeof b.summary==='string'&&b.args&&typeof b.args==='object','确认请求无效');
        try{
          await broker.approvals.request(active.taskId,{tool:'harness_native',args:{...b.args,nativeTool:b.tool},summary:b.summary,evidence:{sessionId:b.sessionId,callId:b.callId}},active.controller.signal);
          // A stop or runtime replacement can run after the approval promise
          // resumes but before this final permission response resumes.
          if(active.controller.signal.aborted||runtime(req)!==active)throw new AppError('cancelled','任务已停止',409);
          assertExecutionPermission(store,toolExecutionDomains(b.tool));
          return json(res,200,{outcome:'allowed-once'});
        }catch(error){if(error.code==='not_approved')return json(res,200,{outcome:'rejected'});if(error.code==='cancelled')return json(res,200,{outcome:'cancelled'});throw error;}
      }
      if(req.method==='POST'&&url.pathname==='/internal/tools/call'){
        requireValue(!active.probe,'诊断模式不能执行任务工具');const b=await body(req);try{return json(res,200,await broker.execute(active.taskId,b.name,b.arguments||{},active.controller.signal));}catch(e){return json(res,200,{isError:true,content:[{type:'text',text:JSON.stringify(safeError(e))}]});}
      }
      throw new AppError('not_found','接口不存在',404);
    }
    if(url.pathname.startsWith('/api/'))return await api(req,res,url);
    if(req.method!=='GET')throw new AppError('method','不支持此操作',405);
    const files={'/':'index.html','/app.js':'app.js','/groups.js':'groups.js','/groups.css':'groups.css','/robot-motion.js':'robot-motion.js','/robot-head-base.png':'assets/robot-head-base.png','/robot-eyes-atlas.png':'assets/robot-eyes-atlas.png','/app.css':'app.css','/icon.svg':'icon.svg'};const file=files[url.pathname]||(/^\/icons\/[a-z0-9-]+\.svg$/.test(url.pathname)&&fs.existsSync(path.join(ROOT,'web',url.pathname.slice(1)))?url.pathname.slice(1):null);if(!file)throw new AppError('not_found','页面不存在',404);
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'");
    res.setHeader('Content-Type',file.endsWith('.html')?'text/html; charset=utf-8':file.endsWith('.css')?'text/css':file.endsWith('.svg')?'image/svg+xml':file.endsWith('.png')?'image/png':'text/javascript');res.setHeader('Cache-Control','no-cache');res.end(fs.readFileSync(path.join(ROOT,'web',file)));
  }catch(e){log('request',e.code||e.message);if(!res.headersSent)json(res,e.status||500,{error:safeError(e)});else res.destroy();}
});
server.requestTimeout=300000;server.headersTimeout=10000;
server.on('error',e=>{log('server',e.code);store.close();process.exitCode=1;});
server.listen(PORT,HOST,async()=>{console.log(`Boujoy Personal Agent: ${ORIGIN}`);await remote.start().catch(()=>log('remote','startup_unavailable'));syncPower();scheduler.start();eventMonitor.start();imageRetention.start();engine.pump();memory.start().catch(e=>log('memory',e.code));});
const memoryTimer=setInterval(()=>engine.flushMemory(),5000);memoryTimer.unref();
let stopping=false;async function shutdown(){if(stopping)return;stopping=true;groups.close();imageRetention.close();power.close();scheduler.stop();eventMonitor.close();clearInterval(memoryTimer);voice.close();for(const r of subscribers)r.end();await engine.shutdown();await remote.close();await connectors.close();memory.close();server.close();server.closeAllConnections();store.close();}
process.on('SIGTERM',()=>shutdown().then(()=>process.exit(0)));process.on('SIGINT',()=>shutdown().then(()=>process.exit(0)));
process.on('uncaughtException',e=>{log('fatal',e.message);shutdown().then(()=>process.exit(1));});
