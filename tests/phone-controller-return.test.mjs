import {ANDROID_PACKAGE} from '../src/distribution.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/core/store.mjs';
import {Engine} from '../src/core/engine.mjs';
import {withCrossEnd} from '../src/core/cross-end.mjs';
import {Broker} from '../src/tools/broker.mjs';
import {Phone} from '../src/adapters/phone.mjs';
import {PhoneUseDriver} from '../src/adapters/phoneuse-driver.mjs';
import {PhoneUseClient} from '../src/adapters/phoneuse-client.mjs';
const DEVICE='native-device',BOUND='00000000-1234-4567-8abc-123456789abc',INSTANCE='native-instance',HOME=ANDROID_PACKAGE,TARGET='com.android.settings';
const wrapped=(value,isError=false)=>({isError,content:[{type:'text',text:JSON.stringify(value)}]});
async function fixture(t,change={}){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'controller-return-')),store=new Store(dir);let now=Date.now(),foreground=HOME,seq=0,control={paused:false,controlEpoch:9};
 const start=now,clock=()=>now+Date.now()-start,actions=[],reads=[],originalId=randomUUID(),cancel=new AbortController();
 const client=new PhoneUseClient({dataDir:dir,clock});client.controllerBootAt=now-60000;client.remoteTransport={dataPort:7,controlPort:8};client.loaded=true;client.start=async()=>{};
 const rpc={dead:false,request:async(_method,{name,arguments:a})=>{
   assert.equal(a.device_id,DEVICE);
   if(name==='get_status'){
    reads.push(a.request_id?'original':'idle');
    if(a.request_id){assert.equal(a.request_id,originalId);return wrapped({device_id:DEVICE,service_instance_id:INSTANCE,error:{code:change.requestPresent?'RESULT_UNKNOWN':'REQUEST_NOT_FOUND',...(change.wrongOriginal?{request_id:'wrong'}:{})}},true);}
    if(change.onSecondIdle&&reads.filter(x=>x==='idle').length===2)change.onSecondIdle({control,cancel,client});
    return wrapped({device_id:DEVICE,service_instance_id:change.differentInstance?'changed':INSTANCE,stopped:!!change.stopped,paused:!!change.paused,executing_request_id:change.busy?'other':null});
   }
   actions.push({tool:name,id:a.request_id,target:a.package_name});
   if(name==='launch_app')foreground=change.wrongTarget?'com.other.app':a.package_name;
   return wrapped({device_id:DEVICE,service_instance_id:change.changedAtLaunch?'replacement':INSTANCE,state:'executed',request_id:a.request_id,action_executed:true});
 }};client.rpc=rpc;client.controlRpc={...rpc};
 const driver=new PhoneUseDriver({client,clock});driver.resolveApp=async(_d,p)=>({packageName:p,label:'Settings',aliases:['Settings','设置']});driver.listApps=async()=>({apps:[{packageName:TARGET,label:'Settings',aliases:['Settings','设置']}]});
 const windows=conflict=>[
  {window_id:1,display_id:0,type:1,layer:0,active:!conflict,focused:!conflict,bounds:[0,0,1000,1600]},
  ...(conflict?[{window_id:2,display_id:0,type:3,layer:100,active:true,focused:true,bounds:[0,0,1000,1600]}]:[])
 ];
 driver.capture=async()=>{
  const real=change.notController&&foreground===HOME?'com.other.app':foreground;
  const state={windowPkg:real,foreground:change.overlay?'other.overlay/Window':real+'/Main',display:'main',tree:'window main\nButton "Battery" clickable bounds=20,200,260,300'};
  return {at:clock(),native:{at:clock()-(change.staleSurface?10000:0),deviceId:DEVICE,serviceInstanceId:INSTANCE,packageName:real,windowId:1,display:{id:0,width:1000,height:1600},windows:windows(real===HOME?change.conflictedController:change.conflictedTarget),observationId:'native-'+(++seq),elements:[]},tree:wrapped({ok:true,result:state}),image:{content:[{type:'image',mimeType:'image/png',data:'AA=='}]},mapping:null};
 };
 driver.recognize=async()=>({width:1000,height:1600,lines:[{id:'battery',text:'Battery 78%',bounds:[20,200,260,300],center:{x:140,y:250}}]});
 const phone=new Phone(store,{clock,phoneUse:driver});phone.remoteControlState=()=>control;phone.remoteDeviceTelemetry=()=>({fresh:!change.staleBinding,deviceId:BOUND,certificateFingerprint:'verified-cert'});
 const broker=new Broker({store,dataDir:dir,phone,browser:{close(){}},approvals:{cancelTask(){}},memory:{}}),engine=new Engine({store,broker,clock,secrets:{get:async()=>null},memory:{}});engine.pump=async()=>{};
 store.transaction(s=>{s.settings.phoneBackend='phoneuse';s.settings.phoneEnabled=true;s.settings.phoneUseDeviceId=DEVICE;});
 const old=engine.create({prompt:change.sameGoal?'Open Android Settings on my phone and tell me the battery percentage. Do not change any settings.':'打开微信返回原页面',cloudConsent:true});store.updateTask(old.id,row=>{row.status=change.oldStatus||'unknown_result';});
 const offset=change.young||change.fresh?1000:180000;const nativeOld={deviceId:DEVICE,requestId:originalId,tool:change.nativeTool||'back',state:'unknown',createdAt:now-offset,serviceInstanceId:INSTANCE};
 await client.commit(()=>client.pending.set(DEVICE+'\u0000'+originalId,nativeOld));
 const ledger={id:randomUUID(),taskId:old.id,tool:'phone_action',phoneOperation:change.oldOperation||'back',authorization:'general_navigation',status:'unknown',startedAt:new Date(now-offset).toISOString(),finishedAt:new Date(now-offset+100).toISOString(),nativeRequestId:originalId};
 store.transaction(s=>{s.actions.push(ledger,{id:randomUUID(),taskId:'earlier-refused-goal',tool:'phone_open_app',status:'not_executed',nativeRequestId:originalId});if(change.extraOld)s.actions.push({...ledger,id:randomUUID(),phoneOperation:'tap',nativeRequestId:randomUUID()});});
 if(change.extraNative)await client.commit(()=>client.pending.set('second',{...nativeOld,requestId:randomUUID(),tool:change.extraNative}));
 const task=withCrossEnd({endpoint:change.mac?'mac':'phone',deviceId:BOUND},()=>engine.create({prompt:change.prompt||'Open Android Settings on my phone and tell me the battery percentage. Do not change any settings.',cloudConsent:true,clientRequestId:randomUUID(),inputDigest:'a'.repeat(64),remoteDeviceId:BOUND,remoteControlEpoch:9,remoteExpiresAt:new Date(now+299000).toISOString(),submittedAt:new Date(now-20).toISOString()}));
 store.updateTask(task.id,row=>{row.status='running';row.deadlineAt=new Date(now+299000).toISOString();});
 const open=()=>broker.execute(task.id,'phone_open_app',{packageName:TARGET},cancel.signal);
 const scroll=()=>broker.execute(task.id,'phone_action',{observationId:phone.observation?.id||'missing',action:'swipe',x1:400,y1:1000,x2:400,y2:300,reason:'Read the user-requested device information'},cancel.signal);
 t.after(async()=>{engine.groups.close();store.close();await fs.rm(dir,{recursive:true,force:true});});
 return {open,scroll,broker,phone,client,store,task,old,originalId,nativeOld,control,actions,reads,cancel,advance:ms=>{now+=ms;},suppress:()=>{foreground='com.other.app';}};
}

