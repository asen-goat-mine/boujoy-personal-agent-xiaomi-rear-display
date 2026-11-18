import {DISTRIBUTION,ANDROID_PACKAGE,BACKGROUND_SUPPORTED} from '../distribution.mjs';
import {reasoningSettings,setReasoning} from '../core/reasoning-settings.mjs';
import {approvalView} from '../core/approval-view.mjs';
import {sendArtifact} from './artifact-transfer.mjs';
import {withCrossEnd,messageOwnedBy,crossEndSummary} from '../core/cross-end.mjs';
import {groupTaskContext} from '../core/groups.mjs';
import {imagePreview} from './image-preview.mjs';
import https from 'node:https';
import {gzipSync} from 'node:zlib';
import {mobileRoles,mutateMobileRole} from './mobile-roles.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID,X509Certificate} from 'node:crypto';
import {AppError,requireValue} from '../core/errors.mjs';
import {hash,assert} from './protocol.mjs';
import {BrowserWorkspace} from './browser-workspace.mjs';
import {ChatUploads} from './chat-uploads.mjs';
import {AttachmentBridge} from './attachment-bridge.mjs';
import {Demonstrations} from './demonstration.mjs';
import {PhoneTyping} from './phone-typing.mjs';
import {DisplayCommands,sanitizeDisplayBackend} from './display-commands.mjs';
import {taskPhase} from '../core/task-phase.mjs';
import {taskProgress} from '../core/task-progress.mjs';
import {inputVerificationTarget} from '../adapters/phone-input-verification.mjs';
import {validateAttachments,stageAttachments} from '../core/input-files.mjs';
import {requestHash,taskDeadline,validateTaskContract} from '../core/task-contract.mjs';
import {assertCollaborationClear} from '../core/collaboration-roster.mjs';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const json=(res,code,value)=>{
 const raw=Buffer.from(JSON.stringify(value));
 const acceptsGzip=String(res.req?.headers['accept-encoding']||'').split(',').some(entry=>{
  const [name,...parameters]=entry.trim().toLowerCase().split(';');
  const q=parameters.find(part=>part.trim().startsWith('q='));
  const quality=q==null?1:Number(q.trim().slice(2));
  return name.trim()==='gzip'&&Number.isFinite(quality)&&quality>0&&quality<=1;
 });
 const compressed=acceptsGzip&&raw.length>=1024?gzipSync(raw,{level:1}):null;
 const body=compressed&&compressed.length<raw.length?compressed:raw;
 res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Vary':'Accept-Encoding','Content-Length':body.length,...(body!==raw?{'Content-Encoding':'gzip'}:{})});
 res.end(body);
};
async function body(req,limit=6*1024*1024){const chunks=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>limit)throw new AppError('too_large','附件或消息过大',413);chunks.push(chunk);}let value;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}catch{throw new AppError('invalid_json','请求格式无效',400);}requireValue(value&&typeof value==='object'&&!Array.isArray(value),'请求格式无效');return value;}
// Android completes a synchronous upload before reading its response. Closing
// an early 403 while it is still writing can turn the precise authentication
// error into EOF/EPIPE. Discard only a declared, bounded body; never parse it,
// buffer it, authorize it, or wait indefinitely for a malicious/stalled sender.
const REJECT_DRAIN_MS=10000;
async function discardRejectedBody(req){
 if(req.readableEnded||req.complete||req.destroyed)return;
 const length=req.headers['content-length'],limit=['/v1/messages','/v1/voice/transcribe'].includes(req.url)?12*1024*1024:6*1024*1024;
 if(req.headers['transfer-encoding']||typeof length!=='string'||!/^\d{1,8}$/.test(length)||Number(length)>limit||Number(length)===0)return;
 await new Promise(resolve=>{
  let bytes=0,done=false;
  const finish=()=>{if(done)return;done=true;clearTimeout(timer);req.off('data',onData);req.off('end',finish);req.off('aborted',finish);req.off('error',finish);req.off('close',finish);req.pause();resolve();};
  const onData=chunk=>{bytes+=chunk.length;if(bytes>limit)finish();};
  const timer=setTimeout(finish,REJECT_DRAIN_MS);timer.unref?.();
  req.on('data',onData);req.once('end',finish);req.once('aborted',finish);req.once('error',finish);req.once('close',finish);req.resume();
 });
}
function fingerprint(req){const raw=req.socket.getPeerCertificate()?.raw;requireValue(raw,'需要绑定设备证书','device_certificate_required');const cert=new X509Certificate(raw);requireValue(Date.parse(cert.validFrom)<=Date.now()&&Date.parse(cert.validTo)>Date.now(),'设备证书已过期','device_certificate_expired');return createHash('sha256').update(raw).digest('hex');}
function timestamp(value){return typeof value==='number'?value:Date.parse(value);}
const RESTARTABLE=new Set(['paused','blocked','failed','interrupted','expired','needs_review']);
function restartGoal(task,store){
 if(groupTaskContext(task,store))return null;
 if(!RESTARTABLE.has(task.status)||!Number.isFinite(taskDeadline(task))||taskDeadline(task)>Date.now()||task.cloudConsent!==true||task.source&&task.source!=='user'||task.parentId||(task.depth||0)>0)return null;
 if(store?.data.actions.some(action=>action.taskId===task.id&&['unknown','executing'].includes(action.status)&&!action.resolution))return null;
 try{assertCollaborationClear(store,task.id);}catch{return null;}
 // Verify the original source at its last valid instant. This does not revive
 // execution authority; the new explicit click creates a new contract below.
 const checked=validateTaskContract(task,{at:taskDeadline(task)-1,store});if(!checked.valid)return null;
 const goal=String(checked.contract.goal||'').replace(/^(?:重新执行[：:]\s*)+/,'').trim();return goal&&goal.length<=199990?goal:null;
}
function canReconcile(task,store){
 const unresolved=store?.data.actions.filter(a=>a.taskId===task.id&&['unknown','executing'].includes(a.status)&&!a.resolution)||[];
 return task.status==='unknown_result'&&unresolved.length>0&&unresolved.every(a=>a.status==='unknown'&&(a.tool==='phone_open_app'&&a.nativeRequestId&&a.nativeDeviceId||inputVerificationTarget(task,a)));
}
function conversationTask(store,id){const selected=store.task(id);return (selected.conversationId||selected.id)===selected.id?store.data.tasks.filter(t=>(t.conversationId||t.id)===selected.id).at(-1)||selected:selected;}
function conversationMessages(store,task){const key=task.conversationId||task.id;return store.data.tasks.filter(t=>(t.conversationId||t.id)===key).flatMap(t=>t.messages||[]);}
// The phone gets the latest 150 tasks plus every older one that still needs it:
// running, queued, paused, or waiting for an approval. History beyond that is not sent.
const PHONE_LIVE=new Set(['queued','running','waiting_approval','waiting_children','paused','interrupted','unknown_result','needs_review']);
export function phoneTaskWindow(tasks,store){
 const recent=new Set(tasks.slice(-150)),pending=new Set((store.data.approvals||[]).filter(a=>a.status==='pending').map(a=>a.taskId));
 const older=tasks.filter(t=>!recent.has(t)&&(PHONE_LIVE.has(t.status)||pending.has(t.id))).slice(-100);
 return older.length?[...older,...tasks.slice(-150)]:tasks.slice(-150);
}
// The phone refuses a state reply above 8 MiB, which used to stop syncing altogether once
// many long results had piled up. Past a 4 MB budget the oldest finished tasks carry a
// short preview instead of their whole result; opening one still loads it in full.
export const STATE_TASK_BUDGET=4*1024*1024;
export function boundTaskSummaries(rows,budget=STATE_TASK_BUDGET){
 const size=row=>Buffer.byteLength(String(row.result||''))+Buffer.byteLength(String(row.preview||''));
 let total=rows.reduce((sum,row)=>sum+size(row)+600,0);if(total<=budget)return rows;
 const out=rows.slice();
 for(let i=0;i<out.length&&total>budget;i++){
  const row=out[i];if(PHONE_LIVE.has(row.status)||String(row.result||'').length<=500)continue;
  const trimmed={...row,result:String(row.result).slice(0,500),resultTrimmed:true};total-=size(row)-size(trimmed);out[i]=trimmed;
 }
 return out;
}
const taskSummary=(t,store,engine)=>({id:t.id,parentId:t.parentId||null,groupId:groupTaskContext(t,store)?.groupId||null,crossEnd:crossEndSummary(t),roleId:t.roleId||'concierge',conversationId:t.conversationId||t.id,title:t.title,status:t.status,...taskPhase(t,{note:engine?.liveDrafts?.get?.(t.id)||null}),progress:taskProgress(t,{actions:store.data.actions,note:engine?.liveDrafts?.get?.(t.id)||null}),...(t.status==='waiting_approval'?{approvals:store.data.approvals.filter(a=>a.taskId===t.id&&a.status==='pending').map(({id,tool,summary,fingerprint,expiresAt,status})=>({id,tool,summary,fingerprint,expiresAt,status}))}:{}),liveDraft:t.status==='running'&&engine?.active?.has(t.id)?String(engine.liveDrafts?.get(t.id)?.text||'').slice(0,2000):'',result:t.result,blockedReason:t.blockedReason,canReconcile:canReconcile(t,store),createdAt:t.createdAt,updatedAt:t.updatedAt,deadlineAt:Number.isFinite(taskDeadline(t))?new Date(taskDeadline(t)).toISOString():null,restartKey:restartGoal(t,store)?requestHash(restartGoal(t,store)):null,preview:t.messages?.at(-1)?.content?.slice(0,500)||t.result||t.prompt,...(t.watchNotice?{notice:t.routineId||t.routineTaskId?'routine':t.watchId?'watch':'dispatch'}:{}),...(t.phoneQueuedAt?{phoneQueued:true}:{})});
function groupReceipt(message,store){const tasks=(message.taskIds||[]).map(id=>store.task(id));return {received:true,messageId:message.id,taskId:tasks[0]?.id||null,taskIds:tasks.map(t=>t.id),status:tasks[0]?.status||message.coordinatorStatus||'received',receivedAt:message.createdAt};}
export function createGateway({identity,state,store,engine,phone,voice,removeRole,dataDir,onControl,onDeviceStatus,onTlsError,onRequestError,port=0}={}){
 const tlsStats={accepted:0,failed:0,lastFailure:null,stateResponses:0,lastStateResponseAt:null,lastSuccessfulSyncAt:null,lastFailedStep:null,lastStepFailureAt:null,phoneStateFailures:0};
 const stateReads=new Map();
 const syncSteps=new Set(['pair','state','observe_control','telemetry','control_sync','cache_publish','notifications','outbox','files','history']);
 const diagnosticTime=value=>{const time=timestamp(value);return Number.isFinite(time)&&time>0&&time<=Date.now()+60000?new Date(time).toISOString():null;};
 const recordSync=value=>{
  if(!value||typeof value!=='object'||Array.isArray(value))return;
  const success=diagnosticTime(value.lastStateSyncAt),failure=diagnosticTime(value.lastFailureAt);
  if(success&&(!tlsStats.lastSuccessfulSyncAt||success>tlsStats.lastSuccessfulSyncAt))tlsStats.lastSuccessfulSyncAt=success;
  if(syncSteps.has(value.lastFailedStep)&&failure&&(!tlsStats.lastStepFailureAt||failure>=tlsStats.lastStepFailureAt)){tlsStats.lastFailedStep=value.lastFailedStep;tlsStats.lastStepFailureAt=failure;}
  const count=value.stateFailures??value.failures;if(Number.isSafeInteger(count)&&count>=0&&count<=2147483647)tlsStats.phoneStateFailures=count;
 };
 const locks=new Set();let connections=new Set(),controlQueue=Promise.resolve(),closing=false,listenPromise=null,rejectListen=null,closePromise=null;
 const workspace=new BrowserWorkspace({browser:engine.broker?.browser,store,engine,state});
 const attachments=new AttachmentBridge({state,store,dataDir});
 const chatUploads=new ChatUploads(dataDir);
 const demonstrations=new Demonstrations({state,store,engine,phone});
 const typing=new PhoneTyping();
 const display=new DisplayCommands();
 const voiceRequests=new Set();
 const cancelVoice=()=>{for(const controller of voiceRequests)controller.abort();};
 const assertOpen=()=>{if(closing)throw new AppError('gateway_closed','连接正在更新，请重新连接',503);};
 const readBody=async(req,limit)=>{const value=await body(req,limit);assertOpen();return value;};
 const serializeControl=fn=>{const next=controlQueue.then(()=>{assertOpen();return fn();});controlQueue=next.catch(()=>{});return next;};
 const server=https.createServer({key:identity.key,cert:identity.cert,requestCert:true,rejectUnauthorized:false,minVersion:'TLSv1.3',maxVersion:'TLSv1.3',handshakeTimeout:8000},async(req,res)=>{
  let requestStep='request';
  try{
   assertOpen();requireValue(!req.headers.origin,'远程接口仅接受绑定客户端','remote_origin');requireValue(req.headers.host==='boujoy.gateway','网关地址无效','remote_host');
   const fp=fingerprint(req),url=new URL(req.url,'https://boujoy.gateway');
   requestStep=url.pathname==='/v1/state'?'state':url.pathname==='/v1/device/status'?'telemetry':url.pathname==='/v1/device/control'?'control_sync':url.pathname==='/v1/pair'?'pair':'request';
   if(req.method==='POST'&&url.pathname==='/v1/pair'){const b=await readBody(req);requireValue(b.edition===DISTRIBUTION.edition&&b.androidApplicationId===ANDROID_PACKAGE,'电脑端与手机端发行版不匹配','edition_mismatch');const device=state.device(fp)||state.bind(fp,b);return json(res,200,{paired:true,edition:DISTRIBUTION.edition,androidApplicationId:ANDROID_PACKAGE,deviceId:device.id,serverTime:new Date().toISOString(),...state.data.control});}
   const device=state.device(fp);if(!device)throw new AppError('device_unbound','此设备尚未绑定或已被撤销',403);
   if(req.method==='POST'&&url.pathname==='/v1/uploads'){req.setTimeout(120000,()=>req.destroy());return json(res,200,await chatUploads.receive(req,device,()=>{assertOpen();requireValue(state.device(fp),'设备已被撤销');}));}
   if(req.method==='POST'&&url.pathname==='/v1/device/status'){
    const b=await readBody(req);requireValue(state.device(fp),'设备已被撤销');
    if(b.edition!==DISTRIBUTION.edition||b.androidApplicationId!==ANDROID_PACKAGE){onDeviceStatus?.({timezone:null,deviceId:device.id,certificateFingerprint:fp});throw new AppError('edition_mismatch','电脑端与手机端发行版不匹配',409);}
    requireValue(typeof b.timezone==='string'&&b.timezone.length<=100,'设备时区无效');let timezone;
    try{timezone=new Intl.DateTimeFormat('en',{timeZone:b.timezone}).resolvedOptions().timeZone;}catch{onDeviceStatus?.({timezone:null,deviceId:device.id,certificateFingerprint:fp});throw new AppError('invalid_device_timezone','设备时区无法核实',400);}
    const observed=timestamp(b.observedAt);requireValue(Number.isFinite(observed),'设备状态时间无效');
    // This endpoint is authenticated phone telemetry, not a model tool. It never
    // grants control, starts a task, or persists a per-heartbeat message receipt.
    const build=/^[a-f0-9]{64}$/.test(b.apkSha256||'')&&Number.isSafeInteger(b.versionCode)?{edition:DISTRIBUTION.edition,androidApplicationId:ANDROID_PACKAGE,apkSha256:b.apkSha256,versionCode:b.versionCode,versionName:String(b.versionName||'').slice(0,30)}:null;
    if(build&&state.data.deviceBuilds?.[device.id]?.apkSha256!==build.apkSha256)state.update(s=>{s.deviceBuilds||={};s.deviceBuilds[device.id]={...build,observedAt:new Date(observed).toISOString()};});
    recordSync(b.syncDiagnostics);
    const receivedAt=new Date().toISOString();const displayBackend=BACKGROUND_SUPPORTED?sanitizeDisplayBackend(b.displayBackend):null;
    onDeviceStatus?.({edition:DISTRIBUTION.edition,androidApplicationId:ANDROID_PACKAGE,timezone,...(b.typingProtocol===2?{typingProtocol:2}:{}),...(build?{build}:{}),...(displayBackend?{displayBackend}:{}),source:'boujoy_android_authenticated',deviceId:device.id,certificateFingerprint:fp,observedAt:new Date(observed).toISOString(),receivedAt});
    return json(res,200,{accepted:true,serverTime:receivedAt});
   }
   const isOwner=t=>t.remoteDeviceId===device.id;
   if(req.method==='GET'){
    if(url.pathname==='/v1/demonstrations/current')return json(res,200,{demonstration:demonstrations.summary(device)});
    if(url.pathname==='/v1/device/files/next')return json(res,200,{job:attachments.next(device),serverTime:new Date().toISOString()});
    if(url.pathname==='/v1/device/display'){requireValue(BACKGROUND_SUPPORTED,'此发行版不支持后台显示执行','background_not_supported');
     requireValue(url.searchParams.get('protocol')==='1','后台执行协议版本不受支持','display_protocol');
     // A disconnected long poll must leave before the next command is offered:
     // marking that command delivered to a dead response would lose it forever.
     const controller=new AbortController(),disconnected=()=>controller.abort();
     res.once('close',disconnected);req.once('aborted',disconnected);
     if(req.aborted||res.destroyed)controller.abort();
     try{const command=await display.wait(device.id,{paused:!!state.data.control?.paused,signal:controller.signal});if(controller.signal.aborted)return;assertOpen();requireValue(state.device(fp),'设备已被撤销');return json(res,200,{command,serverTime:new Date().toISOString()});}
     finally{res.removeListener('close',disconnected);req.removeListener('aborted',disconnected);}
    }
    if(url.pathname==='/v1/device/typing'){
     if(state.data.control?.paused)return json(res,200,{job:null,serverTime:new Date().toISOString()});
     const controller=new AbortController(),disconnected=()=>controller.abort();
     res.once('close',disconnected);req.once('aborted',disconnected);
     if(req.aborted||res.destroyed)controller.abort();
     try{const job=await typing.wait(device.id,{protocol:url.searchParams.get('typingProtocol')==='2'?2:1,signal:controller.signal});if(controller.signal.aborted)return;assertOpen();requireValue(state.device(fp),'设备已被撤销');return json(res,200,{job,serverTime:new Date().toISOString()});}
     finally{res.removeListener('close',disconnected);req.removeListener('aborted',disconnected);}
    }
    const transfer=url.pathname.match(/^\/v1\/device\/files\/([\w-]+)\/bytes$/);if(transfer){const payload=await attachments.bytes(transfer[1],device);assertOpen();requireValue(state.device(fp),'设备已被撤销');attachments.guard(attachments.jobs.get(transfer[1]),device);res.writeHead(200,{'Content-Type':payload.job.mime,'Cache-Control':'no-store','X-Content-SHA256':payload.job.sha256});return res.end(payload.bytes);}
    if(url.pathname==='/v1/settings/reasoning')return json(res,200,reasoningSettings(store.data.settings));
    if(url.pathname==='/v1/notifications/delivery')return json(res,200,{delivery:store.data.remoteNotificationDelivery?.[device.id]||null,preferences:{quiet:store.data.settings.quiet!==false}});
    if(url.pathname==='/v1/voice/status')return json(res,200,voice?.status()||{transcriptionReady:false,speechReady:false,localOnly:true});
    if(url.pathname==='/v1/groups'){requireValue(engine.broker?.groups,'群服务尚未就绪');return json(res,200,{groups:engine.broker.groups.list({deviceId:device.id})});}
    const groupRead=url.pathname.match(/^\/v1\/groups\/([\w-]+)(?:\/messages\/([a-f0-9-]{36}))?$/);if(groupRead){requireValue(engine.broker?.groups,'群服务尚未就绪');const detail=engine.broker.groups.detail(groupRead[1],{deviceId:device.id});if(groupRead[2]){const message=detail.messages.find(m=>m.clientRequestId===groupRead[2]);return json(res,200,message?groupReceipt(message,store):{received:false,status:'not_received'});}return json(res,200,detail);}
    if(url.pathname==='/v1/state'){
     const response={revision:store.data.revision,serverTime:new Date().toISOString(),device:{...state.data.control},phoneExecution:{mode:BACKGROUND_SUPPORTED&&store.data.settings.phoneExecutionMode==='background'?'background':'main',supported:BACKGROUND_SUPPORTED},groups:engine.broker?.groups?.list({deviceId:device.id})||[],tasks:boundTaskSummaries(phoneTaskWindow(store.data.tasks.filter(t=>!t.archived&&(isOwner(t)||!t.remoteDeviceId)),store).map(task=>taskSummary(task,store,engine))),demonstration:demonstrations.summary(device),notificationPreferences:{quiet:store.data.settings.quiet!==false},reasoning:reasoningSettings(store.data.settings),roles:mobileRoles(store,device.id),phone:{enabled:store.data.settings.phoneEnabled},usage:store.data.usage};
     stateReads.set(fp,{epoch:response.device.controlEpoch,at:Date.now()});
     res.once('finish',()=>{tlsStats.stateResponses++;tlsStats.lastStateResponseAt=new Date().toISOString();});
     return json(res,200,response);
    }
    const messageMatch=url.pathname.match(/^\/v1\/messages\/([a-f0-9-]{36})$/i);if(messageMatch){const id=messageMatch[1];const task=store.data.tasks.find(t=>messageOwnedBy(t,id,device.id)&&(t.clientRequestId===id||t.messages?.some(m=>m.clientRequestId===id)));return json(res,200,task?{received:true,taskId:task.id,status:task.status,crossEnd:crossEndSummary(task),serverTime:new Date().toISOString()}:{received:false,status:'not_received',serverTime:new Date().toISOString()});}
    let m=url.pathname.match(/^\/v1\/tasks\/([\w-]+)$/);if(m){const t=store.task(m[1]);requireValue(!t.remoteDeviceId||isOwner(t),'任务不属于此设备');return json(res,200,{...taskSummary(t,store,engine),messages:(t.messages||[]).map(({thinking,...m})=>m),diagnostics:(t.events||[]).filter(e=>['phone_read_unavailable','phone_transport','tool_error'].includes(e.type)).slice(-12).map(e=>Object.fromEntries(['at','type','tool','code','reason','failureCode','foregroundPackage','allowedPackages','overlayPackages','transport','attempts','elapsedMs','httpRequests','tlsHandshakes','receivedBytes','durationMs'].filter(k=>e[k]!==undefined).map(k=>[k,e[k]]))),browserWorkspaceAvailable:workspace.available(t.id),harnessChildren:(t.harnessChildren||[]).slice(-12).map(({id,label,status})=>({id,label:String(label||'子任务').slice(0,60),status})),approvals:store.data.approvals.filter(a=>a.taskId===t.id&&a.status==='pending').map(approvalView),artifacts:store.data.artifacts.filter(a=>a.taskId===t.id).map(({id,name,mime,size,createdAt,kind,sourceMessageId,sha256,importedFrom})=>({id,name,mime,size,createdAt,kind,sourceMessageId,sha256,imported:!!importedFrom})),serverTime:new Date().toISOString()});}
    m=url.pathname.match(/^\/v1\/artifacts\/([\w-]+)(\/preview)?$/);if(m){const a=store.data.artifacts.find(a=>a.id===m[1]);requireValue(a,'文件不存在');const t=store.task(a.taskId);requireValue(!t.remoteDeviceId||isOwner(t),'文件不属于此设备');const root=path.resolve(dataDir,'artifacts'),canonicalRoot=fs.realpathSync(root),file=path.resolve(root,a.path);requireValue(file.startsWith(root+path.sep)&&fs.realpathSync(file).startsWith(canonicalRoot+path.sep),'文件路径无效');requireValue(fs.statSync(file).isFile()&&(!Number.isFinite(a.size)||fs.statSync(file).size===a.size),'文件状态已变化');if(a.sha256){const digest=createHash('sha256');for await(const chunk of fs.createReadStream(file))digest.update(chunk);requireValue(digest.digest('hex')===a.sha256,'文件内容已变化');assertOpen();requireValue(state.device(fp),'设备已被撤销');}if(m[2]){requireValue(String(a.mime).startsWith('image/')||/\.(png|jpe?g|webp|gif|heic|heif|bmp)$/i.test(a.name),'此文件不是可预览图片');const bytes=await imagePreview(file,a.id+':'+(a.sha256||a.size));assertOpen();requireValue(state.device(fp),'设备已被撤销');res.writeHead(200,{'Content-Type':'image/jpeg','Content-Length':bytes.length,'X-Content-SHA256':createHash('sha256').update(bytes).digest('hex'),'Cache-Control':'no-store'});return res.end(bytes);}return await sendArtifact(req,res,{file,name:a.name,mime:a.mime,sha256:a.sha256});}
    throw new AppError('not_found','接口不存在',404);
   }
   if(req.method!=='POST')throw new AppError('method','不支持此操作',405);
   const b=await readBody(req,['/v1/voice/transcribe','/v1/messages'].includes(url.pathname)?12*1024*1024:undefined);requireValue(state.device(fp),'设备已被撤销');requireValue(UUID.test(b.messageId||''),'提交编号无效');
   if(url.pathname==='/v1/notifications/delivery'){
    requireValue(Array.isArray(b.deliveries)&&b.deliveries.length<=200,'通知回执数量无效');
    const rows=b.deliveries.map(row=>{requireValue(row&&typeof row.taskId==='string'&&typeof row.fingerprint==='string'&&row.fingerprint.length<=100&&['pending','posted','permission_denied','deferred_quiet','retry'].includes(row.status),'通知回执无效');const task=store.data.tasks.find(t=>t.id===row.taskId);if(!task)return null;requireValue(!task.remoteDeviceId||isOwner(task),'通知任务不属于此设备');return {taskId:row.taskId,fingerprint:row.fingerprint,status:row.status,attempts:Math.max(0,Math.min(10000,Number(row.attempts)||0)),updatedAt:Number.isFinite(row.updatedAt)?row.updatedAt:null};}).filter(Boolean);
    const receipt={deviceId:device.id,certificateFingerprint:fp,receivedAt:new Date().toISOString(),rows};store.transaction(s=>{s.remoteNotificationDelivery||={};s.remoteNotificationDelivery[device.id]=receipt;});return json(res,200,{accepted:true,receivedAt:receipt.receivedAt});
   }
   if(url.pathname==='/v1/settings/reasoning'){requireValue(Object.keys(b).every(key=>['messageId','modelReasoning'].includes(key)),'只能修改思考档位');return json(res,200,setReasoning(store,b.modelReasoning));}
   if(url.pathname==='/v1/notifications/preferences'){requireValue(typeof b.quiet==='boolean','通知设置无效');store.transaction(s=>{s.settings.quiet=b.quiet;});return json(res,200,{quiet:store.data.settings.quiet});}
   if(url.pathname==='/v1/device/display'){requireValue(BACKGROUND_SUPPORTED,'此发行版不支持后台显示执行','background_not_supported');requireValue(UUID.test(b.id||''),'后台执行编号无效','display_expired');return json(res,200,display.complete(device.id,b.id,b.result));}
   if(url.pathname==='/v1/device/typing'){requireValue(UUID.test(b.id||''),'输入编号无效');return json(res,200,typing.complete(device.id,b.id,b.status,b.diagnostic,b.proof));}
   const attachmentReceipt=url.pathname.match(/^\/v1\/device\/files\/([\w-]+)\/status$/);
   if(attachmentReceipt)return json(res,200,attachments.receipt(attachmentReceipt[1],device,b));
   const speech=url.pathname.match(/^\/v1\/tasks\/([\w-]+)\/messages\/([\w-]+)\/speech$/);
   if(url.pathname==='/v1/voice/transcribe'||speech){
    requireValue(voice,'本机语音尚未准备','voice_unavailable');if(speech){const task=store.task(speech[1]);requireValue(!task.remoteDeviceId||isOwner(task),'任务不属于此设备');}
    const controller=new AbortController(),cancel=()=>controller.abort();voiceRequests.add(controller);res.once('close',cancel);
    try{
     const result=speech?await voice.synthesizeMessage(speech[1],speech[2],{signal:controller.signal}):await voice.transcribeUpload({bytesBase64:b.bytesBase64,sha256:b.sha256,mime:b.mime,language:b.language},{signal:controller.signal});
     assertOpen();requireValue(!controller.signal.aborted&&state.device(fp),'设备连接已变化，语音处理已取消');return json(res,200,result);
    }finally{voiceRequests.delete(controller);res.off('close',cancel);}
   }
   const key=device.id+':'+b.messageId,digest=hash(JSON.stringify({path:url.pathname,body:b})),old=state.data.messages[key];
   if(old){requireValue(old.digest===digest,'同一提交编号不能用于不同内容');if(old.response)return json(res,200,old.response);}
   if(locks.has(key))throw new AppError('request_busy','该请求正在处理',409);locks.add(key);
   try{
    let result;
    if(url.pathname==='/v1/groups'){requireValue(engine.broker?.groups,'群服务尚未就绪');result=engine.broker.groups.create(b,{deviceId:device.id});
    }else if(/^\/v1\/groups\/[\w-]+\/(messages|members)$/.test(url.pathname)){
     const [,groupId,operation]=url.pathname.match(/^\/v1\/groups\/([\w-]+)\/(messages|members)$/);const groups=engine.broker?.groups;requireValue(groups,'群服务尚未就绪');
     if(operation==='members')result=groups.members(groupId,b,{deviceId:device.id});
     else{
      const existing=groups.detail(groupId,{deviceId:device.id}).messages.find(m=>m.clientRequestId===b.messageId);
      if(!existing){const created=timestamp(b.createdAt),expires=timestamp(b.expiresAt);requireValue(Number.isFinite(created)&&Number.isFinite(expires)&&created<=Date.now()+30000&&expires>created&&expires-created<=300000,'消息期限无效');if(expires<=Date.now())throw new AppError('request_expired','请求已过期，未派发新的任务',410);requireValue(b.controlEpoch===state.data.control.controlEpoch&&!state.data.control.paused,'手机已由你接管，请明确继续','phone_paused');}
      const input={content:b.content??b.text,replyToMessageId:b.replyToMessageId,clientRequestId:b.messageId,recipientRoleIds:b.recipientRoleIds,cloudConsent:store.data.settings.chatCloudConsent===true,memoryConsent:store.data.settings.chatCloudConsent===true&&store.data.settings.chatMemoryConsent===true,memoryMode:store.data.settings.chatMemoryMode==='do_not_remember'?'do_not_remember':'default',remoteExpiresAt:b.expiresAt,submittedAt:b.createdAt};
      result=groupReceipt(groups.send(groupId,input,{deviceId:device.id,remoteControlEpoch:b.controlEpoch}),store);
     }
    }else if(/^\/v1\/groups\/[\w-]+\/archive$/.test(url.pathname)){
     const groupId=url.pathname.split('/')[3],groups=engine.broker?.groups;requireValue(groups,'群服务尚未就绪');result=groups.archive(groupId,b,{deviceId:device.id});
    }else if(/^\/v1\/groups\/[\w-]+\/tasks\/[\w-]+\/(pause|resume)$/.test(url.pathname)){
     const [,groupId,taskId,action]=url.pathname.match(/^\/v1\/groups\/([\w-]+)\/tasks\/([\w-]+)\/(pause|resume)$/);const groups=engine.broker?.groups;requireValue(groups,'群服务尚未就绪');
     const previous=(store.data.groupControls||[]).find(r=>r.requestKey===device.id+':'+b.messageId);
     if(action==='resume'&&!previous)requireValue(b.controlEpoch===state.data.control.controlEpoch&&!state.data.control.paused,'手机已由你接管，请明确继续','phone_paused');
     result=await groups.control(groupId,taskId,action,{deviceId:device.id,remoteControlEpoch:b.controlEpoch,clientRequestId:b.messageId});
    }else if(url.pathname==='/v1/roles'||/^\/v1\/roles\/[\w-]+$/.test(url.pathname)){
     if(b.remove===true){requireValue(typeof removeRole==='function','删除服务暂不可用');result=await removeRole(url.pathname.split('/')[3]);}else result=mutateMobileRole(store,url.pathname.split('/')[3]||'',b,{deviceId:device.id,digest});
    }else if(/^\/v1\/roles\/[\w-]+\/brief$/.test(url.pathname)){
     const roleId=url.pathname.split('/')[3];requireValue(store.data.roles.some(r=>r.id===roleId&&!r.hidden&&!r.deletedAt),'助理不存在或已停用');
     const notice=engine.deliverBrief(roleId);result={taskId:notice?.id||null,conversationId:notice?.conversationId||null};
    }else if(url.pathname==='/v1/demonstrations/start'){
     const task=store.task(b.taskId);requireValue(!task.remoteDeviceId||isOwner(task),'任务不属于此设备');result=await serializeControl(()=>demonstrations.start(task.id,device,fp,b.controlEpoch));
    }else if(url.pathname==='/v1/demonstrations/stop'){result=await demonstrations.finish('user_stopped',device,b.sessionId);
    }else if(url.pathname==='/v1/device/control'){
     result=await serializeControl(async()=>{requireValue(state.device(fp),'设备已被撤销');
     requireValue(Number.isSafeInteger(b.controlEpoch)&&b.controlEpoch>=state.data.control.controlEpoch&&typeof b.paused==='boolean','控制代际无效');
     requireValue(!(b.controlEpoch===state.data.control.controlEpoch&&state.data.control.paused&&!b.paused),'继续必须使用新的控制代际');
     if(b.reason==='maintenance_reconnected'){
      const current=state.data.control,read=stateReads.get(fp),age=Date.now()-(read?.at??0);
      requireValue(!b.paused&&current.paused&&current.reason==='maintenance'&&Number.isSafeInteger(current.maintenanceResumeEpoch)&&current.maintenanceResumeEpoch<current.controlEpoch&&b.maintenanceEpoch===current.controlEpoch&&b.controlEpoch===current.controlEpoch+1&&read?.epoch===current.controlEpoch&&age>=0&&age<=30000,'维护状态已变化，请重新同步或明确继续','maintenance_resume_changed');
     }
     const owner=phone?.lease;state.update(s=>{s.control={controlEpoch:b.controlEpoch,paused:b.paused,...(b.paused?{reason:typeof b.reason==='string'&&/^[a-z_]{1,48}$/.test(b.reason)?b.reason:'unspecified',pausedAt:new Date().toISOString()}:{})};});workspace.invalidateChanged();demonstrations.invalidateChanged();if(b.paused)display.cancelUndelivered(device.id,'手机已暂停');await onControl?.(state.data.control);
     if(b.paused&&owner)await engine.stop(owner,{pause:true});
     return {controlEpoch:state.data.control.controlEpoch,paused:state.data.control.paused,serverTime:new Date().toISOString()};});
    }else if(/^\/v1\/tasks\/[\w-]+\/browser\/(begin|frame|act|end)$/.test(url.pathname)){
     const [,taskId,operation]=url.pathname.match(/^\/v1\/tasks\/([\w-]+)\/browser\/(begin|frame|act|end)$/),task=store.task(taskId);requireValue(!task.remoteDeviceId||isOwner(task),'任务不属于此设备');
     if(operation==='begin')result=await serializeControl(()=>workspace.begin(taskId,device,fp,b.controlEpoch));
     else if(operation==='end')result=workspace.finish(taskId,device,fp,b);
     else result=await workspace.operate(taskId,device,fp,b,operation);
     assertOpen();requireValue(state.device(fp),'设备已被撤销');
     // Screenshots are transient; never put them in persistent idempotency receipts.
     if(operation==='frame')return json(res,200,result);
    }else if(url.pathname==='/v1/messages'){
     requireValue(typeof b.text==='string'&&b.text.trim().length>0&&b.text.length<=50000,'请输入有效消息');
     const existing=store.data.tasks.find(t=>t.clientRequestId===b.messageId||t.messages?.some(m=>m.clientRequestId===b.messageId));
     if(existing){requireValue(messageOwnedBy(existing,b.messageId,device.id),'提交编号冲突');const msg=existing.messages.find(m=>m.clientRequestId===b.messageId);requireValue(msg?.content===b.text.trim()&&msg.inputDigest===digest,'提交内容或附件冲突，需核对原任务');result={taskId:existing.id,status:existing.status,crossEnd:crossEndSummary(existing),receivedAt:existing.createdAt,expiresAt:existing.remoteExpiresAt};}
     else{
      const created=timestamp(b.createdAt),expires=timestamp(b.expiresAt);requireValue(Number.isFinite(created)&&Number.isFinite(expires)&&created<=Date.now()+30000&&expires>created&&expires-created<=300000,'消息期限无效');if(expires<=Date.now())throw new AppError('request_expired','请求已过期，未派发新的任务',410);
      requireValue(b.controlEpoch===state.data.control.controlEpoch&&!state.data.control.paused,'手机已由你接管，请明确继续','phone_paused');
      const input={inputDigest:digest,prompt:b.text.trim(),clientRequestId:b.messageId,source:'user',remoteDeviceId:device.id,remoteControlEpoch:b.controlEpoch,remoteExpiresAt:new Date(expires).toISOString(),cloudConsent:store.data.settings.chatCloudConsent===true,memoryConsent:store.data.settings.chatMemoryConsent===true,memoryMode:store.data.settings.chatMemoryMode||'default',submittedAt:new Date(created).toISOString()};
      if(b.roleId!==undefined){requireValue(typeof b.roleId==='string'&&store.data.roles.some(r=>r.id===b.roleId&&!r.hidden&&!r.deletedAt),'助理不存在或已停用');input.roleId=b.roleId;}
      if(b.conversationId){const target=store.data.tasks.find(t=>t.id===b.conversationId);requireValue(target&&!groupTaskContext(target,store)&&!String(target.conversationId||'').startsWith('group:'),'这段会话无法继续，请打开该助理的新对话；消息尚未执行','invalid_private_conversation');}
      if(b.conversationId&&b.roleId!==undefined)requireValue((store.task(b.conversationId).roleId||'concierge')===b.roleId,'这段对话属于另一位助理');
      const uploads=chatUploads.forDevice(device.id).entries;validateAttachments(b.attachments||[],{uploads});
      const pendingUploads=new Map(uploads);const staged=stageAttachments(b.attachments||[],b.messageId,dataDir,{uploads});input.inputArtifacts=staged;
      let task;try{if(b.conversationId){task=store.task(b.conversationId);requireValue(!task.remoteDeviceId||isOwner(task),'会话不属于此设备');task=await withCrossEnd({endpoint:'phone',deviceId:device.id},()=>engine.message(task.id,{...input,message:input.prompt,conversationId:task.conversationId||task.id}));}else task=withCrossEnd({endpoint:'phone',deviceId:device.id},()=>engine.create(input));}
      catch(error){for(const row of staged)if(!store.data.artifacts.some(a=>a.id===row.id)){const file=path.join(dataDir,'artifacts',row.path),original=pendingUploads.get(row.sourceUploadId);if(original){fs.renameSync(file,original.path);uploads.set(original.id,original);}else fs.rmSync(file,{force:true});}throw error;}

      result={taskId:task.id,status:task.status,crossEnd:crossEndSummary(task),receivedAt:new Date().toISOString(),expiresAt:new Date(expires).toISOString()};
     }
    }else if(/^\/v1\/approvals\/[\w-]+$/.test(url.pathname)){
     const id=url.pathname.split('/').at(-1),approval=store.data.approvals.find(a=>a.id===id);requireValue(approval,'操作确认不存在');const task=store.task(approval.taskId);requireValue(!task.remoteDeviceId||isOwner(task),'任务不属于此设备');requireValue(typeof b.allow==='boolean'&&b.fingerprint===approval.fingerprint,'确认内容已变化，请重新查看');requireValue(engine.broker?.approvals,'确认服务不可用');
     if(b.allow){
      requireValue(b.controlEpoch===state.data.control.controlEpoch&&!state.data.control.paused,'请先明确交还控制');
      if(task.status!=='waiting_approval'||approval.status!=='pending'||Date.parse(approval.expiresAt)<=Date.now()||!engine.broker.approvals.waiters?.has(id))throw new AppError('approval_expired','接管后旧操作确认已失效，请继续任务以重新核实页面',409);
      store.updateTask(task.id,t=>{t.remoteDeviceId=device.id;t.remoteControlEpoch=b.controlEpoch;});
     }
     engine.broker.approvals.resolve(id,b.allow);result={resolved:true,taskId:task.id,serverTime:new Date().toISOString()};
    }else{
     const m=url.pathname.match(/^\/v1\/tasks\/([\w-]+)\/(stop|continue|consent|restart|reconcile)$/);if(!m)throw new AppError('not_found','接口不存在',404);const task=store.task(m[1]);requireValue(!task.remoteDeviceId||isOwner(task),'任务不属于此设备');
     if(m[2]==='stop')await serializeControl(async()=>{requireValue(state.device(fp),'设备已被撤销');requireValue(Number.isSafeInteger(b.controlEpoch)&&b.controlEpoch>=state.data.control.controlEpoch,'停止请求属于旧控制代际，请刷新状态');state.update(s=>{s.control={paused:true,controlEpoch:Math.max(s.control.controlEpoch,Number.isSafeInteger(b.controlEpoch)?b.controlEpoch:0),reason:'user_stop',pausedAt:new Date().toISOString()};});workspace.invalidateChanged();demonstrations.invalidateChanged();await onControl?.(state.data.control);await engine.stop(task.id,{pause:true});});
     else if(m[2]==='reconcile'){requireValue(b.controlEpoch===state.data.control.controlEpoch&&!state.data.control.paused,'请先交还手机控制');requireValue(canReconcile(task,store),'只有待核实的打开应用或已输入草稿可在此只读核验');requireValue(!phone?.lease||phone.lease===task.id,'手机正在执行其它任务');
      // Unknown text input has a dedicated read-only proof path. Reconciliation
      // must not change the old business task's phone epoch or its deadline.
      if(!store.data.actions.some(action=>inputVerificationTarget(task,action)))store.updateTask(task.id,t=>{t.remoteControlEpoch=b.controlEpoch;});
      await engine.reconcile(task.id);}
     else{requireValue(b.controlEpoch===state.data.control.controlEpoch&&!state.data.control.paused,'请先交还手机控制');
      const groupContext=groupTaskContext(task,store);
      if(groupContext){
       requireValue(m[2]==='consent','群任务请从群内继续，不能通过单聊恢复','group_task_entry_required');
       const groups=engine.broker?.groups;requireValue(groups,'群服务尚未就绪');const group=groups.detail(groupContext.groupId,{deviceId:device.id});
       requireValue(group.members.some(member=>member.id===task.roleId&&member.available!==false),'接手助理已不在群中','group_member_unavailable');
      }
      const input={clientRequestId:b.messageId,remoteDeviceId:device.id,remoteControlEpoch:b.controlEpoch};if(m[2]==='consent'){requireValue(b.cloudConsent===true&&task.status==='waiting_consent'&&(!task.source||task.source==='user'),'只有等待授权的直接用户任务可以在此授权');input.cloudConsent=true;input.memoryConsent=false;}if(m[2]==='restart'){const goal=restartGoal(task,store);requireValue(goal&&typeof b.restartKey==='string'&&b.restartKey===requestHash(goal),'任务内容或结果已变化，请刷新后重新执行','restart_scope_changed');input.message='重新执行：'+goal;const segment=task.timeline?.segments?.at(-1),budget=task.maxRunSeconds??Math.floor((Date.parse(segment?.deadlineAt)-Date.parse(segment?.startedAt))/1000);if(Number.isInteger(budget)&&budget>=10&&budget<=1200)input.maxRunSeconds=budget;}await withCrossEnd({endpoint:'phone',deviceId:device.id},()=>engine.continue(task.id,input));}
     result={taskId:task.id,status:store.task(task.id).status,serverTime:new Date().toISOString()};
    }
    assertOpen();state.update(s=>{s.messages[key]={digest,response:result,at:Date.now()};});return json(res,200,result);
   }finally{locks.delete(key);}
  }catch(e){tlsStats.lastFailedStep=requestStep;tlsStats.lastStepFailureAt=new Date().toISOString();onRequestError?.([e.code,e.phoneuseCode].filter(code=>typeof code==='string'&&/^[A-Za-z0-9_]{1,80}$/.test(code)).join(':')||'request_rejected');if(!res.headersSent){await discardRejectedBody(req);if(!res.destroyed)json(res,e.status||400,{error:{code:e.code||'request_rejected',message:e instanceof AppError?e.message:'请求无法验证'},serverTime:new Date().toISOString()});}else res.destroy();}
 });
 server.requestTimeout=600000;server.headersTimeout=10000;server.maxHeadersCount=32;
 server.on('secureConnection',socket=>{tlsStats.accepted++;connections.add(socket);socket.on('error',()=>{});socket.on('close',()=>connections.delete(socket));});server.on('tlsClientError',(error,socket)=>{const code=/^[A-Z0-9_]{1,80}$/.test(error?.code||'')?error.code:'TLS_CLIENT_ERROR';tlsStats.failed++;tlsStats.lastFailure={code,at:new Date().toISOString(),receivedBytes:socket?.bytesRead||0,sentBytes:socket?.bytesWritten||0};onTlsError?.(code);});
 return {server,workspace,attachments,demonstrations,typing,display,diagnostics:()=>structuredClone(tlsStats),disconnectWorkspace(){workspace.invalidateAll();attachments.invalidateAll();demonstrations.disconnect();cancelVoice();},async pause(){return serializeControl(async()=>{state.update(s=>{s.control={paused:true,controlEpoch:s.control.controlEpoch+1,reason:'user_takeover',pausedAt:new Date().toISOString()};});display.cancelUndelivered(null,'手机控制已暂停');workspace.invalidateChanged();demonstrations.invalidateChanged();const owner=phone?.lease;await onControl?.(state.data.control);if(owner)await engine.stop(owner,{pause:true});return state.data.control;});},async listen(){assertOpen();if(!listenPromise)listenPromise=new Promise((resolve,reject)=>{let done=false;const finish=error=>{if(done)return;done=true;rejectListen=null;server.removeListener('error',failed);error?reject(error):resolve();};const failed=error=>finish(error);rejectListen=failed;server.once('error',failed);server.listen(port,'127.0.0.1',()=>finish());});await listenPromise;assertOpen();return server.address().port;},close(){if(closePromise)return closePromise;closing=true;display.close();typing.close();workspace.close();attachments.close();demonstrations.close();cancelVoice();rejectListen?.(new AppError('gateway_closed','连接正在更新，请重新连接',503));for(const s of connections)s.destroy();server.closeAllConnections();closePromise=new Promise((resolve,reject)=>server.close(error=>error&&error.code!=='ERR_SERVER_NOT_RUNNING'?reject(error):resolve()));return closePromise;}};
}
