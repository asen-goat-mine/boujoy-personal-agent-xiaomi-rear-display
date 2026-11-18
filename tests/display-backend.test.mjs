import {DISTRIBUTION,ANDROID_PACKAGE,BACKGROUND_SUPPORTED} from '../src/distribution.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/core/store.mjs';
import {RemoteState,spkiPin} from '../src/remote/state.mjs';
import {createGateway} from '../src/remote/gateway.mjs';
import {DisplayCommands,sanitizeDisplayBackend} from '../src/remote/display-commands.mjs';
import {DisplayDriver} from '../src/adapters/display-driver.mjs';
import {normalizePhoneUseObservation} from '../src/adapters/phoneuse-state.mjs';
import {taskPhase} from '../src/core/task-phase.mjs';
import {identities,request} from './helpers/remote-tls.mjs';

const DEVICE='11111111-2222-4333-8444-555555555555';
const SESSION={sessionId:'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',generation:3,displayId:7};
const READY={protocol:1,shizuku:'running',executorService:true,userService:true,session:null,rear:{available:true,displayId:1,showing:false},ready:true,reason:null};

function element(id,extra={}){
 const parent=id==='0'?null:id.slice(0,id.lastIndexOf('.'));
 return {element_id:id,parent_id:parent,class:'android.widget.FrameLayout',bounds:[0,0,1080,2340],actions:[],enabled:true,visible:true,editable:false,password:false,focused:false,checkable:false,checked:false,selected:false,content_invalid:false,text:null,description:null,hint:null,...extra};
}
let serial=0;
function observation({session=SESSION,deviceId=DEVICE,elements,now=Date.now(),displayId=session.displayId,packageName='com.android.settings',windowId=123}={}){
 const nodes=elements||[element('0'),element('0.0',{class:'android.widget.Button',bounds:[100,200,500,300],actions:['tap'],text:'屏幕'})];
 const service='svc-1';
 return {observation_status:'complete',device_id:deviceId,service_instance_id:service,observation_id:`${service}:${++serial}`,captured_at_ms:now,package_name:packageName,window_id:windowId,ui_version:serial,
  display:{id:displayId,width:1080,height:2340,rotation:0,coordinates:'physical_pixels',origin:'top_left',includes_system_bars_and_ime:true},
  display_session:{...session},
  windows:[{window_id:windowId,display_id:displayId,type:1,layer:1,bounds:[0,0,1080,2340],active:true,focused:true}],
  tree:{available:true,started_at_ms:now-20,finished_at_ms:now-10,output:'legacy',compact:false,scope_clipped:false,collection_complete:true,collection_truncated:false,truncated:false,output_nodes:nodes.length,collected_nodes:nodes.length,merged_nodes:0,elements:nodes}};
}
const executed=id=>({request:{request_id:id,state:'executed',action_executed:true},device_id:DEVICE,service_instance_id:'svc-1',session:SESSION});

// A fake phone behind the backend link: records every command it receives.
function fakeLink({telemetry=READY,handle}={}){
 const sent=[];
 const link={sent,current:telemetry,telemetry:()=>link.current,deviceId:()=>DEVICE,
  async request(op,args,{session}={}){sent.push({op,args,session});return handle(op,args,session,sent.length);}};
 return link;
}
function driver(link){const value=new DisplayDriver({backend:()=>link,taskId:()=>'task-1'});return value;}
function defaultHandle(op,args,session){
 if(op==='session_open')return {session:{...SESSION,width:1080,height:2340,densityDpi:420}};
 if(op==='observe')return {observation:observation({session})};
 if(op==='launch_app')return {...executed('launch'),landing:{displayId:SESSION.displayId,packageName:args.package_name,windowId:123,onSessionDisplay:true}};
 return executed(op);
}

test('display commands are handed out once; a delivered effect without a receipt becomes unknown and is never re-sent',async()=>{
 const commands=new DisplayCommands({pollMs:30});
 const effect=commands.request({deviceId:DEVICE,op:'tap',args:{x:1,y:2},session:SESSION,controlEpoch:4,taskId:'t',timeoutMs:600});
 const command=await commands.wait(DEVICE);
 assert.equal(command.op,'tap');assert.deepEqual(command.session,SESSION);assert.equal(command.controlEpoch,4);
 assert.equal(await commands.wait(DEVICE),null,'the same command is never delivered twice');
 await assert.rejects(effect,error=>error.code==='outcome_unknown'&&error.dispatchState==='unknown');
 assert.throws(()=>commands.complete(DEVICE,command.id,executed(command.id)),error=>error.code==='display_expired','a late receipt cannot resurrect it');
});