test('bound new user goal opens one named app and navigates its freshly observed screen; original back stays unknown on disk',async t=>{
 const f=await fixture(t);await f.open();assert.deepEqual(f.actions.map(a=>a.tool),['launch_app']);assert.deepEqual(f.reads,['original','idle'],'one journal read and one idle proof before the launch');
 assert.equal(f.phone.observation?.native?.packageName,TARGET);await f.scroll();assert.deepEqual(f.actions.map(a=>a.tool),['launch_app','swipe']);
 await f.broker.execute(f.task.id,'phone_action',{observationId:f.phone.observation.id,action:'tap',textTargetId:'battery',reason:'Open the visible battery information row'},f.cancel.signal);assert.deepEqual(f.actions.map(a=>a.tool),['launch_app','swipe','tap']);
 assert.equal(f.store.task(f.old.id).status,'unknown_result');assert.equal(f.store.data.actions.find(a=>a.nativeRequestId===f.originalId).status,'unknown');assert.equal(f.client.pending.size,1);
 await f.broker.execute(f.task.id,'phone_observe',{},f.cancel.signal);const screen=f.phone.observation.id;await f.broker.execute(f.task.id,'finish_task',{outcome:'completed',summary:'刚在设置页面读到当前电量为 78%。',evidence:[screen]},f.cancel.signal);assert.equal(f.store.task(f.task.id).status,'completed');
 const disk=JSON.parse(await fs.readFile(f.client.pendingPath,'utf8'));assert.equal(disk.pending.length,1);const {resolution,...kept}=disk.pending[0];assert.deepEqual(kept,f.nativeOld,'the original back is kept as it was');assert.equal(kept.state,'unknown');assert.equal(resolution?.kind,'superseded_after_idle','marked superseded once the phone proved idle, never replayed');
});

