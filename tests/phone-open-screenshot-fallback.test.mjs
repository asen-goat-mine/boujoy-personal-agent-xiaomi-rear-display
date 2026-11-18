import {ANDROID_PACKAGE,BACKGROUND_SUPPORTED} from '../src/distribution.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {Phone} from '../src/adapters/phone.mjs';
import {Broker} from '../src/tools/broker.mjs';
import {normalizePhoneUseObservation} from '../src/adapters/phoneuse-state.mjs';

const DEVICE='11111111-2222-4333-8444-555555555555';
const SESSION={sessionId:'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',generation:3,displayId:19};
const APP='com.android.settings',OTHER=ANDROID_PACKAGE;
// Synthetic transport bytes: these tests run the real screenshot envelope/mapping
// validator, not JPEG decoding, OCR, a model or a device connection.
const IMAGE=Buffer.from('synthetic-screen-pixels').toString('base64');
const decode=result=>result.content.filter(row=>row.type==='text').map(row=>JSON.parse(row.text));
function observation(mode,{pkg=APP,invalidBounds=true}={}){
 const at=Date.now();
 const nodes=[{element_id:'0',parent_id:null,class:'android.widget.FrameLayout',bounds:invalidBounds?[720,0,0,1280]:[0,0,720,1280],actions:[],
  enabled:true,visible:true,editable:false,password:false,focused:false,checkable:false,checked:false,selected:false,content_invalid:false}];
 return {observation_status:'complete',device_id:DEVICE,service_instance_id:'fixture-service',observation_id:'fixture-service:1',captured_at_ms:at,
  package_name:pkg,window_id:123,ui_version:1,display_session:{...SESSION},
  display:{id:19,width:720,height:1280,rotation:0,coordinates:'physical_pixels',origin:'top_left',includes_system_bars_and_ime:true},
  windows:[{window_id:123,display_id:19,package_name:pkg,type:1,layer:1,active:true,focused:true,bounds:[0,0,720,1280]}],
  tree:mode==='screenshot'?{available:false}:{available:true,started_at_ms:at-2,finished_at_ms:at-1,output:'legacy',compact:false,scope_clipped:false,
   collection_complete:true,collection_truncated:false,truncated:false,output_nodes:1,collected_nodes:1,merged_nodes:0,elements:nodes},
  screenshot:{available:true,started_at_ms:at-2,finished_at_ms:at-1,width:720,height:1280,scale_x:1,scale_y:1,offset_x:0,offset_y:0,mime_type:'image/jpeg',data_base64:IMAGE}};
}
function fixture({initialPackage=APP,invalidBounds=true,changeScreenshot=()=>{},afterRead=()=>{},launchUnknown=false}={}){
 const prompt='打开设置查看显示选项';
 const task={id:'open-fixture',source:'user',status:'running',kind:'general',depth:0,parentId:null,phoneQuery:null,phoneUseScope:null,prompt,
  messages:[{id:'fixture-user',role:'user',content:prompt}],quotes:[],children:[],events:[]};
 const data={tasks:[task],actions:[],artifacts:[],roles:[{id:'concierge',hidden:false}],settings:{phoneBackend:'phoneuse',phoneExecutionMode:'background',phoneUseDeviceId:DEVICE,phoneEnabled:true,memoryEnabled:false}};
 const store={data,task:id=>id===task.id?task:null,event(){},transaction:fn=>fn(data),updateTask(id,fn){assert.equal(id,task.id);fn(task,data);return task;}};
 let pkg=initialPackage;const sent=[];
 const phone=new Phone(store,{phoneUse:{client:{}},wait:async()=>{},recognize:async image=>{
  assert.equal(image.content[0].data,IMAGE);return {width:720,height:1280,lines:[]};
 }});
 phone.displayBackend={telemetry:()=>({ready:true}),deviceId:()=>DEVICE,request:async(op,args,options)=>{
  sent.push({op,args,session:options.session});
  if(op==='list_apps')return {apps:[{package_name:APP,label:'设置'}]};
  if(op==='session_open')return {session:{...SESSION,width:720,height:1280}};
  if(op==='observe'){
   const raw=observation(args.mode,{pkg,invalidBounds});if(args.mode==='screenshot')changeScreenshot(raw);
   afterRead(args.mode);return {observation:raw};
  }
  if(op==='launch_app'){
   assert.equal(args.package_name,APP);
   if(launchUnknown)return {request:{request_id:'launch-unknown',state:'unknown',action_executed:true}};
   pkg=APP;return {request:{request_id:'launch-one',state:'executed',action_executed:true},landing:{onSessionDisplay:true,displayId:19,windowId:123,packageName:APP}};
  }
  assert.fail('Unexpected backend operation '+op);
 }};
 const broker=new Broker({store,phone,approvals:{cancelTask(){}}});
 return {phone,broker,task,data,sent,open:signal=>broker.execute(task.id,'phone_open_app',{packageName:APP},signal),
  capture:signal=>phone.captureForOpen(task.id,{signal}),modes:()=>sent.filter(row=>row.op==='observe').map(row=>row.args.mode)};
}