test('undelivered commands fail as not sent; stop and pause remove them before the phone sees them',async()=>{
 const commands=new DisplayCommands({pollMs:20});
 const read=commands.request({deviceId:DEVICE,op:'observe',args:{},session:SESSION,controlEpoch:1,timeoutMs:500});
 await assert.rejects(read,error=>error.dispatchState==='not_sent');
 const queued=commands.request({deviceId:DEVICE,op:'tap',args:{},session:SESSION,controlEpoch:1,timeoutMs:5000});
 assert.equal(await commands.wait(DEVICE,{paused:true}),null,'a paused phone receives nothing');
 commands.cancelUndelivered(null,'手机控制已暂停');
 await assert.rejects(queued,error=>error.code==='action_cancelled'&&error.dispatchState==='not_sent');
 assert.equal(await commands.wait(DEVICE),null);
 const controller=new AbortController();
 const aborted=commands.request({deviceId:DEVICE,op:'tap',args:{},session:SESSION,controlEpoch:1,timeoutMs:5000,signal:controller.signal});
 controller.abort();await assert.rejects(aborted,error=>error.dispatchState==='not_sent');
});

test('receipts are bound to the delivering device and duplicates are idempotent',async()=>{
 const commands=new DisplayCommands({pollMs:20});
 const pending=commands.request({deviceId:DEVICE,op:'observe',args:{},session:SESSION,controlEpoch:1,timeoutMs:2000});
 const command=await commands.wait(DEVICE);
 assert.throws(()=>commands.complete('99999999-2222-4333-8444-555555555555',command.id,{}),error=>error.code==='display_expired');
 assert.deepEqual(commands.complete(DEVICE,command.id,{observation:null}),{accepted:true});
 assert.equal(commands.complete(DEVICE,command.id,{}).duplicate,true);
 assert.deepEqual(await pending,{observation:null});
 assert.throws(()=>commands.request({deviceId:DEVICE,op:'tap',args:{},session:null,controlEpoch:1}),error=>error.code==='display_session_stale','effects require a session');
});

test('capability telemetry is filtered and ready only when every part is up',()=>{
 assert.equal(sanitizeDisplayBackend({...READY,protocol:2}),null);
 assert.equal(sanitizeDisplayBackend(READY).ready,true);
 const missing=sanitizeDisplayBackend({...READY,executorService:false,reason:'executor_service_disabled'});
 assert.equal(missing.ready,false);assert.equal(missing.reason,'executor_service_disabled');
 assert.equal(sanitizeDisplayBackend({...READY,ready:true,shizuku:'not_running',reason:'<script>'}).reason,'display_unsupported');
 assert.equal(sanitizeDisplayBackend({...READY,session:{...SESSION,width:1080,height:2340,densityDpi:420,secret:'x'}}).session.secret,undefined);
});

test('observations must come from the exact display session; Phone Use stays on display 0',()=>{
 const frame=normalizePhoneUseObservation(observation(),{displaySession:SESSION,requireScreenshot:false});
 assert.deepEqual(frame.native.displaySession,SESSION);assert.equal(frame.native.display.id,7);
 for(const session of [{...SESSION,generation:2},{...SESSION,sessionId:randomUUID()}])
  assert.throws(()=>normalizePhoneUseObservation(observation({session}),{displaySession:SESSION,requireScreenshot:false}),error=>error.code==='display_session_stale');
 assert.throws(()=>normalizePhoneUseObservation(observation({displayId:0}),{displaySession:SESSION,requireScreenshot:false}),error=>error.code==='display_session_stale'||error.code==='phoneuse_invalid_observation');
 assert.throws(()=>normalizePhoneUseObservation(observation(),{requireScreenshot:false}),'a Phone Use read can never carry or accept a background display');
});

test('driver reads bind the session and reject a different phone identity',async()=>{
 const link=fakeLink({handle:defaultHandle}),display=driver(link);
 const frame=await display.capture('ignored',{mode:'tree'});
 assert.deepEqual(frame.native.displaySession,SESSION);
 assert.deepEqual(link.sent.map(row=>row.op),['session_open','observe']);
 const other=fakeLink({handle:(op,args,session)=>op==='observe'?{observation:observation({session,deviceId:'99999999-2222-4333-8444-555555555555'})}:defaultHandle(op,args,session)});
 await assert.rejects(driver(other).capture('ignored',{mode:'tree'}),error=>error.code==='stale_observation');
});