test('an unconfirmed back stops fencing new navigation once the phone itself reports it is idle; a busy, paused, stopped phone or a recent unconfirmed tap/typing still fences',async t=>{
 // Fenced: the phone is not idle, still holds the request, the old native step is a
 // recent tap, another recent unconfirmed tap/typing exists, or the run was cancelled.
 for(const change of [{oldStatus:'running'},{nativeTool:'tap',fresh:true},{extraNative:'input_text',fresh:true},{extraNative:'tap',fresh:true},{nativeTool:'tap',paused:true},{stopped:true},{paused:true},{busy:true},{requestPresent:true}]){
  const f=await fixture(t,change);await f.open().catch(()=>{});assert.deepEqual(f.actions,[],JSON.stringify(change));assert.equal(f.client.pending.get(DEVICE+'\u0000'+f.originalId)?.state,'unknown');
 }
 // A back commits nothing; with the phone idle the next navigation goes ahead and
 // the old step is kept on disk as superseded, never replayed.
 for(const change of [{young:true},{notController:true},{overlay:true},{differentInstance:true},{mac:true},{staleBinding:true}]){
  const f=await fixture(t,change);await f.open().catch(()=>{});assert.deepEqual(f.actions.map(a=>a.tool),['launch_app'],JSON.stringify(change));
  const old=f.client.pending.get(DEVICE+'\u0000'+f.originalId);assert.equal(old.state,'unknown');assert.equal(old.resolution.kind,'superseded_after_idle');assert.equal(f.actions.some(a=>a.tool==='back'),false);
 }
});

// Epoch change, an expired controller grant, a switched target or a restarted
// transport no longer fence a plain scroll on their own: the old step was a back,
// which commits nothing, and the phone reports itself idle (see the test above).
test('another unconfirmed native effect, cancellation or a released lease cannot inherit navigation',async t=>{
 for(const which of ['target','service','pending','cancel','release']){
  const f=await fixture(t,{wrongTarget:which==='target',conflictedTarget:which==='covered',changedAtLaunch:which==='service'});await f.open();
  if(which==='covered'){
   assert.equal(f.phone.observation,null);assert.equal(f.client.controllerNavigation,null);
   const result=await f.broker.execute(f.task.id,'phone_observe',{},f.cancel.signal);
   assert.equal(f.phone.observation,null);assert.equal(result.content.some(block=>block.type==='image'),false);
  }
  if(which==='pending')await f.client.commit(()=>f.client.pending.set('other',{...f.nativeOld,requestId:randomUUID(),tool:'input_text'}));
  if(which==='cancel')f.cancel.abort();
  if(which==='release')f.phone.release(f.task.id);
  await f.scroll().catch(()=>{});
  // A different app in front or a restarted phone service is the model's to handle in a direct
  // user task (it gets a fresh screen); another unconfirmed effect, a stop or a released lease still fence.
  assert.deepEqual(f.actions.map(a=>a.tool),['target','service'].includes(which)?['launch_app','swipe']:['launch_app'],which);
 }
});

test('after controller navigation the original task is not revived and its back is never replayed',async t=>{
 const f=await fixture(t);await f.open();
 assert.equal(f.actions.length,1);assert.equal(f.store.task(f.old.id).status,'unknown_result');
 assert.ok(!f.actions.some(a=>a.id===f.originalId),'the original back is never sent again');
});

test('v1 legacy supersession records remain readable and unchanged on disk',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'native-pending-compatibility-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const c=new PhoneUseClient({dataDir:dir});await fs.mkdir(path.dirname(c.pendingPath),{recursive:true});
 const original=JSON.stringify({version:1,pending:[{deviceId:DEVICE,requestId:randomUUID(),createdAt:Date.now()-200000,tool:'input_text',state:'unknown',resolution:{kind:'superseded_after_idle',nativeOutcome:'unknown',at:Date.now()-100000,deviceId:DEVICE,serviceInstanceId:INSTANCE,newRequestId:randomUUID(),newTool:'launch_app'}}]});
 await fs.writeFile(c.pendingPath,original);await c.loadPending();assert.equal(c.pending.size,1);assert.equal((await c.pendingSummary()).count,0);assert.equal(await fs.readFile(c.pendingPath,'utf8'),original);
});

test('IME checks the original device debt before replace and again before any definite-not-sent insert fallback',async t=>{
 const f=await fixture(t);f.phone.acquire(f.task.id);const native={deviceId:DEVICE,packageName:TARGET};let writes=0;
 f.phone.ime={request:async()=>{writes++;await f.client.commit(()=>f.client.pending.set('new-input',{...f.nativeOld,requestId:randomUUID(),tool:'input_text'}));return {status:'failed',diagnostic:'prepare_timeout'};}};
 for(const tool of ['tap','input_text']){
  await f.client.commit(()=>{f.client.pending.clear();f.client.pending.set('unresolved',{...f.nativeOld,tool});});
  await assert.rejects(f.phone.typeWithIme({text:'sample',inputMode:'replace'},native,f.cancel.signal),{code:'outcome_pending'});assert.equal(writes,0);
 }
 await f.client.commit(()=>f.client.pending.clear());
 await assert.rejects(f.phone.typeWithIme({text:'sample',inputMode:'replace'},native,f.cancel.signal),{code:'outcome_pending'});assert.equal(writes,1,'new pending effect prevents the insert retry');
});