async function rejectsUnsupportedBackground(f){
 if(BACKGROUND_SUPPORTED)return false;
 assert.equal(f.phone.displayUse,null);
 await assert.rejects(f.capture(),e=>e.code==='background_not_supported'&&e.dispatchState==='not_sent');
 await assert.rejects(f.open(),e=>e.code==='background_not_supported'&&e.dispatchState==='not_sent');
 assert.deepEqual(f.sent,[],'neither capture nor open dispatches a background request');assert.equal(f.data.actions.length,0);return true;
}

test('captureForOpen uses actual DisplayDriver fallback after strict bounds rejection',async()=>{
 const bad=observation('both');assert.throws(()=>normalizePhoneUseObservation(bad,{displaySession:SESSION}),{code:'phoneuse_invalid_observation',message:'Phone Use 原生节点坐标无效'});
 const f=fixture();if(await rejectsUnsupportedBackground(f))return;const frame=await f.capture();
 assert.deepEqual(f.modes(),['both','screenshot']);assert.equal(frame.readAttempts,2);assert.equal(frame.screenshotOnly,true);
 assert.equal(frame.tree,null);assert.deepEqual(frame.native.elements,[]);assert.deepEqual(frame.native.displaySession,SESSION);
 assert.equal(frame.native.windowId,123);assert.equal(frame.native.packageName,APP);assert.equal(frame.image.content[0].data,IMAGE);
 assert.equal(frame.windowFailure.message,'Phone Use 原生节点坐标无效');assert.equal(f.sent.some(row=>row.op==='launch_app'),false);
});

test('Broker keeps the verified target foreground without ui_tree retry or launch',async()=>{
 const f=fixture();if(await rejectsUnsupportedBackground(f))return;const result=decode(await f.open());
 assert.equal(result[0].alreadyForeground,true);assert.equal(result[1].stability,'fresh');assert.equal(result[1].observationMode,'screenshot_ocr');
 assert.deepEqual(f.modes(),['both','screenshot']);assert.equal(f.data.actions.length,0);
 assert.deepEqual(f.sent.map(row=>row.op),['list_apps','session_open','observe','observe']);
 assert.equal(f.phone.observation.native.display.id,19);assert.equal(f.phone.observation.tree,null);
});

test('Broker launches a selected app once from a different verified screenshot and then observes its landing',async()=>{
 const f=fixture({initialPackage:OTHER});if(await rejectsUnsupportedBackground(f))return;const result=decode(await f.open());
 assert.equal(result[0].alreadyForeground,false);assert.equal(result[0].receipt.accepted,true);assert.equal(result[1].stability,'fresh');
 assert.equal(result[1].foregroundPackage,APP);assert.deepEqual(f.modes(),['both','screenshot','both','screenshot']);
 assert.equal(f.sent.filter(row=>row.op==='launch_app').length,1);assert.equal(f.data.actions.length,1);assert.equal(f.data.actions[0].status,'completed');
});