test('an observation from an older display generation can never drive an action',async()=>{
 const link=fakeLink({handle:defaultHandle}),display=driver(link);
 const frame=await display.capture('ignored',{mode:'tree'});
 display.forgetSession();display.session={...SESSION,generation:4,width:1080,height:2340};
 await assert.rejects(display.call('ignored','tap',{x:150,y:250},8000,{native:frame.native}),error=>error.code==='stale_observation'&&error.dispatchState==='not_sent');
 const crossDisplay={...frame.native,displaySession:{...SESSION,displayId:8}};
 display.session={...SESSION,width:1080,height:2340};
 await assert.rejects(display.call('ignored','tap',{x:150,y:250},8000,{native:crossDisplay}),error=>error.code==='stale_observation');
 assert.ok(!link.sent.some(row=>row.op==='tap'),'nothing was sent to the phone');
});

test('a stale-session receipt from the phone forces a new session instead of reusing the old one',async()=>{
 let generation=3;
 const link=fakeLink({handle:(op,args,session)=>{
  if(op==='session_open')return {session:{...SESSION,generation,width:1080,height:2340,densityDpi:420}};
  if(op==='tap')return {request:{request_id:'x',state:'failed',action_executed:false,error:{code:'SESSION_STALE'}}};
  return defaultHandle(op,args,session);
 }});
 const display=driver(link),frame=await display.capture('ignored',{mode:'tree'});
 await assert.rejects(display.call('ignored','tap',{x:150,y:250},8000,{native:frame.native}),error=>error.code==='stale_observation'&&error.dispatchState==='not_sent');
 assert.equal(display.session,null);generation=4;
 const fresh=await display.capture('ignored',{mode:'tree'});assert.equal(fresh.native.displaySession.generation,4);
});

test('a launch not yet seen on the session display is reported unconfirmed, not a stop; the session keeps working',async()=>{
 const link=fakeLink({handle:(op,args,session)=>op==='launch_app'?{...executed('launch'),landing:{displayId:null,packageName:args.package_name,windowId:null,onSessionDisplay:false}}:defaultHandle(op,args,session)});
 const display=driver(link);
 await assert.rejects(display.call('ignored','open_app',{packageName:'com.android.settings'}),error=>error.code==='outcome_unknown'&&error.dispatchState==='unknown'&&error.landingUnconfirmed===true);
 assert.equal(display.halted,null);
 const frame=await display.capture(DEVICE,{mode:'tree',timeout:5000});
 await display.call('ignored','tap',{x:150,y:250},8000,{native:frame.native});
 assert.equal(link.sent.filter(row=>row.op==='tap').length,1,'input still goes only to the session display');
 assert.equal(link.sent.filter(row=>row.op==='launch_app').length,1,'the launch itself is never re-sent');
});
test('an app open on the unlocked main screen is not taken from the user',async()=>{
 const link=fakeLink({handle:(op,args,session)=>op==='launch_app'?{request:{request_id:'l',state:'failed',action_executed:false,error:{code:'APP_IN_USE_ON_MAIN'}}}:defaultHandle(op,args,session)});
 await assert.rejects(driver(link).call('ignored','open_app',{packageName:'com.android.deskclock'}),error=>error.code==='phone_app_in_use'&&error.dispatchState==='not_sent');
});

test('unknown receipts are never retried and phone-side refusals stay not sent',async()=>{
 let tapState='unknown';
 const link=fakeLink({handle:(op,args,session)=>op==='tap'?{request:{request_id:'x',state:tapState,action_executed:tapState!=='failed',...(tapState==='failed'?{error:{code:'LOCALLY_PAUSED'}}:{})}}:defaultHandle(op,args,session)});
 const display=driver(link),frame=await display.capture('ignored',{mode:'tree'});
 await assert.rejects(display.call('ignored','tap',{x:150,y:250},8000,{native:frame.native}),error=>error.code==='outcome_unknown');
 assert.equal(link.sent.filter(row=>row.op==='tap').length,1,'sent exactly once');
 tapState='failed';
 await assert.rejects(display.call('ignored','tap',{x:150,y:250},8000,{native:frame.native}),error=>error.code==='phone_control_paused'&&error.dispatchState==='not_sent');
});

