import {BACKGROUND_SUPPORTED} from '../src/distribution.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {Phone} from '../src/adapters/phone.mjs';
import {nativeState} from '../src/adapters/phone-purchase-navigation.mjs';
import {generalForeground} from '../src/adapters/phone-general-navigation.mjs';
import {normalizePhoneUseObservation} from '../src/adapters/phoneuse-state.mjs';

const SESSION={sessionId:'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',generation:3,displayId:19};
const DEVICE='11111111-2222-4333-8444-555555555555',APP='com.android.settings';
const OCR={width:720,height:1280,lines:[{id:'synthetic-label',text:'合成显示选项',bounds:[10,20,110,60],center:{x:60,y:40}}]};
function raw({displayId=19,session=SESSION,pkg=APP,mode='screenshot'}={}){
 const now=Date.now();
 return {observation_status:'complete',device_id:DEVICE,service_instance_id:'synthetic-service',observation_id:'synthetic-service:1',captured_at_ms:now,package_name:pkg,window_id:123,ui_version:1,
  display:{id:displayId,width:720,height:1280,rotation:0,coordinates:'physical_pixels',origin:'top_left',includes_system_bars_and_ime:true},
  ...(session?{display_session:{...session}}:{}),
  windows:[{display_id:displayId,window_id:123,package_name:pkg,type:1,layer:1,active:true,focused:true,bounds:[0,0,720,1280]}],
  // A rejected native class exercises the actual DisplayDriver both -> screenshot fallback.
  tree:mode==='both'?{available:true,started_at_ms:now-2,finished_at_ms:now-1,output:'legacy',compact:false,scope_clipped:false,collection_complete:true,collection_truncated:false,truncated:false,output_nodes:1,collected_nodes:1,merged_nodes:0,elements:[{element_id:'0',parent_id:null,bounds:[0,0,720,1280],visible:true,class:false}]}:{available:false},
  screenshot:{available:true,started_at_ms:now-2,finished_at_ms:now-1,width:720,height:1280,scale_x:1,scale_y:1,offset_x:0,offset_y:0,mime_type:'image/jpeg',data_base64:'/9j/2Q=='}};
}
function frame(options={}){
 const normalized=normalizePhoneUseObservation(raw(options),{displaySession:options.session===null?null:SESSION,requireTree:false});
 return {...normalized,native:normalized.native,screenshotOnly:true,ocr:structuredClone(OCR)};
}
function fixture({pkg=APP,knownWindow=false,harness=false}={}){
 const scope={mode:'general',taskId:'synthetic-task',packageName:APP,appName:'Settings',...(harness?{decisionOwner:'harness'}:{})};
 const task={id:scope.taskId,status:'running',messages:[],phoneUseScope:scope};
 const store={data:{settings:{phoneBackend:'phoneuse',phoneExecutionMode:'background',phoneUseDeviceId:DEVICE,phoneEnabled:true},tasks:[task]},task:id=>id===task.id?task:null,event(){}};
 const phone=new Phone(store,{phoneUse:{client:{}},recognize:async()=>structuredClone(OCR)}),modes=[];
 phone.displayBackend={telemetry:()=>({ready:true}),deviceId:()=>DEVICE,request:async(op,args)=>{
  if(op==='session_open')return {session:{...SESSION,width:720,height:1280}};
  assert.equal(op,'observe');modes.push(args.mode);return {observation:raw({pkg,mode:args.mode})};
 }};
 if(knownWindow)phone.returnWindows=new Map([[APP,{key:JSON.stringify([DEVICE,'synthetic-service',123,pkg]),at:Date.now()}]]);
 return {phone,scope,modes};
}

async function rejectsUnsupportedBackground({phone,scope,modes}){
 if(BACKGROUND_SUPPORTED)return false;
 assert.equal(phone.displayUse,null);await assert.rejects(phone.observeGeneral(scope.taskId,scope),e=>e.code==='background_not_supported'&&e.dispatchState==='not_sent');assert.deepEqual(modes,[]);return true;
}