test('valid native trees keep the original single capture path',async()=>{
 const f=fixture({invalidBounds:false});if(await rejectsUnsupportedBackground(f))return;const frame=await f.capture();assert.ok(frame.tree);assert.notEqual(frame.screenshotOnly,true);assert.deepEqual(f.modes(),['both']);
});

for(const [name,change]of Object.entries({
 missing_session:raw=>{delete raw.display_session;},
 foreign_session:raw=>{raw.display_session.generation++;},
 foreign_display:raw=>{raw.display.id=20;},
 missing_window:raw=>{raw.windows=[];},
 foreign_window:raw=>{raw.windows[0].window_id=124;},
 foreign_window_package:raw=>{raw.windows[0].package_name='com.example.other';},
 foreground_overlay:raw=>{raw.windows.push({...raw.windows[0],window_id:124,layer:2});},
 invalid_screenshot:raw=>{raw.screenshot.data_base64='!invalid!';},
 invalid_mapping:raw=>{raw.screenshot.scale_x=2;},
 rejected_tree_still_present:raw=>{raw.tree=observation('both').tree;}
}))test('Broker never launches from fallback with '+name,async()=>{
 const f=fixture({initialPackage:OTHER,changeScreenshot:change});if(await rejectsUnsupportedBackground(f))return;
 if(['missing_session','foreign_session'].includes(name)){
  const direct=fixture({changeScreenshot:change});await assert.rejects(direct.capture(),{code:'stale_observation'});
  // Broker intentionally turns stale observations into recoverable tool feedback.
  // It must not turn that feedback into a launch or a supplied page.
  const result=await f.open();assert.ok(decode(result).some(value=>value.code==='stale_observation'));
  assert.equal(result.content.some(row=>row.type==='image'),false);
 }else await assert.rejects(f.open(),error=>['phoneuse_invalid_observation','phoneuse_incomplete_observation','phoneuse_invalid_mapping'].includes(error.code));
 assert.equal(f.sent.some(row=>row.op==='launch_app'),false);assert.equal(f.data.actions.length,0);
});

test('stopping after the rejected tree prevents the fallback request and launch',async()=>{
 const cancel=new AbortController(),f=fixture({initialPackage:OTHER,afterRead:mode=>{if(mode==='both')cancel.abort();}});if(await rejectsUnsupportedBackground(f))return;
 await assert.rejects(f.open(cancel.signal),{code:'action_cancelled'});assert.deepEqual(f.modes(),['both']);assert.equal(f.data.actions.length,0);
 assert.equal(f.sent.some(row=>row.op==='launch_app'),false);
});

test('a launched app with an unknown receipt stays unknown and is not replayed',async()=>{
 const f=fixture({initialPackage:OTHER,launchUnknown:true});if(await rejectsUnsupportedBackground(f))return;const result=decode(await f.open());
 assert.equal(result[0].receipt.accepted,'unconfirmed');assert.equal(f.sent.filter(row=>row.op==='launch_app').length,1);
 assert.equal(f.data.actions.length,1);assert.equal(f.data.actions[0].status,'unknown');assert.equal(f.data.actions[0].nativeRequestId,'launch-unknown');
});

test('an empty background display does not stop open_app: the app is launched and its landing read',async()=>{
 const f=fixture({initialPackage:OTHER,invalidBounds:false});if(await rejectsUnsupportedBackground(f))return;let launched=false;
 const request=f.phone.displayBackend.request;
 f.phone.displayBackend.request=async(op,args,options)=>{
  if(op==='observe'&&!launched){f.sent.push({op,args,session:options.session});return {observation:{observation_status:'failed',error:{code:'NO_ACTIVE_WINDOW'}}};}
  if(op==='launch_app')launched=true;
  return request(op,args,options);
 };
 const result=decode(await f.open());
 assert.equal(result[0].alreadyForeground,false);assert.equal(result[0].receipt.accepted,true);
 assert.equal(f.sent.filter(row=>row.op==='launch_app').length,1);assert.equal(f.phone.observation.native.packageName,APP);
});