test('background typing never falls back to the input method, and main-screen keys are refused',async()=>{
 const link=fakeLink({handle:defaultHandle}),display=driver(link),frame=await display.capture('ignored',{mode:'tree'});
 await assert.rejects(display.call('ignored','type',{text:'hi',mode:'insert'},8000,{native:frame.native}),error=>error.code==='phone_input_unavailable'&&error.dispatchState==='not_sent');
 for(const key of ['home','recents'])await assert.rejects(display.call('ignored','key',{key},8000,{native:frame.native}),error=>error.code==='phone_capability_unavailable');
 const editor=element('0.1',{class:'android.widget.EditText',bounds:[0,400,1080,500],actions:['tap','set_text'],editable:true,focused:true});
 const withEditor=normalizePhoneUseObservation(observation({elements:[element('0'),editor]}),{displaySession:SESSION,requireScreenshot:false});
 await display.call('ignored','type',{text:'hi',mode:'replace'},8000,{native:withEditor.native});
 const typed=link.sent.at(-1);assert.equal(typed.op,'input_text');assert.equal(typed.args.element_id,'0.1');assert.equal(typed.args.observation_id,withEditor.native.observationId);assert.deepEqual({sessionId:typed.session.sessionId,generation:typed.session.generation,displayId:typed.session.displayId},SESSION);
 const secret=element('0.1',{class:'android.widget.EditText',bounds:[0,400,1080,500],actions:['set_text'],editable:true,focused:true,password:true});
 const protectedFrame=normalizePhoneUseObservation(observation({elements:[element('0'),secret]}),{displaySession:SESSION,requireScreenshot:false});
 await assert.rejects(display.call('ignored','type',{text:'1234',mode:'replace'},8000,{native:protectedFrame.native}),error=>error.code==='user_only_step');
});

test('no command is sent when the phone reports the backend is not ready',async()=>{
 const link=fakeLink({telemetry:{...READY,ready:false,executorService:false,reason:'executor_service_disabled'},handle:defaultHandle});
 await assert.rejects(driver(link).capture('ignored',{mode:'tree'}),error=>error.code==='display_backend_unavailable'&&/无障碍/.test(error.message));
 link.current=null;
 await assert.rejects(driver(link).capture('ignored',{mode:'tree'}),error=>error.code==='display_backend_unavailable');
 assert.equal(link.sent.length,0);
});

test('task phase describes recorded steps without inventing progress',()=>{
 const at='2026-11-14T08:00:00.000Z';
 assert.deepEqual(taskPhase({status:'running',events:[{type:'model_timing',at}]}),{phase:'正在思考',phaseAt:at});
 assert.deepEqual(taskPhase({status:'running',events:[{type:'tool',tool:'phone_use',action:'tap',at}]}),{phase:'操作手机：点按',phaseAt:at});
 assert.equal(taskPhase({status:'waiting_approval',updatedAt:at}).phase,'等待你确认');
 assert.equal(taskPhase({status:'completed',updatedAt:at}).phase,'已完成');
 assert.ok(!JSON.stringify(taskPhase({status:'running',events:[{type:'tool',tool:'phone_use',at}]})).includes('%'));
});

async function setup(t){
 const id=identities();t.after(id.cleanup);const store=new Store(id.dir,{lock:false});t.after(()=>store.close());
 const state=new RemoteState(id.dir),deviceId=randomUUID();const statuses=[];
 const engine={active:new Map(),broker:null,async stop(){}};
 const gateway=createGateway({identity:id.server,state,store,engine,phone:{lease:null},onDeviceStatus:value=>statuses.push(value),dataDir:id.dir});
 const port=await gateway.listen();t.after(()=>gateway.close());
 const call=(pathname,body,who=id.client)=>request({port,identity:who,pin:spkiPin(id.server.cert),pathname,method:body?'POST':'GET',body});
 const pairing=state.issuePairing({deviceId});
 assert.equal((await call('/v1/pair',{edition:DISTRIBUTION.edition,androidApplicationId:ANDROID_PACKAGE,pairToken:pairing.pairToken})).status,200);
 assert.equal((await call('/v1/device/control',{messageId:randomUUID(),controlEpoch:1,paused:false,reason:'new_task'})).status,200);
 return {id,store,state,call,gateway,deviceId,statuses};
}