test('screenshot scope accepts main and the exact validated background display without changing internal main semantics',()=>{
 const main=frame({displayId:0,session:null});assert.equal(generalForeground(main),APP);
 const background=frame(),state=nativeState(background);
 assert.equal(generalForeground(background),APP);assert.equal(state.display,'main');assert.equal(state.backend,'display');
 assert.equal(state.displayId,19);assert.deepEqual(state.displaySession,SESSION);assert.notEqual(state.displaySession,background.native.displaySession);
});

test('complete observeGeneral keeps same-app background screenshot and OCR even with a known return-window key',async()=>{
 const f=fixture({knownWindow:true,harness:true});if(await rejectsUnsupportedBackground(f))return;const {phone,scope,modes}=f;
 const result=await phone.observeGeneral(scope.taskId,scope),meta=JSON.parse(result.content[0].text);
 assert.deepEqual(modes,['both','screenshot']);assert.equal(meta.stability,'fresh');assert.equal(meta.returnOnly,undefined);
 assert.equal(meta.foregroundPackage,APP);assert.equal(meta.observationMode,'screenshot_ocr');
 assert.ok(result.content.some(block=>block.type==='image'));assert.equal(meta.textTargets[0].text,OCR.lines[0].text);
 assert.equal(phone.observation.native.display.id,19);assert.deepEqual(phone.observation.native.displaySession,SESSION);
 assert.equal(phone.observation.tree,null);assert.equal(phone.observation.returnOnly,undefined);
});

test('screenshot fallback never invents a background session or accepts mismatched display/window evidence',()=>{
 const mutations=[
  n=>{delete n.displaySession;},n=>{n.displaySession.displayId=20;},n=>{n.displaySession.generation=-1;},n=>{n.displaySession.sessionId='unknown';},
  n=>{n.display.id=0;},n=>{n.windowId=124;},n=>{n.windows[0].display_id=20;},n=>{n.windows[0].package_name='com.example.other';},
  n=>{n.windows=[];},n=>{n.windows={};},n=>{n.windows[0].type=2;},n=>{n.observationId='different-service:1';},
  n=>{n.windows.push({display_id:19,window_id:456,type:1,layer:2,active:true,focused:true,bounds:[0,0,720,1280]});}
 ];
 for(const mutate of mutations){const observed=frame();mutate(observed.native);assert.equal(nativeState(observed),null,mutate.toString());}
});

test('the real normalizer rejects foreign session id, generation and display before screenshot scope',()=>{
 for(const change of [value=>{value.display_session.sessionId='bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';},value=>{value.display_session.generation=4;},value=>{value.display_session.displayId=20;},value=>{value.display.id=20;},value=>{delete value.display_session;}]){
  const value=raw();change(value);
  assert.throws(()=>normalizePhoneUseObservation(value,{displaySession:SESSION,requireTree:false}),error=>['display_session_stale','phoneuse_invalid_observation'].includes(error.code));
 }
 assert.throws(()=>normalizePhoneUseObservation(raw(),{requireTree:false}),error=>error.code==='phoneuse_invalid_observation');
});

test('an unrelated app outside the granted scope does not expose its screenshot or OCR',async()=>{
 const f=fixture({pkg:'com.example.other'});if(await rejectsUnsupportedBackground(f))return;const {phone,scope}=f,result=await phone.observeGeneral(scope.taskId,scope);
 assert.equal(result.meta.reason,'outside_task_scope');assert.equal(result.meta.foregroundPackage,'com.example.other');
 assert.equal(phone.observation,null);assert.equal(result.content.some(block=>block.type==='image'),false);
 assert.equal(JSON.stringify(result.content).includes(OCR.lines[0].text),false);
});

test('a genuinely remembered foreign-app window keeps its back-only restriction',async()=>{
 const f=fixture({pkg:'com.example.other',knownWindow:true});if(await rejectsUnsupportedBackground(f))return;const {phone,scope}=f,result=await phone.observeGeneral(scope.taskId,scope);
 assert.equal(result.meta.returnOnly,true);assert.deepEqual(result.meta.permittedActions,['back']);
 assert.equal(result.content.some(block=>block.type==='image'),false);assert.equal(JSON.stringify(result.content).includes(OCR.lines[0].text),false);
});