test('real mTLS: the bound phone pulls one display command and reports capability; others cannot',async t=>{
 const x=await setup(t);x.gateway.display.pollMs=200;
 if(!BACKGROUND_SUPPORTED){
  for(const [route,body] of [['/v1/device/display?protocol=1',undefined],['/v1/device/display',{messageId:randomUUID(),id:randomUUID(),result:{}}]]){const rejected=await x.call(route,body);assert.equal(rejected.status,400);assert.equal(rejected.body.error.code,'background_not_supported');}
  assert.equal(x.gateway.display.waiters.length,0);assert.equal(x.gateway.display.pending.size,0);
  const status=await x.call('/v1/device/status',{edition:DISTRIBUTION.edition,androidApplicationId:ANDROID_PACKAGE,timezone:'Asia/Shanghai',observedAt:new Date().toISOString(),displayBackend:{...READY}});
  assert.equal(status.status,200);assert.equal(x.statuses.at(-1).displayBackend,undefined,'generic telemetry cannot advertise a backend');return;
 }
 const boundId=x.state.device(Object.keys(x.state.data.devices)[0])?.id||Object.values(x.state.data.devices)[0].id;
 const pending=x.gateway.display.request({deviceId:boundId,op:'observe',args:{mode:'tree'},session:SESSION,controlEpoch:1,timeoutMs:5000});
 assert.equal((await x.call('/v1/device/display')).status,400,'protocol version is required');
 assert.equal((await x.call('/v1/device/display?protocol=1',undefined,x.id.other)).status,403);
 const polled=await x.call('/v1/device/display?protocol=1');
 assert.equal(polled.status,200);assert.equal(polled.body.command.op,'observe');assert.deepEqual(polled.body.command.session,SESSION);
 assert.equal((await x.call('/v1/device/display?protocol=1')).body.command,null);
 const posted=await x.call('/v1/device/display',{messageId:randomUUID(),id:polled.body.command.id,result:{observation:{observation_status:'failed',error:{code:'NO_ACTIVE_WINDOW'}}}});
 assert.equal(posted.status,200);assert.equal((await pending).observation.error.code,'NO_ACTIVE_WINDOW');
 assert.equal((await x.call('/v1/device/display',{messageId:randomUUID(),id:randomUUID(),result:{}})).status,400);
 const status=await x.call('/v1/device/status',{edition:DISTRIBUTION.edition,androidApplicationId:ANDROID_PACKAGE,timezone:'Asia/Shanghai',observedAt:new Date().toISOString(),displayBackend:{...READY,extra:'dropped'}});
 assert.equal(status.status,200);assert.equal(x.statuses.at(-1).displayBackend.ready,true);assert.equal(x.statuses.at(-1).displayBackend.extra,undefined);
});

test('real mTLS: a phone pause drops queued display commands before delivery',async t=>{
 const x=await setup(t);x.gateway.display.pollMs=100;
 const boundId=Object.values(x.state.data.devices)[0].id;
 const queued=x.gateway.display.request({deviceId:boundId,op:'tap',args:{},session:SESSION,controlEpoch:1,timeoutMs:5000}).then(()=>null,error=>error);
 assert.equal((await x.call('/v1/device/control',{messageId:randomUUID(),controlEpoch:2,paused:true,reason:'rear_stop'})).status,200);
 const error=await queued;assert.equal(error?.dispatchState,'not_sent');
 const polled=await x.call('/v1/device/display?protocol=1');
 if(BACKGROUND_SUPPORTED)assert.equal(polled.body.command,null);else{assert.equal(polled.status,400);assert.equal(polled.body.error.code,'background_not_supported');assert.equal(x.gateway.display.queue.length,0);}
});

test('the phone controller switches drivers only by the explicit setting and never types through the main-screen IME in background mode',async t=>{
 const {Phone}=await import('../src/adapters/phone.mjs');
 const {mkdtempSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const dir=mkdtempSync(join(tmpdir(),'display-phone-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const store=new Store(dir,{lock:false});t.after(()=>store.close());
 const legacy={client:{},close:async()=>{}};
 const phone=new Phone(store,{phoneUse:legacy});
 assert.equal(store.data.settings.phoneExecutionMode,'main');
 store.transaction(s=>{s.settings.phoneBackend='phoneuse';s.settings.phoneEnabled=true;});
 assert.equal(phone.phoneUse,legacy,'main mode keeps the Phone Use driver');
 store.transaction(s=>{s.settings.phoneExecutionMode='background';});
 if(!BACKGROUND_SUPPORTED){let typed=false;phone.ime={request:async()=>{typed=true;}};assert.equal(phone.displayUse,null);assert.equal(phone.phoneUse,legacy);assert.equal(phone.isBackground(),false);await assert.rejects(phone.typeWithIme({text:'hi'},null,null),e=>e.code==='background_not_supported'&&e.dispatchState==='not_sent');await assert.rejects(phone.systemNavigate('t','home'),e=>e.code==='background_not_supported'&&e.dispatchState==='not_sent');assert.equal(typed,false);return;}
 assert.equal(phone.phoneUse,phone.displayUse);assert.equal(phone.phoneUse.client,legacy.client,'transport and pairing stay with the Phone Use client');
 let typed=false;phone.ime={request:async()=>{typed=true;}};
 await assert.rejects(phone.typeWithIme({text:'hi'},null,null),error=>error.code==='phone_input_unavailable'&&error.dispatchState==='not_sent');
 assert.equal(typed,false);
 await assert.rejects(phone.systemNavigate('t','home'),error=>error.code==='phone_capability_unavailable'&&error.dispatchState==='not_sent');
 store.transaction(s=>{s.settings.phoneBackend='pony';});
 assert.equal(phone.isBackground(),false,'background mode exists only for the native backend');
});

test('the phone learns the execution mode from its authenticated state sync',async t=>{
 const x=await setup(t);
 assert.deepEqual((await x.call('/v1/state')).body.phoneExecution,{mode:'main',supported:BACKGROUND_SUPPORTED});
 x.store.transaction(s=>{s.settings.phoneExecutionMode='background';});
 assert.deepEqual((await x.call('/v1/state')).body.phoneExecution,{mode:BACKGROUND_SUPPORTED?'background':'main',supported:BACKGROUND_SUPPORTED});
});

test('telemetry keeps only known optional features and a well-formed handoff state',()=>{
 const value=sanitizeDisplayBackend({...READY,features:['session_handoff','session_handoff','shell_exec'],handoff:{state:'pending',taskId:'t-1',at:'2026-11-14T11:00:00Z',extra:1}});
 assert.deepEqual(value.features,['session_handoff']);
 assert.deepEqual(value.handoff,{state:'pending',taskId:'t-1',at:'2026-11-14T11:00:00Z'});
 assert.equal(sanitizeDisplayBackend({...READY,handoff:{state:'moved_everything'}}).handoff,null);
 assert.deepEqual(sanitizeDisplayBackend(READY).features,[]);
});

test('a task waiting for the user hands its background display over instead of destroying it; older phones still close',async()=>{
 const link=fakeLink({telemetry:{...READY,features:['session_handoff']},handle:(op,args,session)=>op==='session_handoff'?{handoff:{state:'pending'}}:defaultHandle(op,args,session)});
 const display=driver(link);await display.ensureSession();
 const result=await display.handoffSession({taskId:'task-1',title:'  点一杯\n冰美式  ',summary:'已到结算页'.repeat(40)});
 assert.equal(result.handed,true);assert.equal(display.session,null,'the Mac never sends to a handed-over session again');
 const sent=link.sent.at(-1);
 assert.equal(sent.op,'session_handoff');assert.equal(sent.session.sessionId,SESSION.sessionId);assert.equal(sent.session.generation,SESSION.generation);
 assert.equal(sent.args.title,'点一杯 冰美式');assert.equal([...sent.args.summary].length,160);
 assert.equal(link.sent.some(row=>row.op==='session_close'),false);
 const old=fakeLink({handle:defaultHandle}),legacy=driver(old);await legacy.ensureSession();
 assert.equal((await legacy.handoffSession({taskId:'task-1'})).handed,false);
 assert.equal(old.sent.at(-1).op,'session_close');
});

test('releasing the phone offers the handoff only for a background task that is ready for the user',async t=>{
 const {Phone}=await import('../src/adapters/phone.mjs');
 const {mkdtempSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const dir=mkdtempSync(join(tmpdir(),'display-handoff-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const store=new Store(dir,{lock:false});t.after(()=>store.close());
 const phone=new Phone(store,{phoneUse:{client:{},close:async()=>{}}});
 store.transaction(s=>{s.settings.phoneBackend='phoneuse';s.settings.phoneExecutionMode='background';});
 if(!BACKGROUND_SUPPORTED){assert.equal(phone.displayUse,null);phone.lease='task-x';phone.release('task-x');assert.equal(phone.lease,null);return;}
 const calls=[];phone.displayUse.handoffSession=async info=>{calls.push(['handoff',info]);return {handed:true,reason:'pending'};};phone.displayUse.closeSession=async()=>{calls.push(['close']);};
 const task=store.createTask?.({prompt:'点咖啡'})||null;
 const id=task?.id||'task-x';
 if(!task)store.transaction(s=>{s.tasks.push({id,title:'点咖啡',status:'ready_for_user',report:{summary:'已到结算页，请付款'},events:[],messages:[]});});
 else store.updateTask(id,t=>{t.status='ready_for_user';t.report={summary:'已到结算页，请付款'};});
 phone.lease=id;phone.displayUse.session={...SESSION};phone.release(id);
 assert.deepEqual(calls[0],['handoff',{taskId:id,title:store.task(id).title,summary:'已到结算页，请付款'}]);
 store.updateTask(id,t=>{t.status='completed';});phone.lease=id;phone.displayUse.session={...SESSION};phone.release(id);
 assert.deepEqual(calls[1],['close']);
});

test('an unprovable send on the background display stops before the tap and points to the main-screen handoff',async()=>{
 const {verifyOpaqueSend}=await import('../src/tools/broker.mjs');
 let verified=false;
 const phone={isBackground:()=>true,ime:{verify:async()=>{verified=true;}}};
 await assert.rejects(verifyOpaqueSend(phone,{id:'t'},{packageName:'com.tencent.mm',effectPlan:{content:'hi'}},{kind:'effect_send',witness:{requiresEditorProof:true}},{native:{}},'ref',null),
  error=>error.code==='editor_not_verified'&&error.dispatchState==='not_sent'&&error.message.includes('ready_for_user'));
 assert.equal(verified,false,'the main-screen input method is never asked about a background editor');
});

test('a tab label on an autoplaying feed is rechecked by its native control, never for payment words',async()=>{
 const {sameNativeTextTarget}=await import('../src/adapters/phone-ocr.mjs');
 const node=(id,extra)=>({element_id:id,visible:true,enabled:true,password:false,actions:['tap'],...extra});
 const page=(caption,tab=[700,2200,820,2300])=>({windowId:5,packageName:'com.ss.android.ugc.aweme',elements:[node('0',{bounds:[0,0,1080,2348],text:null}),node('0.1',{bounds:[40,2050,1040,2150],text:caption}),node('0.2',{bounds:tab,text:'消息',description:null}),node('0.3',{bounds:[690,2190,830,2310],text:null,description:'消息，按钮'})]});
 const target={text:'消息',bounds:[705,2210,815,2290]};
 assert.equal(sameNativeTextTarget(page('第一条视频的字幕'),page('换了一条视频的字幕'),target),true,'captions changing next to the tab do not matter');
 assert.equal(sameNativeTextTarget(page('a'),page('a',[700,2100,820,2200]),target),false,'the control moved');
 assert.equal(sameNativeTextTarget(page('a'),{...page('a'),windowId:6},target),false,'another window');
 const pay={...page('a'),elements:[node('0',{bounds:[0,0,1080,2348]}),node('0.2',{bounds:[700,2200,820,2300],text:'立即支付'})]};
 assert.equal(sameNativeTextTarget(pay,pay,{text:'立即支付',bounds:[705,2210,815,2290]}),false,'payment words keep the strict OCR check');
});

test('a feed whose tree keeps changing is read as a picture instead of failing the read',async()=>{
 const modes=[];
 const link=fakeLink({handle:(op,args,session)=>{
  if(op==='observe'){modes.push(args.mode);return {observation:{observation_status:'failed',error:{code:'OBSERVATION_INCONSISTENT'}}};}
  return defaultHandle(op,args,session);
 }});
 const display=driver(link);
 await assert.rejects(display.capture(DEVICE,{timeout:5000}));
 assert.deepEqual(modes.slice(0,3),['both','both','screenshot']);assert.ok(modes.slice(3).every(mode=>mode==='screenshot'));
});

test('a background text tap whose label has its own control is rechecked by structure alone, then sent with the fresh read',async t=>{
 const {Phone}=await import('../src/adapters/phone.mjs');
 const {mkdtempSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const dir=mkdtempSync(join(tmpdir(),'display-quick-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const store=new Store(dir,{lock:false});t.after(()=>store.close());
 let recognized=0;
 const phone=new Phone(store,{phoneUse:{client:{},close:async()=>{}},recognize:async()=>{recognized++;return null;}});
 store.transaction(s=>{s.settings.phoneEnabled=true;s.settings.phoneBackend='phoneuse';s.settings.phoneExecutionMode='background';s.settings.phoneUseDeviceId=DEVICE;});
 const node=(id,extra)=>({element_id:id,visible:true,enabled:true,password:false,actions:['tap'],bounds:[0,0,1080,2340],text:null,description:null,...extra});
 const native=id=>({observationId:'svc-1:'+id,deviceId:DEVICE,serviceInstanceId:'svc-1',windowId:5,packageName:'shop.app',displaySession:{...SESSION},display:{id:SESSION.displayId},windows:[],elements:[node('0'),node('0.1',{bounds:[800,690,940,760],text:'选规格'}),node('0.2',{bounds:[40,300,900,380],text:'限时 '+id})]});
 const target={id:'text-2',text:'选规格',bounds:[808,700,932,748],center:{x:870,y:724}};
 phone.lease='task';phone.observation={id:'screen-1',taskId:'task',at:Date.now(),native:native(1),ocr:{width:1080,height:2340,lines:[target]},tree:null};
 const captures=[],sent=[];
 if(!BACKGROUND_SUPPORTED){assert.equal(phone.displayUse,null);await assert.rejects(phone.actGeneral('task',{observationId:'screen-1',action:'tap',textTargetId:'text-2'}),e=>e.code==='background_not_supported'&&e.dispatchState==='not_sent');assert.equal(recognized,0);assert.deepEqual(sent,[]);return;}
 phone.displayUse.capture=async(device,options)=>{captures.push(options.mode);return {native:native(2),tree:null,image:null};};
 phone.displayUse.call=async(device,name,args,timeout,options)=>{sent.push({name,args,observation:options.native.observationId});return {ok:true};};
 await phone.actGeneral('task',{observationId:'screen-1',action:'tap',textTargetId:'text-2'});
 assert.deepEqual(captures,['tree']);assert.equal(recognized,0,'no picture and no text recognition for the recheck');
 assert.equal(sent.length,1);assert.equal(sent[0].name,'tap');assert.equal(sent[0].args.x,870);assert.equal(sent[0].observation,'svc-1:2');
});

test('background typing finds the field without reported focus: the only one, or the one the last tap landed in',async()=>{
 const link=fakeLink({handle:defaultHandle}),display=driver(link);
 const field=(id,bounds)=>element(id,{class:'android.widget.EditText',bounds,actions:['tap','set_text'],editable:true,focused:false});
 const read=async elements=>{link.handleObserve=elements;return normalizePhoneUseObservation(observation({elements}),{displaySession:SESSION,requireScreenshot:false});};
 await display.ensureSession();
 const one=await read([element('0'),field('0.1',[0,400,1080,500])]);
 await display.call('ignored','type',{text:'冰美式',mode:'replace'},8000,{native:one.native});
 assert.equal(link.sent.at(-1).op,'input_text');assert.equal(link.sent.at(-1).args.element_id,'0.1');
 const two=await read([element('0'),field('0.1',[0,400,1080,500]),field('0.2',[0,600,1080,700])]);
 await assert.rejects(display.call('ignored','type',{text:'a',mode:'replace'},8000,{native:two.native}),error=>error.code==='phone_input_unavailable'&&error.dispatchState==='not_sent');
 await display.call('ignored','type',{text:'a',mode:'replace',nearX:500,nearY:650},8000,{native:two.native});
 assert.equal(link.sent.at(-1).args.element_id,'0.2');
});

test('the rear-screen phase prefers what the assistant just said it is doing, and falls back to the recorded step',()=>{
 const now=Date.parse('2026-11-14T12:00:30Z');
 const task={status:'running',events:[{type:'tool',tool:'phone_use',action:'tap',at:'2026-11-14T12:00:20Z'}]};
 assert.deepEqual(taskPhase(task,{now,note:{text:'好的。\n**正在打开淘宝搜纸巾**',at:'2026-11-14T12:00:25Z'}}),{phase:'正在打开淘宝搜纸巾',phaseAt:'2026-11-14T12:00:25Z'});
 assert.equal(taskPhase(task,{now,note:{text:'字'.repeat(80),at:'2026-11-14T12:00:25Z'}}).phase.length,36);
 assert.equal(taskPhase(task,{now,note:{text:'很久以前说的',at:'2026-11-14T11:50:00Z'}}).phase,'操作手机：点按');
 assert.equal(taskPhase(task,{now,note:{text:'  ',at:'2026-11-14T12:00:25Z'}}).phase,'操作手机：点按');
 assert.equal(taskPhase({status:'completed',updatedAt:'x'},{now,note:{text:'正在处理',at:'2026-11-14T12:00:25Z'}}).phase,'已完成');
});

test('a concrete clock time asked for later counts as a schedule request; prices and plain questions do not',async()=>{
 const {userAskedForRoutine}=await import('../src/core/scheduler.mjs');
 const asked=text=>userAskedForRoutine({messages:[{role:'user',content:text}]});
 for(const text of ['你设个自动任务12.20自动给我来一杯manner咖啡','明天中午12点帮我点外卖','12:30 提醒我开会','每天早上8点'])assert.equal(asked(text),true,text);
 for(const text of ['帮我看看抖音私信','价格12.50元的那个','3.14','今天天气怎么样'])assert.equal(asked(text),false,text);
});
